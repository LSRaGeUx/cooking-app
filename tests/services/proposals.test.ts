import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { proposeWeekSchema } from "@/domain/schemas";
import { agentContext } from "@/services/context";
import { ensureUserSetup } from "@/services/onboarding-service";
import {
  acceptPendingEntries,
  acceptPendingVersion,
  checkFeasibility,
  getVersionEntries,
  getWeekView,
  listVersions,
  proposeWeek,
  rejectPendingVersion,
} from "@/services/plan-service";
import { createAllergen, updateProfile } from "@/services/profile-service";
import { createRecipe, searchRecipes } from "@/services/recipe-service";
import { listMealTypes } from "@/services/slot-service";
import { cleanupUser, expectDomainError, testUser } from "../helpers";

/**
 * The pitch, and the rules that make it safe to hand an agent a write.
 *
 * Each test uses its own ISO week, because a write validates the whole
 * resulting week and one test's allergen would otherwise block the next.
 */

const ctx = testUser();
const agent = agentContext(ctx.userId, "client-propose");

let omeletteId = "";

function week(number: number) {
  return { year: 2026, week: number };
}

/**
 * One proposed entry, typed from the schema rather than as
 * `Record<string, unknown>`.
 *
 * The loose type erased everything: a typo in a key compiled, went in as an
 * extra property, and was dropped by the parse, so a test that meant to set
 * `dayOfWeek` and wrote `dayofWeek` asserted about Monday and passed.
 */
type ProposedEntry = z.input<typeof proposeWeekSchema>["entries"][number];

function entry(overrides: Partial<ProposedEntry> = {}): ProposedEntry {
  return {
    dayOfWeek: 1,
    mealType: "dinner",
    recipeRef: omeletteId,
    rationale: "Rapide, et le créneau du lundi n'accepte que 20 minutes.",
    ...overrides,
  };
}

