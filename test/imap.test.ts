import { describe, expect, it } from "vitest";
import { ImapConnection, ImapError } from "../src/imap/connection";
import { buildSearch, imapDate, replySearch } from "../src/imap/mailbox";
import { decodeMailboxName, encodeMailboxName } from "../src/imap/utf7";
import { checkReplied, folders, type MailDeps, read, search } from "../src/mail";
import type { Account } from "../src/store";
import { FakeImapServer, sampleMailbox } from "./fake-imap";

const account: Account = {
  id: "00000000-0000-4000-8000-000000000001",
  label: "Test",
  host: "imap.example.com",
  port: 993,
  username: "me@example.com",
  sentFolder: null,
  createdAt: "",
  updatedAt: "",
};

function setup(pass = "app-pass-1234") {
  const server = new FakeImapServer(sampleMailbox());
  const deps: MailDeps = { open: () => server.transport(), password: async () => pass, timeoutMs: 2000 };
  return { server, deps };
}

describe("mailbox names", () => {
  it("round-trips modified UTF-7", () => {
    for (const name of ["INBOX", "받은 편지함", "Résumé & co", "a&b"]) {
      expect(decodeMailboxName(encodeMailboxName(name))).toBe(name);
    }
    expect(encodeMailboxName("a&b")).toBe("a&-b");
  });
});

describe("search building", () => {
  it("uses plain quoted strings for ASCII", () => {
    expect(buildSearch({ since: "2026-11-01", from: "alice", unanswered: true })).toEqual([
      "UID SEARCH ",
      "SINCE 1-Nov-2026",
      " ",
      "UNANSWERED",
      " ",
      "FROM ",
      '"alice"',
    ]);
  });
  it("switches to UTF-8 literals for other text", () => {
    const parts = buildSearch({ subject: "회의" });
    expect(parts[0]).toBe("UID SEARCH CHARSET UTF-8 ");
    expect(parts.some((p) => typeof p !== "string")).toBe(true);
  });
  it("rejects bad dates and message ids", () => {
    expect(() => imapDate("2026/11/01")).toThrow(ImapError);
    expect(() => replySearch("no-brackets")).toThrow(ImapError);
    expect(() => replySearch('<a"b@x> OR ALL')).toThrow(ImapError);
  });
});

describe("read-only guard", () => {
  it("refuses commands that change the mailbox", async () => {
    const { server } = setup();
    const conn = await ImapConnection.open(server.transport(), 2000);
    for (const cmd of ["STORE 1 +FLAGS (\\Deleted)", "UID STORE 1 +FLAGS (\\Seen)", "EXPUNGE", "SELECT INBOX", "UID MOVE 1 Trash"]) {
      await expect(conn.command([cmd])).rejects.toThrow(/could change the mailbox/);
    }
    await expect(conn.command(["NOOP\r\nSTORE 1 +FLAGS (\\Deleted)"])).rejects.toThrow(/line breaks/);
    await conn.close();
  });
});

describe("mail operations against a fake server", () => {
  it("lists folders with roles and decoded names", async () => {
    const { deps } = setup();
    const list = await folders(deps, account);
    expect(list.map((f) => f.role)).toEqual(["inbox", "sent", null]);
    expect(list[2]!.name).toBe(decodeMailboxName("&ycDGtA- &wtTQ3A-"));
  });

  it("searches newest first and decodes headers", async () => {
    const { server, deps } = setup();
    const result = await search(deps, account, "INBOX", {}, 10);
    expect(result.total).toBe(2);
    expect(result.messages.map((m) => m.uid)).toEqual([12, 11]);
    expect(result.messages[0]!.from[0]).toBe("홍길동 <hong@example.kr>");
    expect(result.messages[0]!.subject).toBe("회의 자료");
    expect(result.messages[1]!.seen).toBe(true);
    // Read-only: EXAMINE, PEEK, and nothing that writes.
    expect(server.commands.some((c) => /^EXAMINE /.test(c))).toBe(true);
    expect(server.commands.filter((c) => /FETCH/.test(c)).every((c) => /BODY\.PEEK/.test(c))).toBe(true);
    expect(server.commands.some((c) => /STORE|EXPUNGE|SELECT|COPY|MOVE/i.test(c))).toBe(false);
  });

  it("limits to the newest messages", async () => {
    const { deps } = setup();
    const result = await search(deps, account, "INBOX", {}, 1);
    expect(result.messages.map((m) => m.uid)).toEqual([12]);
  });

  it("reads a message as text, turning HTML into text", async () => {
    const { deps } = setup();
    const m = await read(deps, account, "INBOX", 12, 1000);
    expect(m?.text).toBe("Hello,\nPlease review the report.");
    expect(m?.text_source).toBe("html");
    expect(m?.text_truncated).toBe(false);
  });

  it("cuts long bodies", async () => {
    const { deps } = setup();
    const m = await read(deps, account, "INBOX", 11, 5);
    expect(m?.text).toBe("Are y");
    expect(m?.text_truncated).toBe(true);
  });

  it("returns null for a missing UID", async () => {
    const { deps } = setup();
    expect(await read(deps, account, "INBOX", 999, 1000)).toBeNull();
  });

  it("finds a reply in the Sent folder", async () => {
    const { deps } = setup();
    const r = await checkReplied(deps, account, "<lunch-1@example.org>", "INBOX");
    expect(r.replied).toBe(true);
    expect(r.sent_folder).toBe("Sent Messages");
    expect(r.replies.map((x) => x.subject)).toEqual(["Re: Lunch on Friday?"]);
    const none = await checkReplied(deps, account, "<report-2@example.kr>", "INBOX");
    expect(none.replied).toBe(false);
    expect(none.answered_flag).toBe(false);
  });

  it("reports a refused sign-in without the password", async () => {
    const { deps } = setup("wrong");
    const err = await folders(deps, account).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect((err as ImapError).code).toBe("auth");
    expect((err as Error).message).not.toContain("wrong");
  });

  it("errors on an unknown folder", async () => {
    const { deps } = setup();
    await expect(search(deps, account, "Nope", {}, 5)).rejects.toThrow(/folder not found/);
  });
});
