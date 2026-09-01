import { and, asc, eq } from "drizzle-orm";
import { pantryItem } from "@/db/schema";
import { DomainError } from "@/domain/errors";
import { pantryItemInputSchema } from "@/domain/schemas";
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

export interface PantryItemView {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly ingredientId: string | null;
  readonly quantityNote: string | null;
  readonly expiresOn: string | null;
  readonly source: string;
  readonly addedAt: Date;
}

export async function listPantry(
  ctx: ServiceContext,
  kind?: "staple" | "use_soon",
): Promise<PantryItemView[]> {
  return inScope(ctx, async (tx) => {
    const conditions = [eq(pantryItem.userId, ctx.userId)];
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

export async function addPantryItems(
  ctx: ServiceContext,
  inputs: readonly unknown[],
): Promise<PantryItemView[]> {
  const parsed = inputs.map((input) => pantryItemInputSchema.parse(input));
  if (parsed.length === 0) return [];

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
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

export async function removePantryItem(
  ctx: ServiceContext,
  itemId: string,
): Promise<void> {
  await inScope(ctx, async (tx) => {
    const rows = await tx
      .delete(pantryItem)
      .where(eq(pantryItem.id, itemId))
      .returning({ id: pantryItem.id });
    if (!rows[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce produit n'est pas dans vos placards.",
        { itemId },
      );
    }
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
    names.add(item.name.trim().toLowerCase());
  }

  return coverage;
}

function toView(row: typeof pantryItem.$inferSelect): PantryItemView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    ingredientId: row.ingredientId,
    quantityNote: row.quantityNote,
    expiresOn: row.expiresOn,
    source: row.source,
    addedAt: row.addedAt,
  };
}
