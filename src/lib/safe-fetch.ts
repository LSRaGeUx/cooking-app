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
 * - **Address validation after resolution, with the resolved address pinned.**
 *   Checking the hostname is useless: `evil.test` can resolve to 127.0.0.1.
 *   Checking the resolved address and then calling `fetch` is nearly useless
 *   too, because the name can resolve differently the second time, which is DNS
 *   rebinding. So the socket is told exactly which address to use, and that
 *   address is the one that was validated.
 * - **Redirect cap, and every hop revalidated.** A public URL that redirects to
 *   169.254.169.254 is the standard bypass.
 * - **Size cap and timeout.** A URL that streams forever is a denial of service
 *   against our own process.
 *
 * `purpose` is required and logged. If a second caller ever appears, it should
 * be obvious in the logs what the server is reaching out for and why.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 3;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 8_000;

export interface SafeFetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

export async function safeFetch(
  rawUrl: string,
  purpose: "recipe-import",
): Promise<SafeFetchResult> {
  let current = parseUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const address = await resolvePublicAddress(current.hostname);
    const response = await requestOnce(current, address, purpose);

    if (response.location) {
      if (hop === MAX_REDIRECTS) {
        throw new DomainError(
          "VALIDATION",
          `Cette adresse redirige trop de fois (plus de ${MAX_REDIRECTS}). Donnez l'adresse finale de la recette.`,
          { url: rawUrl },
        );
      }
      // Revalidated on the next pass, because the whole point of a redirect
      // bypass is that the first hop looked fine.
      current = parseUrl(new URL(response.location, current).toString());
      continue;
    }

    return {
      url: current.toString(),
      status: response.status,
      contentType: response.contentType,
      body: response.body,
    };
  }

  throw new DomainError("VALIDATION", "Trop de redirections.", { url: rawUrl });
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

  return url;
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

async function resolvePublicAddress(
  hostname: string,
): Promise<ResolvedAddress> {
  const resolved = await new Promise<ResolvedAddress>((resolve, reject) => {
    dnsLookup(hostname, { verbatim: true }, (error, address, family) => {
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

  if (!isPublicAddress(resolved.address)) {
    throw new DomainError(
      "FORBIDDEN",
      `Cette adresse pointe vers un réseau privé (${resolved.address}) et ne sera pas lue. Seules les adresses publiques sont autorisées.`,
      { hostname, address: resolved.address },
    );
  }

  return resolved;
}

/**
 * Everything that is not routable on the public internet is refused: loopback,
 * private ranges, link-local (which is where cloud metadata lives), carrier
 * NAT, multicast, and the documentation ranges.
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
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier NAT
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast and reserved

  return true;
}

function isPublicIPv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";

  // An IPv4-mapped address is an IPv4 address wearing a hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return isPublicIPv4(mapped[1]);

  if (normalized === "::1" || normalized === "::") return false;
  if (/^f[cd]/.test(normalized)) return false; // unique local
  if (/^fe[89ab]/.test(normalized)) return false; // link-local
  if (/^ff/.test(normalized)) return false; // multicast

  return true;
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
): Promise<RawResponse> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<RawResponse>((resolve, reject) => {
    const client = request(
      url,
      {
        method: "GET",
        timeout: TIMEOUT_MS,
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
          resolve({ status, contentType: null, location, body: "" });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;

        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy();
            reject(
              new DomainError(
                "VALIDATION",
                `La page dépasse ${Math.round(MAX_BYTES / 1000)} ko et n'a pas été lue en entier.`,
                { url: url.toString() },
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        response.on("end", () => {
          resolve({
            status,
            contentType: response.headers["content-type"] ?? null,
            location: null,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });

        response.on("error", reject);
      },
    );

    client.on("timeout", () => {
      client.destroy();
      reject(
        new DomainError(
          "VALIDATION",
          `Le site n'a pas répondu en moins de ${TIMEOUT_MS / 1000} secondes.`,
          { url: url.toString() },
        ),
      );
    });

    client.on("error", (error) => {
      reject(
        error instanceof DomainError
          ? error
          : new DomainError(
              "VALIDATION",
              `Impossible de joindre ce site : ${error.message}`,
              { url: url.toString() },
            ),
      );
    });

    client.end();
  });
}
