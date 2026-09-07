import { describe, expect, it } from "vitest";
import { recipeSeal, sealClass, SEAL_COUNT } from "@/lib/recipe-seal";

/**
 * The seal is a derived colour, not a stored one, which is only safe while it
 * is stable: the same recipe has to keep its colour across the library, the
 * week and the shopping list, and across deploys. That is the property worth
 * pinning down.
 */
describe("recipeSeal", () => {
  it("is stable for the same id", () => {
    const id = "01a0588c-2e56-7993-a2ec-e976186e75e3";
    expect(recipeSeal(id)).toBe(recipeSeal(id));
  });

  it("stays inside the range the stylesheet defines", () => {
    for (let index = 0; index < 500; index += 1) {
      const seal = recipeSeal(`recipe-${index}`);
      expect(Number.isInteger(seal)).toBe(true);
      expect(seal).toBeGreaterThanOrEqual(0);
      expect(seal).toBeLessThan(SEAL_COUNT);
    }
  });

  it("spreads uuid-shaped ids across every hue", () => {
    // A hash that piles a real library into two colours would defeat the whole
    // point, so the spread is asserted rather than assumed.
    const used = new Set<number>();
    for (let index = 0; index < 200; index += 1) {
      used.add(
        recipeSeal(
          `01a0588c-2e56-7993-a2ec-e9761${String(index).padStart(5, "0")}`,
        ),
      );
    }
    expect(used.size).toBe(SEAL_COUNT);
  });

  it("names the class the stylesheet declares", () => {
    // Built from the constant, not hand-written as `[0-9]`. That literal baked
    // `SEAL_COUNT <= 10` into a file that imports SEAL_COUNT two lines up: an
    // eleventh hue would have kept this test green while `seal-10` named a
    // class the stylesheet does not declare.
    const indexes = Array.from({ length: SEAL_COUNT }, (_, index) => index);
    const declared = new RegExp(`^seal-(?:${indexes.join("|")})$`);

    for (let index = 0; index < 50; index += 1) {
      expect(sealClass(`recipe-${index}`)).toMatch(declared);
    }
  });
});
