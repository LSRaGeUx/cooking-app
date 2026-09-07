import { and, arrayOverlaps, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  ingredient,
  recipe,
  recipeIngredient,
  recipeRevision,
  recipeStep,
} from "@/db/schema";
import { findAllergenHits, type IngredientText } from "@/domain/allergens";
import { DomainError } from "@/domain/errors";
import {
  recipeInputSchema,
  recipeSearchSchema,
  type RecipeInput,
} from "@/domain/schemas";
import type { RecipeSource } from "@/domain/vocabulary";
import { isoWeekOf, shiftIsoWeek, weeksBetween } from "@/domain/week";
import { inScope, type ServiceContext } from "./context";
import { linkIngredientNames } from "./ingredient-service";
import { listAllergens } from "./profile-service";

/**
 * Recipes: create, edit, read, search, soft delete.
 *
 * Two rules shape this file. Edits keep a revision, because an agent-driven
 * edit has to be reversible. And deletes are soft, because past plan entries
 * reference the recipe and history has to stay readable.
 */

/** Everything but the generated search vector, which is never read directly. */
const recipeColumns = {
  id: recipe.id,
  userId: recipe.userId,
  title: recipe.title,
  description: recipe.description,
  imageUrl: recipe.imageUrl,
  source: recipe.source,
  sourceUrl: recipe.sourceUrl,
  sourceClientId: recipe.sourceClientId,
  servings: recipe.servings,
  prepTimeMin: recipe.prepTimeMin,
  cookTimeMin: recipe.cookTimeMin,
  activeTimeMin: recipe.activeTimeMin,
  batchFriendly: recipe.batchFriendly,
  keepsDays: recipe.keepsDays,
  tags: recipe.tags,
  cuisine: recipe.cuisine,
  mainProtein: recipe.mainProtein,
  difficulty: recipe.difficulty,
  equipmentKeys: recipe.equipmentKeys,
  allergenIds: recipe.allergenIds,
  revision: recipe.revision,
  createdAt: recipe.createdAt,
  updatedAt: recipe.updatedAt,
  deletedAt: recipe.deletedAt,
} as const;

export type RecipeRow = {
  [K in keyof typeof recipeColumns]: (typeof recipe.$inferSelect)[K];
};

export interface RecipeIngredientRow {
  readonly id: string;
  readonly position: number;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly rawName: string;
  readonly note: string | null;
  readonly optional: boolean;
  readonly ingredientId: string | null;
  readonly canonicalName: string | null;
  readonly aliases: readonly string[] | null;
  readonly aisle: string | null;
}

export interface RecipeStepRow {
  readonly id: string;
  readonly position: number;
  readonly text: string;
  readonly durationMin: number | null;
  readonly unattended: boolean;
}

export interface RecipeDetail {
  readonly recipe: RecipeRow;
  readonly ingredients: RecipeIngredientRow[];
  readonly steps: RecipeStepRow[];
}

export async function createRecipe(
  ctx: ServiceContext,
  input: unknown,
  options: { source?: RecipeSource; sourceUrl?: string | null } = {},
): Promise<RecipeDetail> {
  const parsed = recipeInputSchema.parse(input);
  const source: RecipeSource =
    options.source ?? (ctx.actor === "agent" ? "agent" : "manual");

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const links = await linkIngredientNames(
      scoped,
      parsed.ingredients.map((line) => line.rawName),
    );

    const inserted = await tx
      .insert(recipe)
      .values({
        userId: ctx.userId,
        title: parsed.title,
        description: parsed.description,
        imageUrl: parsed.imageUrl,
        source,
        sourceUrl: options.sourceUrl ?? null,
        sourceClientId: ctx.actor === "agent" ? (ctx.clientId ?? null) : null,
        servings: parsed.servings,
        prepTimeMin: parsed.prepTimeMin,
        cookTimeMin: parsed.cookTimeMin,
        activeTimeMin: parsed.activeTimeMin,
        batchFriendly: parsed.batchFriendly,
        keepsDays: parsed.keepsDays,
        tags: parsed.tags,
        cuisine: parsed.cuisine,
        mainProtein: parsed.mainProtein,
        difficulty: parsed.difficulty,
        equipmentKeys: parsed.equipmentKeys,
      })
      .returning({ id: recipe.id });

    const recipeId = inserted[0]!.id;
    await writeChildren(tx, ctx, recipeId, parsed, links);
    await refreshDerivedAllergens(scoped, recipeId);

    return loadRecipe(scoped, recipeId);
  });
}

