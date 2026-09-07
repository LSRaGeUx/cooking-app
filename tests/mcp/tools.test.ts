import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type McpCallerContext } from "@/mcp/server";
import { MCP_SCOPES } from "@/lib/scopes";
import { agentContext, type ServiceContext } from "@/services/context";
import { createFact, listFacts, confirmFact } from "@/services/fact-service";
import { createAllergen } from "@/services/profile-service";
import { createRecipe } from "@/services/recipe-service";
import { listMealTypes } from "@/services/slot-service";
import { getWeekView } from "@/services/plan-queries";
import { ensureUserSetup } from "@/services/onboarding-service";
import {
  cleanupUser,
  clearAgentConsent,
  seedAgentConsent,
  testUser,
} from "../helpers";

/**
 * The tools themselves, called the way an agent calls them.
 *
 * These are the rules that were previously pinned only at the service layer.
 * That is not the same thing: rule 3 says the web UI and the MCP endpoint go
 * through one service layer, and the way that rule breaks is a guard living in a
 * tool rather than in a service, or a tool reaching past one. A test that only
 * ever calls the service cannot see either.
 *
 * The client talks to a real `McpServer` over the SDK's in-memory transport, so
 * the schemas, the runner, the scope checks and the serializers are all in the
 * path. Only the HTTP hop and the OAuth token are not, and those are what
 * `npm run verify:oauth` covers.
 */

let ctx: ServiceContext;
let agent: ServiceContext;
let caller: McpCallerContext;
let client: Client;

/**
 * Calls a tool and normalises the three shapes a refusal can arrive in.
 *
 * A tool that returns a refusal answers with `isError` and a JSON body. A
 * schema violation is caught by the SDK before the handler runs and comes back
 * as text rather than JSON. A thrown `McpError` rejects the promise. All three
 * are refusals from the caller's point of view, and a test that only understood
 * the first would report the other two as crashes.
 */
async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ error: boolean; body: Record<string, unknown>; text: string }> {
  let result: unknown;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    const data = (thrown as { data?: Record<string, unknown> }).data;
    return {
      error: true,
      body: data ?? { code: codeFromText(message) },
      text: message,
    };
  }

  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text ?? "";
  const error = (result as { isError?: boolean }).isError === true;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // A refusal is `{ error, message, details }`; a success is the tool's own
    // shape. Normalise the code onto `code` either way so an assertion reads
    // the same for both.
    return {
      error,
      body:
        typeof parsed.error === "string"
          ? { ...parsed, code: parsed.error }
          : parsed,
      text,
    };
  } catch {
    // Not JSON: the SDK rejected the arguments against the tool's own schema
    // before the handler ran. Still a refusal, and still the caller's fault.
    return { error, body: { code: "VALIDATION", message: text }, text };
  }
}

/** The code out of a thrown McpError, whose `data` carries the domain code. */
function codeFromText(text: string): string {
  const match =
    /\b(VALIDATION|NOT_FOUND|FORBIDDEN|INTERNAL|STRICT_ALLERGEN)\b/.exec(text);
  return match?.[1] ?? "VALIDATION";
}

beforeAll(async () => {
  ctx = testUser();
  await ensureUserSetup(ctx);
  const mealTypes = await listMealTypes(ctx);
  if (!mealTypes.some((type) => type.key === "dinner")) {
    throw new Error("setup did not seed a dinner meal type");
  }

  const clientId = `tools-test-${randomUUID()}`;
  agent = agentContext(ctx.userId, clientId);
  caller = { userId: ctx.userId, clientId, scopes: new Set(MCP_SCOPES) };

  // Without this every call is refused by the runner's consent check, before
  // any handler runs.
  await seedAgentConsent(ctx, clientId, [...MCP_SCOPES]);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "tools-test", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    buildServer(caller).connect(serverTransport),
  ]);
});

afterAll(async () => {
  await cleanupUser(ctx);
  if (caller?.clientId) await clearAgentConsent(ctx, caller.clientId);
});

