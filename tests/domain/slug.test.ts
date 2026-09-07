import { describe, expect, it } from "vitest";
import { slugify } from "@/domain/slug";
import { equipmentInputSchema, mealTypeInputSchema } from "@/domain/schemas";

describe("slugify", () => {
  it("folds French accents to their base letter", () => {
    expect(slugify("Dîner")).toBe("diner");
    expect(slugify("Petit-déjeuner")).toBe("petit_dejeuner");
    expect(slugify("Robot pâtissier")).toBe("robot_patissier");
    expect(slugify("Congélateur")).toBe("congelateur");
  });

  it("collapses every run of separators into one underscore", () => {
    expect(slugify("Petit  déjeuner")).toBe("petit_dejeuner");
    expect(slugify("Cocotte-minute")).toBe("cocotte_minute");
    expect(slugify("Friteuse à air")).toBe("friteuse_a_air");
  });

  it("leaves no leading or trailing separator", () => {
    expect(slugify("  Dîner  ")).toBe("diner");
    expect(slugify("-Dîner-")).toBe("diner");
    expect(slugify("(Dîner)")).toBe("diner");
  });

  it("caps at the forty characters the key columns allow", () => {
    const key = slugify("Déjeuner du dimanche avec toute la famille réunie");
    expect(key.length).toBeLessThanOrEqual(40);
    // And never ends on the separator the slice happened to land on.
    expect(key.endsWith("_")).toBe(false);
  });

  it("falls back rather than returning an empty key", () => {
    // Both key columns require `^[a-z0-9_]+$`, so an empty string is not a
    // key. The two call sites want different words for the fallback, which is
    // why it is a parameter rather than a constant in here.
    expect(slugify("!!!")).toBe("cle");
    expect(slugify("   ")).toBe("cle");
    expect(slugify("!!!", "repas")).toBe("repas");
    expect(slugify("!!!", "equipement")).toBe("equipement");
  });

  it("produces a key both schemas accept, for every label it is given", () => {
    // The reason this function moved into the domain: it was copied into two
    // components, so an MCP caller and a screen could derive different keys
    // from one label, and two keys for one label is two rows for one meal.
    const labels = [
      "Dîner",
      "Petit-déjeuner",
      "Brunch du dimanche",
      "Cocotte-minute",
      "Thermomètre de cuisson",
      "!!!",
      "Déjeuner du dimanche avec toute la famille réunie",
    ];

    for (const label of labels) {
      const key = slugify(label);
      expect(mealTypeInputSchema.shape.key.safeParse(key).success).toBe(true);
      expect(equipmentInputSchema.shape.key.safeParse(key).success).toBe(true);
    }
  });
});
