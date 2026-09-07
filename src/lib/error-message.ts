"use client";

import { useTranslations } from "next-intl";
import { errorMessageParams } from "@/domain/error-params";
import type { DomainErrorDetails, DomainWarning } from "@/domain/errors";

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
 *
 * Two codes never carry a server sentence at all, so they are worded here:
 * `VALIDATION`, which the action boundary raises from a Zod failure and which
 * used to carry a hardcoded French sentence, and `NETWORK`, which no server
 * ever sends because it means the request did not arrive. `message` is
 * therefore optional, and an error with neither a template nor a sentence falls
 * back to `common.unknownError` rather than rendering an empty paragraph.
 */

export interface RenderableError {
  readonly code: string;
  /** The service's own sentence, when there is one. */
  readonly message?: string | undefined;
  readonly details?: DomainErrorDetails | undefined;
}

/**
 * Codes no service ever words, so the screen words them, and whose templates
 * take no parameters. `errorMessageParams` returns null for all three:
 * VALIDATION is thrown from too many places for one general template to be
 * honest, and the other two are not domain codes at all. Listed explicitly
 * rather than inferred, because next-intl cannot render a template whose
 * placeholders it was given nothing for.
 */
const CLIENT_WORDED: ReadonlySet<string> = new Set([
  "VALIDATION",
  "NETWORK",
  "DELETE_CONFIRMATION",
]);

export function useErrorMessage(): (error: RenderableError) => string {
  const t = useTranslations("errors.messages");
  const common = useTranslations("common");
  const days = useTranslations("week.days");

  return (error) => {
    const params = errorMessageParams(error.code, error.details ?? {}, (day) =>
      days.has(String(day)) ? days(String(day)) : String(day),
    );
    if (params !== null && t.has(error.code)) return t(error.code, params);

    // A field-level Zod failure. The action sends the dotted path and no
    // sentence, because Zod's own message is English and untranslatable.
    if (error.code === "VALIDATION") {
      const field = fieldOf(error.details);
      if (field !== null) return t("VALIDATION_FIELD", { field });
    }

    if (CLIENT_WORDED.has(error.code)) return t(error.code);

    if (error.message !== undefined && error.message.length > 0) {
      return error.message;
    }
    return common("unknownError");
  };
}

/** The dotted path of the first failing field, when the details carry one. */
function fieldOf(details: DomainErrorDetails | undefined): string | null {
  const field = details?.["field"];
  return typeof field === "string" && field.length > 0 ? field : null;
}

export function useWarningMessage(): (warning: DomainWarning) => string {
  const t = useTranslations("warnings.messages");
  const days = useTranslations("week.days");

  return (warning) => {
    const params = errorMessageParams(
      warning.code,
      warning.details ?? {},
      (day) => (days.has(String(day)) ? days(String(day)) : String(day)),
    );
    if (params === null || !t.has(warning.code)) return warning.message;
    return t(warning.code, params);
  };
}