/**
 * Every edit snapshots the previous state into recipe_revision and bumps
 * `revision`, so a plan entry that recorded revision 3 can still be explained
 * after the recipe moved on.
 */
export async function updateRecipe(
  ctx: ServiceContext,
  recipeId: string,
  input: unknown,
): Promise<RecipeDetail> {
  const parsed = recipeInputSchema.parse(input);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const before = await loadRecipe(scoped, recipeId);

    await tx.insert(recipeRevision).values({
      userId: ctx.userId,
      recipeId,
      revision: before.recipe.revision,
      snapshot: before,
    });

    await tx
      .update(recipe)
      .set({
        title: parsed.title,
        description: parsed.description,
        imageUrl: parsed.imageUrl,
        servings: parsed.servings,
        prepTimeMin: parsed.prepTimeMin,
        cookTimeMin: parsed.cookTimeMin,
        activeTimeMin: parsed.activeTimeMin,
        batchFriendly: parsed.batchFriendly,
        keepsDays: parsed.keepsDays,
        tags: parsed.tags,
        cuisine: parsed.cuisine,
        mainProtein: parsed.mainProtein,
        difficulty: parsed.difficulty,
        equipmentKeys: parsed.equipmentKeys,
        revision: before.recipe.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(recipe.id, recipeId));

    await tx
      .delete(recipeIngredient)
      .where(eq(recipeIngredient.recipeId, recipeId));
    await tx.delete(recipeStep).where(eq(recipeStep.recipeId, recipeId));

    const links = await linkIngredientNames(
      scoped,
      parsed.ingredients.map((line) => line.rawName),
    );
    await writeChildren(tx, ctx, recipeId, parsed, links);
    await refreshDerivedAllergens(scoped, recipeId);

    return loadRecipe(scoped, recipeId);
  });
}

/** Soft delete, with a 30-day window before the purge job takes it. */
export async function softDeleteRecipe(
  ctx: ServiceContext,
  recipeId: string,
): Promise<void> {
  await inScope(ctx, async (tx) => {
    const rows = await tx
      .update(recipe)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(recipe.id, recipeId), isNull(recipe.deletedAt)))
      .returning({ id: recipe.id });
    if (!rows[0]) {
      throw new DomainError(
        "RECIPE_NOT_FOUND",
        "Cette recette n'existe pas ou a déjà été supprimée.",
        { recipeId },
      );
    }
  });
}

export async function restoreRecipe(
  ctx: ServiceContext,
  recipeId: string,
): Promise<void> {
  await inScope(ctx, async (tx) => {
    await tx
      .update(recipe)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(recipe.id, recipeId));
  });
}

export async function getRecipe(
  ctx: ServiceContext,
  recipeId: string,
): Promise<RecipeDetail> {
  return inScope(ctx, (tx) => loadRecipe({ ...ctx, tx }, recipeId));
}

export interface RecipeSearchResult {
  readonly recipes: RecipeRow[];
  readonly total: number;
}

/**
 * Full-text search on the generated French vector, with a title fallback so a
 * partial word still finds something while the user is typing.
 */
