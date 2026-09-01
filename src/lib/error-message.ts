"use client";

import { useTranslations } from "next-intl";
import { errorMessageParams } from "@/domain/error-params";
import type { DomainWarning } from "@/domain/errors";

/**
 * Turning a refusal into a sentence the reader can act on, in their language.
 *
 * The service layer writes its message in French for the agent, because that is
 * the language of everything the agent reads about this user, and because a
 * model needs the whole rule in one string. A screen cannot show that string
 * once the interface is in English, and it cannot translate a sentence that
 * arrived pre-assembled either.
 *
 * So the screen rebuilds the sentence from `code` plus `details`, which is what
 * `src/domain/errors.ts` says details are for. There is one template per code,
 * not one per throw site: 64 throws share 15 codes, and a template per site
 * would be the second copy of every rule that the error taxonomy exists to
 * avoid.
 *
 * When a code has no template, or its details lack what the template needs, the
 * server sentence is shown as it stands. A French sentence in an English screen
 * is worse than an English one and better than a blank banner, and it is the
 * honest state for the handful of one-off validation messages.
 */

export interface RenderableError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown> | undefined;
}

export function useErrorMessage(): (error: RenderableError) => string {
  const t = useTranslations("errors.messages");
  const days = useTranslations("week.days");

  return (error) => {
    const params = errorMessageParams(error.code, error.details ?? {}, (day) =>
      days.has(String(day)) ? days(String(day)) : String(day),
    );
    if (params === null || !t.has(error.code)) return error.message;
    return t(error.code, params);
  };
}

export function useWarningMessage(): (warning: DomainWarning) => string {
  const t = useTranslations("warnings.messages");
  const days = useTranslations("week.days");

  return (warning) => {
    const params = errorMessageParams(
      warning.code,
      (warning.details ?? {}) as Record<string, unknown>,
      (day) => (days.has(String(day)) ? days(String(day)) : String(day)),
    );
    if (params === null || !t.has(warning.code)) return warning.message;
    return t(warning.code, params);
  };
}