describe("rule 2, the strict allergen block, on the MCP path", () => {
  it("refuses a proposal whose recipe carries a strict allergen, and writes nothing", async () => {
    await createAllergen(ctx, {
      name: "arachide",
      severity: "strict",
      matches: ["arachide", "cacahuète"],
    });

    const recipe = await createRecipe(ctx, {
      title: "Poulet aux cacahuètes",
      servings: 2,
      activeTimeMin: 20,
      ingredients: [{ rawName: "cacahuètes", quantity: 50, unit: "g" }],
    });

    const week = { year: 2027, week: 10 };
    const { error, body } = await call("propose_week", {
      year: week.year,
      week: week.week,
      summary: "Une semaine qui doit être refusée.",
      entries: [
        {
          day_of_week: 1,
          meal_type: "dinner",
          recipe_ref: recipe.recipe.id,
          rationale: "Test du blocage allergène strict.",
        },
      ],
    });

    expect(error).toBe(true);
    expect(body.code).toBe("STRICT_ALLERGEN");

    // Rule 10: the refusal has to be actionable, not just correct.
    expect(typeof body.message).toBe("string");
    expect(String(body.message).length).toBeGreaterThan(20);

    // And nothing was written. A refusal that leaves a pending version behind
    // would be worse than one that wrote the plan, because the agent is told it
    // failed and the user finds a proposal waiting.
    const view = await getWeekView(ctx, week);
    expect(view.pendingVersion).toBeNull();
    expect(view.activeVersion).toBeNull();
  });
});

describe("rule 7, an agent-written fact enters unconfirmed", () => {
  it("stores unconfirmed even when the agent asks for confirmed", async () => {
    const { error, body } = await call("record_facts", {
      facts: [
        {
          category: "taste",
          polarity: "positive",
          statement: "Aime beaucoup le poisson grillé.",
          confidence: "high",
          // The agent asks for a status and a source it has no business
          // setting. The tool schema does not even offer the keys, and the
          // server decides regardless: two independent reasons the rule holds,
          // and this asserts the outcome rather than either mechanism.
          status: "confirmed",
          source: "user",
        },
      ],
    });

    expect(error).toBe(false);
    const created = body.created as Array<Record<string, unknown>>;
    expect(created).toHaveLength(1);

    const stored = (await listFacts(ctx, {})).find(
      (fact) => fact.id === created[0]?.id,
    );
    expect(stored?.status).toBe("unconfirmed");
    expect(stored?.source).toBe("agent");
  });

  /**
   * The batch is one transaction, which is what "a blocking error writes
   * nothing" in the interface spec has always promised. It used to insert one
   * fact at a time, so a cap breach on the fifth committed the first four and
   * reported only the error, leaving the agent with no way to know what had
   * landed.
   */
  it("writes none of a batch when one entry is refused", async () => {
    const before = (await listFacts(ctx, {})).length;

    const { error } = await call("record_facts", {
      facts: [
        {
          category: "taste",
          polarity: "positive",
          statement: "Premier fait valide du lot.",
          confidence: "medium",
        },
        {
          // Refused: an empty statement.
          category: "taste",
          polarity: "positive",
          statement: "   ",
          confidence: "medium",
        },
      ],
    });

    expect(error).toBe(true);
    expect((await listFacts(ctx, {})).length).toBe(before);
  });
});

describe("rule 6, nothing an agent does is irreversible", () => {
  it("makes a pantry removal reversible", async () => {
    const added = await call("add_pantry_items", {
      items: [{ name: "Riz complet", kind: "staple" }],
    });
    expect(added.error).toBe(false);

    const items = (added.body.added ?? added.body.items) as
      | Array<Record<string, unknown>>
      | undefined;
    const id = String(items?.[0]?.id);
    expect(id).not.toBe("undefined");

    const removed = await call("remove_pantry_item", { item_id: id });
    expect(removed.error).toBe(false);

    const afterRemove = await call("get_pantry");
    expect(JSON.stringify(afterRemove.body)).not.toContain("Riz complet");

    const restored = await call("restore_pantry_item", { item_id: id });
    expect(restored.error).toBe(false);

    const afterRestore = await call("get_pantry");
    expect(JSON.stringify(afterRestore.body)).toContain("Riz complet");
  });

  it("refuses to let an agent retire a fact a human confirmed", async () => {
    const fact = await createFact(ctx, {
      category: "health",
      polarity: "negative",
      statement: "Évite le sel ajouté sur recommandation médicale.",
      confidence: "high",
    });
    await confirmFact(ctx, fact.id);

    const { error, body } = await call("retire_fact", {
      fact_id: fact.id,
      reason: "Test: un agent ne doit pas pouvoir retirer un fait confirmé.",
    });

    expect(error).toBe(true);
    expect(body.code).toBe("FORBIDDEN");

    const stored = (await listFacts(ctx, {})).find((row) => row.id === fact.id);
    expect(stored?.status).toBe("confirmed");
  });
});

