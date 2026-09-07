// Constraint 1: the application never calls an LLM. A constraint that lives only
// in a document decays, so it is mechanical, and it is checked two ways.
//
// 1. No LLM client library may reach the lockfile, transitively included.
// 2. No file in src/ may name an LLM provider's API host, which is what calling
//    a model without an SDK looks like: a `fetch` to api.openai.com needs no
//    dependency at all, and the lockfile check would never see it.
//
// A word about what this is. CLAUDE.md calls it an allowlist check; it is a
// denylist, and the difference matters. A denylist cannot see a package nobody
// has thought of yet, so the list below has to grow whenever the market does. A
// real allowlist would mean enumerating every legitimate dependency in the tree
// and refusing the rest, which is a different and much larger piece of work
// (npm packages arrive transitively in the hundreds). The second check exists
// partly to cover the gap: whatever the package is called, an outbound call has
// to name a host.
import { readFile, readdir } from "node:fs/promises";

const DENIED = [
  /^@anthropic-ai\//,
  /^openai$/,
  /^@openai\//,
  /^@google\/generative-ai$/,
  /^@google\/genai$/,
  /^@google-cloud\/aiplatform$/,
  /^@google-cloud\/vertexai$/,
  /^@mistralai\//,
  /^cohere-ai$/,
  /^replicate$/,
  /^ollama$/,
  /^langchain$/,
  /^@langchain\//,
  /^llamaindex$/,
  /^ai$/, // Vercel AI SDK
  /^@ai-sdk\//,
  /^groq-sdk$/,
  /^together-ai$/,
  /^voyageai$/,
  /^@aws-sdk\/client-bedrock-runtime$/,
  /^@aws-sdk\/client-bedrock-agent-runtime$/,
  /^@azure\/openai$/,
  /^@azure-rest\/ai-inference$/,
  /^@huggingface\/inference$/,
  /^@huggingface\/transformers$/,
];

// The MCP SDK is the opposite of a violation: it is how the user's own agent
// reaches us. Nothing here calls a model.
const ALLOWED = [/^@modelcontextprotocol\/sdk$/];

/**
 * The hosts a model is reached at. A dependency is the easy half of this rule
 * to enforce and the easy half to avoid: `fetch("https://api.openai.com/...")`
 * adds nothing to the lockfile.
 *
 * Matched against the text of every source file, so a URL in a comment counts.
 * That is deliberate: a commented-out call is a call somebody meant to make,
 * and the conversation belongs in review rather than in a diff nobody reads.
 */
const DENIED_HOSTS = [
  /api\.openai\.com/,
  /api\.anthropic\.com/,
  /generativelanguage\.googleapis\.com/,
  /api\.groq\.com/,
  /bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/,
  /api\.mistral\.ai/,
  /api\.cohere\.(?:ai|com)/,
  /api\.replicate\.com/,
  /api-inference\.huggingface\.co/,
  /[a-z0-9-]+\.openai\.azure\.com/,
];

const root = new URL("../", import.meta.url);
const failures = [];

// ---------------------------------------------------------------------------
// 1. The lockfile.
// ---------------------------------------------------------------------------
const lock = JSON.parse(
  await readFile(new URL("package-lock.json", root), "utf8"),
);

const names = new Set();
for (const path of Object.keys(lock.packages ?? {})) {
  if (!path.startsWith("node_modules/")) continue;
  names.add(
    path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
  );
}

// A lockfile shape this script does not understand yields no names at all, and
// a denylist over nothing passes. That is the one failure mode a check like this
// must not have: it would go green on the day it stopped looking. npm has
// changed the lockfile format three times.
if (names.size === 0) {
  failures.push(
    "read no package names out of package-lock.json. Either the lockfile is " +
      `empty or its format changed (lockfileVersion ${lock.lockfileVersion ?? "absent"}), ` +
      "and a check that scans nothing passes without meaning anything.",
  );
}

const denied = [...names]
  .filter((n) => DENIED.some((r) => r.test(n)))
  .filter((n) => !ALLOWED.some((r) => r.test(n)))
  .sort();

if (denied.length > 0) {
  failures.push(
    "forbidden packages in the lockfile:\n" +
      denied.map((v) => `  - ${v}`).join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 2. The source tree.
// ---------------------------------------------------------------------------
const sourceFiles = await collect(new URL("src/", root));

if (sourceFiles.length === 0) {
  failures.push(
    "found no source files under src/, so the host scan checked nothing.",
  );
}

const hostHits = [];
for (const file of sourceFiles) {
  const text = await readFile(file, "utf8");
  for (const pattern of DENIED_HOSTS) {
    const match = text.match(pattern);
    if (match) {
      hostHits.push(`  - ${relative(file)}: ${match[0]}`);
    }
  }
}

if (hostHits.length > 0) {
  failures.push(
    "an LLM provider's API host is named in the source:\n" +
      hostHits.sort().join("\n"),
  );
}

// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(
    "check:deps FAILED. The app must never call an LLM (docs/00-vision.md section 4).\n" +
      failures.join("\n") +
      "\n\nAnything that seems to need a model gets restructured as a tool the " +
      "user's own agent calls. See docs/03-agent-interface.md.",
  );
  process.exit(1);
}

console.log(
  `check:deps ok, ${names.size} packages and ${sourceFiles.length} source files scanned, ` +
    "no LLM client and no model host present",
);

/** Every .ts/.tsx/.mjs/.js file under a directory. */
async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...(await collect(new URL(`${entry.name}/`, dir))));
    } else if (/\.(?:tsx?|mjs|js)$/.test(entry.name)) {
      found.push(new URL(entry.name, dir));
    }
  }
  return found;
}

function relative(url) {
  return url.href.slice(root.href.length);
}
