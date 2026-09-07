import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv4, isIPv6 } from "node:net";
import { DomainError } from "@/domain/errors";

/**
 * The only place in the application that makes an outbound HTTP request.
 *
 * Fetching a URL a user supplies is server-side request forgery bait: the
 * server sits inside a network the user cannot reach, so "fetch this for me"
 * is an invitation to read the metadata endpoint, the database, or another
 * container. Every protection below exists for a specific attack:
 *
 * - **Scheme allowlist.** `file:`, `gopher:` and friends never reach the wire.
 * - **No credentials in the URL.** `http://user:pass@host/` is refused rather
 *   than forwarded: the userinfo field is both a way to hand our server someone
 *   else's credential to replay and the classic way to make a URL look like it
 *   points somewhere it does not.
 * - **Address validation after resolution, with the resolved address pinned.**
 *   Checking the hostname is useless: `evil.test` can resolve to 127.0.0.1.
 *   Checking the resolved address and then calling `fetch` is nearly useless
 *   too, because the name can resolve differently the second time, which is DNS
 *   rebinding. So the socket is told exactly which address to use, and that
 *   address is the one that was validated.
 * - **Every IPv4 address an IPv6 address embeds is checked as well.** See
 *   `isPublicIPv6`: half a dozen IPv6 forms carry an IPv4 address inside them,
 *   and each is a way to write 127.0.0.1 that a plain prefix check waves through.
 * - **Redirect cap, and every hop revalidated.** A public URL that redirects to
 *   169.254.169.254 is the standard bypass.
 * - **Size cap, socket idle timeout, and an overall deadline.** A URL that
 *   streams forever is a denial of service against our own process, and so is
 *   one that trickles a byte at a time: an idle timeout alone never fires
 *   against a server that answers slowly on purpose.
 *
 * `purpose` is required and logged. If a second caller ever appears, it should
 * be obvious in the logs what the server is reaching out for and why.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 3;
const MAX_BYTES = 2_000_000;

/** Between two bytes on the socket. Not a deadline; see the next constant. */
const SOCKET_IDLE_TIMEOUT_MS = 8_000;

/**
 * The whole operation, redirects included.
 *
 * `timeout` on a Node request is an idle timeout: it resets on every byte. A
 * server that sends one byte every seven seconds therefore holds the request
 * open indefinitely, bounded only by the 2 MB cap, which at that rate is longer
 * than the process will live. That is a slow-loris against ourselves, reachable
 * from any URL a user can type, so there is a hard ceiling on top.
 */
const TOTAL_DEADLINE_MS = 15_000;

/** `dnsLookup` takes no timeout of its own, and a hung resolver is a hang. */
const DNS_TIMEOUT_MS = 3_000;

export interface SafeFetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

/**
 * How a hostname becomes an address. Injectable for one reason only: so a test
 * can prove that a redirect to a private host is re-resolved and refused.
 *
 * The classic way to get past a check like this one is a public hostname that
 * redirects to `169.254.169.254`, and the only way to demonstrate the defence
 * without reaching the real internet is to control what the resolver answers.
 *
 * Note what is deliberately *not* injectable: `isPublicAddress`. The refusal
 * itself has no bypass, in tests or anywhere else, so a mocked resolver can
 * make this function look up whatever it likes and still cannot make it fetch a
 * private address.
 */
export type HostLookup = (hostname: string) => Promise<ResolvedAddress>;

export interface SafeFetchOptions {
  readonly lookup?: HostLookup;
}

export async function safeFetch(
  rawUrl: string,
  purpose: "recipe-import",
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const deadline = Date.now() + TOTAL_DEADLINE_MS;
  let current = parseUrl(rawUrl);
  let hop = 0;

  // `for (;;)` rather than a bounded loop: every path inside returns or throws,
  // and a bounded loop obliged a trailing `throw` after it that no input could
  // ever reach. An unreachable line that looks like a real refusal is worse than
  // no line, because the next reader tries to work out when it fires.
  for (;;) {
    const address = await resolvePublicAddress(
      current.hostname,
      deadline,
      options.lookup,
    );
    const response = await requestOnce(current, address, purpose, deadline);

    if (!response.location) {
      return {
        url: current.toString(),
        status: response.status,
        contentType: response.contentType,
        body: response.body,
      };
    }

    if (hop === MAX_REDIRECTS) {
      throw new DomainError(
        "VALIDATION",
        `Cette adresse redirige trop de fois (plus de ${MAX_REDIRECTS}). Donnez l'adresse finale de la recette.`,
        { url: rawUrl },
      );
    }

    hop += 1;
    // Revalidated on the next pass, because the whole point of a redirect
    // bypass is that the first hop looked fine.
    current = parseUrl(new URL(response.location, current).toString());
  }
}

function parseUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainError(
      "VALIDATION",
      `« ${rawUrl} » n'est pas une adresse valide. Donnez une adresse complète, commençant par https://.`,
      { url: rawUrl },
    );
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new DomainError(
      "VALIDATION",
      `Seules les adresses http et https peuvent être lues. Reçu : ${url.protocol}`,
      { protocol: url.protocol },
    );
  }

  // Refused rather than stripped. `request(url, ...)` forwards the userinfo as
  // an Authorization header, so a URL carrying one has our server replaying a
  // credential it was handed, at a host it was told to trust. Stripping it
  // silently would instead fetch a page the caller did not ask for and import
  // whatever a login wall serves.
  if (url.username || url.password) {
    throw new DomainError(
      "VALIDATION",
      "Cette adresse contient un identifiant et un mot de passe (la partie avant le @). Elle ne sera pas lue. Donnez l'adresse publique de la page ; si la recette est derrière une authentification, récupérez-la vous-même et créez-la avec `create_recipe`.",
      { url: `${url.protocol}//${url.host}${url.pathname}` },
    );
  }

  return url;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

async function resolvePublicAddress(
  hostname: string,
  deadline: number,
  inject?: HostLookup,
): Promise<ResolvedAddress> {
  /**
   * `new URL("http://[::1]/").hostname` is `"[::1]"`, brackets included, and
   * they are part of the URL syntax rather than part of the address. Handed to
   * the resolver they made every IPv6 literal unresolvable, so `http://[::1]/`
   * was refused as "the domain name cannot be found" when the truth is that it
   * points at loopback. The refusal was right and its reason was wrong, which
   * on this surface matters: an agent told a host does not exist will go looking
   * for a typo, and one told the address is private will stop.
   */
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  // A literal address needs no resolver, and asking one to resolve it is how
  // the bug above happened. Classify it directly.
  if (isIPv4(host) || isIPv6(host)) {
    return assertPublic(host, { address: host, family: isIPv4(host) ? 4 : 6 });
  }

  const resolved = inject
    ? await inject(host)
    : await lookupWithTimeout(host, deadline);

  return assertPublic(host, resolved);
}

/** The refusal, with no bypass. Applied to an injected answer just the same. */
function assertPublic(
  hostname: string,
  resolved: ResolvedAddress,
): ResolvedAddress {
  if (!isPublicAddress(resolved.address)) {
    throw new DomainError(
      "FORBIDDEN",
      `Cette adresse pointe vers un réseau privé (${resolved.address}) et ne sera pas lue. Seules les adresses publiques sont autorisées.`,
      { hostname, address: resolved.address },
    );
  }
  return resolved;
}

function lookupWithTimeout(
  hostname: string,
  deadline: number,
): Promise<ResolvedAddress> {
  return new Promise<ResolvedAddress>((resolve, reject) => {
    // The lookup itself has no timeout option, so it gets one here: a resolver
    // that never answers used to hang the request for as long as the operating
    // system's own retry schedule took, outside every other limit in this file.
    const budget = Math.min(DNS_TIMEOUT_MS, deadline - Date.now());
    const timer = setTimeout(
      () => {
        reject(
          new DomainError(
            "VALIDATION",
            `La résolution du nom de domaine « ${hostname} » n'a pas abouti en moins de ${Math.round(DNS_TIMEOUT_MS / 1000)} secondes.`,
            { hostname },
          ),
        );
      },
      Math.max(budget, 0),
    );

    dnsLookup(hostname, { verbatim: true }, (error, address, family) => {
      clearTimeout(timer);
      if (error) {
        reject(
          new DomainError(
            "VALIDATION",
            `Le nom de domaine « ${hostname} » est introuvable.`,
            { hostname },
          ),
        );
        return;
      }
      resolve({ address, family });
    });
  });
}

/**
 * Everything that is not routable on the public internet is refused: loopback,
 * private ranges, link-local (which is where cloud metadata lives), carrier
 * NAT, multicast, benchmarking, and the documentation ranges.
 */
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return isPublicIPv4(address);
  if (isIPv6(address)) return isPublicIPv6(address);
  return false;
}

function isPublicIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier NAT
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast and reserved

  // The documentation and protocol-assignment ranges. The comment above this
  // function claimed they were refused and only the benchmarking range was, so
  // 192.0.2.1 and 203.0.113.1 were treated as ordinary public addresses. They
  // are not routable, so nothing legitimate is lost, and they are exactly what
  // an internal test fixture is likely to answer on.
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3

  return true;
}

