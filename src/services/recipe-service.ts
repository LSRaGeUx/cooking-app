import {
  and,
  arrayOverlaps,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  ingredient,
  recipe,
  recipeIngredient,
  recipeRevision,
  recipeStep,
} from "@/db/schema";
import { firstRow } from "@/db/rows";
import type { IngredientText } from "@/domain/allergens";
import { DomainError } from "@/domain/errors";
import {
  recipeInputSchema,
  recipeSearchSchema,
  type RecipeInput,
} from "@/domain/schemas";
import type { RecipeSource } from "@/domain/vocabulary";
import { isoWeekOf, shiftIsoWeek } from "@/domain/week";
import { inScope, type ScopedContext, type ServiceContext } from "./context";
import { recipeHistoryAggregate, weeksSinceKey } from "./history-service";
import {
  linkIngredientNames,
  ownedIngredientIds,
  type IngredientMatch,
} from "./ingredient-service";

/**
 * Recipes: create, edit, read, search, soft delete.
 *
 * Two rules shape this file. Edits keep a revision, because an agent-driven
 * edit has to be reversible. And deletes are soft, because past plan entries
 * reference the recipe and history has to stay readable.
 *
 * **There is no cached allergen list on a recipe any more.** `recipe.allergen_ids`
 * was written when a recipe was created or edited and never afterwards, so
 * adding or deleting an allergen left every existing recipe carrying a list
 * derived from the old rules: a listing showed a recipe as clean while the
 * assignment path, which re-runs the matcher against live data on every write,
 * refused it. Correctness beats the read cost here, and the read cost turned
 * out to be nothing at all: the only consumer of the column was the MCP
 * serializer, which deliberately drops it as "rows an agent cannot resolve", so
 * the cache had no readers. Nothing writes it now, it is out of `recipeColumns`
 * so no reader can pick up a stale value, and the column itself is the domain
 * agent's to drop.
 */

/**
 * Everything but the generated search vector, which is never read directly, and
 * `allergen_ids`, which is no longer maintained. See the note above.
 */
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
  revision: recipe.revision,
  createdAt: recipe.createdAt,
  updatedAt: recipe.updatedAt,
  deletedAt: recipe.deletedAt,
} as const;

/**
 * How long a soft-deleted recipe can be restored. Rule 6 promises the window,
 * and `purgeDeletedRecipes` below is what makes it a window rather than a
 * permanent hoard.
 */
export const RECIPE_RESTORE_WINDOW_DAYS = 30;

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

  return inScope(ctx, async (scoped) => {
    const links = await resolveIngredientLinks(scoped, parsed);

    const inserted = await scoped.tx
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

    const recipeId = firstRow(inserted, "recipe insert").id;
    await writeChildren(scoped, recipeId, parsed, links);

    return loadRecipe(scoped, recipeId);
  });
}

/**
 * Every edit snapshots the previous state into recipe_revision and bumps
 * `revision`, so a plan entry that recorded revision 3 can still be explained
 * after the recipe moved on.
 *
 * A soft-deleted recipe is refused. `loadRecipe` ignores `deleted_at`, so an
 * edit of a deleted recipe used to succeed, bump its revision and pile up
 * revision rows for something the library no longer shows.
 *
 * The row is locked before it is read. Read, then insert a revision numbered
 * from what was read, then update, is a race: two concurrent edits both read
 * revision 3, both insert revision 3 and the loser gets a raw `23505` from
 * `recipe_revision_recipe_revision_key`. `for update` makes the second edit
 * wait and then read revision 4, which is what it should have read.
 */
export async function updateRecipe(
  ctx: ServiceContext,
  recipeId: string,
  input: unknown,
): Promise<RecipeDetail> {
  const parsed = recipeInputSchema.parse(input);

  return inScope(ctx, async (scoped) => {
    const { tx } = scoped;
    await lockRecipe(scoped, recipeId);
    const before = await loadRecipe(scoped, recipeId);
    if (before.recipe.deletedAt !== null) {
      throw new DomainError(
        "RECIPE_NOT_FOUND",
        `La recette « ${before.recipe.title} » est supprimée et ne peut pas être modifiée. Restaurez-la d'abord si vous voulez la reprendre.`,
        { recipeId, deletedAt: before.recipe.deletedAt.toISOString() },
      );
    }

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
        // `updatedAt` carries `$onUpdate`, so Drizzle writes it itself.
      })
      .where(and(eq(recipe.id, recipeId), eq(recipe.userId, ctx.userId)));

    await tx
      .delete(recipeIngredient)
      .where(
        and(
          eq(recipeIngredient.recipeId, recipeId),
          eq(recipeIngredient.userId, ctx.userId),
        ),
      );
    await tx
      .delete(recipeStep)
      .where(
        and(
          eq(recipeStep.recipeId, recipeId),
          eq(recipeStep.userId, ctx.userId),
        ),
      );

    const links = await resolveIngredientLinks(scoped, parsed);
    await writeChildren(scoped, recipeId, parsed, links);

    return loadRecipe(scoped, recipeId);
  });
}

