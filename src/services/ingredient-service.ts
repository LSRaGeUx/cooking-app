import { asc, eq } from "drizzle-orm";
import { ingredient } from "@/db/schema";
import { normalizeTerm, termMatches } from "@/domain/allergens";
import { inScope, type ServiceContext } from "./context";
import { STARTER_INGREDIENTS } from "./data/starter-ingredients";

/**
 * The normalized, per-user ingredient vocabulary. Grocery merging and allergen
 * derivation both read it, and neither works without it.
 *
 * Linking is best-effort by design: an unlinked ingredient still displays and
 * still cooks, it only loses merging. Blocking a recipe save until every line
 * resolves would make creation slow, and creation speed is what fills the
 * library.
 */

export interface IngredientMatch {
  readonly id: string;
  readonly canonicalName: string;
  /** `exact` on the canonical name or an alias, `contained` on a word match. */
  readonly kind: "exact" | "contained";
}

export async function listIngredients(ctx: ServiceContext) {
  return inScope(ctx, ({ tx }) =>
    tx
      .select()
      .from(ingredient)
      .where(eq(ingredient.userId, ctx.userId))
      .orderBy(asc(ingredient.canonicalName)),
  );
}

/**
 * One vocabulary entry with its names normalized once.
 *
 * The normalization is the whole reason this type exists. Matching used to
 * re-normalize every candidate name for every written name it was asked about,
 * and `termMatches` compiled a fresh RegExp per pair on top of that: a
 * hundred-line recipe against sixty starter ingredients, each carrying a few
 * aliases, ran into tens of thousands of regex constructions for one save. The
 * candidates are prepared once per read instead.
 */
interface PreparedCandidate {
  readonly id: string;
  readonly canonicalName: string;
  /** Canonical name first, then the aliases, each already normalized. */
  readonly normalizedNames: readonly string[];
  /** The names as written, which is what the contained match tests against. */
  readonly names: readonly string[];
  /**
   * The shortest form of each normalized name that a word-boundary match could
   * possibly find, used as a cheap prefilter before `termMatches` compiles a
   * pattern. See `termForms` in src/domain/allergens.ts: it varies a term by
   * stripping a trailing plural marker and nothing else, so every form it can
   * produce still contains the stem. If that rule ever widens, this prefilter
   * has to widen with it, or a link that should resolve will quietly stop
   * resolving.
   */
  readonly stems: readonly string[];
}

/** The stem `termForms` can strip a term down to. */
function stemOf(normalized: string): string {
  return normalized.length <= 3 ? normalized : normalized.replace(/[sx]$/, "");
}

function prepareCandidates(
  rows: ReadonlyArray<{
    id: string;
    canonicalName: string;
    aliases: readonly string[];
  }>,
): PreparedCandidate[] {
  return rows.map((row) => {
    const names = [row.canonicalName, ...row.aliases];
    const normalizedNames = names.map(normalizeTerm);
    return {
      id: row.id,
      canonicalName: row.canonicalName,
      names,
      normalizedNames,
      stems: normalizedNames.map(stemOf),
    };
  });
}

/**
 * Best-effort resolution of one written ingredient name.
 *
 * Exact matches on the canonical name or an alias win outright. Failing that,
 * the longest canonical name that appears as a whole word inside the written
 * text wins, so "filet de saumon fumé" resolves to "Saumon" rather than to
 * whichever row happened to be read first. Word-boundary matching is what keeps
 * "Lait" from claiming "laitue".
 */
function matchPrepared(
  rawName: string,
  candidates: readonly PreparedCandidate[],
): IngredientMatch | null {
  const normalized = normalizeTerm(rawName);
  if (!normalized) return null;

  for (const candidate of candidates) {
    if (candidate.normalizedNames.includes(normalized)) {
      return {
        id: candidate.id,
        canonicalName: candidate.canonicalName,
        kind: "exact",
      };
    }
  }

  let best: { candidate: PreparedCandidate; length: number } | null = null;

  for (const candidate of candidates) {
    for (const [index, name] of candidate.names.entries()) {
      const stem = candidate.stems[index];
      // The prefilter. A name whose stem does not appear anywhere in the
      // written text cannot match on a word boundary either, and skipping it
      // here is what keeps the regex compilation off the hot path.
      if (stem === undefined || stem.length === 0) continue;
      if (!normalized.includes(stem)) continue;
      const length = candidate.normalizedNames[index]?.length ?? 0;
      // Nothing longer can be found later in this pass, so a candidate that
      // cannot win is not tested at all.
      if (best && length <= best.length) continue;
      if (!termMatches(name, rawName)) continue;
      best = { candidate, length };
    }
  }

  return best
    ? {
        id: best.candidate.id,
        canonicalName: best.candidate.canonicalName,
        kind: "contained",
      }
    : null;
}

/** Resolves many names against the user's vocabulary in one read. */
export async function linkIngredientNames(
  ctx: ServiceContext,
  rawNames: readonly string[],
): Promise<Map<string, IngredientMatch>> {
  if (rawNames.length === 0) return new Map();

  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .select({
        id: ingredient.id,
        canonicalName: ingredient.canonicalName,
        aliases: ingredient.aliases,
      })
      .from(ingredient)
      .where(eq(ingredient.userId, ctx.userId));

    const candidates = prepareCandidates(rows);

    const resolved = new Map<string, IngredientMatch>();
    for (const rawName of rawNames) {
      // The same written name can appear twice in one recipe, and the answer
      // cannot change between the two.
      if (resolved.has(rawName)) continue;
      const match = matchPrepared(rawName, candidates);
      if (match) resolved.set(rawName, match);
    }
    return resolved;
  });
}

/**
 * The ids of this user's vocabulary entries.
 *
 * It exists because a caller may name an `ingredientId` explicitly, and a
 * foreign key is not a tenancy check: foreign key checks run as the table owner
 * and bypass row-level security, so an insert naming another tenant's uuid
 * succeeded or failed depending on whether that uuid happened to exist. That is
 * an existence oracle, and the row it produced was invisible to every join that
 * scopes by user. The recipe service checks against this set first.
 */
export async function ownedIngredientIds(
  ctx: ServiceContext,
): Promise<Set<string>> {
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .select({ id: ingredient.id })
      .from(ingredient)
      .where(eq(ingredient.userId, ctx.userId));
    return new Set(rows.map((row) => row.id));
  });
}

export async function seedStarterIngredients(ctx: ServiceContext) {
  return inScope(ctx, async ({ tx }) => {
    const existing = await tx
      .select({ id: ingredient.id })
      .from(ingredient)
      .where(eq(ingredient.userId, ctx.userId))
      .limit(1);
    if (existing[0]) return 0;

    const inserted = await tx
      .insert(ingredient)
      .values(
        STARTER_INGREDIENTS.map((item) => ({
          userId: ctx.userId,
          canonicalName: item.canonicalName,
          aliases: [...item.aliases],
          category: item.category,
          aisle: item.aisle,
          defaultUnit: item.defaultUnit ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: ingredient.id });

    return inserted.length;
  });
}
