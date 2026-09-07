import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type McpCallerContext } from "@/mcp/server";
import { MCP_SCOPES } from "@/lib/scopes";

/**
 * The shape of the agent surface, checked by listing it.
 *
 * Nothing used to import a single file from `src/mcp/tools/`. Only the runner
 * was covered, so the 20 tools and 8 resources were pinned by exactly one thing:
 * `npm run verify:oauth`, a script that needs a live HTTP server and which CI
 * therefore never runs. A renamed parameter, a dropped registration or a tool
 * answering in a different naming convention all passed.
 *
 * These tests need neither a server nor a database. `buildServer` is stateless
 * and the SDK's in-memory transport pairs a client to it directly, so listing
 * the surface is a pure function of the code. The handlers themselves are
 * exercised in tools.test.ts, which does need a database.
 */

const caller: McpCallerContext = {
  userId: randomUUID(),
  clientId: `surface-${randomUUID()}`,
  // Everything, so nothing is hidden behind a scope check while we enumerate.
  scopes: new Set(MCP_SCOPES),
};

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "surface-test", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    buildServer(caller).connect(serverTransport),
  ]);
  return client;
}

/** Every property name in a JSON Schema, at every depth. */
function propertyNames(schema: unknown, found: string[] = []): string[] {
  if (schema === null || typeof schema !== "object") return found;
  const node = schema as Record<string, unknown>;

  const properties = node.properties;
  if (properties && typeof properties === "object") {
    for (const [name, child] of Object.entries(properties)) {
      found.push(name);
      propertyNames(child, found);
    }
  }
  // `items` for arrays, and the union keywords, so a nested object inside an
  // array of objects is not missed. That is where three of the renamed
  // parameters lived.
  for (const key of ["items", "anyOf", "oneOf", "allOf"]) {
    const child = node[key];
    if (Array.isArray(child))
      child.forEach((entry) => propertyNames(entry, found));
    else if (child) propertyNames(child, found);
  }
  return found;
}

/** Every leaf schema that ought to carry a description. */
function describedProperties(
  schema: unknown,
  path: string[] = [],
  found: Array<{ path: string; described: boolean }> = [],
): Array<{ path: string; described: boolean }> {
  if (schema === null || typeof schema !== "object") return found;
  const node = schema as Record<string, unknown>;

  const properties = node.properties;
  if (properties && typeof properties === "object") {
    for (const [name, child] of Object.entries(properties)) {
      const childNode = (child ?? {}) as Record<string, unknown>;
      found.push({
        path: [...path, name].join("."),
        described:
          typeof childNode.description === "string" &&
          childNode.description.length > 0,
      });
      describedProperties(child, [...path, name], found);
    }
  }
  for (const key of ["items", "anyOf", "oneOf", "allOf"]) {
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach((entry) => describedProperties(entry, path, found));
    } else if (child) {
      describedProperties(child, path, found);
    }
  }
  return found;
}

describe("the tool surface", () => {
  it("registers every tool the interface documents", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    // Spelled out rather than counted. A count passes when one tool is dropped
    // and another added, which is exactly the change worth failing on.
    expect(names).toEqual(
      [
        "add_pantry_items",
        "check_feasibility",
        "create_recipe",
        "get_history",
        "get_pantry",
        "get_profile_snapshot",
        "get_recipe",
        "get_week",
        "import_recipe_from_url",
        "link_prep",
        "propose_week",
        "record_facts",
        "remove_pantry_item",
        "restore_fact",
        "restore_pantry_item",
        "retire_fact",
        "search_recipes",
        "update_recipe",
        "update_slot",
        "whoami",
      ].sort(),
    );
  });

  /**
   * The parameter naming rule, mechanically.
   *
   * Two conventions used to coexist: a tool that spread a domain Zod schema
   * inherited the domain's camelCase, while a tool that declared its own fields
   * used snake_case, and `update_recipe` managed both in one object. An agent
   * that learned `day_of_week` from `update_slot` sent it to `propose_week` and
   * got a validation error, which is a cost paid by the one party who cannot
   * read the source to work out why.
   */
  it("names every parameter in snake_case, at every depth", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    const offenders = tools.flatMap((tool) =>
      propertyNames(tool.inputSchema)
        .filter((name) => /[a-z0-9][A-Z]/.test(name))
        .map((name) => `${tool.name}.${name}`),
    );

    expect(
      offenders,
      "A camelCase parameter is back on the agent surface. The whole surface " +
        "is snake_case: map to the domain shape inside the handler instead of " +
        "spreading a domain schema's `.shape`.",
    ).toEqual([]);
  });

  /**
   * Descriptions are product copy here, not developer comments. They are the
   * only way to steer an agent we do not run, and three parameters shipped
   * without any.
   */
  it("describes every parameter", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    const undescribed = tools.flatMap((tool) =>
      describedProperties(tool.inputSchema)
        .filter((entry) => !entry.described)
        .map((entry) => `${tool.name}.${entry.path}`),
    );

    expect(undescribed).toEqual([]);
  });

  it("describes every tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const undescribed = tools
      .filter(
        (tool) => !tool.description || tool.description.trim().length === 0,
      )
      .map((tool) => tool.name);
    expect(undescribed).toEqual([]);
  });

  /**
   * The read and write split is what the scope model rests on. A tool that
   * writes must ask for a write scope, and the only place that is visible from
   * the outside is the tool's own registration.
   */
  it("keeps the write tools named, so a new one cannot arrive unnoticed", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const writeVerbs =
      /^(create|update|propose|record|retire|restore|add|remove|link|import)_/;
    const writers = tools
      .map((tool) => tool.name)
      .filter((name) => writeVerbs.test(name))
      .sort();

    expect(writers).toEqual([
      "add_pantry_items",
      "create_recipe",
      "import_recipe_from_url",
      "link_prep",
      "propose_week",
      "record_facts",
      "remove_pantry_item",
      "restore_fact",
      "restore_pantry_item",
      "retire_fact",
      "update_recipe",
      "update_slot",
    ]);
  });
});

describe("the resource surface", () => {
  it("registers the static resources and the templates", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resources.map((resource) => resource.uri).sort()).toEqual(
      [
        "cooking://history/recent",
        "cooking://pantry",
        "cooking://plan/current",
        "cooking://profile",
        "cooking://recipes/index",
        "cooking://slots",
      ].sort(),
    );

    expect(
      resourceTemplates.map((template) => template.uriTemplate).sort(),
    ).toEqual(["cooking://plan/{week}", "cooking://recipes/{id}"].sort());
  });

  it("gives every resource a mime type and a description", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    for (const resource of resources) {
      expect(resource.mimeType, resource.uri).toBeTruthy();
      expect(resource.description, resource.uri).toBeTruthy();
    }
  });
});

describe("the prompt surface", () => {
  it("serves the prompt pack", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      "plan_my_week",
      "weekly_review",
    ]);
  });
});
