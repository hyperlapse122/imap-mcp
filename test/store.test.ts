import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, importKey, toBase64 } from "../src/crypto";
import { AccountStore, validateAccountInput } from "../src/store";
import { memoryD1 } from "./d1-sqlite";

const keyB64 = toBase64(new Uint8Array(32).fill(7));

describe("password encryption", () => {
  it("round-trips and binds to the account id", async () => {
    const key = await importKey(keyB64);
    const sealed = await encryptSecret(key, "secret-pass", "acct-1");
    expect(sealed).not.toContain("secret-pass");
    expect(await decryptSecret(key, sealed, "acct-1")).toBe("secret-pass");
    await expect(decryptSecret(key, sealed, "acct-2")).rejects.toThrow();
  });
  it("needs a 32-byte key", async () => {
    await expect(importKey(undefined)).rejects.toThrow(/not set/);
    await expect(importKey(toBase64(new Uint8Array(16)))).rejects.toThrow(/32 bytes/);
  });
});

describe("account store", () => {
  it("stores passwords encrypted and resolves by name", async () => {
    const db = memoryD1();
    const store = new AccountStore(db, await importKey(keyB64));
    const a = await store.create({ label: "iCloud", host: "imap.mail.me.com", port: 993, username: "me", sentFolder: null }, "pw-1");
    const raw = await db.prepare("SELECT password_enc FROM accounts").first<{ password_enc: string }>();
    expect(raw?.password_enc).toMatch(/^v1:/);
    expect(raw?.password_enc).not.toContain("pw-1");
    expect(await store.password(a.id)).toBe("pw-1");
    expect((await store.resolve(undefined)).id).toBe(a.id);
    expect((await store.resolve("icloud")).id).toBe(a.id);

    await store.update(a.id, { label: "iCloud", host: "imap.mail.me.com", port: 993, username: "me2", sentFolder: "Sent" }, null);
    expect(await store.password(a.id)).toBe("pw-1");
    expect((await store.get(a.id))?.username).toBe("me2");
    await store.update(a.id, { label: "iCloud", host: "imap.mail.me.com", port: 993, username: "me2", sentFolder: null }, "pw-2");
    expect(await store.password(a.id)).toBe("pw-2");

    await store.create({ label: "Work", host: "imap.example.com", port: 993, username: "w", sentFolder: null }, "pw");
    await expect(store.resolve(undefined)).rejects.toThrow(/several accounts/);
    await store.remove(a.id);
    expect(await store.list()).toHaveLength(1);
  });
});

describe("form validation", () => {
  it("accepts a normal account and rejects bad values", () => {
    expect(validateAccountInput({ label: "iCloud", host: "IMAP.mail.me.com", port: "", username: "me" })).toEqual({
      label: "iCloud",
      host: "imap.mail.me.com",
      port: 993,
      username: "me",
      sentFolder: null,
    });
    expect(() => validateAccountInput({ label: "x", host: "localhost", username: "me" })).toThrow(/Server/);
    expect(() => validateAccountInput({ label: "x", host: "10.0.0.1", username: "me" })).toThrow(/Server/);
    expect(() => validateAccountInput({ label: "x", host: "a.com", port: "99999", username: "me" })).toThrow(/Port/);
    expect(() => validateAccountInput({ label: "<b>", host: "a.com", username: "me" })).toThrow(/Name/);
  });
});
