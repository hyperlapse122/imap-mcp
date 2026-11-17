// AES-GCM encryption for stored mail server passwords.
// The key comes from the ENCRYPTION_KEY secret and never touches the database.

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function importKey(base64Key: string | undefined): Promise<CryptoKey> {
  if (!base64Key) throw new Error("ENCRYPTION_KEY is not set");
  const raw = fromBase64(base64Key.trim());
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a secret. The account id is bound as additional data, so a ciphertext cannot be moved to another row. */
export async function encryptSecret(key: CryptoKey, plaintext: string, accountId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(accountId) }, key, enc.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return "v1:" + toBase64(out);
}

export async function decryptSecret(key: CryptoKey, stored: string, accountId: string): Promise<string> {
  if (!stored.startsWith("v1:")) throw new Error("unknown password format");
  const bytes = fromBase64(stored.slice(3));
  const iv = bytes.subarray(0, 12);
  const sealed = bytes.subarray(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(accountId) }, key, sealed);
  return dec.decode(plain);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(value: string): Uint8Array {
  const s = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
