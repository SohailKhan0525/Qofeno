/**
 * SSRF defense for network tools (#0037 web retrieval, #0079 network policy).
 * Blocks private/link-local/metastack addresses, non-http(s) schemes and
 * re-validates after redirects.
 */
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { ErrorCode, QofenoError } from "@agent-qofeno/core";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
]);

function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7));
    return false;
  }
  return false;
}

export interface UrlCheckOptions {
  /** Hosts the policy explicitly allows even if they would otherwise be blocked. */
  allowHosts?: string[];
  allowPrivateNetworks?: boolean;
}

export async function assertSafeUrl(rawUrl: string, opts: UrlCheckOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: `invalid url` });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new QofenoError({
      code: ErrorCode.POLICY_DENIED,
      message: `blocked scheme ${url.protocol}`,
      userMessage: "Only http and https URLs may be fetched.",
    });
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (opts.allowHosts?.includes(host)) return url;
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new QofenoError({
      code: ErrorCode.POLICY_DENIED,
      message: `blocked host ${host}`,
      userMessage: "That host is not reachable from the fetch tool.",
    });
  }
  if (isIP(host) && isPrivateIp(host) && !opts.allowPrivateNetworks) {
    throw privateBlock(url.hostname);
  }
  if (!isIP(host) && !opts.allowPrivateNetworks) {
    try {
      const records = await lookup(host, { all: true, verbatim: true });
      for (const r of records) {
        if (isPrivateIp(r.address)) throw privateBlock(`${host} (${r.address})`);
      }
    } catch (e) {
      if (e instanceof QofenoError) throw e;
      throw new QofenoError({
        code: ErrorCode.PROVIDER_UNAVAILABLE,
        message: `dns failure for ${host}`,
        userMessage: `Could not resolve ${host}.`,
        retryable: true,
      });
    }
  }
  return url;
}

function privateBlock(detail: string): QofenoError {
  return new QofenoError({
    code: ErrorCode.POLICY_DENIED,
    message: `private network target blocked: ${detail}`,
    userMessage: "Fetching internal/private network addresses is blocked by policy.",
  });
}
