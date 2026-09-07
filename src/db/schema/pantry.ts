import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { PANTRY_KINDS, PANTRY_SOURCES, sqlInList } from "@/domain/vocabulary";
import { createdAt, ownerId, ownerPolicy, primaryId } from "./_shared";
import { ingredient } from "./recipes";

/**
 * Two short lists, and deliberately no stock accounting.
 *
 * `quantity_note` is free text on purpose. A numeric quantity invites
 * decrementing, decrementing invites bookkeeping, and bookkeeping is what makes
 * people abandon pantry features. The user's job here is thirty seconds of
 * typing, not inventory management.
 */
export const pantryItem = pgTable(
  "pantry_item",
  {
    id: primaryId(),
    userId: ownerId(),
    kind: text("kind").notNull(),
    // Best-effort link, same as a recipe ingredient: an unlinked item still
    // works, it just cannot be matched against a grocery line. Single-column,
    // for the reason on `recipe_ingredient.ingredient_id` in ./recipes.ts.
    ingredientId: uuid("ingredient_id").references(() => ingredient.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    quantityNote: text("quantity_note"),
    expiresOn: date("expires_on"),
    source: text("source").notNull().default("user"),
    // The property and the column now agree. It was `addedAt` over a column
    // called `created_at`, so a service, a migration and a psql session each
    // had a different name for one value, and the mismatch is the sort that
    // costs an afternoon the first time someone greps for the wrong one.
    //
    // The property was renamed rather than the column, and the choice was not
    // free: "added" is the better name for the concept, and renaming the column
    // to match would have been the nicer schema. drizzle-kit resolves a column
    // rename by asking, interactively, whether a dropped column and an added
    // one are the same column, and it cannot be asked in this environment; the
    // alternative was hand-writing the migration and hand-editing the snapshot
    // it diffs against, which is how the next migration silently generates
    // wrong. A comment costs nothing and a corrupt snapshot costs a restore.
    createdAt: createdAt(),
    // Soft delete, because rule 6 says nothing an agent does is irreversible,
    // and an agent removing a staple is exactly the case: the user has to be
    // able to put it back, and a deleted row cannot be put back. Set instead of
    // deleting, and `restorePantryItem` clears it.
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    // Partial on the live rows. Every screen and every snapshot asks for the
    // items that are still there, so a removed row is an index entry nothing
    // ever reads, and this is the index that answers "list the live ones".
    index("pantry_item_user_kind_idx")
      .on(t.userId, t.kind)
      .where(sql`removed_at is null`),
    // The pantry subtraction joins grocery lines to pantry items on this
    // column, and the `on delete set null` above scans it whenever a vocabulary
    // entry is removed. Postgres does not index a foreign key column for you.
    index("pantry_item_ingredient_idx").on(t.ingredientId),
    check(
      "pantry_item_kind_known",
      sql`${t.kind} in ${sql.raw(sqlInList(PANTRY_KINDS))}`,
    ),
    check(
      "pantry_item_source_known",
      sql`${t.source} in ${sql.raw(sqlInList(PANTRY_SOURCES))}`,
    ),
    ownerPolicy("pantry_item_owner", t.userId),
  ],
).enableRLS();

export type PantryItem = typeof pantryItem.$inferSelect;
export type NewPantryItem = typeof pantryItem.$inferInsert;
