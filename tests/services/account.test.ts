import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount, exportAccount } from "@/services/account-service";
import { cleanupUser, testUser, userOwnedTableNames } from "../helpers";
import { closeOwnerPool, ownerRowCount } from "../helpers/owner";
import { seedEveryUserOwnedTable } from "../helpers/seed";

/**
 * Taking your data out, and taking your account down.
 *
 * The deletion half is the reason this file exists. Domain tables carry no
 * foreign key to the Better Auth user, so nothing cascades on its own and the
 * order of twenty-two deletes is written by hand in `deleteAccount`. A table
 * left out of that list leaves rows behind that nobody can ever see again.
 *
 * The old version of this file judged that by the keys `exportAccount` chooses
 * to expose, which cannot work: a table missing from **both** the export and
 * the delete passes, and that is precisely the file's own stated failure mode.
 * It happened, too. `grocery_list_version` was in neither, so an export
 * promising "everything, in one file" could not say what any grocery list had
 * been built from, and the deletion left its rows behind.
 *
 * So the enumeration is taken from the schema rather than from either list, and
 * both halves are checked against it: every user-owned table must appear in the
 * export, and every user-owned table must be empty afterwards. The emptiness
 * check runs on the **owner** connection, because a leftover row and a row
 * row-level security is hiding look identical through the runtime role, and it
 * is the leftover row this test is about.
 */

const leaving = testUser();
const staying = testUser();

/**
 * Which export key holds each table. Not derivable: `slot_config` is exported
 * as `slots`, `profile` is a single object rather than an array, and several
 * names pluralize irregularly.
 *
 * The map being explicit is the mechanism. A table added to the schema has no
 * entry here, the first test below says so by name, and the fix is to export
 * it, delete it, and add the line. That is three places, and all three are
 * places it needed to be added anyway.
 */
const EXPORT_KEY: Record<string, string> = {
  profile: "profile",
  allergen: "allergens",
  exclusion: "exclusions",
  equipment: "equipment",
  fact: "facts",
  meal_type: "mealTypes",
  slot_config: "slots",
  ingredient: "ingredients",
  recipe: "recipes",
  recipe_ingredient: "recipeIngredients",
  recipe_step: "recipeSteps",
  recipe_revision: "recipeRevisions",
  plan: "plans",
  plan_version: "planVersions",
  plan_entry: "planEntries",
  entry_feedback: "entryFeedback",
  prep_link: "prepLinks",
  pantry_item: "pantryItems",
  grocery_list: "groceryLists",
  grocery_list_version: "groceryListVersions",
  grocery_line: "groceryLines",
  agent_activity: "agentActivity",
};

/** `profile` is one row, so it is exported as an object, not as an array. */
const SINGLETON_TABLES = new Set(["profile"]);

beforeAll(async () => {
  for (const ctx of [leaving, staying]) {
    await seedEveryUserOwnedTable(ctx);
  }
}, 120_000);

afterAll(async () => {
  await cleanupUser(leaving);
  await cleanupUser(staying);
  await closeOwnerPool();
});

describe("exporting an account", () => {
  it("has a key for every user-owned table", () => {
    const missing = userOwnedTableNames().filter(
      (table) => EXPORT_KEY[table] === undefined,
    );
    expect(
      missing,
      "These user-owned tables have no entry in EXPORT_KEY. Add them to " +
        "exportAccount, to deleteAccount, and to the map in this file.",
    ).toEqual([]);
  });

  it("carries every part of the account, in one document", async () => {
    const data = await exportAccount(leaving);

    expect(data.format).toBe("cooking-app/v1");

    for (const table of userOwnedTableNames()) {
      const key = EXPORT_KEY[table];
      if (key === undefined) continue; // reported by the test above
      const value = data[key];

      if (SINGLETON_TABLES.has(table)) {
        expect(value, `${key} (${table}) missing from the export`).not.toBe(
          undefined,
        );
        expect(value, `${key} (${table}) exported as null`).not.toBeNull();
        continue;
      }

      expect(
        Array.isArray(value),
        `${key} (${table}) missing from the export`,
      ).toBe(true);
      // Non-empty, because the seed writes to every one of these tables. An
      // empty array here means either the export dropped the table or the seed
      // stopped covering it, and both are worth failing over.
      expect(
        (value as unknown[]).length,
        `${key} (${table}) is empty in the export, so nothing here proves it ` +
          "is exported at all",
      ).toBeGreaterThan(0);
    }
  });

  it("holds nothing belonging to anyone else", async () => {
    // The export reads through withUser, so this is really a test that
    // row-level security still covers the one query that reads every table at
    // once.
    const data = await exportAccount(leaving);
    const serialized = JSON.stringify(data);

    expect(serialized).toContain(leaving.userId);
    expect(serialized).not.toContain(staying.userId);
  });
});

describe("deleting an account", () => {
  it("leaves no row in any user-owned table, checked past row-level security", async () => {
    const tables = userOwnedTableNames();

    // Non-vacuous by construction: every table has rows before the delete, so
    // a table `deleteAccount` never touches is a table this test catches.
    const before = await Promise.all(
      tables.map(
        async (table) =>
          [table, await ownerRowCount(table, leaving.userId)] as const,
      ),
    );
    for (const [table, count] of before) {
      expect(
        count,
        `${table} had no row for the departing user before the delete, so ` +
          "the assertion after it would pass on an empty table. Add a write " +
          "for it to seedEveryUserOwnedTable() in tests/helpers/seed.ts.",
      ).toBeGreaterThan(0);
    }

    await deleteAccount(leaving);

    const after = await Promise.all(
      tables.map(
        async (table) =>
          [table, await ownerRowCount(table, leaving.userId)] as const,
      ),
    );
    const leftBehind = after.filter(([, count]) => count !== 0);
    expect(
      leftBehind,
      "These tables kept rows the departing user owns, which nobody can ever " +
        "see or remove again. Add them to deleteAccount in " +
        "src/services/account-service.ts.",
    ).toEqual([]);
  });

  it("leaves the other account untouched", async () => {
    const survivor = await exportAccount(staying);
    expect(survivor.profile).not.toBeNull();
    expect((survivor.recipes as unknown[]).length).toBeGreaterThan(0);
    expect((survivor.groceryLines as unknown[]).length).toBeGreaterThan(0);

    for (const table of userOwnedTableNames()) {
      expect(
        await ownerRowCount(table, staying.userId),
        `${table} lost the surviving user's rows`,
      ).toBeGreaterThan(0);
    }
  });

  it("reports an emptied account rather than a broken one", async () => {
    // The account is gone and the export still answers, which is what the
    // deletion screen reads on its way out.
    const emptied = await exportAccount(leaving);
    expect(emptied.profile).toBeNull();
    for (const table of userOwnedTableNames()) {
      const key = EXPORT_KEY[table];
      if (key === undefined || SINGLETON_TABLES.has(table)) continue;
      expect(emptied[key], `${key} left rows behind`).toEqual([]);
    }
  });
});
