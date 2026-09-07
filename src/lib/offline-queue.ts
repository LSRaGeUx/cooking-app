"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ActionResult } from "@/app/actions/result";
import type { RenderableError } from "@/lib/error-message";

/**
 * Ticking grocery lines with no signal.
 *
 * The grocery list is the one screen used in a place where the connection
 * fails, so a tick that cannot be written must not be lost and must not be
 * silently reverted. It goes into a queue in localStorage and is replayed when
 * the connection returns.
 *
 * The queue is keyed by line, so the last state a user chose for a line is the
 * one that is sent. Ticking and unticking the same line while offline collapses
 * to one write rather than replaying a history nobody cares about.
 *
 * localStorage rather than the service worker's Background Sync: the queue has
 * to survive the worker being evicted, and it has to be replayed by code that
 * knows which server action to call.
 *
 * Five things went wrong in the first version of this file, and they are worth
 * naming because each one is a way a queue quietly stops being a queue.
 *
 * 1. `flush` snapshotted the queue, awaited every send, then wrote the snapshot
 *    back. A tick made during one of those awaits was in the newer stored queue
 *    and not in the snapshot, so it was overwritten and lost. The queue is now
 *    re-read before it is written, and only the ids actually sent are removed.
 * 2. Any thrown error counted as "offline". A 500, a bug in the service, a
 *    redirect: all of them queued a tick that would throw again on every replay
 *    and `break` out of the loop, so `pendingCount` stayed positive forever and
 *    the banner never went away. A connection failure is now told apart from
 *    the rest, and anything still queued past `QUEUE_TTL_MS` is dropped rather
 *    than replayed until the end of time.
 * 3. The mount flush and the `online` flush could run at the same time and
 *    replay the same ids twice. One in-flight guard.
 * 4. `JSON.parse` was cast straight to the queue type, so a malformed value in
 *    localStorage reached `send(undefined, undefined)`. Every entry is checked
 *    and the rest are dropped.
 * 5. `flush` swallowed a server refusal, with a comment claiming the screen
 *    "reloads the truth". Nothing reloaded and nothing reported, so a tick the
 *    server refused disappeared without a word. Refusals come back from
 *    `flush` now, and the screen shows them.
 */

const STORAGE_KEY = "cooking-app.grocery-queue.v1";

/**
 * A tick older than this is dropped unsent. A shopping cycle is a week, so a
 * tick that has not reached the server in a day is about a list nobody is
 * shopping from any more, and replaying it would tick a line in the past.
 */
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

interface QueuedCheck {
  readonly lineId: string;
  readonly checked: boolean;
  readonly queuedAt: number;
}

type Queue = Record<string, QueuedCheck>;

/** Validates every entry rather than trusting what is in localStorage. */
function readQueue(): Queue {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};

    const queue: Queue = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const entry = asQueuedCheck(value);
      if (entry !== null) queue[key] = entry;
    }
    return queue;
  } catch {
    // A private window, a full disk, a corrupted value: none of these are worth
    // breaking the screen over.
    return {};
  }
}

function asQueuedCheck(value: unknown): QueuedCheck | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.lineId !== "string" || row.lineId.length === 0) return null;
  if (typeof row.checked !== "boolean") return null;
  // An entry written before `queuedAt` existed, or with a broken one, is taken
  // as queued now: better one extra replay than an entry that never expires.
  const queuedAt =
    typeof row.queuedAt === "number" && Number.isFinite(row.queuedAt)
      ? row.queuedAt
      : Date.now();
  return { lineId: row.lineId, checked: row.checked, queuedAt };
}

function writeQueue(queue: Queue): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Nothing to do. The tick stays in memory for this session.
  }
}

/*
 * The queue as an external store, read through `useSyncExternalStore`.
 *
 * It is one thing per browser, not one per component, and localStorage is an
 * external system rather than React state, which is exactly what that hook is
 * for. The previous version held it in `useState` and seeded it with
 * `setQueue(readQueue())` inside a mount effect, which React's hooks lint now
 * reports and which paints a zero count for one frame on every load.
 *
 * The snapshot has to keep the same identity between reads or React re-renders
 * forever, so the parsed queue is cached here and replaced only on a write.
 * The server snapshot is a shared empty object for the same reason: there is no
 * localStorage on the server, and a fresh `{}` per render would loop.
 */
let cached: Queue | null = null;
const listeners = new Set<() => void>();
const SERVER_QUEUE: Queue = {};

function queueSnapshot(): Queue {
  cached ??= readQueue();
  return cached;
}

function serverQueueSnapshot(): Queue {
  return SERVER_QUEUE;
}

function storeQueue(next: Queue): void {
  cached = next;
  writeQueue(next);
  for (const listener of listeners) listener();
}

function subscribeQueue(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** The browser's own connection flag, read the same way. */
function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function onlineSnapshot(): boolean {
  return navigator.onLine;
}

/** Optimistic on the server: a page rendered offline is not a case that exists. */
function serverOnlineSnapshot(): boolean {
  return true;
}

/**
 * `queued` and `refused` are kept apart on purpose. A queued tick stays on
 * screen because it will be written; a refused one is rolled back because it
 * never will be.
 */
export type SubmitOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "queued" }
  // The server's own refusal travels back, so the screen can say what the rule
  // was instead of inventing a message for a failure it did not diagnose.
  | { readonly kind: "refused"; readonly error: RenderableError };

/** What a replay found out, for the screen to report. */
export interface FlushReport {
  /** Ticks the server refused. They are gone from the queue. */
  readonly refusals: readonly RenderableError[];
  /** Ticks dropped for being older than the queue's time to live. */
  readonly expired: number;
  /** True when at least one tick reached the server. */
  readonly sent: boolean;
}

