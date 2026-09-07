import { describe, expect, it } from "vitest";
import {
  assertPrepOrder,
  canServeFrom,
  checkBatchFriendly,
  checkPrepCapacity,
  totalServingsFor,
  type PrepEndpoint,
} from "@/domain/prep";
import { DomainError } from "@/domain/errors";
import { expectDomainErrorSync } from "../helpers";

function endpoint(overrides: Partial<PrepEndpoint> = {}): PrepEndpoint {
  return {
    entryId: "entry-1",
    dayOfWeek: 7,
    mealTypeLabel: "Dîner",
    recipeTitle: "Chili sin carne",
    servings: 4,
    batchFriendly: true,
    ...overrides,
  };
}

describe("canServeFrom", () => {
  it("allows a session on the same day or earlier", () => {
    // Cooking a big lunch and eating the rest at dinner is the commonest case
    // of all, so same-day is allowed rather than merely tolerated.
    expect(canServeFrom(2, 2)).toBe(true);
    expect(canServeFrom(1, 5)).toBe(true);
    expect(canServeFrom(6, 7)).toBe(true);
  });

  it("refuses a session after the meal that depends on it", () => {
    expect(canServeFrom(4, 2)).toBe(false);
    expect(canServeFrom(7, 1)).toBe(false);
  });

  it("agrees with assertPrepOrder, which is the point of it existing", () => {
    // The week grid used to re-implement this comparison inline to build its
    // list of candidate sources, so the list and the rule that rejects them
    // were two statements of the same thing.
    for (let source = 1; source <= 7; source += 1) {
      for (let dependent = 1; dependent <= 7; dependent += 1) {
        const throws = (): void => {
          assertPrepOrder(
            endpoint({ dayOfWeek: source }),
            endpoint({ entryId: "entry-2", dayOfWeek: dependent }),
          );
        };
        if (canServeFrom(source as 1, dependent as 1)) {
          expect(throws).not.toThrow();
        } else {
          expect(throws).toThrow(DomainError);
        }
      }
    }
  });
});

describe("assertPrepOrder", () => {
  it("names both days and offers a way out", () => {
    const error = expectDomainErrorSync(
      () =>
        assertPrepOrder(
          endpoint({ dayOfWeek: 4 }),
          endpoint({ entryId: "entry-2", dayOfWeek: 2 }),
        ),
      "PREP_LINK_ORDER",
    );
    expect(error.message).toContain("jeudi");
    expect(error.message).toContain("mardi");
    expect(error.details).toMatchObject({ sourceDay: 4, dependentDay: 2 });
  });
});

describe("checkPrepCapacity", () => {
  it("does not warn on an ordinary prep link", () => {
    // The regression this pins down: it used to warn on every single link,
    // because it compared `servings + drawn` against `servings` and then fired
    // whenever anything at all was drawn. The sentence told the user to raise
    // the source's servings to a total the grocery list had already shopped
    // for, and doing as it asked would have doubled the draws into the basket.
    expect(
      checkPrepCapacity(endpoint(), [
        {
          dependent: endpoint({ entryId: "entry-2", dayOfWeek: 2 }),
          servingsDrawn: 2,
        },
      ]),
    ).toBeNull();
  });

  it("does not warn when nothing is drawn either", () => {
    expect(checkPrepCapacity(endpoint(), [])).toBeNull();
  });
});

describe("totalServingsFor", () => {
  it("adds the draws to the session's own meal", () => {
    // The model: `entry.servings` is the meal, not the batch, and the grocery
    // list scales the source recipe by this sum.
    expect(totalServingsFor({ servings: 4 }, [{ servingsDrawn: 2 }])).toBe(6);
    expect(
      totalServingsFor({ servings: 2 }, [
        { servingsDrawn: 2 },
        { servingsDrawn: 3 },
      ]),
    ).toBe(7);
  });

  it("is the servings themselves when nothing is drawn", () => {
    expect(totalServingsFor({ servings: 3 }, [])).toBe(3);
  });
});

describe("checkBatchFriendly", () => {
  it("warns for a dish that does not keep, without refusing it", () => {
    const warning = checkBatchFriendly(endpoint({ batchFriendly: false }));
    expect(warning).toMatchObject({ code: "NOT_BATCH_FRIENDLY" });
  });

  it("says nothing about a dish that does", () => {
    expect(checkBatchFriendly(endpoint())).toBeNull();
  });
});
