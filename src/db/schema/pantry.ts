import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  text,
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
    // works, it just cannot be matched against a grocery line.
    ingredientId: uuid("ingredient_id").references(() => ingredient.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    quantityNote: text("quantity_note"),
    expiresOn: date("expires_on"),
    source: text("source").notNull().default("user"),
    addedAt: createdAt(),
  },
  (t) => [
    index("pantry_item_user_kind_idx").on(t.userId, t.kind),
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