/**
 * IPv6, including every IPv4 address an IPv6 address can carry inside it.
 *
 * This used to recognise one of them: the dotted IPv4-mapped form,
 * `::ffff:127.0.0.1`, matched with a regular expression. `isIPv6` also accepts
 * the hexadecimal spelling of the same address, `::ffff:7f00:1`, which the
 * regular expression missed, so the most obvious bypass in the file was to write
 * loopback in hex. Four more prefixes embed an IPv4 address and all of them
 * passed as ordinary public addresses:
 *
 * - `::ffff:0:0/96`, IPv4-mapped, in either spelling.
 * - `::ffff:0:0:0/96`, IPv4-translated (SIIT).
 * - `::/96`, the deprecated IPv4-compatible form, `::127.0.0.1`.
 * - `64:ff9b::/96`, NAT64. `64:ff9b:1::/48` is the local-use variant and is
 *   refused outright, since where the address sits inside it is deployment
 *   specific.
 * - `2002::/16`, 6to4, which carries the IPv4 address in bits 16 to 48.
 * - `2001:0::/32`, Teredo, which carries the server's IPv4 address in bits 32 to
 *   64 and the client's, bitwise complemented, in the last 32. Both are checked.
 *
 * So the address is expanded to its sixteen bytes once and every embedded IPv4
 * address is run through `isPublicIPv4`, rather than pattern-matching text.
 */
