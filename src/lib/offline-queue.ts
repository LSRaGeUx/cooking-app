"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
 */

const STORAGE_KEY = "cooking-app.grocery-queue.v1";

interface QueuedCheck {
  readonly lineId: string;
  readonly checked: boolean;
  readonly queuedAt: number;
}

type Queue = Record<string, QueuedCheck>;

function readQueue(): Queue {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Queue;
  } catch {
    // A private window, a full disk, a corrupted value: none of these are worth
    // breaking the screen over.
    return {};
  }
}

function writeQueue(queue: Queue): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Nothing to do. The tick stays in memory for this session.
  }
}

/**
 * `queued` and `refused` are kept apart on purpose. A queued tick stays on
 * screen because it will be written; a refused one is rolled back because it
 * never will be.
 */
export type SubmitOutcome = "sent" | "queued" | "refused";

export interface OfflineChecks {
  /** Number of ticks waiting to reach the server. */
  readonly pendingCount: number;
  /** What the browser last told us about the connection. */
  readonly online: boolean;
  /** Records a tick. Never rejects. */
  readonly submit: (lineId: string, checked: boolean) => Promise<SubmitOutcome>;
}

export function useOfflineChecks(
  send: (lineId: string, checked: boolean) => Promise<{ ok: boolean }>,
): OfflineChecks {
  const [queue, setQueue] = useState<Queue>({});
  const [online, setOnline] = useState(true);
  // The action is recreated on every render of the caller; the replay effect
  // must not restart because of that.
  const sendRef = useRef(send);
  sendRef.current = send;

  const flush = useCallback(async () => {
    const current = readQueue();
    const ids = Object.keys(current);
    if (ids.length === 0) return;

    for (const id of ids) {
      const item = current[id];
      if (!item) continue;
      try {
        const result = await sendRef.current(item.lineId, item.checked);
        // A refusal from the server is final: replaying it forever would never
        // succeed, so the entry is dropped and the screen reloads the truth.
        delete current[id];
        if (!result.ok) continue;
      } catch {
        // Still offline. Keep everything that is left and try again later.
        break;
      }
    }

    writeQueue(current);
    setQueue(current);
  }, []);

  useEffect(() => {
    setQueue(readQueue());
    setOnline(navigator.onLine);

    const goOnline = (): void => {
      setOnline(true);
      void flush();
    };
    const goOffline = (): void => setOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    // A queue can survive a full reload, so drain it on mount too.
    if (navigator.onLine) void flush();

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [flush]);

  const submit = useCallback(
    async (lineId: string, checked: boolean): Promise<SubmitOutcome> => {
      try {
        const result = await sendRef.current(lineId, checked);
        // A refusal is the server answering, not the connection failing.
        return result.ok ? "sent" : "refused";
      } catch {
        const next = {
          ...readQueue(),
          [lineId]: { lineId, checked, queuedAt: Date.now() },
        };
        writeQueue(next);
        setQueue(next);
        setOnline(false);
        return "queued";
      }
    },
    [],
  );

  return { pendingCount: Object.keys(queue).length, online, submit };
}
