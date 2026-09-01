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
    <div className="flex flex-col gap-2" aria-live="polite">
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm"
        >
          <p className="font-medium">{headingFor(errors, error.code)}</p>
          <p className="opacity-90">{errorMessage(error)}</p>
        </div>
      ) : null}

      {warnings.map((warning, index) => (
        <div
          key={`${warning.code}-${index}`}
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
        >
          <p className="font-medium">
            {headingFor(warningLabels, warning.code)}
          </p>
          <p className="opacity-90">{warningMessage(warning)}</p>
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
