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
  // The account itself lost access to the instance. Distinct from
  // CLIENT_REVOKED on purpose: reconnecting the client fixes that one and does
  // nothing for this one, and an agent that cannot tell them apart will loop
  // through the authorization dance forever.
  "ACCESS_REVOKED",
  // The three below all used to be reported as VALIDATION, and that was the
  // defect: VALIDATION means "your arguments were wrong, fix them and retry",
  // so an agent reads it as an instruction to edit its own call. For a server
  // bug it edits a correct call forever; for a page with no recipe in it, it
  // rewrites a perfectly good URL; for a remote server that is down, it goes
  // looking for a typo in an address that was right.
  //
  // The server failed, the call did not. `details.retryable` says whether
  // sending the identical call again is worth anything.
  "INTERNAL",
  // The address was reachable and returned something, but no recipe could be
  // read out of it. The argument was fine, the page was not.
  "PARSE_FAILED",
  // The remote server refused or failed: a 5xx, a connection reset, a timeout.
  // Nothing about the request needs changing.
  "UPSTREAM_FAILED",
] as const;

export type BlockingCode = (typeof BLOCKING_CODES)[number];

/**
 * Two of these are declared and not yet emitted, and that is on purpose rather
 * than an oversight: `DIET_MISMATCH` and `BUDGET_EXCEEDED` are in the published
 * taxonomy (docs/03-agent-interface.md section 6), so an agent may already be
 * written to expect them, and removing them from the list would be a breaking
 * change to a documented interface for no gain.
 *
 * Nothing raises them because the two checks behind them do not exist yet.
 * Diet is stored as a preference and never compared against a recipe's
 * ingredients, and no price data enters the model, so there is nothing to
 * compare a weekly budget against. **Neither has a next-intl template, and
 * neither should get one until something emits it**: a template written against
 * guessed `details` renders a sentence with the wrong numbers in it, which is
 * worse than falling back to the server's own message. See the note at the
 * `default` branch of src/domain/error-params.ts.
 */
export const WARNING_CODES = [
  // Not emitted. See the note above before wiring a template for it.
  "DIET_MISMATCH",
  "EXCLUDED_INGREDIENT",
  "EQUIPMENT_MISSING",
  "REPEAT_RECIPE_THIS_WEEK",
  "SERVINGS_SHORTFALL",
  "NOT_BATCH_FRIENDLY",
  // Not emitted. See the note above before wiring a template for it.
  "BUDGET_EXCEEDED",
  "TIME_BUDGET_TIGHT",
  /**
   * A slot that still holds a meal has stopped being plannable, because it was
   * set to skipped or hidden after the meal was assigned.
   *
   * This used to be a blocking `SLOT_NOT_PLANNED` raised on every later edit of
   * the week, about a slot the caller had not touched, so changing Tuesday
   * failed because of something done to Saturday. The entry is carried forward
   * now and the week stays editable. The warning is what keeps that from being
   * silent: the meal is still there and the grid will not show it.
   */
  "SLOT_NO_LONGER_PLANNED",
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
