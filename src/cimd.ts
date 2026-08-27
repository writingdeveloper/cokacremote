import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, type LookupFunction } from "node:net";

const MAX_METADATA_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

export interface CimdResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface CimdHttpResponse {
  statusCode: number;
  contentType: string | undefined;
  body: string;
}

export interface CimdResolverDependencies {
  lookup?: (hostname: string) => Promise<CimdResolvedAddress[]>;
  fetchDocument?: (
    url: URL,
    address: CimdResolvedAddress,
  ) => Promise<CimdHttpResponse>;
}

export interface CimdClientResolverLike {
  resolve(clientId: string): Promise<unknown>;
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function validateClientIdUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new Error("CIMD client_id must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("CIMD client_id must use HTTPS");
  }
  if (!url.hostname) {
    throw new Error("CIMD client_id must include a hostname");
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error("CIMD client_id must include a non-root path");
  }
  if (url.username || url.password) {
    throw new Error("CIMD client_id must not contain user credentials");
  }
  if (url.hash) {
    throw new Error("CIMD client_id must not contain a fragment");
  }
  return url;
}

export function isCimdClientId(clientId: string): boolean {
  try {
    validateClientIdUrl(clientId);
    return true;
  } catch {
    return false;
  }
}

function isPublicAddress(value: CimdResolvedAddress): boolean {
  if (value.family === 6 && value.address.toLowerCase().startsWith("::ffff:")) {
    return false;
  }
  return !blockedAddresses.check(value.address, value.family === 4 ? "ipv4" : "ipv6");
}

async function defaultLookup(hostname: string): Promise<CimdResolvedAddress[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results
    .filter((result): result is { address: string; family: 4 | 6 } =>
      result.family === 4 || result.family === 6,
    )
    .map(({ address, family }) => ({ address, family }));
}

function defaultFetchDocument(
  url: URL,
  address: CimdResolvedAddress,
): Promise<CimdHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === "object" && options.all) {
        callback(null, [{ address: address.address, family: address.family }]);
        return;
      }
      callback(null, address.address, address.family);
    };
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "cokacremote-cimd/0.1",
        },
        lookup: pinnedLookup,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_METADATA_BYTES) {
            finishReject(new Error("CIMD metadata document is too large"));
            response.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", (error) => finishReject(error));
        response.once("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: response.statusCode ?? 0,
            contentType:
              typeof response.headers["content-type"] === "string"
                ? response.headers["content-type"]
                : undefined,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(FETCH_TIMEOUT_MS, () => {
      request.destroy(new Error("CIMD metadata request timed out"));
    });
    request.once("error", (error) => finishReject(error));
    request.end();
  });
}

export class CimdClientResolver implements CimdClientResolverLike {
  private readonly lookup: (hostname: string) => Promise<CimdResolvedAddress[]>;
  private readonly fetchDocument: (
    url: URL,
    address: CimdResolvedAddress,
  ) => Promise<CimdHttpResponse>;

  constructor(dependencies: CimdResolverDependencies = {}) {
    this.lookup = dependencies.lookup ?? defaultLookup;
    this.fetchDocument = dependencies.fetchDocument ?? defaultFetchDocument;
  }

  async resolve(clientId: string): Promise<unknown> {
    const url = validateClientIdUrl(clientId);
    const addresses = await this.lookup(url.hostname);
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
      throw new Error("CIMD metadata hostname must resolve only to public addresses");
    }

    const response = await this.fetchDocument(url, addresses[0]!);
    if (response.statusCode !== 200) {
      throw new Error("CIMD metadata fetch must return HTTP 200 without redirects");
    }
    if (
      !response.contentType ||
      !/^(?:application\/json|[^;\s]+\/[^;\s]+\+json)(?:\s*;|$)/i.test(response.contentType)
    ) {
      throw new Error("CIMD metadata must use a JSON content type");
    }
    if (Buffer.byteLength(response.body, "utf8") > MAX_METADATA_BYTES) {
      throw new Error("CIMD metadata document is too large");
    }

    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new Error("CIMD metadata document must contain valid JSON");
    }
  }
}