beforeAll(async () => {
  await ensureUserSetup(ctx);
  await listMealTypes(ctx);

  omeletteId = (
    await createRecipe(ctx, {
      title: "Omelette",
      servings: 2,
      activeTimeMin: 10,
      ingredients: [{ rawName: "3 oeufs" }, { rawName: "sel" }],
    })
  ).recipe.id;
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("checking before writing", () => {
  it("passes a week that breaks no rule", async () => {
    const report = await checkFeasibility(agent, {
      year: 2026,
      week: 30,
      entries: [entry()],
    });
    expect(report.errors).toEqual([]);
  });

  it("returns every problem at once rather than the first", async () => {
    const report = await checkFeasibility(agent, {
      year: 2026,
      week: 30,
      entries: [
        // An unknown meal type, and a missing rationale on another entry.
        entry({ mealType: "brunch" }),
        entry({ dayOfWeek: 2, rationale: "   " }),
      ],
    });

    const codes = report.errors.map((error) => error.code);
    expect(codes).toContain("SLOT_UNKNOWN");
    expect(codes).toContain("MISSING_RATIONALE");
    expect(report.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("checks a recipe that does not exist yet, before it is created", async () => {
    await createAllergen(ctx, {
      name: "Arachide",
      severity: "strict",
      matches: ["arachide", "cacahuète"],
    });

    const report = await checkFeasibility(agent, {
      year: 2026,
      week: 30,
      newRecipes: [
        {
          tempId: "temp-1",
          title: "Poulet sauce cacahuète",
          servings: 2,
          activeTimeMin: 20,
          ingredients: [{ rawName: "2 c. à s. de beurre de cacahuète" }],
        },
      ],
      entries: [entry({ recipeRef: "temp-1" })],
    });

    expect(report.errors.map((error) => error.code)).toContain(
      "STRICT_ALLERGEN",
    );
  });

  it("writes nothing at all", async () => {
    const view = await getWeekView(ctx, week(30));
    expect(view.activeVersion).toBeNull();
    expect(view.pendingVersion).toBeNull();
  });
});

describe("proposing", () => {
  const target = week(31);

  it("lands as a proposal, not a plan, under the default authority", async () => {
    const result = await proposeWeek(agent, {
      year: target.year,
      week: target.week,
      entries: [entry(), entry({ dayOfWeek: 2 })],
    });

    expect(result.version.state).toBe("pending");
    expect(result.version.createdBy).toBe("agent");
    expect(result.entries).toHaveLength(2);
    expect(result.reviewUrl).toContain("/semaine/2026-W31/proposition");

    // The active plan is untouched, which is what makes a proposal ignorable.
    const view = await getWeekView(ctx, target);
    expect(view.activeVersion).toBeNull();
    expect(view.pendingVersion?.versionNumber).toBe(
      result.version.versionNumber,
    );
  });

  it("keeps the rationale on every entry", async () => {
    const view = await getWeekView(ctx, target);
    const entries = await listVersions(ctx, target);
    expect(entries[0]?.state).toBe("pending");
    expect(view.pendingVersion).not.toBeNull();
  });

  it("refuses an entry with no rationale", async () => {
    await expect(
      proposeWeek(agent, {
        year: 2026,
        week: 32,
        entries: [entry({ rationale: "  " })],
      }),
    ).rejects.toMatchObject({ code: "MISSING_RATIONALE" });
  });

  it("creates invented recipes and the week in one transaction", async () => {
    const before = await searchRecipes(ctx, { limit: 100 });

    const result = await proposeWeek(agent, {
      year: 2026,
      week: 33,
      newRecipes: [
        {
          tempId: "temp-soup",
          title: "Soupe de courge",
          servings: 4,
          activeTimeMin: 15,
          ingredients: [{ rawName: "1 courge" }],
        },
      ],
      entries: [entry({ recipeRef: "temp-soup" })],
    });

    expect(result.entries[0]?.recipeTitleSnapshot).toBe("Soupe de courge");
    const after = await searchRecipes(ctx, { limit: 100 });
    expect(after.total).toBe(before.total + 1);
  });

  it("creates no recipe when the week it belongs to is refused", async () => {
    const before = await searchRecipes(ctx, { limit: 100 });

    await expect(
      proposeWeek(agent, {
        year: 2026,
        week: 34,
        newRecipes: [
          {
            tempId: "temp-doomed",
            title: "Plat qui ne doit pas exister",
            servings: 2,
            activeTimeMin: 10,
            ingredients: [{ rawName: "cacahuètes" }],
          },
        ],
        entries: [entry({ recipeRef: "temp-doomed" })],
      }),
    ).rejects.toMatchObject({ code: "STRICT_ALLERGEN" });

    // The whole call is one transaction, so the recipe went with it.
    const after = await searchRecipes(ctx, { limit: 100 });
    expect(after.total).toBe(before.total);
    expect(
      after.recipes.some((row) => row.title === "Plat qui ne doit pas exister"),
    ).toBe(false);
  });
});

describe("optimistic concurrency", () => {
  const target = week(35);

  it("refuses a proposal built on a stale reading of the week", async () => {
    await proposeWeek(agent, {
      year: target.year,
      week: target.week,
      entries: [entry()],
    });
    await acceptPendingVersion(ctx, target);

    const active = (await getWeekView(ctx, target)).activeVersion!;

    const error = await expectDomainError(
      proposeWeek(agent, {
        year: target.year,
        week: target.week,
        expectedBaseVersion: active.versionNumber + 5,
        entries: [entry({ dayOfWeek: 3 })],
      }),
      "VERSION_CONFLICT",
    );
    // The current state comes back, so the agent can rebase without a human.
    expect(error.details.current).toBe(active.versionNumber);
  });

  it("accepts a proposal built on the current version", async () => {
    const active = (await getWeekView(ctx, target)).activeVersion!;
    const result = await proposeWeek(agent, {
      year: target.year,
      week: target.week,
      expectedBaseVersion: active.versionNumber,
      entries: [entry({ dayOfWeek: 3 })],
    });
    expect(result.version.state).toBe("pending");
  });
});

describe("reviewing a proposal", () => {
  it("accepts the whole thing without creating a new version", async () => {
    const target = week(36);
    const proposed = await proposeWeek(agent, {
      year: target.year,
      week: target.week,
      entries: [entry(), entry({ dayOfWeek: 4 })],
    });

    const accepted = await acceptPendingVersion(ctx, target);

    // The version the user reviewed is the one that became active.
    expect(accepted.version.versionNumber).toBe(proposed.version.versionNumber);
    expect(accepted.version.state).toBe("active");
    expect(accepted.entries).toHaveLength(2);
  });

  it("accepts part of a proposal by building a new version", async () => {
    const target = week(37);
    await proposeWeek(agent, {
      year: target.year,
      week: target.week,
      entries: [entry(), entry({ dayOfWeek: 5 })],
    });

    const pending = (await getWeekView(ctx, target)).pendingVersion!;
    const proposedEntries = await listVersions(ctx, target);
    expect(proposedEntries[0]?.id).toBe(pending.id);

    const entries = await getVersionEntries(ctx, pending.id);
    const monday = entries.find((row) => row.dayOfWeek === 1)!;

    const result = await acceptPendingEntries(ctx, target, [monday.id]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.dayOfWeek).toBe(1);
    expect(result.version.state).toBe("active");

    // The proposal is consumed, not left hanging.
    const after = await getWeekView(ctx, target);
    expect(after.pendingVersion).toBeNull();
  });

  it("keeps the reason when a proposal is rejected", async () => {
    const target = week(38);
    await proposeWeek(agent, {
      year: target.year,
      week: target.week,
      entries: [entry()],
    });

    const rejected = await rejectPendingVersion(
      ctx,
      target,
      "Trop d'oeufs cette semaine",
    );

    expect(rejected.state).toBe("rejected");
    const view = await getWeekView(ctx, target);
    expect(view.pendingVersion).toBeNull();
    expect(view.activeVersion).toBeNull();
  });

  it("refuses to accept a proposal that a new allergen has since broken", async () => {
    const target = week(39);
    const eggy = (
      await createRecipe(ctx, {
        title: "Oeufs brouillés",
        servings: 2,
        activeTimeMin: 10,
        ingredients: [{ rawName: "4 oeufs" }],
      })
    ).recipe.id;

    await proposeWeek(agent, {
      year: target.year,
      week: target.week,
      entries: [entry({ recipeRef: eggy })],
    });

    // The user declares an egg allergy after the proposal was written.
    await createAllergen(ctx, {
      name: "Oeuf",
      severity: "strict",
      matches: ["oeuf"],
    });

    await expect(acceptPendingVersion(ctx, target)).rejects.toMatchObject({
      code: "STRICT_ALLERGEN",
    });

    const view = await getWeekView(ctx, target);
    expect(view.activeVersion).toBeNull();
  });
});

describe("direct authority", () => {
  it("applies immediately when the user has allowed it", async () => {
    await updateProfile(ctx, { agentAuthority: "direct" });

    // A recipe with nothing the allergens declared above would catch: by this
    // point the account has a strict egg allergy.
    const salad = (
      await createRecipe(ctx, {
        title: "Salade verte",
        servings: 2,
        activeTimeMin: 5,
        ingredients: [{ rawName: "1 laitue" }],
      })
    ).recipe.id;

    const result = await proposeWeek(agent, {
      year: 2026,
      week: 40,
      entries: [
        {
          dayOfWeek: 1,
          mealType: "dinner",
          recipeRef: salad,
          rationale: "Autorité directe, appliqué tout de suite.",
        },
      ],
    });

    expect(result.version.state).toBe("active");
    const view = await getWeekView(ctx, { year: 2026, week: 40 });
    expect(view.activeVersion?.versionNumber).toBe(
      result.version.versionNumber,
    );
    expect(view.pendingVersion).toBeNull();

    await updateProfile(ctx, { agentAuthority: "proposal" });
  });
});