export async function searchRecipes(
  ctx: ServiceContext,
  input: unknown = {},
): Promise<RecipeSearchResult> {
  const search = recipeSearchSchema.parse(input);

  return inScope(ctx, async (tx) => {
    const conditions = [eq(recipe.userId, ctx.userId), isNull(recipe.deletedAt)];

    if (search.query && search.query.trim().length > 0) {
      const query = search.query.trim();
      const textMatch = or(
        sql`${recipe.searchVector} @@ websearch_to_tsquery('french', ${query})`,
        sql`${recipe.title} ilike ${`%${query}%`}`,
      );
      if (textMatch) conditions.push(textMatch);
    }

    if (search.tags && search.tags.length > 0) {
      conditions.push(arrayOverlaps(recipe.tags, search.tags));
    }

    if (search.mainProtein) {
      conditions.push(eq(recipe.mainProtein, search.mainProtein));
    }

    if (search.batchFriendly !== undefined) {
      conditions.push(eq(recipe.batchFriendly, search.batchFriendly));
    }

    if (search.notPlannedInWeeks !== undefined) {
      // Weeks are compared as year*100 + week, which orders correctly across a
      // year boundary and across a 53-week year, unlike a bare week number.
      const cutoff = shiftIsoWeek(
        isoWeekOf(new Date()),
        -(search.notPlannedInWeeks - 1),
      );
      const cutoffKey = cutoff.year * 100 + cutoff.week;
      conditions.push(sql`not exists (
        select 1 from plan_entry pe
        join plan_version pv on pv.id = pe.plan_version_id
        join plan p on p.id = pv.plan_id
        where pe.recipe_id = ${recipe.id}
          and pv.state = 'active'
          and (p.iso_year * 100 + p.iso_week) >= ${cutoffKey}
      )`);
    }

    if (search.notCookedInWeeks !== undefined) {
      const cutoff = shiftIsoWeek(
        isoWeekOf(new Date()),
        -(search.notCookedInWeeks - 1),
      );
      const cutoffKey = cutoff.year * 100 + cutoff.week;
      // A recipe never cooked passes: "not cooked in six weeks" is true of a
      // dish nobody has ever made.
      conditions.push(sql`not exists (
        select 1 from plan_entry pe
        join plan_version pv on pv.id = pe.plan_version_id
        join plan p on p.id = pv.plan_id
        join entry_feedback f on f.plan_entry_id = pe.id
        where pe.recipe_id = ${recipe.id}
          and pv.state = 'active'
          and f.outcome = 'cooked'
          and (p.iso_year * 100 + p.iso_week) >= ${cutoffKey}
      )`);
    }

    if (search.minRating !== undefined) {
      // Never rated is excluded rather than treated as neutral: an absent
      // rating is not a good one.
      conditions.push(sql`coalesce((
        select avg(f.rating)
        from plan_entry pe
        join entry_feedback f on f.plan_entry_id = pe.id
        where pe.recipe_id = ${recipe.id} and f.rating is not null
      ), -1) >= ${search.minRating}`);
    }

    if (search.maxActiveTimeMin !== undefined) {
      // The same fallback the time budget rule uses: attended time when it is
      // recorded, prep plus cook when it is not.
      conditions.push(
        sql`coalesce(${recipe.activeTimeMin}, coalesce(${recipe.prepTimeMin}, 0) + coalesce(${recipe.cookTimeMin}, 0)) <= ${search.maxActiveTimeMin}`,
      );
    }

    const where = and(...conditions);

    const rows = await tx
      .select(recipeColumns)
      .from(recipe)
      .where(where)
      .orderBy(desc(recipe.updatedAt))
      .limit(search.limit)
      .offset(search.offset);

    const counted = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(recipe)
      .where(where);

    return { recipes: rows, total: counted[0]?.total ?? 0 };
  });
}

export interface RecipeSummary {
  readonly id: string;
  readonly title: string;
  readonly servings: number;
  readonly activeTimeMin: number | null;
  /** Whether it doubles and keeps, which decides if it can feed other meals. */
  readonly batchFriendly: boolean;
}

export interface RecipeIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly servings: number;
  readonly activeTimeMin: number | null;
  readonly tags: string[];
  readonly mainProtein: string | null;
  readonly cuisine: string | null;
  readonly batchFriendly: boolean;
  /** How many active plan versions have ever carried this recipe. */
  readonly timesPlanned: number;
  readonly timesCooked: number;
  readonly averageRating: number | null;
  /** Weeks since it was actually cooked, from recorded feedback. */
  readonly weeksSinceLastCooked: number | null;
  /**
   * Weeks since this recipe last appeared in an active plan. Null when it has
   * never been planned. Deliberately not called "rotation age": until feedback
   * exists in phase 6 we know what was planned, not what was cooked.
   */
  readonly weeksSinceLastPlanned: number | null;
}

/**
 * The compact index an agent surveys before deciding what to fetch in full.
 *
 * Compactness is the point: a 200-recipe library has to be readable in a few
 * hundred tokens, or the agent burns its context on the catalogue instead of
 * the plan.
 */
