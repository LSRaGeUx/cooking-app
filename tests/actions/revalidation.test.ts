import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Every path a server action invalidates has to be a path a route actually
 * renders, and `revalidatePath` will not tell you when it is not.
 *
 * It takes a string, matches it against the route tree, and returns undefined
 * whether or not anything matched. So `revalidatePath("/courses/2026-W37")`, a
 * path no route in this application ever produces, was a silent no-op: the
 * grocery screen kept showing ingredients a prep link had just merged away, and
 * because the action returned success the bug looked like a service bug. It
 * shipped, and this file is why it cannot ship twice.
 *
 * Two things are asserted. Generically, that every path any action passes
 * resolves against the route tree read off disk, with the `type` argument the
 * Next 16 documentation requires for a dynamic pattern and forbids for a literal
 * path. Specifically, that the grocery route is keyed by the date a shopping
 * cycle starts on, which is what the shipped defect got wrong: a cycle can
 * straddle a Sunday, so it is not an ISO week and cannot be named by one.
 */

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(),
  getCurrentSession: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT;replace;${to};307;`);
  }),
}));

import { revalidatePath } from "next/cache";
import { parseCycleStart } from "@/domain/shopping";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import { agentContext } from "@/services/context";
import { proposeWeek } from "@/services/plan-service";
import { getWeekView } from "@/services/plan-queries";
import { createRecipe } from "@/services/recipe-service";
import { createAllergenAction } from "@/app/actions/profile-actions";
import { setSlotConfigAction } from "@/app/actions/slot-actions";
import { addPantryItemsAction } from "@/app/actions/pantry-actions";
import { createFactAction } from "@/app/actions/fact-actions";
import { createRecipeAction } from "@/app/actions/recipe-actions";
import { assignRecipeAction } from "@/app/actions/plan-actions";
import { linkPrepAction } from "@/app/actions/prep-actions";
import { generateGroceryListAction } from "@/app/actions/grocery-actions";
import { rejectProposalAction } from "@/app/actions/proposal-actions";
import {
  applyBudgetSuggestionAction,
  recordFeedbackAction,
} from "@/app/actions/feedback-actions";
import { revokeClientAction } from "@/app/actions/agent-actions";
import { MCP_SCOPES } from "@/lib/scopes";
import { cycleOf, seedAgentConsent, setupTestUser } from "../helpers";

/* ------------------------------------------------------------------ *
 * The route tree, read off disk.
 * ------------------------------------------------------------------ */

const APP_DIR = join(import.meta.dirname, "..", "..", "src", "app");

/**
 * `src/app/(app)/semaine/[week]/page.tsx` becomes `/semaine/[week]`.
 *
 * Route groups are dropped, because they organise files and never appear in a
 * URL. The docs note that `revalidatePath` accepts either spelling for a
 * grouped route, so both are accepted here.
 */
function routes(kind: "page" | "layout"): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (name !== `${kind}.tsx` && name !== `${kind}.ts`) continue;
      const segments = relative(APP_DIR, path)
        .split(sep)
        .slice(0, -1)
        .filter((segment) => !segment.startsWith("("));
      found.push(`/${segments.join("/")}`.replace(/\/+$/, "") || "/");
    }
  }

  walk(APP_DIR);
  return found.sort();
}

const PAGES = routes("page");
const LAYOUTS = routes("layout");

/** A literal path matches a pattern when a dynamic segment eats one segment. */
function matchesPattern(literal: string, pattern: string): boolean {
  const left = literal.split("/");
  const right = pattern.split("/");
  if (left.length !== right.length) return false;
  return right.every((segment, index) =>
    segment.startsWith("[")
      ? (left[index] ?? "") !== ""
      : segment === left[index],
  );
}

/**
 * Why a `revalidatePath` call would not have invalidated anything, or null when
 * it would have. The message is the whole value of this file, so it names the
 * closest route rather than only refusing.
 */
function reasonItWouldNotMatch(
  path: string,
  type?: "page" | "layout",
): string | null {
  if (path.length > 1024)
    return "longer than the 1024 characters the docs allow";

  const isPattern = path.includes("[");

  // The one documented exception: `revalidatePath("/", "layout")` is the
  // "invalidate everything" idiom, and the root layout is a real file.
  if (path === "/" && type === "layout") return null;

  if (isPattern && type === undefined) {
    return "a path with a dynamic segment requires an explicit page or layout type";
  }
  if (!isPattern && type !== undefined) {
    return `a literal path takes no type, and this passed "${type}"`;
  }

  if (type === "layout") {
    return LAYOUTS.includes(path)
      ? null
      : `no layout.tsx renders it. The layouts are ${LAYOUTS.join(", ")}`;
  }

  if (type === "page") {
    return PAGES.includes(path)
      ? null
      : `no page.tsx is at that pattern. The closest are ${
          PAGES.filter((page) =>
            page.startsWith(`/${path.split("/")[1] ?? ""}`),
          ).join(", ") || "none in that segment"
        }`;
  }

  const matched = PAGES.some((page) => matchesPattern(path, page));
  return matched
    ? null
    : `no route pattern matches it. The patterns in that segment are ${
        PAGES.filter((page) =>
          page.startsWith(`/${path.split("/")[1] ?? ""}`),
        ).join(", ") || "none"
      }`;
}

/** Everything `revalidatePath` was asked to invalidate since the last reset. */
function invalidated(): { path: string; type?: "page" | "layout" }[] {
  return vi.mocked(revalidatePath).mock.calls.map(([path, type]) => ({
    path: String(path),
    ...(type === undefined ? {} : { type: type as "page" | "layout" }),
  }));
}

function expectEveryPathReal(): { path: string; type?: "page" | "layout" }[] {
  const calls = invalidated();
  expect(calls.length, "the action invalidated nothing at all").toBeGreaterThan(
    0,
  );
  for (const call of calls) {
    const reason = reasonItWouldNotMatch(call.path, call.type);
    expect(
      reason,
      `revalidatePath("${call.path}"${
        call.type ? `, "${call.type}"` : ""
      }) invalidates nothing: ${reason}`,
    ).toBeNull();
  }
  return calls;
}

/* ------------------------------------------------------------------ *
 * The account and the week these actions run against.
 * ------------------------------------------------------------------ */

const week: IsoWeek = { year: 2027, week: 15 };
let user: Awaited<ReturnType<typeof setupTestUser>>;
let stewId = "";
let clientId = "";

beforeAll(async () => {
  user = await setupTestUser();

  stewId = (
    await createRecipe(user.ctx, {
      title: "Boeuf aux carottes",
      servings: 4,
      activeTimeMin: 40,
      batchFriendly: true,
      ingredients: [
        { rawName: "boeuf", quantity: 800, unit: "g" },
        { rawName: "carotte", quantity: 4 },
      ],
    })
  ).recipe.id;

  clientId = `revalidation-${randomUUID()}`;
  await seedAgentConsent(user.ctx, clientId, [...MCP_SCOPES]);
});

afterAll(async () => {
  await user.cleanup();
});

beforeEach(() => {
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(requireUser).mockResolvedValue({
    user: {
      id: user.ctx.userId,
      email: `${user.ctx.userId}@example.test`,
      name: "Test",
    },
    ctx: user.ctx,
  });
});

/* ------------------------------------------------------------------ *
 * The route tree itself, so a failure below is readable.
 * ------------------------------------------------------------------ */

describe("the route tree this file checks against", () => {
  it("was read off disk and holds the screens the actions name", () => {
    expect(PAGES).toContain("/semaine/[week]");
    expect(PAGES).toContain("/semaine/[week]/bilan");
    expect(PAGES).toContain("/semaine/[week]/proposition");
    expect(PAGES).toContain("/courses/[cycle]");
    expect(PAGES).toContain("/recettes/[id]");
    expect(PAGES).toContain("/agent/activite");
    expect(LAYOUTS).toContain("/");
  });

  it("would catch the path that shipped", () => {
    // The regression itself, run through the matcher rather than described. An
    // ISO week is not a cycle start, but `/courses/2026-W37` is one segment
    // under `/courses/[cycle]`, so a matcher that only counted segments would
    // call it valid: the specific assertion further down is what catches it.
    expect(reasonItWouldNotMatch("/semaine", "layout")).not.toBeNull();
    expect(reasonItWouldNotMatch("/courses/[cycle]")).not.toBeNull();
    expect(reasonItWouldNotMatch("/placards/inexistant")).not.toBeNull();
    expect(reasonItWouldNotMatch("/courses/[cycle]", "page")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * One block per action group.
 * ------------------------------------------------------------------ */

describe("the profile actions", () => {
  it("invalidate the profile screen and the agent-facing overview", async () => {
    const result = await createAllergenAction({
      name: `celeri-${randomUUID().slice(0, 8)}`,
      severity: "avoid",
      matches: ["céleri"],
    });
    expect(result.ok).toBe(true);

    const paths = expectEveryPathReal().map((call) => call.path);
    expect(paths).toContain("/profil");
    // The overview is what the snapshot resource renders from, so a profile
    // change that left it stale would hand an agent last week's constraints.
    expect(paths).toContain("/profil/apercu");
  });
});

describe("the slot actions", () => {
  it("invalidate the three week screens by pattern, not by segment", async () => {
    const result = await setSlotConfigAction({
      dayOfWeek: 2,
      mealTypeId: user.dinnerId,
      state: "planned",
      timeBudgetMin: 30,
      defaultServings: 2,
    });
    expect(result.ok).toBe(true);

    const calls = expectEveryPathReal();
    // The correction the audit made: this said `revalidatePath("/semaine",
    // "layout")`, and "/semaine" has neither a page nor a layout of its own, so
    // a renamed meal type kept its old label until something else happened to
    // revalidate. The pattern form is what reaches every week at once.
    expect(calls).toContainEqual({ path: "/semaine/[week]", type: "page" });
    expect(calls).toContainEqual({
      path: "/semaine/[week]/bilan",
      type: "page",
    });
    expect(calls).toContainEqual({
      path: "/semaine/[week]/proposition",
      type: "page",
    });
    expect(calls.map((call) => call.path)).toContain("/creneaux");
  });
});

