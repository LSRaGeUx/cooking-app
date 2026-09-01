import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import fr from "../messages/fr.json";

/**
 * The two catalogues have to stay in step.
 *
 * A missing key does not crash next-intl loudly enough: it renders the key path
 * into the page, which is the kind of thing that ships. This test is the reason
 * the English translation is worth having at all, since it turns "no hardcoded
 * strings" from a convention into something enforced.
 */

type Tree = { [key: string]: string | Tree };

function paths(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof value === "string" ? [path] : paths(value, path);
  });
}

function valueAt(tree: Tree, path: string): string {
  const value = path
    .split(".")
    .reduce<string | Tree | undefined>(
      (node, key) => (typeof node === "object" ? node[key] : undefined),
      tree,
    );
  return typeof value === "string" ? value : "";
}

/** `{count}` and `{count, plural, ...}` both name the same placeholder. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*[,}]/g)]
    .map((match) => match[1] ?? "")
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();
}

const french = fr as Tree;
const english = en as Tree;

describe("the message catalogues", () => {
  it("hold exactly the same keys", () => {
    const frenchPaths = paths(french).sort();
    const englishPaths = paths(english).sort();

    const missingInEnglish = frenchPaths.filter(
      (path) => !englishPaths.includes(path),
    );
    const missingInFrench = englishPaths.filter(
      (path) => !frenchPaths.includes(path),
    );

    expect(missingInEnglish).toEqual([]);
    expect(missingInFrench).toEqual([]);
  });

  it("use the same placeholders in every message", () => {
    for (const path of paths(french)) {
      expect(
        placeholders(valueAt(english, path)),
        `placeholders differ in ${path}`,
      ).toEqual(placeholders(valueAt(french, path)));
    }
  });

  it("never leave an empty string as a translation", () => {
    for (const path of paths(english)) {
      expect(valueAt(english, path).trim(), `empty message at ${path}`).not.toBe(
        "",
      );
    }
  });

  it("contain no em dash, in either language", () => {
    // A project rule, and the kind of thing that only ever arrives by copy and
    // paste, so it is checked rather than remembered.
    for (const file of ["messages/fr.json", "messages/en.json"]) {
      expect(readFileSync(file, "utf8"), `em dash in ${file}`).not.toContain(
        "—",
      );
    }
  });
});
