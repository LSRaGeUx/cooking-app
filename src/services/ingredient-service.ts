import { asc, eq } from "drizzle-orm";
import { ingredient } from "@/db/schema";
import { normalizeTerm, termMatches } from "@/domain/allergens";
import { DomainError } from "@/domain/errors";
import { ingredientInputSchema } from "@/domain/schemas";
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
  return inScope(ctx, (tx) =>
    tx
      .select()
      .from(ingredient)
      .where(eq(ingredient.userId, ctx.userId))
      .orderBy(asc(ingredient.canonicalName)),
  );
}

export async function createIngredient(ctx: ServiceContext, input: unknown) {
  const parsed = ingredientInputSchema.parse(input);
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .insert(ingredient)
      .values({ ...parsed, userId: ctx.userId })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return rows[0];

    const existing = await tx
      .select()
      .from(ingredient)
      .where(eq(ingredient.canonicalName, parsed.canonicalName))
      .limit(1);
    if (!existing[0]) {
      throw new DomainError(
        "VALIDATION",
        `L'ingrédient « ${parsed.canonicalName} » n'a pas pu être créé.`,
      );
    }
    return existing[0];
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
export function matchIngredient(
  rawName: string,
  candidates: ReadonlyArray<{
    id: string;
    canonicalName: string;
    aliases: readonly string[];
  }>,
): IngredientMatch | null {
  const normalized = normalizeTerm(rawName);
  if (!normalized) return null;

  for (const candidate of candidates) {
    const names = [candidate.canonicalName, ...candidate.aliases];
    if (names.some((name) => normalizeTerm(name) === normalized)) {
      return {
        id: candidate.id,
        canonicalName: candidate.canonicalName,
        kind: "exact",
      };
    }
  }

  let best: { candidate: (typeof candidates)[number]; length: number } | null =
    null;

  for (const candidate of candidates) {
    const names = [candidate.canonicalName, ...candidate.aliases];
    for (const name of names) {
      if (!termMatches(name, rawName)) continue;
      const length = normalizeTerm(name).length;
      if (!best || length > best.length) best = { candidate, length };
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

  return inScope(ctx, async (tx) => {
    const candidates = await tx
      .select({
        id: ingredient.id,
        canonicalName: ingredient.canonicalName,
        aliases: ingredient.aliases,
      })
      .from(ingredient)
      .where(eq(ingredient.userId, ctx.userId));

    const resolved = new Map<string, IngredientMatch>();
    for (const rawName of rawNames) {
      const match = matchIngredient(rawName, candidates);
      if (match) resolved.set(rawName, match);
    }
    return resolved;
  });
}

export async function seedStarterIngredients(ctx: ServiceContext) {
  return inScope(ctx, async (tx) => {
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