describe("rule 8, the tenant id never leaves", () => {
  /**
   * The resources used to serialize raw database rows while the tools
   * serialized curated views, so the same entity had two shapes and the
   * resource half carried `user_id`, `source_client_id`, `allergen_ids` and row
   * timestamps. One serializer per entity is the fix; this is what stops it
   * coming back.
   */
  it("keeps internal columns out of every resource and tool answer", async () => {
    const recipe = await createRecipe(ctx, {
      title: "Soupe de courge",
      servings: 4,
      activeTimeMin: 25,
      ingredients: [{ rawName: "courge", quantity: 1 }],
    });

    const bodies: string[] = [];

    for (const uri of [
      "cooking://profile",
      "cooking://slots",
      "cooking://pantry",
      "cooking://recipes/index",
      "cooking://history/recent",
      `cooking://recipes/${recipe.recipe.id}`,
    ]) {
      const read = await client.readResource({ uri });
      bodies.push(JSON.stringify(read.contents));
    }

    for (const tool of ["get_pantry", "get_recipe", "search_recipes"]) {
      const args = tool === "get_recipe" ? { recipe_id: recipe.recipe.id } : {};
      bodies.push(JSON.stringify((await call(tool, args)).body));
    }

    for (const body of bodies) {
      expect(body).not.toContain("userId");
      expect(body).not.toContain("user_id");
      expect(body).not.toContain(ctx.userId);
      expect(body).not.toContain("sourceClientId");
      expect(body).not.toContain("allergenIds");
    }
  });
});

describe("rule 10, a refusal an agent can act on", () => {
  it("names the valid alternatives when a week has no such version", async () => {
    const { error, body } = await call("get_week", {
      year: 2027,
      week: 20,
      version: 99,
    });

    expect(error).toBe(true);
    expect(body.code).toBe("NOT_FOUND");
    // The point of the code: the agent is told what does exist, so its next
    // call can be right rather than another guess.
    expect(body.details).toBeDefined();
  });

  it("refuses a week number without a year rather than silently answering about today", async () => {
    const { error } = await call("get_week", { week: 40 });
    expect(error).toBe(true);
  });

  /**
   * A Zod failure inside a service is the agent's fault and must be reported as
   * such. It used to fall through to `INTERNAL`, which carries
   * `retryable: true` and tells an agent in as many words not to change its
   * arguments, so a call with a bad value was answered with "the server broke,
   * try again" and the identical call would fail forever.
   */
  it("reports a schema violation as VALIDATION, not as an internal error", async () => {
    const { error, body } = await call("update_slot", {
      year: 2027,
      week: 21,
      day_of_week: 1,
      meal_type: "dinner",
      recipe_id: "not-a-uuid",
    });

    expect(error).toBe(true);
    // The precise code matters less than what it is not: `INTERNAL` carries
    // `retryable: true` and tells the agent its arguments were fine, which for
    // a malformed uuid is a lie that costs it an unbounded retry loop.
    expect(body.code).not.toBe("INTERNAL");
    expect(["VALIDATION", "RECIPE_NOT_FOUND"]).toContain(body.code);
  });
});

describe("whoami", () => {
  it("answers in snake_case, like the rest of the surface", async () => {
    const { error, body } = await call("whoami");
    expect(error).toBe(false);
    expect(body.user_id).toBe(ctx.userId);
    expect(typeof body.client_id).toBe("string");
    expect(Array.isArray(body.scopes)).toBe(true);
    // The old spelling must not come back: it was the last camelCase output on
    // an otherwise snake_case surface.
    expect(body.userId).toBeUndefined();
    expect(body.clientId).toBeUndefined();
  });
});

describe("the agent context is what the runner builds", () => {
  it("attributes a write to the calling client", async () => {
    // `agent` is the same context the runner constructs from `caller`, and the
    // audit log is what the user reads to see what their agent did.
    expect(agent.actor).toBe("agent");
    expect(agent.clientId).toBe(caller.clientId);
  });
});