/** Soft delete, with a 30-day window before `purgeDeletedRecipes` takes it. */
export async function softDeleteRecipe(
  ctx: ServiceContext,
  recipeId: string,
): Promise<void> {
  await inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .update(recipe)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(recipe.id, recipeId),
          eq(recipe.userId, ctx.userId),
          isNull(recipe.deletedAt),
        ),
      )
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

/**
 * Brings a soft-deleted recipe back, and says so when it cannot.
 *
 * It used to clear `deleted_at` on any id, reporting nothing when the id was
 * unknown or the recipe was never deleted, which is the wrong half of the pair:
 * `softDeleteRecipe` throws and this said nothing, so a screen wiring the two
 * together could show a successful restore of a recipe that does not exist.
 */
export async function restoreRecipe(
  ctx: ServiceContext,
  recipeId: string,
): Promise<RecipeDetail> {
  return inScope(ctx, async (scoped) => {
    const rows = await scoped.tx
      .update(recipe)
      .set({ deletedAt: null })
      .where(
        and(
          eq(recipe.id, recipeId),
          eq(recipe.userId, ctx.userId),
          isNotNull(recipe.deletedAt),
        ),
      )
      .returning({ id: recipe.id });
    if (!rows[0]) {
      throw new DomainError(
        "RECIPE_NOT_FOUND",
        `Aucune recette supprimée ne correspond à cet identifiant. Une recette supprimée depuis plus de ${RECIPE_RESTORE_WINDOW_DAYS} jours a pu être purgée, et une recette encore présente n'a pas besoin d'être restaurée.`,
        { recipeId },
      );
    }
    return loadRecipe(scoped, recipeId);
  });
}

/** Soft-deleted recipes still inside the window, for the restore control. */
export async function listDeletedRecipes(
  ctx: ServiceContext,
): Promise<RecipeRow[]> {
  return inScope(ctx, ({ tx }) =>
    tx
      .select(recipeColumns)
      .from(recipe)
      .where(and(eq(recipe.userId, ctx.userId), isNotNull(recipe.deletedAt)))
      .orderBy(desc(recipe.deletedAt)),
  );
}

/**
 * Deletes for real what has been soft-deleted longer than the window.
 *
 * The comment on `softDeleteRecipe` promised a purge job and there was none, so
 * "30-day window" meant "kept for ever, hidden". This is the service half; a
 * schedule that calls it per user is the tooling agent's.
 *
 * A recipe still referenced by a plan entry survives the purge. `plan_entry`
 * carries an `on delete set null` on `recipe_id`, so deleting the row would
 * unlink historic meals and leave the week showing a dish with no recipe. The
 * title snapshot keeps history readable either way, but a plan the user can
 * still open should keep working, so the purge only takes what nothing points
 * at. The count returned is what was actually removed.
 */
export async function purgeDeletedRecipes(
  ctx: ServiceContext,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - RECIPE_RESTORE_WINDOW_DAYS * 86_400_000,
  );

  return inScope(ctx, async ({ tx }) => {
    const purged = await tx
      .delete(recipe)
      .where(
        and(
          eq(recipe.userId, ctx.userId),
          isNotNull(recipe.deletedAt),
          lt(recipe.deletedAt, cutoff),
          sql`not exists (
            select 1 from plan_entry pe
            where pe.recipe_id = ${recipe.id}
              and pe.user_id = ${ctx.userId}
          )`,
        ),
      )
      .returning({ id: recipe.id });
    return purged.length;
  });
}

/**
 * One recipe, deleted or not. `deletedAt` is part of `RecipeRow`, so a reader
 * can tell: this used to return a deleted recipe with nothing to distinguish it
 * from a live one, and the screens rendered it as current.
 */
export async function getRecipe(
  ctx: ServiceContext,
  recipeId: string,
): Promise<RecipeDetail> {
  return inScope(ctx, (scoped) => loadRecipe(scoped, recipeId));
}

export interface RecipeSearchResult {
  readonly recipes: RecipeRow[];
  readonly total: number;
}

