import { describe, expect, it } from "vitest";
import { importKey, toBase64 } from "../src/crypto";
import type { MailDeps } from "../src/mail";
import { handleMcp } from "../src/mcp";
import { AccountStore } from "../src/store";
import { handleWeb } from "../src/web";
import { memoryD1 } from "./d1-sqlite";
import { FakeImapServer, sampleMailbox } from "./fake-imap";

async function setup() {
  const store = new AccountStore(memoryD1(), await importKey(toBase64(new Uint8Array(32).fill(1))));
  const server = new FakeImapServer(sampleMailbox());
  const deps: MailDeps = { open: () => server.transport(), password: (a) => store.password(a.id), timeoutMs: 2000 };
  return { store, server, deps };
}

const BASE = "https://mail-mcp.example.com";

async function rpc(store: AccountStore, deps: MailDeps, method: string, params: unknown = {}) {
  const res = await handleMcp(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    store,
    deps,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { result: any };
}

describe("MCP endpoint", () => {
  it("lists only read-only tools", async () => {
    const { store, deps } = await setup();
    const init = await rpc(store, deps, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.result.serverInfo.name).toBe("imap-mcp");
    const tools = (await rpc(store, deps, "tools/list")).result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["check_replied", "list_accounts", "list_folders", "read_message", "search_messages"]);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("searches and reads through tools", async () => {
    const { store, deps } = await setup();
    await store.create({ label: "iCloud", host: "imap.example.com", port: 993, username: "me@example.com", sentFolder: null }, "app-pass-1234");
    const found = await rpc(store, deps, "tools/call", { name: "search_messages", arguments: { limit: 5 } });
    const payload = JSON.parse(found.result.content[0].text);
    expect(payload.messages.map((m: { uid: number }) => m.uid)).toEqual([12, 11]);
    const accounts = JSON.parse((await rpc(store, deps, "tools/call", { name: "list_accounts", arguments: {} })).result.content[0].text);
    expect(JSON.stringify(accounts)).not.toContain("app-pass");
    const err = await rpc(store, deps, "tools/call", { name: "read_message", arguments: { account: "nope", uid: 1 } });
    expect(err.result.isError).toBe(true);
  });

  it("refuses GET", async () => {
    const { store, deps } = await setup();
    expect((await handleMcp(new Request(`${BASE}/mcp`), store, deps)).status).toBe(405);
  });
});

function form(path: string, fields: Record<string, string>, origin = BASE) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("account page", () => {
  it("adds, tests, edits and removes an account without showing the password", async () => {
    const { store, deps } = await setup();
    const fields = { label: "iCloud", host: "imap.example.com", port: "993", username: "me@example.com", password: "app-pass-1234" };
    const added = await handleWeb(form("/accounts", fields), store, deps, "me@example.com");
    expect(added.status).toBe(303);
    const location = added.headers.get("Location")!;
    const id = /\/accounts\/([0-9a-f-]+)/.exec(location)![1]!;

    const detail = await (await handleWeb(new Request(BASE + location), store, deps, null)).text();
    expect(detail).toContain("iCloud");
    expect(detail).not.toContain("app-pass-1234");

    const tested = await (await handleWeb(form(`/accounts/${id}/test`, {}), store, deps, null)).text();
    expect(tested).toContain("Signed in. 3 folders found");
    expect(tested).toContain("Sent Messages");

    await handleWeb(form(`/accounts/${id}`, { ...fields, password: "" }), store, deps, null);
    expect(await store.password(id)).toBe("app-pass-1234");

    const wrong = await handleWeb(form(`/accounts/${id}`, { ...fields, password: "wrong" }), store, deps, null);
    expect(wrong.status).toBe(303);
    const failed = await (await handleWeb(form(`/accounts/${id}/test`, {}), store, deps, null)).text();
    expect(failed).toContain("Could not read this account: sign-in to the mail server was refused");

    expect((await handleWeb(form(`/accounts/${id}/delete`, {}), store, deps, null)).status).toBe(303);
    expect(await store.list()).toHaveLength(0);
  });

  it("escapes values and keeps the password out of error pages", async () => {
    const { store, deps } = await setup();
    const res = await handleWeb(
      form("/accounts", { label: "<script>", host: "imap.example.com", username: '"><img>', password: "secret-xyz" }),
      store,
      deps,
      null,
    );
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('"><img>');
    expect(html).not.toContain("secret-xyz");
  });

  it("refuses cross-site posts", async () => {
    const { store, deps } = await setup();
    const res = await handleWeb(form("/accounts", { label: "x" }, "https://evil.example"), store, deps, null);
    expect(res.status).toBe(403);
  });
});
