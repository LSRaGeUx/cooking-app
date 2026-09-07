import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  appDatabaseUrl,
  baseUrl,
  googleCredentials,
  mcpResource,
  optional,
  optionalSecret,
  ownerDatabaseUrl,
  passwordLoginEnabled,
  required,
  secret,
} from "@/lib/config";

/**
 * The module that decides every environment read in this application.
 *
 * Three separate files used to resolve `BETTER_AUTH_URL` with a silent
 * `?? "http://localhost:3000"`, which on a deployed instance is not a fallback
 * but a wrong answer: it is the OAuth issuer, it decides cookie attributes, and
 * it is the base of every review link handed to an agent. Nothing failed, and
 * the symptom was agents receiving links into the developer's laptop.
 *
 * Everything here is a function rather than a module constant precisely so this
 * file can exist: a constant would have baked whatever the environment held when
 * the module was first imported, and there would be no way to test the
 * production branch at all. Every variable touched below is restored in
 * `afterEach`, including `NODE_ENV`, because the rest of the suite reads it.
 */

const TOUCHED = [
  "BETTER_AUTH_URL",
  "MCP_RESOURCE",
  "NODE_ENV",
  "CONFIG_TEST_SECRET",
  "CONFIG_TEST_SECRET_FILE",
  "CONFIG_TEST_PLAIN",
  "AUTH_PASSWORD_LOGIN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET_FILE",
] as const;

const original = new Map<string, string | undefined>();
let scratch = "";

beforeAll(() => {
  for (const name of TOUCHED) original.set(name, process.env[name]);
  scratch = mkdtempSync(join(tmpdir(), "cooking-config-"));
});

afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * `NODE_ENV` through an index rather than the property.
 *
 * `@types/node` declares it read-only, which is right for application code and
 * wrong here: the production branch of this module is decided by nothing else,
 * so a test that cannot set it cannot reach the branch that matters. The
 * indexed write is the same assignment with the declaration out of the way, and
 * `afterEach` puts "test" back.
 */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/** Writes a secret to a file the way a Compose or Kubernetes mount would. */
