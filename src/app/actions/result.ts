import { ZodError } from "zod";
import { isDomainError, type DomainWarning } from "@/domain/errors";

/**
 * The single shape a server action ever returns. Actions never throw at the
 * client: a refused write is a normal outcome of a rule doing its job, and the
 * screen has to render it.
 *
 * `message` comes from the service layer, which writes it in French and makes
 * it actionable ("choisissez une recette plus rapide, ou augmentez le budget de
 * ce créneau"). The UI adds a localized heading keyed by `code` rather than
 * restating the rule, so there is one place where each rule is worded.
 */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T; readonly warnings: DomainWarning[] }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

export interface WithWarnings {
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
        ? ((data as WithWarnings).warnings as DomainWarning[])
        : [];
    return { ok: true, data, warnings };
  } catch (error) {
    if (isDomainError(error)) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details as Record<string, unknown>,
      };
    }

    if (error instanceof ZodError) {
      const first = error.issues[0];
      return {
        ok: false,
        code: "VALIDATION",
        message: first
          ? `${first.path.join(".") || "valeur"} : ${first.message}`
          : "Donnée invalide.",
        details: { issues: error.issues },
      };
    }

    // Anything else is a bug rather than a rule. Log it server-side and give
    // the screen something honest to show.
    console.error("Unhandled action failure", error);
    return {
      ok: false,
      code: "INTERNAL",
      message: "Une erreur inattendue est survenue. Réessayez.",
    };
  }
}
