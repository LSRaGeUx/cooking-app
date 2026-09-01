/**
 * The error taxonomy from docs/03-agent-interface.md section 6.
 *
 * These codes are product copy, not developer plumbing. Every message built
 * from them must be actionable by a model with no human in the loop: what was
 * rejected, why, and what the valid alternatives are. Compare
 * `SLOT_NOT_PLANNED: vendredi soir est configuré comme sauté` against
 * `400 invalid slot`. The first one gets fixed on retry.
 *
 * On language: `message` is the agent-facing string and is written in French,
 * the language of the app and of everything the agent reads about this user.
 * It is deliberately not a next-intl key, because it is consumed by a model
 * rather than rendered as UI copy. Screens render `code` plus `details`
 * through next-intl instead, so the two surfaces can word things differently
 * without either drifting from the rule.
 */
export const BLOCKING_CODES = [
  "STRICT_ALLERGEN",
  "SLOT_NOT_PLANNED",
  "SLOT_UNKNOWN",
  "RECIPE_NOT_FOUND",
  "TIME_BUDGET_EXCEEDED",
  "VERSION_CONFLICT",
  "PREP_LINK_ORDER",
  "MISSING_RATIONALE",
  "FACT_CAP_REACHED",
  "VALIDATION",
  "NOT_FOUND",
  "FORBIDDEN",
  // Added in phase 4, when the agent surface got real. Not in the original
  // taxonomy because nothing could be rate limited or revoked until then.
  "MISSING_SCOPE",
  "CLIENT_REVOKED",
  "RATE_LIMITED",
] as const;

export type BlockingCode = (typeof BLOCKING_CODES)[number];

export const WARNING_CODES = [
  "DIET_MISMATCH",
  "EXCLUDED_INGREDIENT",
  "EQUIPMENT_MISSING",
  "REPEAT_RECIPE_THIS_WEEK",
  "SERVINGS_SHORTFALL",
  "NOT_BATCH_FRIENDLY",
  "BUDGET_EXCEEDED",
  "TIME_BUDGET_TIGHT",
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

/**
 * `details` is returned verbatim to agents, so it must carry the corrective
 * information the message promises: the valid slots, the current version, the
 * ingredient that matched. It is never allowed to carry another user's data.
 */
export interface DomainErrorDetails {
  readonly [key: string]: unknown;
}

export class DomainError extends Error {
  readonly code: BlockingCode;
  readonly details: DomainErrorDetails;

  constructor(
    code: BlockingCode,
    message: string,
    details: DomainErrorDetails = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export interface DomainWarning {
  readonly code: WarningCode;
  readonly message: string;
  readonly details?: DomainErrorDetails;
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export function validationError(
  message: string,
  details: DomainErrorDetails = {},
): DomainError {
  return new DomainError("VALIDATION", message, details);
}