export interface OfflineChecks {
  /** Number of ticks waiting to reach the server. */
  readonly pendingCount: number;
  /** What the browser last told us about the connection. */
  readonly online: boolean;
  /** Records a tick. Never rejects. */
  readonly submit: (lineId: string, checked: boolean) => Promise<SubmitOutcome>;
}

export function useOfflineChecks(
  send: (lineId: string, checked: boolean) => Promise<ActionResult<void>>,
  onReplay?: (report: FlushReport) => void,
): OfflineChecks {
  const queue = useSyncExternalStore(
    subscribeQueue,
    queueSnapshot,
    serverQueueSnapshot,
  );
  const online = useSyncExternalStore(
    subscribeOnline,
    onlineSnapshot,
    serverOnlineSnapshot,
  );

  /*
   * The action and the callback are recreated on every render of the caller,
   * and the replay effect must not restart because of that. Both are held in
   * refs, written from an effect rather than during render: a ref written
   * during render is a render with a side effect, which React's own lint rule
   * now reports, and which is wrong under a re-render that never commits.
   */
  const sendRef = useRef(send);
  const onReplayRef = useRef(onReplay);
  useEffect(() => {
    sendRef.current = send;
    onReplayRef.current = onReplay;
  }, [send, onReplay]);

  // One replay at a time. The mount flush and the `online` flush used to be
  // able to run together and send the same ids twice.
  const flushing = useRef(false);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;

    const refusals: RenderableError[] = [];
    let expired = 0;
    let sent = false;
    // Ids that must leave the queue: sent, refused, or too old to replay.
    const settled = new Set<string>();

    try {
      const pending = queueSnapshot();
      const now = Date.now();

      for (const [id, item] of Object.entries(pending)) {
        if (now - item.queuedAt > QUEUE_TTL_MS) {
          settled.add(id);
          expired += 1;
          continue;
        }

        try {
          const result = await sendRef.current(item.lineId, item.checked);
          settled.add(id);
          if (result.ok) {
            sent = true;
          } else {
            // Final: the server answered and said no. Replaying it would never
            // succeed, so it leaves the queue and the screen is told why.
            refusals.push({
              code: result.code,
              message: result.message,
              details: result.details,
            });
          }
        } catch (error) {
          if (isConnectionFailure(error)) {
            // Still offline. Keep everything that is left and try again later.
            // Nothing to set: `online` is read from the browser's own flag, and
            // the banner is driven by the pending count in any case.
            break;
          }
          // Not the connection: a bug or a server error. Dropping it is the
          // only way out of a loop that would otherwise never end, and it is
          // reported rather than swallowed.
          console.error("Grocery tick could not be replayed", error);
          settled.add(id);
          refusals.push({ code: "INTERNAL" });
        }
      }

      /*
       * Re-read rather than write back the snapshot: `submit` may have queued
       * a tick during one of the awaits above, and that tick is in the store
       * and not in `pending`. Only the ids actually settled are removed.
       */
      const latest = { ...queueSnapshot() };
      for (const id of settled) delete latest[id];
      storeQueue(latest);
    } finally {
      flushing.current = false;
    }

    if (refusals.length > 0 || expired > 0 || sent) {
      onReplayRef.current?.({ refusals, expired, sent });
    }
  }, []);

  /*
   * The replay, and only the replay. The connection flag and the queue are
   * both read through `useSyncExternalStore` above, so this effect subscribes
   * to nothing React needs to know about and sets no state of its own.
   */
  useEffect(() => {
    const goOnline = (): void => void flush();
    window.addEventListener("online", goOnline);
    // A queue can survive a full reload, so drain it on mount too.
    if (navigator.onLine) void flush();

    return () => window.removeEventListener("online", goOnline);
  }, [flush]);

  const submit = useCallback(
    async (lineId: string, checked: boolean): Promise<SubmitOutcome> => {
      try {
        const result = await sendRef.current(lineId, checked);
        // A refusal is the server answering, not the connection failing.
        if (result.ok) return { kind: "sent" };
        return {
          kind: "refused",
          error: {
            code: result.code,
            message: result.message,
            details: result.details,
          },
        };
      } catch (error) {
        if (!isConnectionFailure(error)) {
          // A bug, not a dead spot in the shop. Queuing it would replay a call
          // that fails the same way every time, so it is refused instead and
          // the checkbox goes back where the server has it.
          console.error("Grocery tick failed", error);
          return { kind: "refused", error: { code: "INTERNAL" } };
        }

        storeQueue({
          ...queueSnapshot(),
          [lineId]: { lineId, checked, queuedAt: Date.now() },
        });
        return { kind: "queued" };
      }
    },
    [],
  );

  return { pendingCount: Object.keys(queue).length, online, submit };
}

/**
 * Whether a thrown error means "the request did not arrive" as opposed to "the
 * server answered badly".
 *
 * There is no reliable error class for this: a server action that cannot reach
 * the server rejects with a `TypeError` from `fetch` in every current browser,
 * and the message differs per engine ("Failed to fetch", "Load failed",
 * "NetworkError when attempting to fetch resource"). The browser's own offline
 * flag is checked first because it is the only unambiguous signal, and the rest
 * is a best effort that errs towards *not* queueing: a tick wrongly refused is
 * visible and correctable, and a tick wrongly queued is invisible and forever.
 */
function isConnectionFailure(error: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    return /failed to fetch|load failed|networkerror|network request/i.test(
      error.message,
    );
  }
  return false;
}
