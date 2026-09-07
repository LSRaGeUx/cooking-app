import { describe, expect, it } from "vitest";
import { firstRow, maybeRow } from "@/db/rows";

/**
 * The two helpers that replaced fourteen `rows[0]!` sites.
 *
 * Drizzle types every `insert().returning()` as an array, so a query that writes
 * exactly one row still hands back a list, and under `noUncheckedIndexedAccess`
 * the non-null assertion was the only thing that compiled. What that assertion
 * bought was a `TypeError` about a property of `undefined`, raised several frames
 * later in whichever mapper first read a field, with nothing in it naming the
 * query that came back empty.
 *
 * The message is therefore the whole feature, and it is what this file asserts:
 * an update whose `where` matched nothing on a user-owned table usually means the
 * id belongs to another tenant, and row-level security turns that into an empty
 * result rather than an error. Someone reading the failure needs to be told that.
 */

describe("firstRow", () => {
  it("returns the first row when there is one", () => {
    expect(firstRow([{ id: "a" }], "insert profile")).toEqual({ id: "a" });
    expect(firstRow([1, 2, 3], "select something")).toBe(1);
  });

  it("names the operation when the array is empty", () => {
    expect(() => firstRow([], "insert profile")).toThrowError(/insert profile/);
  });

  it("says why an empty result is the likely tenancy answer, not a crash", () => {
    let message = "";
    try {
      firstRow([], "update plan_entry");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Three things the reader needs, and the reason this is a helper rather than
    // a bare throw: which query, that the filter matched nothing, and that
    // another user's id looks exactly like this because row-level security hides
    // the row instead of refusing the statement.
    expect(message).toContain("update plan_entry");
    expect(message).toContain("matched nothing");
    expect(message).toContain("row-level security");
  });

  it("returns a row that is itself falsy rather than treating it as absent", () => {
    // `rows[0] ?? throw` would be wrong here, and so would a truthiness check: a
    // `select count(*)` mapped to a scalar can legitimately be 0, and an
    // aggregate row can legitimately be null.
    expect(firstRow([0], "count")).toBe(0);
    expect(firstRow([null], "aggregate")).toBeNull();
    expect(firstRow([false], "exists")).toBe(false);
  });
});

describe("maybeRow", () => {
  it("returns undefined rather than throwing, for a read where absence is an answer", () => {
    expect(maybeRow([])).toBeUndefined();
    expect(maybeRow([{ id: "a" }])).toEqual({ id: "a" });
  });

  it("ignores everything after the first row", () => {
    expect(maybeRow([{ id: "a" }, { id: "b" }])).toEqual({ id: "a" });
  });
});
