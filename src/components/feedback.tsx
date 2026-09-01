"use client";

import { useTranslations } from "next-intl";
import type { DomainWarning } from "@/domain/errors";

export interface FeedbackState {
  readonly error?: { code: string; message: string } | null;
  readonly warnings?: readonly DomainWarning[];
}

/**
 * How a refused write reaches the user.
 *
 * The heading is localized from the error code and the sentence comes from the
 * service layer, which already words it as a corrective instruction. Restating
 * the rule here would create a second place to keep it accurate.
 */
export function Feedback({ error, warnings = [] }: FeedbackState) {
  const errors = useTranslations("errors");
  const warningLabels = useTranslations("warnings");

  if (!error && warnings.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm"
        >
          <p className="font-medium">{headingFor(errors, error.code)}</p>
          <p className="opacity-90">{error.message}</p>
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
          <p className="opacity-90">{warning.message}</p>
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
