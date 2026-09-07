"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/app/actions/result";
import type { DomainWarning } from "@/domain/errors";
import type { RenderableError } from "@/lib/error-message";

/**
 * Calling a server action from a screen, once.
 *
 * Eleven call sites wrote `setPending(true)`, awaited the action, then
 * `setPending(false)` with no `try`/`finally`. This application is designed
 * around a bad connection, so a request that never answers is the expected
 * case, not the exotic one, and every one of those call sites left the whole
 * screen disabled forever and produced an unhandled rejection when it happened.
 * Six of them also carried a copy of the same `run()` helper, each typing the
 * callback as `{ ok: boolean; code?: string }` rather than `ActionResult`, which
 * is why they all needed a `?? "INTERNAL"` fallback for a field that is never
 * actually absent.
 *
 * So the `try`/`finally`, the error surfacing and the revalidation live here.
 *
 * `run` resolves rather than rejecting, always. It returns the `ActionResult`
 * when the server answered, so a caller can read `result.data`, and `undefined`
 * when the request itself failed or when the action redirected, so a caller can
 * tell "refused" from "never arrived" without catching anything.
 */
export interface ActionRunner {
  /** True while at least one action started by this runner is in flight. */
  readonly pending: boolean;
  /** The last refusal, ready to hand to `<Feedback error={...} />`. */
  readonly feedback: RenderableError | null;
  /** Warnings from the last successful write. Accepted, not refused. */
  readonly warnings: readonly DomainWarning[];
  readonly clear: () => void;
  readonly run: <T>(
    action: () => Promise<ActionResult<T>>,
    options?: {
      readonly onSuccess?: (data: T) => void;
      /** Re-read the server's version of the screen. Default true. */
      readonly refresh?: boolean;
    },
  ) => Promise<ActionResult<T> | undefined>;
}

export function useActionRunner(): ActionRunner {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<RenderableError | null>(null);
  const [warnings, setWarnings] = useState<readonly DomainWarning[]>([]);

  // A count rather than a boolean: two writes can overlap on the grocery and
  // week screens, and the first one to finish must not re-enable the buttons
  // while the second is still running.
  const inFlight = useRef(0);

  const clear = useCallback(() => {
    setFeedback(null);
    setWarnings([]);
  }, []);

  const run = useCallback(
    async <T>(
      action: () => Promise<ActionResult<T>>,
      options?: {
        readonly onSuccess?: (data: T) => void;
        readonly refresh?: boolean;
      },
    ): Promise<ActionResult<T> | undefined> => {
      inFlight.current += 1;
      setPending(true);

      try {
        /*
         * Typed as possibly absent because at runtime it is. A server action
         * that calls `redirect()` resolves with nothing: the router has already
         * navigated by the time this line runs, so there is no result to
         * report and nothing to render it on. `deleteAccountAction` is the one
         * that does this.
         */
        const result: ActionResult<T> | undefined = await action();
        if (result === undefined) return undefined;

        if (!result.ok) {
          setFeedback({
            code: result.code,
            message: result.message,
            details: result.details,
          });
          setWarnings([]);
          return result;
        }

        setFeedback(null);
        setWarnings(result.warnings);
        options?.onSuccess?.(result.data);
        // The server is the authority on what the screen now says, so unless
        // the caller is holding its own optimistic copy it re-reads.
        if (options?.refresh !== false) router.refresh();
        return result;
      } catch (error) {
        /*
         * The request did not complete: no signal, a dropped connection, a
         * server that died mid-flight. Distinct from a refusal, which arrives
         * as `ok: false` and says which rule fired. `NETWORK` is the code the
         * screen words as "the change was not sent, try again", because that is
         * the only true thing to say about it.
         */
        console.error("Server action did not complete", error);
        setFeedback({ code: "NETWORK" });
        setWarnings([]);
        return undefined;
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) setPending(false);
      }
    },
    [router],
  );

  return { pending, feedback, warnings, clear, run };
}
