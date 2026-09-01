import { describe, expect, it } from "vitest";
import {
  extractRecipe,
  parseIsoDuration,
  parseYield,
} from "@/domain/recipe-import";
import { isPublicAddress, safeFetch } from "@/lib/safe-fetch";

/**
 * Reading a recipe out of a page, and refusing to guess when there is none.
 *
 * The failure case matters as much as the success: a clean refusal is what
 * invites the user's agent to fetch the page itself, and a half-guessed recipe
 * would have to be corrected by hand instead.
 */

function page(head: string): string {
  return `<!doctype html><html><head>${head}</head><body><p>Bonjour</p></body></html>`;
}

function jsonLd(payload: unknown): string {
  return page(
    `<script type="application/ld+json">${JSON.stringify(payload)}</script>`,
  );
}

describe("reading schema.org JSON-LD", () => {
  it("reads a plain Recipe", () => {
    const outcome = extractRecipe(
      jsonLd({
        "@context": "https://schema.org",
        "@type": "Recipe",
        name: "Tarte aux pommes",
        description: "Une tarte simple",
        recipeYield: "6 parts",
        prepTime: "PT20M",
        cookTime: "PT40M",
        recipeCuisine: "Française",
        keywords: "dessert, pommes",
        recipeIngredient: ["200 g de farine", "3 pommes"],
        recipeInstructions: ["Étaler la pâte.", "Enfourner 40 minutes."],
      }),
      "text/html; charset=utf-8",
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.recipe).toMatchObject({
      title: "Tarte aux pommes",
      servings: 6,
      prepTimeMin: 20,
      cookTimeMin: 40,
      cuisine: "Française",
    });
    expect(outcome.recipe.tags).toEqual(["dessert", "pommes"]);
    // Ingredient lines go through the same parser as a pasted block.
    expect(outcome.recipe.ingredients[0]).toMatchObject({
      quantity: 200,
      unit: "g",
      rawName: "farine",
    });
    expect(outcome.recipe.steps).toHaveLength(2);
  });

  it("never guesses the attended time, which no site publishes", () => {
    const outcome = extractRecipe(
      jsonLd({
        "@type": "Recipe",
        name: "Ragoût",
        cookTime: "PT2H",
        recipeIngredient: ["1 kg de boeuf"],
      }),
      "text/html",
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Two hours of oven is not two hours of the cook's evening, and this field
    // is what the slot budget compares against.
    expect(outcome.recipe.activeTimeMin).toBeNull();
    expect(outcome.recipe.cookTimeMin).toBe(120);
  });

  it("finds a Recipe buried in an @graph", () => {
    const outcome = extractRecipe(
      jsonLd({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebSite", name: "Un blog" },
          {
            "@type": ["Recipe", "Thing"],
            name: "Soupe",
            recipeIngredient: ["1 courge"],
          },
        ],
      }),
      "text/html",
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.recipe.title).toBe("Soupe");
  });

  it("reads HowToStep instructions", () => {
    const outcome = extractRecipe(
      jsonLd({
        "@type": "Recipe",
        name: "Pâtes",
        recipeIngredient: ["300 g de pâtes"],
        recipeInstructions: [
          { "@type": "HowToStep", text: "Faire bouillir l'eau." },
          { "@type": "HowToStep", text: "Cuire 10 minutes." },
        ],
      }),
      "text/html",
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.recipe.steps.map((step) => step.text)).toEqual([
        "Faire bouillir l'eau.",
        "Cuire 10 minutes.",
      ]);
    }
  });

  it("ignores a malformed block and keeps looking", () => {
    const html = page(
      `<script type="application/ld+json">{ not json </script>` +
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "Recipe",
          name: "Trouvée quand même",
          recipeIngredient: ["sel"],
        })}</script>`,
    );

    const outcome = extractRecipe(html, "text/html");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.recipe.title).toBe("Trouvée quand même");
  });
});

describe("reading microdata when there is no JSON-LD", () => {
  it("falls back to itemprop attributes", () => {
    const html = `<!doctype html><html><body>
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Omelette</h1>
        <span itemprop="recipeYield">2 portions</span>
        <li itemprop="recipeIngredient">3 oeufs</li>
        <li itemprop="recipeIngredient">sel</li>
        <p itemprop="recipeInstructions">Battre et cuire.</p>
      </div></body></html>`;

    const outcome = extractRecipe(html, "text/html");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.recipe.title).toBe("Omelette");
    expect(outcome.recipe.servings).toBe(2);
    expect(outcome.recipe.ingredients).toHaveLength(2);
  });
});

describe("refusing to guess", () => {
  it("reports a page with no structured recipe", () => {
    const outcome = extractRecipe(
      page("<title>Un blog de cuisine</title>"),
      "text/html",
    );
    expect(outcome).toEqual({ ok: false, reason: "no-recipe-found" });
  });

  it("refuses content that is not a page", () => {
    expect(extractRecipe("{}", "application/json")).toEqual({
      ok: false,
      reason: "not-html",
    });
  });

  it("refuses an empty body", () => {
    expect(extractRecipe("   ", "text/html")).toEqual({
      ok: false,
      reason: "empty",
    });
  });
});

describe("the awkward small formats", () => {
  it("reads ISO durations", () => {
    expect(parseIsoDuration("PT1H30M")).toBe(90);
    expect(parseIsoDuration("PT45M")).toBe(45);
    expect(parseIsoDuration("PT0M")).toBeNull();
    expect(parseIsoDuration("bientôt")).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });

  it("reads a serving count out of whatever the site wrote", () => {
    expect(parseYield("4")).toBe(4);
    expect(parseYield("Pour 6 personnes")).toBe(6);
    expect(parseYield(["8 parts"])).toBe(8);
    // Two is the app's own default rather than a guess at the page's meaning.
    expect(parseYield("beaucoup")).toBe(2);
    expect(parseYield(undefined)).toBe(2);
  });
});

describe("the fetcher itself, before it touches the network", () => {
  it("refuses a loopback URL", async () => {
    // No request is made: the address is rejected after resolution and before
    // a socket is opened, which is the whole point.
    await expect(safeFetch("http://127.0.0.1:3000/", "recipe-import")).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
  });

  it("refuses the cloud metadata address", async () => {
    await expect(
      safeFetch("http://169.254.169.254/latest/meta-data/", "recipe-import"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a scheme that is not http or https", async () => {
    await expect(
      safeFetch("file:///etc/passwd", "recipe-import"),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      safeFetch("gopher://example.test/", "recipe-import"),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses something that is not a URL", async () => {
    await expect(
      safeFetch("pas une adresse", "recipe-import"),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("the addresses the fetcher will refuse", () => {
  it("refuses loopback, private ranges and cloud metadata", () => {
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.1.2.3")).toBe(false);
    expect(isPublicAddress("172.16.0.1")).toBe(false);
    expect(isPublicAddress("192.168.1.1")).toBe(false);
    // The one that matters most: cloud instance metadata.
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("100.64.0.1")).toBe(false);
    expect(isPublicAddress("0.0.0.0")).toBe(false);
    expect(isPublicAddress("224.0.0.1")).toBe(false);
  });

  it("refuses the IPv6 equivalents, including a mapped IPv4", () => {
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fd00::1")).toBe(false);
    expect(isPublicAddress("fe80::1")).toBe(false);
    // An IPv4 loopback wearing an IPv6 hat is still a loopback.
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  });

  it("allows ordinary public addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("refuses anything that is not an address at all", () => {
    expect(isPublicAddress("localhost")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});
