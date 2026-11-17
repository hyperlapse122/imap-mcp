// Checks the Cloudflare Access JWT that Access adds to every request it lets through.
// Browser logins and Managed OAuth tokens both arrive here as the same signed JWT,
// so this one check covers the web page and the MCP endpoint.

import { fromBase64 } from "./crypto";

export interface AccessIdentity {
  email: string | null;
  subject: string;
}

export class AccessError extends Error {}

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface CachedKeys {
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, CachedKeys>();
const dec = new TextDecoder();

export type Fetcher = (url: string) => Promise<Response>;

async function loadKeys(teamDomain: string, fetcher: Fetcher, force = false): Promise<Map<string, CryptoKey>> {
  const hit = cache.get(teamDomain);
  if (hit && !force && Date.now() - hit.fetchedAt < CACHE_MS) return hit.keys;
  const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AccessError("could not load Access signing keys");
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  cache.set(teamDomain, { fetchedAt: Date.now(), keys });
  return keys;
}

function decodePart<T>(part: string): T {
  return JSON.parse(dec.decode(fromBase64(part))) as T;
}

export function normalizeTeamDomain(value: string | undefined): string {
  const v = (value ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(v)) {
    throw new AccessError("ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com");
  }
  return v.toLowerCase();
}

export interface VerifyOptions {
  teamDomain: string | undefined;
  audience: string | undefined;
  allowedEmails?: string | undefined;
  now?: number;
  fetcher?: Fetcher;
}

/** Verify a Cf-Access-Jwt-Assertion value. Throws AccessError when it is missing or invalid. */
export async function verifyAccessJwt(token: string | null, opts: VerifyOptions): Promise<AccessIdentity> {
  if (!token) throw new AccessError("missing Access token");
  const teamDomain = normalizeTeamDomain(opts.teamDomain);
  const audience = (opts.audience ?? "").trim();
  if (!audience) throw new AccessError("ACCESS_AUD is not set");
  const fetcher = opts.fetcher ?? ((url: string) => fetch(url));

  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("malformed token");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; sub?: string; common_name?: string };
  try {
    header = decodePart(h);
    payload = decodePart(p);
  } catch {
    throw new AccessError("malformed token");
  }
  if (header.alg !== "RS256" || !header.kid) throw new AccessError("unexpected token algorithm");

  let keys = await loadKeys(teamDomain, fetcher);
  let key = keys.get(header.kid);
  if (!key) {
    // Keys rotate; refresh once before giving up.
    keys = await loadKeys(teamDomain, fetcher, true);
    key = keys.get(header.kid);
  }
  if (!key) throw new AccessError("unknown signing key");

  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AccessError("bad signature");

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new AccessError("token expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new AccessError("token not yet valid");
  if (payload.iss !== `https://${teamDomain}`) throw new AccessError("wrong issuer");
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(audience)) throw new AccessError("wrong audience");

  const email = payload.email?.toLowerCase() ?? null;
  const allowed = (opts.allowedEmails ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length > 0 && (!email || !allowed.includes(email))) throw new AccessError("this account is not allowed");

  return { email, subject: payload.sub ?? payload.common_name ?? "" };
}

/** For tests. */
export function clearKeyCache(): void {
  cache.clear();
}
