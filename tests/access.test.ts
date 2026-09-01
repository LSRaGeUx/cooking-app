import { describe, expect, it } from "vitest";
import { NOT_ALLOWED, NOT_CONFIGURED, checkAccess } from "@/lib/access";

/**
 * The allowlist is the only thing standing between a public instance and anyone
 * holding a Google account, so its edges are pinned here rather than trusted:
 * how an address is normalized, and which way an unconfigured list fails.
 */
describe("the access allowlist", () => {
  const list = ["cook@example.com", "guest@example.org"];

  it("admits an address on the list", () => {
    expect(checkAccess("cook@example.com", { list })).toEqual({ allowed: true });
  });

  it("ignores case and surrounding space, because a provider decides neither", () => {
    expect(checkAccess("  Cook@Example.COM ", { list })).toEqual({
      allowed: true,
    });
    expect(checkAccess("cook@example.com", { list: [" COOK@example.com "] })).toEqual(
      { allowed: true },
    );
  });

  it("refuses an address that is not on the list", () => {
    expect(checkAccess("stranger@example.com", { list })).toEqual({
      allowed: false,
      code: NOT_ALLOWED,
    });
  });

  it("refuses an empty address rather than reading it as a wildcard", () => {
    expect(checkAccess("", { list })).toEqual({
      allowed: false,
      code: NOT_ALLOWED,
    });
  });

  it("matches the whole address, so a substring is not enough", () => {
    expect(checkAccess("cook@example.com.attacker.test", { list })).toEqual({
      allowed: false,
      code: NOT_ALLOWED,
    });
  });

  it("stays open with no list in development, so a fresh clone can sign in", () => {
    expect(checkAccess("anyone@example.com", { list: [], requireList: false })).toEqual(
      { allowed: true },
    );
  });

  it("closes with no list in production, which is the safe way to fail", () => {
    expect(checkAccess("anyone@example.com", { list: [], requireList: true })).toEqual({
      allowed: false,
      code: NOT_CONFIGURED,
    });
  });

  it("reads the environment when no list is passed", () => {
    const previous = process.env.ALLOWED_EMAILS;
    process.env.ALLOWED_EMAILS = "cook@example.com, guest@example.org ,";
    try {
      expect(checkAccess("guest@example.org", { requireList: true })).toEqual({
        allowed: true,
      });
      expect(checkAccess("stranger@example.org", { requireList: true })).toEqual({
        allowed: false,
        code: NOT_ALLOWED,
      });
    } finally {
      if (previous === undefined) delete process.env.ALLOWED_EMAILS;
      else process.env.ALLOWED_EMAILS = previous;
    }
  });
});
