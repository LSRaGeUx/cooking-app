import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { pantryItem } from "@/db/schema";
import { normalizeTerm } from "@/domain/allergens";
import { DomainError } from "@/domain/errors";
import { pantryItemInputSchema } from "@/domain/schemas";
import type { PantryKind } from "@/domain/vocabulary";
import { inScope, type ServiceContext } from "./context";
import { linkIngredientNames } from "./ingredient-service";

/**
 * The pantry: two short lists, no stock accounting.
 *
 * Staples are things always present, and they drop off the grocery list.
 * Use-soon items are things to eat before they go, and they are a planning
 * priority the agent reads. That is the whole feature, on purpose: everything
 * richer turns into bookkeeping, and bookkeeping is what kills pantry features.
 */

/**
 * How long a removed item can be brought back. The same window recipes get, for
 * the same reason: rule 6 says nothing an agent does is irreversible, and an
 * agent removing a staple has to be undoable by the person whose cupboard it is.
 */
export const PANTRY_RESTORE_WINDOW_DAYS = 30;

/**
 * How many items one call may add.
 *
 * There was no bound at all, so a single agent call could insert thousands of
 * rows into a feature whose entire point is that it stays short enough to read.
 * Fifty is well past any real cupboard inventory somebody types in one go, and
 * the error names the cap so a caller that hits it batches rather than guesses.
 */
export const PANTRY_ADD_MAX = 50;

export interface PantryItemView {
  readonly id: string;
  readonly kind: PantryKind;
  readonly name: string;
  readonly ingredientId: string | null;
  readonly quantityNote: string | null;
  readonly expiresOn: string | null;
  readonly source: string;
  readonly addedAt: Date;
  /** Set while the item is inside its restore window. */
  readonly removedAt: Date | null;
}

/**
 * The live lists. A removed item is filtered out here rather than deleted, so
 * `restorePantryItem` has something to bring back.
 */
export async function listPantry(
  ctx: ServiceContext,
  kind?: PantryKind,
): Promise<PantryItemView[]> {
  return inScope(ctx, async ({ tx }) => {
    const conditions = [
      eq(pantryItem.userId, ctx.userId),
      isNull(pantryItem.removedAt),
    ];
    if (kind) conditions.push(eq(pantryItem.kind, kind));

    const rows = await tx
      .select()
      .from(pantryItem)
      .where(and(...conditions))
      // Expiring first among use-soon items: the list is read to decide what to
      // cook next, so the urgent end belongs at the top.
      .orderBy(asc(pantryItem.expiresOn), asc(pantryItem.name));

    return rows.map(toView);
  });
}

/** Items inside the restore window, for the screen that offers them back. */
export async function listRemovedPantryItems(
  ctx: ServiceContext,
): Promise<PantryItemView[]> {
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .select()
      .from(pantryItem)
      .where(
        and(eq(pantryItem.userId, ctx.userId), isNotNull(pantryItem.removedAt)),
      )
      .orderBy(asc(pantryItem.name));
    return rows.map(toView);
  });
}

export async function addPantryItems(
  ctx: ServiceContext,
  inputs: readonly unknown[],
): Promise<PantryItemView[]> {
  if (inputs.length > PANTRY_ADD_MAX) {
    throw new DomainError(
      "VALIDATION",
      `${inputs.length} produits en un appel, pour un maximum de ${PANTRY_ADD_MAX}. Les placards sont deux listes courtes que la personne relit : au-delà de ${PANTRY_ADD_MAX} produits elles ne se lisent plus. Découpez l'ajout en plusieurs appels si l'inventaire est réellement aussi long.`,
      { received: inputs.length, max: PANTRY_ADD_MAX },
    );
  }

  const parsed = inputs.map((input) => pantryItemInputSchema.parse(input));
  if (parsed.length === 0) return [];

  return inScope(ctx, async (scoped) => {
    const { tx } = scoped;
    // Best-effort linking, so a staple named "farine" can be matched against a
    // grocery line for "Farine" later.
    const links = await linkIngredientNames(
      scoped,
      parsed.map((item) => item.name),
    );

    const rows = await tx
      .insert(pantryItem)
      .values(
        parsed.map((item) => ({
          userId: ctx.userId,
          kind: item.kind,
          name: item.name,
          ingredientId: links.get(item.name)?.id ?? null,
          quantityNote: item.quantityNote,
          expiresOn: item.expiresOn,
          source: ctx.actor === "agent" ? "agent" : "user",
        })),
      )
      .returning();

    return rows.map(toView);
  });
}