function isPublicIPv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;

  const zeros = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) {
      if (bytes[i] !== 0) return false;
    }
    return true;
  };
  const embedded = (offset: number): string =>
    `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;

  // Unspecified and loopback, before the IPv4-compatible check below, which
  // would otherwise read them as 0.0.0.0 and 0.0.0.1.
  if (zeros(0, 16)) return false; // ::
  if (zeros(0, 15) && bytes[15] === 1) return false; // ::1

  // ::ffff:a.b.c.d and ::ffff:0:a.b.c.d, in either spelling: the expansion has
  // already made the two identical.
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIPv4(embedded(12));
  }
  if (zeros(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zeros(10, 12)) {
    return isPublicIPv4(embedded(12));
  }
  // ::a.b.c.d, deprecated but still parsed by isIPv6.
  if (zeros(0, 12)) return isPublicIPv4(embedded(12));

  // 64:ff9b::/96, well-known NAT64.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b
  ) {
    // 64:ff9b:1::/48 places the IPv4 address differently per deployment, so
    // there is nothing reliable to extract. A translation prefix is not a
    // destination, so it is refused rather than guessed at.
    if (bytes[4] === 0x00 && bytes[5] === 0x01) return false;
    if (!zeros(4, 12)) return false;
    return isPublicIPv4(embedded(12));
  }

  // 2002::/16, 6to4.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPublicIPv4(embedded(2));

  // 2001:0::/32, Teredo. The client address is stored complemented.
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    const client = [12, 13, 14, 15]
      .map((offset) => ((bytes[offset] ?? 0) ^ 0xff).toString())
      .join(".");
    return isPublicIPv4(embedded(4)) && isPublicIPv4(client);
  }

  if ((bytes[0] ?? 0) >= 0xfc && (bytes[0] ?? 0) <= 0xfd) return false; // unique local
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return false; // link-local
  if (bytes[0] === 0xff) return false; // multicast

  // 2001:db8::/32, the IPv6 documentation range. The same class of address as
  // the IPv4 TEST-NET blocks above and refused for the same reason.
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return false;
  }

  return true;
}

/**
 * An IPv6 address as its sixteen bytes, or null when it is not one.
 *
 * Text matching on an IPv6 address is a losing game: one address has many
 * spellings, and the attacker picks. Expanding once and comparing bytes means
 * `::ffff:127.0.0.1`, `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:0001` are the
 * same three checks.
 */
function ipv6Bytes(address: string): Uint8Array | null {
  const [withoutZone = ""] = address.toLowerCase().split("%");
  const halves = withoutZone.split("::");
  if (halves.length > 2) return null;

  const expand = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const last = groups[groups.length - 1] ?? "";
    if (last.includes(".")) {
      const quad = last.split(".").map(Number);
      if (quad.length !== 4) return null;
      if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
        return null;
      const [q0 = 0, q1 = 0, q2 = 0, q3 = 0] = quad;
      groups.splice(
        groups.length - 1,
        1,
        ((q0 << 8) | q1).toString(16),
        ((q2 << 8) | q3).toString(16),
      );
    }
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    }
    return groups;
  };

  const head = expand(halves[0] ?? "");
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];
  if (!head || !tail) return null;

  const missing = 8 - head.length - tail.length;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (missing < 0) {
    return null;
  }

  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...tail,
  ];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = (value >> 8) & 0xff;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

interface RawResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly location: string | null;
  readonly body: string;
}

function requestOnce(
  url: URL,
  resolved: ResolvedAddress,
  purpose: string,
  deadline: number,
): Promise<RawResponse> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const budget = deadline - Date.now();

  return new Promise<RawResponse>((resolve, reject) => {
    if (budget <= 0) {
      reject(deadlineExceeded(url));
      return;
    }

    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };

    const client = request(
      url,
      {
        method: "GET",
        // Idle timeout between bytes. Kept alongside the deadline because it
        // fires sooner and says something more specific about a dead host.
        timeout: Math.min(SOCKET_IDLE_TIMEOUT_MS, budget),
        // The ceiling. `timeout` above resets on every byte, so without this a
        // site that trickles output holds the socket for as long as it likes.
        // An abort surfaces on the `error` handler below, which recognises it.
        // `AbortSignal.timeout` unrefs its own timer, so a request that finishes
        // early leaves nothing holding the event loop open.
        signal: AbortSignal.timeout(budget),
        headers: {
          // Honest about who is calling and why.
          "user-agent": `CookingApp/0.1 (+${purpose})`,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "fr,en;q=0.8",
        },
        // The socket connects to the address that was validated, not to
        // whatever the name resolves to a second time. This is what closes the
        // DNS rebinding window.
        lookup: (_hostname, _options, callback) => {
          callback(null, resolved.address, resolved.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;

        if (status >= 300 && status < 400 && location) {
          response.resume();
          settle(() =>
            resolve({ status, contentType: null, location, body: "" }),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;

        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy();
            settle(() =>
              reject(
                new DomainError(
                  "VALIDATION",
                  `La page dépasse ${Math.round(MAX_BYTES / 1000)} ko et n'a pas été lue en entier.`,
                  { url: url.toString() },
                ),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        response.on("end", () => {
          const contentType = response.headers["content-type"] ?? null;
          settle(() =>
            resolve({
              status,
              contentType,
              location: null,
              body: decodeBody(Buffer.concat(chunks), contentType),
            }),
          );
        });

        response.on("error", (error) => settle(() => reject(error)));
      },
    );

    client.on("timeout", () => {
      settle(() => {
        client.destroy();
        reject(
          new DomainError(
            "VALIDATION",
            `Le site n'a pas répondu en moins de ${SOCKET_IDLE_TIMEOUT_MS / 1000} secondes.`,
            { url: url.toString() },
          ),
        );
      });
    });

    client.on("error", (error) => {
      settle(() =>
        reject(
          error instanceof DomainError
            ? error
            : isAbort(error)
              ? // The overall deadline fired. Reported as a deadline rather than
                // as "impossible to reach", which would send the agent to check
                // an address that answered perfectly well, only slowly.
                deadlineExceeded(url)
              : new DomainError(
                  "VALIDATION",
                  `Impossible de joindre ce site : ${error.message}`,
                  { url: url.toString() },
                ),
        ),
      );
    });

    client.end();
  });
}

/** An `AbortSignal.timeout` abort, whichever of the two shapes Node reports. */
function isAbort(error: Error): boolean {
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    (error as NodeJS.ErrnoException).code === "ABORT_ERR"
  );
}

function deadlineExceeded(url: URL): DomainError {
  return new DomainError(
    "VALIDATION",
    `La lecture de cette page a dépassé ${TOTAL_DEADLINE_MS / 1000} secondes en tout et a été abandonnée. Récupérez la page vous-même et créez la recette avec \`create_recipe\`.`,
    { url: url.toString() },
  );
}

/**
 * Decoded with the charset the response declares, not as UTF-8 regardless.
 *
 * French recipe sites are exactly the population most likely to still serve
 * latin-1, and decoding those bytes as UTF-8 turns every accent into a
 * replacement character. The recipe then imports as mojibake, is stored that
 * way, and nothing downstream can tell it from a title someone typed badly.
 * An unknown or absent charset falls back to UTF-8, which is the right guess
 * for anything written this decade.
 */
function decodeBody(body: Buffer, contentType: string | null): string {
  const declared = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? "")?.[1];
  if (!declared || /^utf-?8$/i.test(declared)) return body.toString("utf8");

  try {
    return new TextDecoder(declared).decode(body);
  } catch {
    // An unrecognised label. Better a readable guess than a failed import.
    return body.toString("utf8");
  }
}
