import { describe, expect, it } from "vitest";
import { isPublicAddress, safeFetch } from "@/lib/safe-fetch";

/**
 * The server-side request forgery surface, which is the whole reason
 * `src/lib/safe-fetch.ts` exists.
 *
 * `importRecipeFromUrl` takes an address from a user or an agent and fetches it
 * from inside a network neither of them can reach, so "fetch this for me" is an
 * invitation to read the cloud metadata endpoint, the database container, or the
 * router. The address classifier is the only thing between the two.
 *
 * It is tested as a pure function because that is what it is, and because text
 * matching on an IPv6 address is a losing game the attacker gets to pick the
 * spelling for. Half a dozen IPv6 prefixes carry an IPv4 address inside them and
 * every one of them is a way to write 127.0.0.1: the module used to recognise
 * exactly one, the dotted IPv4-mapped form, with a regular expression, so
 * `::ffff:7f00:1` (the same address in hex) went through as an ordinary public
 * address. Each of those forms gets a case here, in both spellings where there
 * are two, with the public counterpart beside it so the check cannot be passed
 * by refusing everything.
 *
 * 93.184.216.34 is the public address throughout, and its bytes are `5d b8 d8
 * 22`, which is what appears embedded in the IPv6 forms below.
 */

describe("what safeFetch refuses before opening a socket", () => {
  it("refuses a URL carrying a username and password", async () => {
    /*
     * Refused, not stripped. `request(url, ...)` forwards the userinfo as an
     * Authorization header, so a URL carrying one has this server replaying a
     * credential it was handed at a host it was told to trust. Stripping it
     * silently would instead fetch a different page from the one the caller
     * named and import whatever a login wall serves.
     */
    await expect(
      safeFetch("http://admin:hunter2@example.test/recette", "recipe-import"),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps the password out of the error it reports", async () => {
    // The refusal is logged and handed to an agent, so echoing the credential
    // back would move it from one URL into every log line downstream.
    let thrown: unknown;
    try {
      await safeFetch("http://admin:hunter2@example.test/", "recipe-import");
    } catch (error) {
      thrown = error;
    }

    const serialized = JSON.stringify(
      thrown,
      Object.getOwnPropertyNames(thrown),
    );
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("admin");
  });

  it("refuses a scheme that never reaches the wire", async () => {
    for (const url of [
      "file:///etc/passwd",
      "gopher://example.test/",
      "ftp://example.test/",
      "data:text/html,<h1>hi</h1>",
    ]) {
      await expect(safeFetch(url, "recipe-import")).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
  });

  it("refuses a literal private IPv4 address as a private network", async () => {
    for (const url of [
      "http://127.0.0.1:3000/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
    ]) {
      await expect(safeFetch(url, "recipe-import")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  it("refuses a bracketed IPv6 literal, for the right reason", async () => {
    /*
     * This used to fail closed for the wrong reason, and it mattered.
     *
     * `new URL("http://[::1]/").hostname` is `"[::1]"`, brackets included,
     * because they are URL syntax rather than part of the address, and that
     * string went straight to the resolver, which cannot resolve it. So the
     * refusal was `VALIDATION`, "le nom de domaine est introuvable", rather
     * than the `FORBIDDEN` "cette adresse pointe vers un réseau privé" the
     * address classifier would have given. Nothing was ever fetched, so there
     * was no bypass. But an agent told a host does not exist goes looking for a
     * typo in the address, and one told the address is private stops, and only
     * one of those is true.
     *
     * A literal address now skips the resolver entirely and is classified
     * directly, which is both correct and one fewer DNS query.
     */
    for (const url of [
      "http://[::1]:3000/",
      "http://[::ffff:7f00:1]/",
      "http://[fe80::1]/",
      "http://[64:ff9b::a9fe:a9fe]/",
    ]) {
      await expect(safeFetch(url, "recipe-import"), url).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }

    // And the classifier itself, given the same addresses unbracketed, refuses
    // every one of them. So the fix is to strip the brackets, not to change any
    // rule about what is public.
    for (const address of ["::1", "::ffff:7f00:1", "fe80::1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("names the address it refused, so the refusal is actionable", async () => {
    let message = "";
    try {
      await safeFetch("http://169.254.169.254/", "recipe-import");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    // Rule 10. An agent told only "forbidden" retries; one told the address is
    // private and that only public addresses are read does not.
    expect(message).toContain("169.254.169.254");
    expect(message).toContain("privé");
  });
});

describe("the IPv4 ranges that are not the public internet", () => {
  it("refuses loopback, the private blocks and cloud metadata", () => {
    for (const address of [
      "0.0.0.0",
      "0.1.2.3",
      "10.1.2.3",
      "127.0.0.1",
      "127.1.1.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "100.64.0.1",
      "100.127.255.254",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses the benchmarking, documentation and protocol-assignment blocks", () => {
    // The comment on the classifier claimed these were refused and only the
    // benchmarking range was, so 192.0.2.1 and 203.0.113.1 were treated as
    // ordinary public addresses. Nothing routable is lost by refusing them, and
    // they are exactly what an internal test fixture answers on.
    for (const address of [
      "192.0.0.1", // IETF protocol assignments
      "192.0.2.1", // TEST-NET-1
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "198.18.0.1", // benchmarking
      "198.19.255.254", // benchmarking
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("still allows the addresses immediately outside each block", () => {
    // The other half of a range check. A classifier that refused 172.32.0.1 or
    // 192.169.1.1 would be safe and useless, and a bad range boundary shows up
    // here rather than as a site that mysteriously cannot be imported.
    for (const address of [
      "9.255.255.255",
      "11.0.0.1",
      "128.0.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.167.1.1",
      "192.169.1.1",
      "100.63.255.255",
      "100.128.0.1",
      "169.253.0.1",
      "169.255.0.1",
      "223.255.255.254",
      "93.184.216.34",
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});

describe("every IPv4 address an IPv6 address can hide", () => {
  it("refuses the IPv4-mapped form in the dotted spelling and in hex", () => {
    // The bypass that existed: the regular expression matched the dotted form
    // and `isIPv6` accepts the hex spelling of the same address, so writing
    // loopback in hex was the shortest way past the entire file.
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicAddress("0:0:0:0:0:ffff:7f00:0001")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:a9fe:a9fe")).toBe(false);

    // And the public counterpart still passes, in both spellings.
    expect(isPublicAddress("::ffff:93.184.216.34")).toBe(true);
    expect(isPublicAddress("::ffff:5db8:d822")).toBe(true);
  });

  it("refuses the IPv4-translated (SIIT) form", () => {
    // ::ffff:0:0:0/96, one group longer than the mapped form above.
    expect(isPublicAddress("::ffff:0:7f00:1")).toBe(false);
    expect(isPublicAddress("::ffff:0:a9fe:a9fe")).toBe(false);
    expect(isPublicAddress("::ffff:0:5db8:d822")).toBe(true);
  });

  it("refuses the deprecated IPv4-compatible form", () => {
    // ::/96. Deprecated for twenty years and still parsed by `isIPv6`, which
    // is all an attacker needs.
    expect(isPublicAddress("::127.0.0.1")).toBe(false);
    expect(isPublicAddress("::7f00:1")).toBe(false);
    expect(isPublicAddress("::93.184.216.34")).toBe(true);
  });

  it("refuses NAT64 carrying a private address, and its local-use prefix outright", () => {
    // 64:ff9b::/96, the well-known prefix: the IPv4 address is in the last four
    // bytes.
    expect(isPublicAddress("64:ff9b::7f00:1")).toBe(false);
    expect(isPublicAddress("64:ff9b::127.0.0.1")).toBe(false);
    expect(isPublicAddress("64:ff9b::a9fe:a9fe")).toBe(false);
    expect(isPublicAddress("64:ff9b::5db8:d822")).toBe(true);

    // 64:ff9b:1::/48 places the address differently per deployment, so there is
    // nothing reliable to extract. A translation prefix is not a destination,
    // so it is refused rather than guessed at.
    expect(isPublicAddress("64:ff9b:1::5db8:d822")).toBe(false);
    expect(isPublicAddress("64:ff9b:1:0:0:0:5db8:d822")).toBe(false);
  });

  it("refuses 6to4 carrying a private address", () => {
    // 2002::/16, with the IPv4 address in bits 16 to 48.
    expect(isPublicAddress("2002:7f00:1::")).toBe(false);
    expect(isPublicAddress("2002:a9fe:a9fe::")).toBe(false);
    expect(isPublicAddress("2002:c0a8:101::1")).toBe(false); // 192.168.1.1
    expect(isPublicAddress("2002:5db8:d822::")).toBe(true);
  });

  it("refuses Teredo when either embedded address is private", () => {
    /*
     * 2001:0::/32 carries two IPv4 addresses: the server's in bits 32 to 64,
     * and the client's, bitwise complemented, in the last 32. Both are checked,
     * because either one is a way to name a host on our side of the network.
     *
     * The complement of 93.184.216.34 is 162.71.39.221, `a247:27dd`, which is
     * what the public cases below carry in their last two groups.
     */
    expect(isPublicAddress("2001:0:5db8:d822:0:0:a247:27dd")).toBe(true);

    // A private server address.
    expect(isPublicAddress("2001:0:7f00:1:0:0:a247:27dd")).toBe(false);
    expect(isPublicAddress("2001:0:a9fe:a9fe:0:0:a247:27dd")).toBe(false);

    // A private client address: 127.0.0.1 complemented is 128.255.255.254,
    // `80ff:fffe`.
    expect(isPublicAddress("2001:0:5db8:d822:0:0:80ff:fffe")).toBe(false);
  });

  it("refuses the IPv6 ranges that are private in their own right", () => {
    for (const address of [
      "::", // unspecified
      "::1", // loopback
      "fc00::1", // unique local
      "fd00::1",
      "fdff:ffff::1",
      "fe80::1", // link-local
      "feb0::1",
      "ff02::1", // multicast
      "2001:db8::1", // documentation
      "2001:db8:1234::5678",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("strips a zone identifier before classifying", () => {
    // `fe80::1%eth0` is what a link-local address looks like when it comes off
    // an interface, and the zone suffix must not make it unparseable and
    // therefore, by a different route, refused for the wrong reason.
    expect(isPublicAddress("fe80::1%eth0")).toBe(false);
    expect(isPublicAddress("::1%lo0")).toBe(false);
  });

  it("allows an ordinary public IPv6 address", () => {
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
    expect(isPublicAddress("2a00:1450:4007:80f::200e")).toBe(true);
  });
});

describe("anything that is not an address", () => {
  it("is refused rather than passed through", () => {
    // The default has to be refusal: this function is called with whatever DNS
    // returned, and a value it cannot parse is a value it cannot vouch for.
    for (const value of [
      "",
      "localhost",
      "example.test",
      "127.0.0.1.",
      "127.0.0.1:80",
      "0x7f000001",
      "2130706433",
      "::ffff:127.0.0.1.5",
      "1:2:3:4:5:6:7:8:9",
      "12345::1",
      "::gggg",
      "fe80:::1",
    ]) {
      expect(isPublicAddress(value), JSON.stringify(value)).toBe(false);
    }
  });
});

/**
 * `safeFetch` takes an injectable `lookup` so that a redirect to a private host
 * can be reasoned about without reaching the real internet. An injection point
 * inside a security control earns its own tests: these assert it can be used to
 * steer the resolver and cannot be used to get past the refusal.
 */
describe("the injectable resolver", () => {
  it("is consulted for the hostname, with the brackets already stripped", async () => {
    const asked: string[] = [];

    await expect(
      safeFetch("http://[2001:db8::1]/recipe", "recipe-import", {
        lookup: async (hostname) => {
          asked.push(hostname);
          return { address: "203.0.113.10", family: 4 };
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A literal address needs no resolver at all, so the injected one is never
    // reached: the address is classified directly. That is the fix for the bug
    // where `http://[::1]/` was reported as an unresolvable domain name rather
    // than as a private address.
    expect(asked).toEqual([]);
  });

  it("asks the resolver for a real hostname", async () => {
    const asked: string[] = [];

    await expect(
      safeFetch("http://recipes.example/x", "recipe-import", {
        lookup: async (hostname) => {
          asked.push(hostname);
          return { address: "169.254.169.254", family: 4 };
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(asked).toEqual(["recipes.example"]);
  });

  /**
   * The point of the whole file. A hostname that resolves to cloud metadata is
   * refused whatever the resolver says, so the injection cannot be turned into
   * a bypass: it decides which address is checked, never whether it is.
   */
  it("cannot be used to reach a private address", async () => {
    for (const address of [
      "169.254.169.254",
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "::1",
      "::ffff:7f00:1",
      "64:ff9b::a9fe:a9fe",
    ]) {
      await expect(
        safeFetch("http://looks-fine.example/", "recipe-import", {
          lookup: async () => ({
            address,
            family: address.includes(":") ? 6 : 4,
          }),
        }),
        address,
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("names the address it refused, so the refusal is diagnosable", async () => {
    await expect(
      safeFetch("http://looks-fine.example/", "recipe-import", {
        lookup: async () => ({ address: "169.254.169.254", family: 4 }),
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { hostname: "looks-fine.example", address: "169.254.169.254" },
    });
  });
});
