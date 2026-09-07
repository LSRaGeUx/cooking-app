import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import fr from "../messages/fr.json";
import { repoFiles, repoRoot } from "./helpers/files";

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
    .reduce<
      string | Tree | undefined
    >((node, key) => (typeof node === "object" ? node[key] : undefined), tree);
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
      expect(
        valueAt(english, path).trim(),
        `empty message at ${path}`,
      ).not.toBe("");
    }
  });

  it("reference every top-level section from somewhere in the application", () => {
    /*
     * A whole dead section is what actually accumulates. A single stale key is
     * cheap and hard to detect without resolving next-intl's namespaces
     * properly, but a namespace nothing ever asks for is a screen that was
     * removed and took nobody's copy with it.
     *
     * The check is a prefix match rather than an exact one, because a component
     * may narrow into a subtree: `useTranslations("recipes.form")` is a
     * reference to `recipes`.
     */
    const referenced = new Set<string>();
    for (const file of repoFiles("src")) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /(?:useTranslations|getTranslations)\(\s*"([^"]*)"/g,
      )) {
        if (match[1]) referenced.add(match[1]);
      }
    }

    // A scan that has gone blind would pass this without checking anything.
    expect(referenced.size).toBeGreaterThan(10);

    const orphaned = Object.keys(french).filter(
      (section) =>
        ![...referenced].some(
          (namespace) =>
            namespace === section || namespace.startsWith(`${section}.`),
        ),
    );

    expect(
      orphaned,
      "These catalogue sections are asked for by nothing in src/. Either a " +
        "screen was removed and its copy stayed, or a namespace was renamed " +
        "on one side only.",
    ).toEqual([]);
  });
});

/**
 * The em dash rule, over everything it actually covers.
 *
 * CLAUDE.md states it without qualification: never write an em dash in code, in
 * a comment, in a document or in UI copy. The check used to read the two message
 * catalogues and nothing else, which is the smallest possible fraction of the
 * surface: the specification is nine documents, the agent pack is four more that
 * an agent reads verbatim, and both the French sentences the services write and
 * the MCP tool descriptions are product copy that reaches a user or a model.
 *
 * Two carve-outs, both narrow and both explained where they are made.
 */
describe("the em dash rule", () => {
  const DOCUMENTS = [
    ...repoFiles("docs", [".md"]),
    ...repoFiles("public/agent-pack", [".md"]),
    join(repoRoot, "README.md"),
    join(repoRoot, "messages/fr.json"),
    join(repoRoot, "messages/en.json"),
  ];

  /**
   * The French copy the services write, and the tool and parameter descriptions
   * that steer an agent we do not run. Both are product copy, reviewed as
   * carefully as behaviour, so both are covered.
   */
  const COPY = [
    ...repoFiles("src/services"),
    ...repoFiles("src/mcp"),
    ...repoFiles("src/domain"),
  ];

  /**
   * An em dash inside a regular expression character class is a character being
   * matched, not one being written.
   *
   * `src/domain/ingredient-parser.ts` strips leading bullets from a pasted
   * ingredient block, and the class it strips lists the em dash alongside the
   * hyphen, the asterisk and the bullet, because a paste out of a web page
   * really does arrive with one in front of it. Taking it out of that class
   * would not honour the rule, it would break the parser on exactly the input
   * the rule has nothing to say about.
   */
  function withoutCharacterClasses(line: string): string {
    return line.replace(/\[[^\]]*\]/g, "[]");
  }

  /**
   * The block `next dev` writes into CLAUDE.md and re-adds on every run. It is
   * not ours to edit: removing the em dashes from it only re-creates the
   * uncommitted change, which the block itself says. Everything outside the
   * markers is ours and is checked.
   */
  function withoutGeneratedBlock(text: string): string {
    const start = text.indexOf("<!-- BEGIN:nextjs-agent-rules -->");
    const end = text.indexOf("<!-- END:nextjs-agent-rules -->");
    if (start === -1 || end === -1) return text;
    return text.slice(0, start) + text.slice(end);
  }

  function offendingLines(
    text: string,
    strip: (line: string) => string,
  ): string[] {
    return text
      .split("\n")
      .map((line, index) => ({ line: strip(line), number: index + 1 }))
      .filter((entry) => entry.line.includes("—"))
      .map((entry) => `${entry.number}: ${entry.line.trim()}`);
  }

  it("was pointed at the whole surface, not at two files", () => {
    // The guard on the sweep itself. A glob that matched nothing would make
    // every assertion below pass while checking no document at all.
    expect(DOCUMENTS.length).toBeGreaterThanOrEqual(15);
    expect(COPY.length).toBeGreaterThanOrEqual(20);
  });

  it.each(DOCUMENTS.map((path) => [relative(repoRoot, path), path] as const))(
    "%s contains no em dash",
    (label, path) => {
      const found = offendingLines(readFileSync(path, "utf8"), (line) => line);
      expect(found, `em dash in ${label}`).toEqual([]);
    },
  );

  it("CLAUDE.md contains no em dash outside the block next dev writes", () => {
    const text = withoutGeneratedBlock(
      readFileSync(join(repoRoot, "CLAUDE.md"), "utf8"),
    );
    expect(offendingLines(text, (line) => line)).toEqual([]);
  });

  it("no service or MCP source writes one, in copy or in a comment", () => {
    const offenders: string[] = [];
    for (const path of COPY) {
      const found = offendingLines(
        readFileSync(path, "utf8"),
        withoutCharacterClasses,
      );
      for (const line of found)
        offenders.push(`${relative(repoRoot, path)}:${line}`);
    }

    expect(
      offenders,
      "An em dash reached product copy. Use a full stop or a comma and start " +
        "a new clause.",
    ).toEqual([]);
  });

  it("still refuses one that hides inside a regex character class it did not write", () => {
    // The carve-out, tested rather than trusted, so it cannot be widened by
    // accident into "any line with a bracket in it".
    expect(withoutCharacterClasses('replace(/^[-*—]+/, "")')).not.toContain(
      "—",
    );
    expect(withoutCharacterClasses('const label = "voici — non";')).toContain(
      "—",
    );
    expect(withoutCharacterClasses('t("a[b]") + " — "')).toContain("—");
  });
});
