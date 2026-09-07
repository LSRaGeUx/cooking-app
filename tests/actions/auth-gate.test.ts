import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every server action is a public HTTP endpoint, and the only thing standing in
 * front of the service layer is the `requireUser()` call on its first line.
 *
 * Nothing tested that line. An action that forgets it is not a compile error, it
 * is not a lint error, and it does not fail any other test in this suite: it
 * simply reads and writes whatever `ctx` it was handed, which for an action with
 * no session is nothing at all until someone passes a user id in. So this file
 * sweeps every exported function of every module in `src/app/actions/` and
 * asserts that it does not get past the gate.
 *
 * The sweep is deliberately generic rather than a list. A list would pass on the
 * day an action is added, which is the day it needed to fail.
 *
 * `requireUser` is mocked rather than driven, because the real one calls
 * `redirect()` from `next/navigation`, and `redirect` works by throwing a
 * framework-private error that only the Next runtime understands. The mock
 * throws in the same shape, which is what an action sees.
 */

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(),
  getCurrentSession: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";

/**
 * What `redirect("/login")` actually does inside a server action: it throws, and
 * the throw is the navigation. So an action that hits the gate must reject, and
 * a gate that merely returned `{ ok: false }` would be a different bug, because
 * the screen would render a refusal instead of sending the reader to sign in.
 */
const NO_SESSION = new Error("NEXT_REDIRECT;replace;/login;307;");

/**
 * The two actions that deliberately need no session, and the reason each one is
 * allowed to. Both write a browser preference cookie and touch nothing a user
 * owns, which is stated in their own files. Anything else appearing here is a
 * missing auth gate, so the list is asserted to be exactly this, not merely to
 * contain what is checked.
 */
const SESSIONLESS = new Set(["setLocaleAction", "setThemeAction"]);

const modules: Record<string, () => Promise<Record<string, unknown>>> = {
  "account-actions": () => import("@/app/actions/account-actions"),
  "agent-actions": () => import("@/app/actions/agent-actions"),
  "fact-actions": () => import("@/app/actions/fact-actions"),
  "feedback-actions": () => import("@/app/actions/feedback-actions"),
  "grocery-actions": () => import("@/app/actions/grocery-actions"),
  "locale-actions": () => import("@/app/actions/locale-actions"),
  "pantry-actions": () => import("@/app/actions/pantry-actions"),
  "plan-actions": () => import("@/app/actions/plan-actions"),
  "prep-actions": () => import("@/app/actions/prep-actions"),
  "profile-actions": () => import("@/app/actions/profile-actions"),
  "proposal-actions": () => import("@/app/actions/proposal-actions"),
  "recipe-actions": () => import("@/app/actions/recipe-actions"),
  "slot-actions": () => import("@/app/actions/slot-actions"),
  "theme-actions": () => import("@/app/actions/theme-actions"),
};

interface Action {
  readonly module: string;
  readonly name: string;
  readonly fn: (...args: unknown[]) => Promise<unknown>;
  readonly arity: number;
}

async function everyAction(): Promise<Action[]> {
  const found: Action[] = [];
  for (const [name, load] of Object.entries(modules)) {
    const loaded = await load();
    for (const [exported, value] of Object.entries(loaded)) {
      if (typeof value !== "function") continue;
      found.push({
        module: name,
        name: exported,
        fn: value as (...args: unknown[]) => Promise<unknown>,
        arity: (value as { length: number }).length,
      });
    }
  }
  return found;
}

const actions = await everyAction();

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
  vi.mocked(revalidatePath).mockClear();
});

describe("the module sweep itself", () => {
  it("covers every module on disk, so the list above cannot go stale", () => {
    // Read from the directory rather than counted. A module added to
    // src/app/actions/ and not to `modules` above would leave its actions
    // ungated and every assertion in this file still green, which is the exact
    // failure the sweep exists to prevent.
    const dir = join(import.meta.dirname, "..", "..", "src", "app", "actions");
    const onDisk = readdirSync(dir)
      .filter((name) => name.endsWith("-actions.ts"))
      .map((name) => name.replace(/\.ts$/, ""))
      .sort();

    expect(Object.keys(modules).sort()).toEqual(onDisk);
    expect(actions.length).toBeGreaterThan(onDisk.length);
  });

  it("has exactly two actions that need no session", () => {
    const sessionless = actions
      .filter((action) => SESSIONLESS.has(action.name))
      .map((action) => action.name)
      .sort();
    expect(sessionless).toEqual(["setLocaleAction", "setThemeAction"]);
  });
});

describe("the auth gate on every action", () => {
  const gated = actions.filter((action) => !SESSIONLESS.has(action.name));

  it.each(
    gated.map((action) => [`${action.module}.${action.name}`, action] as const),
  )("%s refuses a caller with no session", async (_label, action) => {
    vi.mocked(requireUser).mockRejectedValue(NO_SESSION);

    // Called with nothing at all. The gate is the first statement of every
    // one of these, so the arguments never get looked at, and passing a
    // plausible payload per action would only make the test agree with itself.
    const args = Array.from({ length: action.arity }, () => undefined);
    await expect(action.fn(...args)).rejects.toBe(NO_SESSION);

    // And it stopped before doing anything. A gate that threw after the write
    // would pass the assertion above and still have written.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("puts the gate before argument validation, not after", async () => {
    // The order matters: an action that parsed first would answer an
    // unauthenticated caller with a description of the shape it expects, which
    // is a free schema for anyone probing the endpoint.
    vi.mocked(requireUser).mockRejectedValue(NO_SESSION);

    const { createFactAction } = await import("@/app/actions/fact-actions");
    await expect(
      createFactAction({ category: "not-a-category", statement: "" }),
    ).rejects.toBe(NO_SESSION);
  });
});

describe("the two preference actions", () => {
  it("write no cookie for a value outside their own vocabulary", async () => {
    const { setLocaleAction } = await import("@/app/actions/locale-actions");
    const { setThemeAction } = await import("@/app/actions/theme-actions");

    // These take a string from the client and turn it into a cookie name and
    // value, so the validation is the whole security property: without it they
    // are a way to write any cookie on the origin.
    await setLocaleAction("klingon");
    await setThemeAction("chartreuse");
    expect(revalidatePath).not.toHaveBeenCalled();

    await setLocaleAction("fr");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
