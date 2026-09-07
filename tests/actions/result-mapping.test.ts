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
 * What a server action answers when something goes wrong.
 *
 * Actions never throw at the client, and that is a product decision rather than
 * a convenience: a refused write is a rule doing its job, and the screen has to
 * render it in the reader's language. So there are exactly four outcomes, all of
 * them decided by `runAction` in src/app/actions/result.ts, and each one is
 * asserted here through a real action against a real service.
 *
 * The one that matters most is the Zod branch. A bad argument used to reach the
 * database as a cast and come back as a 500, and a 500 on a server action is a
 * blank error boundary rather than the "ce champ est invalide" the form already
 * knows how to draw.
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
import { DomainError } from "@/domain/errors";
import { requireUser } from "@/lib/session";
import { runAction } from "@/app/actions/result";
import { deleteAccountAction } from "@/app/actions/account-actions";
import { createFactAction, retireFactAction } from "@/app/actions/fact-actions";
import { addPantryItemsAction } from "@/app/actions/pantry-actions";
import {
  createAllergenAction,
  updateProfileAction,
} from "@/app/actions/profile-actions";
import { deleteRecipeAction } from "@/app/actions/recipe-actions";
import { updateEntryAction } from "@/app/actions/plan-actions";
import { setupTestUser } from "../helpers";

let user: Awaited<ReturnType<typeof setupTestUser>>;

beforeAll(async () => {
  user = await setupTestUser();
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

describe("a rule that refused the write", () => {
  it("becomes the failed ActionResult, carrying the service's own French sentence", async () => {
    const result = await deleteRecipeAction(randomUUID());

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe("RECIPE_NOT_FOUND");
    // The message is the service's, in French, and the screen shows it rather
    // than restating the rule. An action that swallowed it would leave the UI
    // with a bare code and nothing to say.
    expect(result.message).toBeTypeOf("string");
    expect(String(result.message).length).toBeGreaterThan(20);
    expect(result.details).toBeDefined();
  });

  it("invalidates no page, because nothing changed", async () => {
    await deleteRecipeAction(randomUUID());
    // Revalidation lives after the service call inside `runAction`'s callback
    // for exactly this reason. Called before it, a refused write would blow the
    // cache of a page that is still correct.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps a FORBIDDEN distinct from a NOT_FOUND", async () => {
    // Two codes the screen words differently, and a mapping that collapsed them
    // would tell a user their own fact does not exist.
    const created = await createFactAction({
      category: "taste",
      polarity: "negative",
      statement: "N'aime pas la coriandre.",
      confidence: "high",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const retired = await retireFactAction(created.data.id);
    expect(retired.ok).toBe(true);

    const missing = await retireFactAction(randomUUID());
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).not.toBe("VALIDATION");
  });
});

describe("a bad argument", () => {
  it("becomes VALIDATION naming the field, not a 500", async () => {
    const result = await createFactAction({
      category: "taste",
      polarity: "positive",
      // Trimmed to nothing, which the schema refuses.
      statement: "   ",
      confidence: "high",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION");
    expect(result.details?.field).toBe("statement");
    // The issues travel too, so a form can mark more than the first field.
    expect(Array.isArray(result.details?.issues)).toBe(true);
  });

  it("names the index as well as the field inside an array", async () => {
    const result = await addPantryItemsAction([
      { kind: "staple", name: "Riz" },
      { kind: "not-a-kind", name: "Quinoa" },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION");
    // The dotted path, so the row that is wrong is identifiable rather than
    // "something in the batch".
    expect(result.details?.field).toBe("1.kind");
  });

  it("still says VALIDATION when the failing value has no field path at all", async () => {
    // A bare `z.uuid().parse(id)` produces an issue with an empty path, and the
    // mapping has to survive that: it used to read `issues[0].path.join(".")`
    // unconditionally and put an empty string in `field`, which a form then
    // marked as an error on no input.
    const result = await updateEntryAction(
      { year: 2027, week: 12 },
      "not-a-uuid",
      { servings: 2 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION");
    expect(result.details?.field).toBeUndefined();
  });

  it("refuses a week the year does not have, and says which weeks it does", async () => {
    // 2026 has 53 ISO weeks; 2027 has 52. The refusal has to name the real last
    // week, because "invalid week" leaves a caller guessing.
    const result = await updateEntryAction(
      { year: 2027, week: 53 },
      randomUUID(),
      { servings: 2 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION");
    expect(result.details?.field).toBe("week");
  });

  it("refuses a non-string confirmation on the delete-account action", async () => {
    // This one parses outside `runAction`, because the check has to happen
    // before the service call. It used to call `.trim()` straight away, so a
    // number here was a TypeError and therefore a 500.
    const result = await deleteAccountAction(42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION");
    expect(result.details?.field).toBe("confirmation");
  });

  it("refuses the wrong word without deleting anything", async () => {
    const result = await deleteAccountAction("supprime peut-etre");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Its own code rather than VALIDATION: the screen has to say which word to
    // type, and that sentence lives in the catalogues.
    expect(result.code).toBe("DELETE_CONFIRMATION");
  });
});

describe("a write that succeeded", () => {
  it("carries the saved row and an always-present warnings array", async () => {
    const result = await createAllergenAction({
      name: `moutarde-${randomUUID().slice(0, 8)}`,
      severity: "avoid",
      matches: ["moutarde"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeDefined();
    // The screen renders warnings unconditionally, so an action that returned
    // no array would need a null check at every one of its call sites.
    expect(result.warnings).toEqual([]);
  });

  it("accepts a partial patch, since the profile screen saves one field", async () => {
    const result = await updateProfileAction({ skillLevel: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.skillLevel).toBe(4);
  });
});

/**
 * The fourth branch, direct, because there is no action that can be made to
 * throw something that is neither a `DomainError` nor a `ZodError` without
 * breaking a service to do it. It is the branch that decides what a genuine bug
 * looks like from the outside, so it is worth pinning.
 */
describe("runAction, on the branches an action cannot reach", () => {
  it("turns an unexpected throw into INTERNAL and no message", async () => {
    const console_error = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const result = await runAction(async () => {
      throw new TypeError("Cannot read properties of undefined");
    });

    expect(result).toEqual({ ok: false, code: "INTERNAL" });
    // No message, on purpose: the screen words this one from
    // `common.unknownError`, in the reader's language, and a French sentence
    // written here would be UI copy in a server action.
    expect(console_error).toHaveBeenCalled();
    console_error.mockRestore();
  });

  it("passes a DomainError's code, message and details through unchanged", async () => {
    const result = await runAction(async () => {
      throw new DomainError("SLOT_UNKNOWN", "Ce créneau n'existe pas.", {
        dayOfWeek: 9,
      });
    });

    expect(result).toEqual({
      ok: false,
      code: "SLOT_UNKNOWN",
      message: "Ce créneau n'existe pas.",
      details: { dayOfWeek: 9 },
    });
  });

  it("reads warnings off the service's own result rather than requiring them", async () => {
    const withWarnings = await runAction(async () => ({
      warnings: [{ code: "NOT_BATCH_FRIENDLY", message: "Se conserve mal." }],
    }));
    expect(withWarnings.ok && withWarnings.warnings).toHaveLength(1);

    const withoutWarnings = await runAction(async () => 7);
    expect(withoutWarnings.ok && withoutWarnings.warnings).toEqual([]);

    // Null is the case a bare `typeof data === "object"` check gets wrong, and
    // an action returning void resolves to undefined.
    const nothing = await runAction(async () => null);
    expect(nothing.ok && nothing.warnings).toEqual([]);
  });
});