describe("the pantry and fact actions", () => {
  it("invalidate their own screen and the overview", async () => {
    const pantry = await addPantryItemsAction([
      { kind: "staple", name: "Riz complet" },
    ]);
    expect(pantry.ok).toBe(true);
    expect(expectEveryPathReal().map((call) => call.path)).toEqual([
      "/placards",
      "/profil/apercu",
    ]);

    vi.mocked(revalidatePath).mockClear();
    const fact = await createFactAction({
      category: "organization",
      polarity: "neutral",
      statement: "Fait le marché le samedi matin.",
      confidence: "medium",
    });
    expect(fact.ok).toBe(true);
    expect(expectEveryPathReal().map((call) => call.path)).toEqual([
      "/faits",
      "/profil/apercu",
    ]);
  });
});

describe("the recipe actions", () => {
  it("invalidate the library and the detail page of the recipe that changed", async () => {
    const result = await createRecipeAction({
      title: "Soupe de potimarron",
      servings: 4,
      activeTimeMin: 25,
      ingredients: [{ rawName: "potimarron", quantity: 1 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = expectEveryPathReal().map((call) => call.path);
    expect(paths).toContain("/recettes");
    // The literal detail path, so the id has to be in it. A delete used to
    // invalidate only the library, and the detail page kept rendering without
    // the "supprimée" chip that is the only sign the recipe is on its way out.
    expect(paths).toContain(`/recettes/${result.data.recipe.id}`);
  });
});

describe("the planning actions", () => {
  it("invalidate the one week they wrote to, by its literal path", async () => {
    const result = await assignRecipeAction(week, {
      dayOfWeek: 1,
      mealTypeId: user.dinnerId,
      recipeId: stewId,
    });
    expect(result.ok).toBe(true);

    const calls = expectEveryPathReal();
    // A literal path and therefore no type, which is what the docs require: a
    // write touches exactly one week, and the pattern form would invalidate
    // every week the user has ever planned.
    expect(calls).toEqual([{ path: `/semaine/${formatIsoWeek(week)}` }]);
    expect(formatIsoWeek(week)).toBe("2027-W15");
  });
});

describe("the prep actions", () => {
  it("invalidate the grocery route by pattern, because a cycle is not a week", async () => {
    await assignRecipeAction(week, {
      dayOfWeek: 4,
      mealTypeId: user.dinnerId,
      recipeId: stewId,
    });

    const view = await getWeekView(user.ctx, week);
    const monday = view.entries.find((row) => row.dayOfWeek === 1);
    const thursday = view.entries.find((row) => row.dayOfWeek === 4);
    expect(monday).toBeDefined();
    expect(thursday).toBeDefined();
    if (!monday || !thursday) return;

    vi.mocked(revalidatePath).mockClear();
    const result = await linkPrepAction(week, monday.id, thursday.id);
    expect(result.ok).toBe(true);

    const calls = expectEveryPathReal();
    expect(calls).toContainEqual({ path: `/semaine/${formatIsoWeek(week)}` });

    /*
     * This is the shipped defect, pinned.
     *
     * The action used to compute `/courses/${formatIsoWeek(week)}`, giving
     * `/courses/2026-W37`. Which cycle covers a week depends on the profile's
     * shopping day, and a cycle can straddle a Sunday, so no ISO week names one.
     * Rather than read the profile to compute a single literal path, the route
     * pattern is invalidated: correct whichever cycle the week falls in, and a
     * grocery page is cheap to rebuild.
     */
    expect(calls).toContainEqual({ path: "/courses/[cycle]", type: "page" });
    for (const call of calls) {
      if (!call.path.startsWith("/courses/")) continue;
      const segment = call.path.slice("/courses/".length);
      if (segment === "[cycle]") continue;
      expect.fail(
        `The grocery route is keyed by a cycle start date, and this ` +
          `invalidated the literal path "${call.path}". "${segment}" is not a ` +
          "date, so it matches no cache entry and the shopping list stays stale.",
      );
    }
  });
});

describe("the grocery actions", () => {
  it("invalidate the literal list they generated, keyed by its cycle start date", async () => {
    const cycle = cycleOf(week);
    const result = await generateGroceryListAction(cycle);
    expect(result.ok).toBe(true);

    const calls = expectEveryPathReal();
    expect(calls).toEqual([{ path: `/courses/${cycle}` }]);

    // And the segment really is a date the route can parse back, which is the
    // property the prep action got wrong in the other direction.
    const segment = calls[0]?.path.slice("/courses/".length) ?? "";
    expect(parseCycleStart(segment)).not.toBeNull();
    expect(segment).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("do not invalidate on a ticked checkbox", async () => {
    // Deliberate, and worth pinning so nobody "fixes" it: ticking a line happens
    // one-handed in a shop on a bad connection, and re-rendering the page under
    // the user's thumb for every checkbox is the wrong trade.
    const { setLineCheckedAction } = await import(
      "@/app/actions/grocery-actions"
    );
    await setLineCheckedAction(randomUUID(), true);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("the proposal actions", () => {
  it("invalidate the week and the review screen", async () => {
    const target: IsoWeek = { year: 2027, week: 16 };
    const agent = agentContext(user.ctx.userId, clientId);
    await proposeWeek(agent, {
      year: target.year,
      week: target.week,
      entries: [
        {
          dayOfWeek: 3,
          mealType: "dinner",
          recipeRef: stewId,
          rationale: "Mercredi est le créneau le plus contraint de la semaine.",
        },
      ],
    });

    vi.mocked(revalidatePath).mockClear();
    const result = await rejectProposalAction(target, "Trop long à cuisiner.");
    expect(result.ok).toBe(true);

    const paths = expectEveryPathReal().map((call) => call.path);
    expect(paths).toContain(`/semaine/${formatIsoWeek(target)}`);
    expect(paths).toContain(`/semaine/${formatIsoWeek(target)}/proposition`);
  });
});

describe("the feedback actions", () => {
  it("invalidate the week and its review", async () => {
    const view = await getWeekView(user.ctx, week);
    const entry = view.entries.find((row) => row.dayOfWeek === 1);
    expect(entry).toBeDefined();
    if (!entry) return;

    vi.mocked(revalidatePath).mockClear();
    const result = await recordFeedbackAction(week, entry.id, {
      outcome: "cooked",
      rating: 4,
    });
    expect(result.ok).toBe(true);

    const paths = expectEveryPathReal().map((call) => call.path);
    expect(paths).toContain(`/semaine/${formatIsoWeek(week)}`);
    expect(paths).toContain(`/semaine/${formatIsoWeek(week)}/bilan`);
  });

  it("invalidate every week when a time budget is accepted, not one of them", async () => {
    const result = await applyBudgetSuggestionAction(
      { dayOfWeek: 6, mealTypeId: user.dinnerId },
      75,
    );
    expect(result.ok).toBe(true);

    const calls = expectEveryPathReal();
    // A budget is a property of a slot and applies to every week, so the
    // pattern form is right here and the literal form was wrong.
    expect(calls).toContainEqual({ path: "/semaine/[week]", type: "page" });
    expect(calls).toContainEqual({
      path: "/semaine/[week]/bilan",
      type: "page",
    });
    expect(calls.map((call) => call.path)).toContain("/creneaux");
  });
});

describe("the agent actions", () => {
  it("invalidate both agent screens on a revoke", async () => {
    const result = await revokeClientAction(clientId);
    expect(result.ok).toBe(true);

    expect(expectEveryPathReal().map((call) => call.path)).toEqual([
      "/agent",
      "/agent/activite",
    ]);
  });
});