/**
 * Full-text search on the generated French vector, with a title fallback so a
 * partial word still finds something while the user is typing.
 *
 * `now` is injected rather than read from the clock inside, so the two
 * week-relative filters are testable and so a caller that also reads history
 * can pass one instant for the whole answer. See the note in
 * src/domain/week.ts: week arithmetic is done on the running instance's local
 * calendar day, which is the one clock this codebase uses for "today".
 */
export async function searchRecipes(
  ctx: ServiceContext,
  input: unknown = {},
  now: Date = new Date(),
): Promise<RecipeSearchResult> {
  const search = recipeSearchSchema.parse(input);

  return inScope(ctx, async ({ tx }) => {
    const conditions = [
      eq(recipe.userId, ctx.userId),
      isNull(recipe.deletedAt),
    ];

    if (search.query && search.query.trim().length > 0) {
      const query = search.query.trim();
      const textMatch = or(
        sql`${recipe.searchVector} @@ websearch_to_tsquery('french', ${query})`,
        sql`${recipe.title} ilike ${`%${escapeLikePattern(query)}%`} escape '\\'`,
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
        isoWeekOf(now),
        -(search.notPlannedInWeeks - 1),
      );
      const cutoffKey = cutoff.year * 100 + cutoff.week;
      conditions.push(sql`not exists (
        select 1 from plan_entry pe
        join plan_version pv on pv.id = pe.plan_version_id
        join plan p on p.id = pv.plan_id
        where pe.recipe_id = ${recipe.id}
          and pe.user_id = ${ctx.userId}
          and pv.state = 'active'
          and (p.iso_year * 100 + p.iso_week) >= ${cutoffKey}
      )`);
    }

    if (search.notCookedInWeeks !== undefined) {
      const cutoff = shiftIsoWeek(
        isoWeekOf(now),
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
          and pe.user_id = ${ctx.userId}
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
        where pe.recipe_id = ${recipe.id}
          and pe.user_id = ${ctx.userId}
          and f.rating is not null
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
   * never been planned. Deliberately not called "rotation age": it is what was
   * planned, which is not the same as what was cooked.
   */
  readonly weeksSinceLastPlanned: number | null;
}

/**
 * The compact index an agent surveys before deciding what to fetch in full.
 *
 * Compactness is the point: a 200-recipe library has to be readable in a few
 * hundred tokens, or the agent burns its context on the catalogue instead of
 * the plan.
 *
 * The plan-and-feedback half comes from `recipeHistoryAggregate`, which is the
 * one statement of that aggregate. This file used to carry its own copy of the
 * same join, and the two had drifted.
 */
export async function loadRecipeIndex(
  ctx: ServiceContext,
  now: Date = new Date(),
): Promise<RecipeIndexEntry[]> {
  return inScope(ctx, async (scoped) => {
    const rows = await scoped.tx
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

    const history = await recipeHistoryAggregate(scoped);
    const thisWeek = isoWeekOf(now);

    return rows.map((row) => {
      const seen = history.get(row.id);
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
        timesPlanned: seen?.planned ?? 0,
        timesCooked: seen?.cooked ?? 0,
        averageRating: seen?.averageRating ?? null,
        weeksSinceLastPlanned: weeksSinceKey(
          seen?.lastPlannedKey ?? null,
          thisWeek,
        ),
        weeksSinceLastCooked: weeksSinceKey(
          seen?.lastCookedKey ?? null,
          thisWeek,
        ),
      };
    });
  });
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

  return inScope(ctx, async ({ tx }) => {
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
      .where(
        and(
          eq(recipeIngredient.userId, ctx.userId),
          inArray(recipeIngredient.recipeId, [...recipeIds]),
        ),
      )
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
        densityGPerMl: numberOrNull(line.densityGPerMl),
        quantity: numberOrNull(line.quantity),
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

  return inScope(ctx, async ({ tx }) => {
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

  return inScope(ctx, async ({ tx }) => {
    const recipes = await tx
      .select(recipeColumns)
      .from(recipe)
      .where(
        and(eq(recipe.userId, ctx.userId), inArray(recipe.id, [...recipeIds])),
      );

    const lines = await tx
      .select({
        recipeId: recipeIngredient.recipeId,
        rawName: recipeIngredient.rawName,
        canonicalName: ingredient.canonicalName,
        aliases: ingredient.aliases,
      })
      .from(recipeIngredient)
      .leftJoin(ingredient, eq(ingredient.id, recipeIngredient.ingredientId))
      .where(
        and(
          eq(recipeIngredient.userId, ctx.userId),
          inArray(recipeIngredient.recipeId, [...recipeIds]),
        ),
      );

    // Collected into a mutable map and assembled after, rather than pushing
    // through `(entry.ingredientTexts as IngredientText[])`. The cast was there
    // to defeat the `readonly` on the interface, which is the interface saying
    // the array is not to be mutated.
    const textsByRecipe = new Map<string, IngredientText[]>();
    for (const line of lines) {
      const texts = textsByRecipe.get(line.recipeId) ?? [];
      texts.push({
        rawName: line.rawName,
        canonicalName: line.canonicalName,
        aliases: line.aliases,
      });
      textsByRecipe.set(line.recipeId, texts);
    }

    return new Map(
      recipes.map((row) => [
        row.id,
        { recipe: row, ingredientTexts: textsByRecipe.get(row.id) ?? [] },
      ]),
    );
  });
}

async function loadRecipe(
  ctx: ScopedContext,
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
    .where(
      and(
        eq(recipeIngredient.recipeId, recipeId),
        eq(recipeIngredient.userId, ctx.userId),
      ),
    )
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
    .where(
      and(eq(recipeStep.recipeId, recipeId), eq(recipeStep.userId, ctx.userId)),
    )
    .orderBy(asc(recipeStep.position));

  return {
    recipe: found,
    ingredients: ingredients.map((row) => ({
      ...row,
      quantity: numberOrNull(row.quantity),
    })),
    steps,
  };
}

/** Takes the row lock `updateRecipe` needs before it reads a revision number. */
async function lockRecipe(ctx: ScopedContext, recipeId: string): Promise<void> {
  const rows = await ctx.tx.execute<{ id: string }>(sql`
    select id from recipe
    where id = ${recipeId} and user_id = ${ctx.userId}
    for update
  `);
  if (rows.rows.length === 0) {
    throw new DomainError(
      "RECIPE_NOT_FOUND",
      `Aucune recette ne correspond à l'identifiant ${recipeId}. Utilisez la recherche de recettes pour retrouver un identifiant valide.`,
      { recipeId },
    );
  }
}

/**
 * Resolves every ingredient line's link, and refuses an explicit
 * `ingredientId` that is not this user's.
 *
 * The explicit id used to be inserted unchecked. A foreign key looks like it
 * covers that, and it does not: foreign key checks run as the table owner and
 * bypass row-level security, so naming another tenant's uuid succeeded when
 * that row existed and failed when it did not, which answers a question about
 * someone else's data. The row it wrote was then invisible to every join that
 * scopes by user, so the ingredient silently did not link at all.
 */
async function resolveIngredientLinks(
  ctx: ScopedContext,
  parsed: RecipeInput,
): Promise<Map<string, IngredientMatch>> {
  const explicit = [
    ...new Set(
      parsed.ingredients
        .map((line) => line.ingredientId)
        .filter((id): id is string => id !== null),
    ),
  ];

  if (explicit.length > 0) {
    const owned = await ownedIngredientIds(ctx);
    const unknown = explicit.filter((id) => !owned.has(id));
    if (unknown.length > 0) {
      throw new DomainError(
        "VALIDATION",
        `Ces identifiants d'ingrédient n'existent pas dans votre vocabulaire : ${unknown.join(", ")}. Laissez \`ingredientId\` à null pour laisser le rattachement se faire sur le nom, ou reprenez un identifiant de la liste des ingrédients.`,
        { ingredientIds: unknown },
      );
    }
  }

  return linkIngredientNames(
    ctx,
    parsed.ingredients.map((line) => line.rawName),
  );
}

/**
 * Inserts the ingredient and step rows of a recipe.
 *
 * Takes a `ScopedContext` like every other helper in the service layer. It used
 * to take `(tx, ctx, ...)`, which is the same two values in a shape nothing else
 * used.
 */
async function writeChildren(
  ctx: ScopedContext,
  recipeId: string,
  parsed: RecipeInput,
  links: Map<string, IngredientMatch>,
): Promise<void> {
  const { tx } = ctx;

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
        // An explicit link from the caller wins, and it has been checked
        // against this user's vocabulary by `resolveIngredientLinks`.
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
 * `%` and `_` are wildcards in `like`, so a user searching for "100_g" or for a
 * literal "%" was running a pattern rather than a search. The backslash has to
 * go first, since it is the escape character the query names.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Postgres hands `numeric` back as a string, so every read of one converts.
 * Written once here rather than as three inline ternaries; the grocery service
 * imports it for the same reason.
 */
export function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}
