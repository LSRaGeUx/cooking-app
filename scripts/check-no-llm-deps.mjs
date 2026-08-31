// Constraint 1: the application never calls an LLM. A constraint that lives only
// in a document decays, so it is mechanical: this fails the build if any LLM
// client library reaches the lockfile, transitively included.
import { readFile } from "node:fs/promises";

const DENIED = [
  /^@anthropic-ai\//,
  /^openai$/,
  /^@openai\//,
  /^@google\/generative-ai$/,
  /^@google\/genai$/,
  /^@google-cloud\/aiplatform$/,
  /^@mistralai\//,
  /^cohere-ai$/,
  /^replicate$/,
  /^ollama$/,
  /^langchain$/,
  /^@langchain\//,
  /^llamaindex$/,
  /^ai$/, // Vercel AI SDK
  /^@ai-sdk\//,
  /^@huggingface\/inference$/,
];

// The MCP SDK is the opposite of a violation: it is how the user's own agent
// reaches us. Nothing here calls a model.
const ALLOWED = [/^@modelcontextprotocol\/sdk$/];

const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));

const names = new Set();
for (const path of Object.keys(lock.packages ?? {})) {
  if (!path.startsWith("node_modules/")) continue;
  names.add(path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length));
}

const violations = [...names]
  .filter((n) => DENIED.some((r) => r.test(n)))
  .filter((n) => !ALLOWED.some((r) => r.test(n)))
  .sort();

if (violations.length > 0) {
  console.error(
    "check:deps FAILED. The app must never call an LLM (docs/00-vision.md section 4).\n" +
      "Forbidden packages in the lockfile:\n" +
      violations.map((v) => `  - ${v}`).join("\n"),
  );
  process.exit(1);
}

console.log(`check:deps ok, ${names.size} packages scanned, no LLM client present`);