/**
 * Soft delete, with the same 30-day window a recipe gets.
 *
 * It was a hard `delete`, and it is reachable by an agent through
 * `src/mcp/tools/pantry.ts`, which breaks rule 6: an agent that removes the
 * flour leaves nothing for the user to put back. Setting `removed_at` keeps the
 * row, and `listPantry` filters it out, so the feature behaves the same and the
 * mistake is recoverable.
 */
export async function removePantryItem(
  ctx: ServiceContext,
  itemId: string,
): Promise<PantryItemView> {
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .update(pantryItem)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(pantryItem.id, itemId),
          eq(pantryItem.userId, ctx.userId),
          isNull(pantryItem.removedAt),
        ),
      )
      .returning();
    const [row] = rows;
    if (!row) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce produit n'est pas dans vos placards, ou il en a déjà été retiré.",
        { itemId },
      );
    }
    return toView(row);
  });
}

/**
 * Puts a removed item back. The other half of rule 6: a soft delete nobody can
 * undo from the product is a hard delete with extra steps.
 */
export async function restorePantryItem(
  ctx: ServiceContext,
  id: string,
): Promise<PantryItemView> {
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .update(pantryItem)
      .set({ removedAt: null })
      .where(
        and(
          eq(pantryItem.id, id),
          eq(pantryItem.userId, ctx.userId),
          isNotNull(pantryItem.removedAt),
        ),
      )
      .returning();
    const [row] = rows;
    if (!row) {
      throw new DomainError(
        "NOT_FOUND",
        `Aucun produit retiré ne porte cet identifiant. Un produit retiré depuis plus de ${PANTRY_RESTORE_WINDOW_DAYS} jours a pu être purgé, et un produit encore présent n'a pas besoin d'être restauré.`,
        { itemId: id },
      );
    }
    return toView(row);
  });
}

/**
 * Deletes items removed longer ago than the restore window. The scheduled
 * counterpart to the soft delete: without it a removed row stays for ever and
 * the window means nothing.
 */
export async function purgeRemovedPantryItems(
  ctx: ServiceContext,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - PANTRY_RESTORE_WINDOW_DAYS * 86_400_000,
  );

  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .delete(pantryItem)
      .where(
        and(
          eq(pantryItem.userId, ctx.userId),
          isNotNull(pantryItem.removedAt),
          lt(pantryItem.removedAt, cutoff),
        ),
      )
      .returning({ id: pantryItem.id });
    return rows.length;
  });
}

/**
 * What the grocery list needs: which normalized ingredients are staples, and
 * which are running out. Names are included because an unlinked pantry item
 * can still be matched against a line by name.
 */
export interface PantryCoverage {
  readonly stapleIngredientIds: Set<string>;
  readonly stapleNames: Set<string>;
  readonly useSoonIngredientIds: Set<string>;
  readonly useSoonNames: Set<string>;
}

export async function loadPantryCoverage(
  ctx: ServiceContext,
): Promise<PantryCoverage> {
  const items = await listPantry(ctx);

  const coverage: PantryCoverage = {
    stapleIngredientIds: new Set(),
    stapleNames: new Set(),
    useSoonIngredientIds: new Set(),
    useSoonNames: new Set(),
  };

  for (const item of items) {
    const ids =
      item.kind === "staple"
        ? coverage.stapleIngredientIds
        : coverage.useSoonIngredientIds;
    const names =
      item.kind === "staple" ? coverage.stapleNames : coverage.useSoonNames;

    if (item.ingredientId) ids.add(item.ingredientId);
    // `normalizeTerm`, the same folding the allergen matcher and the grocery
    // match key use. It was `trim().toLowerCase()`, so a cupboard holding
    // "Crème fraîche" covered nothing written "creme fraiche" and "Œufs" never
    // covered "oeufs": the line stayed on the list, which is the safe direction
    // but not the correct one, and the two halves of one comparison disagreed
    // about what the same word is.
    names.add(normalizeTerm(item.name));
  }

  return coverage;
}

function toView(row: typeof pantryItem.$inferSelect): PantryItemView {
  return {
    id: row.id,
    kind: row.kind as PantryKind,
    name: row.name,
    ingredientId: row.ingredientId,
    quantityNote: row.quantityNote,
    expiresOn: row.expiresOn,
    source: row.source,
    // The Drizzle property is `createdAt` now; the column is unchanged. The
    // view keeps calling it `addedAt`, which is what the screens read and the
    // better name for the concept.
    addedAt: row.createdAt,
    removedAt: row.removedAt,
  };
}