export async function loadRecipeIndex(
  ctx: ServiceContext,
  now: Date = new Date(),
): Promise<RecipeIndexEntry[]> {
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: recipe.id,
        title: recipe.title,
        servings: recipe.servings,
        activeTimeMin: recipe.activeTimeMin,
        prepTimeMin: recipe.prepTimeMin,
        cookTimeMin: recipe.cookTimeMin,
        tags: recipe.tags,
        mainProtein: recipe.mainProtein,
        cuisine: recipe.cuisine,
        batchFriendly: recipe.batchFriendly,
      })
      .from(recipe)
      .where(and(eq(recipe.userId, ctx.userId), isNull(recipe.deletedAt)))
      .orderBy(asc(recipe.title));

    // Only active versions count. A superseded version is a plan that was
    // replaced, so counting it would say a recipe was planned when it was not.
    const planned = await tx.execute<{
      recipe_id: string;
      times_planned: number;
      times_cooked: number;
      average_rating: string | null;
      last_key: number | null;
      last_cooked_key: number | null;
    }>(sql`
      select pe.recipe_id,
             count(*)::int as times_planned,
             count(*) filter (where f.outcome = 'cooked')::int as times_cooked,
             avg(f.rating) filter (where f.rating is not null) as average_rating,
             max(p.iso_year * 100 + p.iso_week) as last_key,
             max(p.iso_year * 100 + p.iso_week)
               filter (where f.outcome = 'cooked') as last_cooked_key
      from plan_entry pe
      join plan_version pv on pv.id = pe.plan_version_id
      join plan p on p.id = pv.plan_id
      left join entry_feedback f on f.plan_entry_id = pe.id
      where pe.user_id = ${ctx.userId}
        and pv.state = 'active'
        and pe.recipe_id is not null
      group by pe.recipe_id
    `);

    const history = new Map(
      planned.rows.map((row) => [
        row.recipe_id,
        {
          timesPlanned: row.times_planned,
          timesCooked: row.times_cooked,
          averageRating:
            row.average_rating === null ? null : Number(row.average_rating),
          lastKey: row.last_key,
          lastCookedKey: row.last_cooked_key,
        },
      ]),
    );
    const thisWeek = isoWeekOf(now);

    return rows.map((row) => {
      const seen = history.get(row.id);
      const lastKey = seen?.lastKey ?? null;
      return {
        id: row.id,
        title: row.title,
        servings: row.servings,
        activeTimeMin:
          row.activeTimeMin ??
          (row.prepTimeMin === null && row.cookTimeMin === null
            ? null
            : (row.prepTimeMin ?? 0) + (row.cookTimeMin ?? 0)),
        tags: row.tags,
        mainProtein: row.mainProtein,
        cuisine: row.cuisine,
        batchFriendly: row.batchFriendly,
        timesPlanned: seen?.timesPlanned ?? 0,
        timesCooked: seen?.timesCooked ?? 0,
        averageRating: seen?.averageRating ?? null,
        weeksSinceLastPlanned: weeksSince(lastKey, thisWeek),
        weeksSinceLastCooked: weeksSince(seen?.lastCookedKey ?? null, thisWeek),
      };
    });
  });
}

/** Weeks from a stored `year * 100 + week` key to now, or null if never. */
function weeksSince(
  key: number | null,
  thisWeek: { year: number; week: number },
): number | null {
  if (key === null) return null;
  return weeksBetween(
    { year: Math.floor(key / 100), week: key % 100 },
    thisWeek,
  );
}

export interface RecipeBasketLine {
  readonly ingredientId: string | null;
  /** The name as written in the recipe. */
  readonly rawName: string;
  /**
   * The linked ingredient's canonical name. The grocery list needs it next to
   * the raw name to tell the ingredient itself from a narrower product that
   * merely resolved to it.
   */
  readonly canonicalName: string | null;
  readonly aisle: string | null;
  readonly densityGPerMl: number | null;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly optional: boolean;
}

export interface RecipeBasket {
  readonly recipeId: string;
  /** The servings the quantities below are written for. */
  readonly servings: number;
  readonly lines: RecipeBasketLine[];
}

/**
 * What the grocery list needs from a recipe: the servings its quantities are
 * written for, and every ingredient with whatever the linked record knows about
 * aisle and density.
 */
