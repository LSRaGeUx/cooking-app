"use client";

import { useTranslations } from "next-intl";
import type { DomainWarning } from "@/domain/errors";
import {
  useErrorMessage,
  useWarningMessage,
  type RenderableError,
} from "@/lib/error-message";

export interface FeedbackState {
  readonly error?: RenderableError | null;
  readonly warnings?: readonly DomainWarning[];
}

/**
 * How a refused write reaches the user.
 *
 * Both the heading and the sentence are built here from the code and the
 * details, so the screen speaks the reader's language while the service keeps
 * writing one French sentence for the agent. A code with no template falls back
 * to that sentence: see src/lib/error-message.ts for why that is the right
 * failure.
 */
export function Feedback({ error, warnings = [] }: FeedbackState) {
  const errors = useTranslations("errors");
  const warningLabels = useTranslations("warnings");
  const errorMessage = useErrorMessage();
  const warningMessage = useWarningMessage();

  if (!error && warnings.length === 0) return null;

  return (
    /*
     * No `aria-live` on the wrapper. It used to carry `aria-live="polite"`
     * around a child with `role="alert"`, which is itself an assertive live
     * region: two live modes on one announcement, and the outer one wins in
     * some screen readers, so a refused write could be read out politely, after
     * whatever the user was already hearing. The alert on the error and the
     * plain region on the warnings are the two behaviours actually wanted.
     */
    <div className="flex flex-col gap-2">
      {error ? (
        <div role="alert" className="banner banner-danger banner-block">
          <p className="font-medium text-danger-ink">
            {headingFor(errors, error.code)}
          </p>
          <p>{errorMessage(error)}</p>
        </div>
      ) : null}

      {warnings.map((warning, index) => (
        <div
          key={`${warning.code}-${index}`}
          aria-live="polite"
          className="banner banner-warn banner-block"
        >
          <p className="font-medium text-amber-ink">
            {headingFor(warningLabels, warning.code)}
          </p>
          <p>{warningMessage(warning)}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * An unknown code still shows its sentence rather than a blank heading: a rule
 * added tomorrow must not be able to render an empty banner.
 */
function headingFor(
  t: ReturnType<typeof useTranslations>,
  code: string,
): string {
  return t.has(code) ? t(code) : code;
}
