import { beforeEach, describe, expect, it } from "vitest";
import { AccessError, clearKeyCache, verifyAccessJwt } from "../src/access";
import { toBase64 } from "../src/crypto";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-123";

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keypair() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { pair, jwk: { ...jwk, kid: "k1", alg: "RS256", use: "sig" } };
}

async function sign(privateKey: CryptoKey, payload: Record<string, unknown>, kid = "k1") {
  const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

describe("Access JWT", () => {
  beforeEach(() => clearKeyCache());

  it("accepts a valid token and checks issuer, audience, expiry and the allowlist", async () => {
    const { pair, jwk } = await keypair();
    let certFetches = 0;
    const fetcher = async (url: string) => {
      expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
      certFetches++;
      return Response.json({ keys: [jwk] });
    };
    const now = Math.floor(Date.now() / 1000);
    const good = { aud: [AUD], iss: `https://${TEAM}`, exp: now + 300, iat: now, email: "Me@Example.com", sub: "u1" };
    const opts = { teamDomain: TEAM, audience: AUD, fetcher };

    expect(await verifyAccessJwt(await sign(pair.privateKey, good), opts)).toEqual({ email: "me@example.com", subject: "u1" });
    expect(certFetches).toBe(1);

    const bad = async (payload: Record<string, unknown>, o: Record<string, unknown> = {}) =>
      expect(verifyAccessJwt(await sign(pair.privateKey, payload), { ...opts, ...o })).rejects.toBeInstanceOf(AccessError);
    await bad({ ...good, aud: ["other"] });
    await bad({ ...good, iss: "https://evil.cloudflareaccess.com" });
    await bad({ ...good, exp: now - 120 });
    await bad(good, { allowedEmails: "someone@else.com" });
    await expect(verifyAccessJwt(await sign(pair.privateKey, good), { ...opts, allowedEmails: "me@example.com, x@y.z" })).resolves.toBeTruthy();

    // A token signed by some other key fails.
    const other = await keypair();
    await expect(verifyAccessJwt(await sign(other.pair.privateKey, good), opts)).rejects.toThrow(/bad signature/);
    await expect(verifyAccessJwt(null, opts)).rejects.toThrow(/missing/);
    await expect(verifyAccessJwt("a.b", opts)).rejects.toThrow(/malformed/);
  });

  it("requires configuration", async () => {
    await expect(verifyAccessJwt("a.b.c", { teamDomain: "example.com", audience: AUD })).rejects.toThrow(/ACCESS_TEAM_DOMAIN/);
    await expect(verifyAccessJwt("a.b.c", { teamDomain: TEAM, audience: "" })).rejects.toThrow(/ACCESS_AUD/);
  });
});