export async function loadRecipeBaskets(
  ctx: ServiceContext,
  recipeIds: readonly string[],
): Promise<Map<string, RecipeBasket>> {
  if (recipeIds.length === 0) return new Map();

  return inScope(ctx, async (tx) => {
    const recipes = await tx
      .select({ id: recipe.id, servings: recipe.servings })
      .from(recipe)
      .where(
        and(eq(recipe.userId, ctx.userId), inArray(recipe.id, [...recipeIds])),
      );

    const lines = await tx
      .select({
        recipeId: recipeIngredient.recipeId,
        ingredientId: recipeIngredient.ingredientId,
        rawName: recipeIngredient.rawName,
        quantity: recipeIngredient.quantity,
        unit: recipeIngredient.unit,
        optional: recipeIngredient.optional,
        canonicalName: ingredient.canonicalName,
        aisle: ingredient.aisle,
        densityGPerMl: ingredient.densityGPerMl,
      })
      .from(recipeIngredient)
      .leftJoin(ingredient, eq(ingredient.id, recipeIngredient.ingredientId))
      .where(inArray(recipeIngredient.recipeId, [...recipeIds]))
      .orderBy(asc(recipeIngredient.position));

    const baskets = new Map<string, RecipeBasket>();
    for (const row of recipes) {
      baskets.set(row.id, {
        recipeId: row.id,
        servings: row.servings,
        lines: [],
      });
    }

    for (const line of lines) {
      const basket = baskets.get(line.recipeId);
      if (!basket) continue;
      basket.lines.push({
        ingredientId: line.ingredientId,
        rawName: line.rawName,
        canonicalName: line.canonicalName,
        aisle: line.aisle,
        densityGPerMl:
          line.densityGPerMl === null ? null : Number(line.densityGPerMl),
        quantity: line.quantity === null ? null : Number(line.quantity),
        unit: line.unit,
        optional: line.optional,
      });
    }

    return baskets;
  });
}

/**
 * Just enough about a set of recipes to render a plan entry: the title for the
 * card and the attended time for the day total. Deliberately narrower than
 * loadRecipesForValidation, which also reads every ingredient row.
 */
export async function loadRecipeSummaries(
  ctx: ServiceContext,
  recipeIds: readonly string[],
): Promise<Map<string, RecipeSummary>> {
  if (recipeIds.length === 0) return new Map();

  return inScope(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: recipe.id,
        title: recipe.title,
        servings: recipe.servings,
        activeTimeMin: recipe.activeTimeMin,
        prepTimeMin: recipe.prepTimeMin,
        cookTimeMin: recipe.cookTimeMin,
        batchFriendly: recipe.batchFriendly,
      })
      .from(recipe)
      .where(
        and(eq(recipe.userId, ctx.userId), inArray(recipe.id, [...recipeIds])),
      );

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          title: row.title,
          servings: row.servings,
          batchFriendly: row.batchFriendly,
          // The same fallback the time budget rule uses, so the grid shows the
          // number the rule will compare against.
          activeTimeMin:
            row.activeTimeMin ??
            (row.prepTimeMin === null && row.cookTimeMin === null
              ? null
              : (row.prepTimeMin ?? 0) + (row.cookTimeMin ?? 0)),
        },
      ]),
    );
  });
}

/**
 * The shape the planning rules need: each recipe with enough ingredient text to
 * run the allergen matcher, including the aliases of any linked ingredient.
 */
export interface RecipeForValidation {
  readonly recipe: RecipeRow;
  readonly ingredientTexts: IngredientText[];
}

export async function loadRecipesForValidation(
  ctx: ServiceContext,
  recipeIds: readonly string[],
): Promise<Map<string, RecipeForValidation>> {
  if (recipeIds.length === 0) return new Map();

  return inScope(ctx, async (tx) => {
    const recipes = await tx
      .select(recipeColumns)
      .from(recipe)
      .where(and(eq(recipe.userId, ctx.userId), inArray(recipe.id, [...recipeIds])));

    const lines = await tx
      .select({
        recipeId: recipeIngredient.recipeId,
        rawName: recipeIngredient.rawName,
        canonicalName: ingredient.canonicalName,
        aliases: ingredient.aliases,
      })
      .from(recipeIngredient)
      .leftJoin(ingredient, eq(ingredient.id, recipeIngredient.ingredientId))
      .where(inArray(recipeIngredient.recipeId, [...recipeIds]));

    const byRecipe = new Map<string, RecipeForValidation>();
    for (const row of recipes) {
      byRecipe.set(row.id, { recipe: row, ingredientTexts: [] });
    }
    for (const line of lines) {
      const entry = byRecipe.get(line.recipeId);
      if (!entry) continue;
      (entry.ingredientTexts as IngredientText[]).push({
        rawName: line.rawName,
        canonicalName: line.canonicalName,
        aliases: line.aliases,
      });
    }

    return byRecipe;
  });
}

