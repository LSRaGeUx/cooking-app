import { ZodError } from "zod";
import {
  isDomainError,
  type DomainErrorDetails,
  type DomainWarning,
} from "@/domain/errors";

/**
 * The single shape a server action ever returns. Actions never throw at the
 * client: a refused write is a normal outcome of a rule doing its job, and the
 * screen has to render it.
 *
 * `message` comes from the service layer, which writes it in French and makes
 * it actionable ("choisissez une recette plus rapide, ou augmentez le budget de
 * ce créneau"). The UI adds a localized heading keyed by `code` rather than
 * restating the rule, so there is one place where each rule is worded.
 *
 * The two failures this file raises itself carry no message at all. They are
 * not rules and have no French sentence to pass on: a Zod failure is worded on
 * the screen from `code` plus the failing field, and an unexpected throw is
 * worded from `common.unknownError`. Writing either sentence here would put UI
 * copy in a server action, in one language, outside next-intl.
 */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T; readonly warnings: DomainWarning[] }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message?: string;
      readonly details?: DomainErrorDetails;
    };

interface WithWarnings {
  readonly warnings?: DomainWarning[];
}

export async function runAction<T>(
  fn: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    const warnings =
      data !== null &&
      typeof data === "object" &&
      Array.isArray((data as WithWarnings).warnings)
        ? ((data as WithWarnings).warnings ?? [])
        : [];
    return { ok: true, data, warnings };
  } catch (error) {
    if (isDomainError(error)) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details,
      };
    }

    if (error instanceof ZodError) {
      const first = error.issues[0];
      return {
        ok: false,
        code: "VALIDATION",
        // The dotted path, not a sentence: Zod's own message is English and
        // untranslatable, and the screen only needs to know which field.
        details: {
          ...(first && first.path.length > 0
            ? { field: first.path.join(".") }
            : {}),
          issues: error.issues,
        },
      };
    }

    // Anything else is a bug rather than a rule. Log it server-side and let the
    // screen say so in the reader's language.
    console.error("Unhandled action failure", error);
    return { ok: false, code: "INTERNAL" };
  }
}