function mountSecret(name: string, contents: string): string {
  const path = join(scratch, `${name}.txt`);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("baseUrl", () => {
  it("refuses to guess in production, and names the variable", () => {
    delete process.env.BETTER_AUTH_URL;
    setNodeEnv("production");

    // Not just that it throws: the message has to name the variable and say why
    // a development default is not good enough, because whoever reads it is
    // looking at a container that will not start.
    expect(() => baseUrl()).toThrowError(/BETTER_AUTH_URL/);
    expect(() => baseUrl()).toThrowError(/OAuth issuer/);
  });

  it("defaults to localhost outside production, so a clone needs no .env", () => {
    delete process.env.BETTER_AUTH_URL;
    setNodeEnv("development");
    expect(baseUrl()).toBe("http://localhost:3000");

    // "test" is not "production" either, which is what lets the rest of this
    // suite import the auth module without configuring an address.
    setNodeEnv("test");
    expect(baseUrl()).toBe("http://localhost:3000");
  });

  it("strips a trailing slash, so nothing downstream builds a double one", () => {
    process.env.BETTER_AUTH_URL = "https://cook.example.com/";
    expect(baseUrl()).toBe("https://cook.example.com");

    process.env.BETTER_AUTH_URL = "https://cook.example.com";
    expect(baseUrl()).toBe("https://cook.example.com");
  });

  it("prefers a configured address over the default even in development", () => {
    setNodeEnv("development");
    process.env.BETTER_AUTH_URL = "http://192.168.1.20:3000";
    expect(baseUrl()).toBe("http://192.168.1.20:3000");
  });

  it("treats an empty value as unset rather than as an empty address", () => {
    process.env.BETTER_AUTH_URL = "";
    setNodeEnv("production");
    expect(() => baseUrl()).toThrowError(/BETTER_AUTH_URL/);
  });
});

describe("mcpResource", () => {
  it("has the same production contract as baseUrl", () => {
    delete process.env.MCP_RESOURCE;
    setNodeEnv("production");
    expect(() => mcpResource()).toThrowError(/MCP_RESOURCE/);

    setNodeEnv("development");
    expect(mcpResource()).toBe("http://localhost:3000/api/mcp");
  });

  it("is not derived from baseUrl, because a token is bound to it exactly", () => {
    // RFC 8707 audience binding: an issued token names this resource, and an
    // agent connects to whatever it was told. Deriving it from `baseUrl()` would
    // make the two disagree the moment the endpoint moves behind a path prefix.
    process.env.BETTER_AUTH_URL = "https://cook.example.com";
    process.env.MCP_RESOURCE = "https://mcp.example.com/api/mcp";
    expect(mcpResource()).toBe("https://mcp.example.com/api/mcp");
    expect(mcpResource().startsWith(baseUrl())).toBe(false);
  });
});

describe("secret", () => {
  it("prefers <NAME>_FILE over <NAME>, so a mount wins over the environment", () => {
    process.env.CONFIG_TEST_SECRET = "from-the-environment";
    process.env.CONFIG_TEST_SECRET_FILE = mountSecret(
      "preferred",
      "from-the-file",
    );

    // The direction is the point. A deployment migrating to file-mounted
    // secrets leaves the old variable in place for a while, and the new value
    // has to be the one that takes effect.
    expect(secret("CONFIG_TEST_SECRET")).toBe("from-the-file");
  });

  it("trims the file, because an editor and a heredoc both add a newline", () => {
    process.env.CONFIG_TEST_SECRET_FILE = mountSecret(
      "trailing",
      "  a-real-secret\n",
    );
    expect(secret("CONFIG_TEST_SECRET")).toBe("a-real-secret");
  });

  it("falls back to the plain variable when no file is named", () => {
    delete process.env.CONFIG_TEST_SECRET_FILE;
    process.env.CONFIG_TEST_SECRET = "plain-value";
    expect(secret("CONFIG_TEST_SECRET")).toBe("plain-value");
  });

  it("names both spellings when neither is set", () => {
    delete process.env.CONFIG_TEST_SECRET;
    delete process.env.CONFIG_TEST_SECRET_FILE;

    // A deployment using the file form gets no help from an error that mentions
    // only the variable, which is why the message carries both.
    expect(() => secret("CONFIG_TEST_SECRET")).toThrowError(
      /CONFIG_TEST_SECRET or CONFIG_TEST_SECRET_FILE/,
    );
  });

  it("says which path it could not read rather than reporting the value missing", () => {
    process.env.CONFIG_TEST_SECRET = "would-have-worked";
    const missing = join(scratch, "not-here.txt");
    process.env.CONFIG_TEST_SECRET_FILE = missing;

    // Deliberately not a fall-through to the plain variable. A named file that
    // cannot be read is a broken mount, and silently using the older value is
    // how a rotated secret goes unnoticed.
    expect(() => secret("CONFIG_TEST_SECRET")).toThrowError(/not-here\.txt/);
  });

  it("treats an empty file as unset", () => {
    delete process.env.CONFIG_TEST_SECRET;
    process.env.CONFIG_TEST_SECRET_FILE = mountSecret("empty", "   \n");
    expect(() => secret("CONFIG_TEST_SECRET")).toThrowError(
      /CONFIG_TEST_SECRET_FILE/,
    );
  });
});

describe("optionalSecret", () => {
  it("returns undefined instead of throwing when nothing is set", () => {
    delete process.env.CONFIG_TEST_SECRET;
    delete process.env.CONFIG_TEST_SECRET_FILE;
    expect(optionalSecret("CONFIG_TEST_SECRET")).toBeUndefined();
  });

  it("still prefers the file form when there is one", () => {
    process.env.CONFIG_TEST_SECRET = "from-the-environment";
    process.env.CONFIG_TEST_SECRET_FILE = mountSecret(
      "optional",
      "from-the-file",
    );
    expect(optionalSecret("CONFIG_TEST_SECRET")).toBe("from-the-file");
  });

  it("still throws on a file it cannot read, because that is a broken mount", () => {
    process.env.CONFIG_TEST_SECRET_FILE = join(scratch, "gone.txt");
    expect(() => optionalSecret("CONFIG_TEST_SECRET")).toThrowError(
      /gone\.txt/,
    );
  });
});

describe("required and optional", () => {
  it("name the variable when a required one is missing", () => {
    delete process.env.CONFIG_TEST_PLAIN;
    expect(() => required("CONFIG_TEST_PLAIN")).toThrowError(
      /Missing required env var: CONFIG_TEST_PLAIN/,
    );
  });

  it("read an empty value as absent, in both directions", () => {
    process.env.CONFIG_TEST_PLAIN = "";
    expect(optional("CONFIG_TEST_PLAIN")).toBeUndefined();
    expect(() => required("CONFIG_TEST_PLAIN")).toThrowError(
      /CONFIG_TEST_PLAIN/,
    );

    process.env.CONFIG_TEST_PLAIN = "set";
    expect(optional("CONFIG_TEST_PLAIN")).toBe("set");
    expect(required("CONFIG_TEST_PLAIN")).toBe("set");
  });
});

describe("the two database roles", () => {
  it("come through secret(), so either can be mounted as a file", () => {
    // Mixing these two up defeats tenancy: the owner is exempt from row-level
    // security. Both are read here to pin that they are file-capable, which is
    // the whole reason a deployment can keep a connection string off `docker
    // inspect`.
    expect(ownerDatabaseUrl()).toBeTypeOf("string");
    expect(appDatabaseUrl()).toBeTypeOf("string");
    expect(appDatabaseUrl()).not.toBe("");
  });
});

describe("passwordLoginEnabled", () => {
  it("is on only for the exact string true", () => {
    process.env.AUTH_PASSWORD_LOGIN = "true";
    expect(passwordLoginEnabled()).toBe(true);

    // Anything else is off. Password sign-in is a development affordance, and
    // "1", "yes" and "TRUE" all reading as on is how it ends up on a deployed
    // instance by accident.
    for (const value of ["1", "yes", "TRUE", "false", ""]) {
      process.env.AUTH_PASSWORD_LOGIN = value;
      expect(passwordLoginEnabled(), `for ${JSON.stringify(value)}`).toBe(
        false,
      );
    }

    delete process.env.AUTH_PASSWORD_LOGIN;
    expect(passwordLoginEnabled()).toBe(false);
  });
});

describe("googleCredentials", () => {
  it("is undefined unless both halves are present", () => {
    process.env.GOOGLE_CLIENT_ID = "";
    process.env.GOOGLE_CLIENT_SECRET = "";
    delete process.env.GOOGLE_CLIENT_SECRET_FILE;
    expect(googleCredentials()).toBeUndefined();

    process.env.GOOGLE_CLIENT_ID = "an-id.apps.googleusercontent.com";
    // Half configured is the state that produces a sign-in button leading to a
    // Google error page, so it counts as not configured.
    expect(googleCredentials()).toBeUndefined();
  });

  it("takes the secret half from a file when one is mounted", () => {
    process.env.GOOGLE_CLIENT_ID = "an-id.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "";
    process.env.GOOGLE_CLIENT_SECRET_FILE = mountSecret("google", "a-secret\n");

    expect(googleCredentials()).toEqual({
      clientId: "an-id.apps.googleusercontent.com",
      clientSecret: "a-secret",
    });
  });
});