async function loadRecipe(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  recipeId: string,
): Promise<RecipeDetail> {
  const { tx } = ctx;

  const rows = await tx
    .select(recipeColumns)
    .from(recipe)
    .where(and(eq(recipe.id, recipeId), eq(recipe.userId, ctx.userId)))
    .limit(1);

  const found = rows[0];
  if (!found) {
    throw new DomainError(
      "RECIPE_NOT_FOUND",
      `Aucune recette ne correspond à l'identifiant ${recipeId}. Utilisez la recherche de recettes pour retrouver un identifiant valide.`,
      { recipeId },
    );
  }

  const ingredients = await tx
    .select({
      id: recipeIngredient.id,
      position: recipeIngredient.position,
      quantity: recipeIngredient.quantity,
      unit: recipeIngredient.unit,
      rawName: recipeIngredient.rawName,
      note: recipeIngredient.note,
      optional: recipeIngredient.optional,
      ingredientId: recipeIngredient.ingredientId,
      canonicalName: ingredient.canonicalName,
      aliases: ingredient.aliases,
      aisle: ingredient.aisle,
    })
    .from(recipeIngredient)
    .leftJoin(ingredient, eq(ingredient.id, recipeIngredient.ingredientId))
    .where(eq(recipeIngredient.recipeId, recipeId))
    .orderBy(asc(recipeIngredient.position));

  const steps = await tx
    .select({
      id: recipeStep.id,
      position: recipeStep.position,
      text: recipeStep.text,
      durationMin: recipeStep.durationMin,
      unattended: recipeStep.unattended,
    })
    .from(recipeStep)
    .where(eq(recipeStep.recipeId, recipeId))
    .orderBy(asc(recipeStep.position));

  return {
    recipe: found,
    ingredients: ingredients.map((row) => ({
      ...row,
      quantity: row.quantity === null ? null : Number(row.quantity),
    })),
    steps,
  };
}

async function writeChildren(
  tx: NonNullable<ServiceContext["tx"]>,
  ctx: ServiceContext,
  recipeId: string,
  parsed: RecipeInput,
  links: Map<string, { id: string }>,
): Promise<void> {
  if (parsed.ingredients.length > 0) {
    await tx.insert(recipeIngredient).values(
      parsed.ingredients.map((line, index) => ({
        userId: ctx.userId,
        recipeId,
        position: index,
        quantity: line.quantity === null ? null : String(line.quantity),
        unit: line.unit,
        rawName: line.rawName,
        note: line.note,
        optional: line.optional,
        // An explicit link from the caller wins; otherwise best-effort.
        ingredientId: line.ingredientId ?? links.get(line.rawName)?.id ?? null,
      })),
    );
  }

  if (parsed.steps.length > 0) {
    await tx.insert(recipeStep).values(
      parsed.steps.map((step, index) => ({
        userId: ctx.userId,
        recipeId,
        position: index,
        text: step.text,
        durationMin: step.durationMin,
        unattended: step.unattended,
      })),
    );
  }
}

/**
 * Caches which of the user's allergens this recipe touches, for display and
 * filtering. It is a cache and nothing more: the strict block re-runs the
 * matcher against live data on every assignment, because an allergen added
 * after a recipe was saved must still block it.
 */
async function refreshDerivedAllergens(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  recipeId: string,
): Promise<void> {
  const { tx } = ctx;
  const allergens = await listAllergens(ctx);
  if (allergens.length === 0) {
    await tx.update(recipe).set({ allergenIds: [] }).where(eq(recipe.id, recipeId));
    return;
  }

  const lines = await tx
    .select({
      rawName: recipeIngredient.rawName,
      canonicalName: ingredient.canonicalName,
      aliases: ingredient.aliases,
    })
    .from(recipeIngredient)
    .leftJoin(ingredient, eq(ingredient.id, recipeIngredient.ingredientId))
    .where(eq(recipeIngredient.recipeId, recipeId));

  const hits = findAllergenHits(
    lines,
    allergens.map((row) => ({
      id: row.id,
      name: row.name,
      severity: row.severity as "avoid" | "strict",
      matches: row.matches,
    })),
  );

  const allergenIds = [...new Set(hits.map((hit) => hit.allergenId))];
  await tx.update(recipe).set({ allergenIds }).where(eq(recipe.id, recipeId));
}
