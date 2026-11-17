// Read-only mail operations for one account: open a connection, sign in, do the work, log out.

import { astring, ImapConnection, ImapError, type Transport } from "./imap/connection";
import {
  buildSearch,
  examine,
  fetchMessage,
  fetchSummaries,
  findSentFolder,
  type Folder,
  listFolders,
  type MailAddress,
  type MessageDetail,
  type MessageSummary,
  replySearch,
  type SearchCriteria,
  searchUids,
} from "./imap/mailbox";
import type { Account } from "./store";

export interface MailDeps {
  /** Opens a TLS connection to host:port. */
  open: (host: string, port: number) => Transport;
  /** Returns the decrypted password for an account. */
  password: (account: Account) => Promise<string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_SOURCE_BYTES = 2_000_000;

export async function withMailbox<T>(deps: MailDeps, account: Account, fn: (conn: ImapConnection) => Promise<T>): Promise<T> {
  let transport: Transport;
  try {
    transport = deps.open(account.host, account.port);
  } catch {
    throw new ImapError("could not connect to the mail server", "connection");
  }
  const conn = await ImapConnection.open(transport, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS).catch(async (e) => {
    try {
      await transport.close();
    } catch {
      // ignore
    }
    throw e;
  });
  try {
    await conn.login(account.username, await deps.password(account));
    return await fn(conn);
  } finally {
    await conn.logout();
  }
}

export function formatAddress(a: MailAddress): string {
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address ?? a.name ?? "";
}

export interface SummaryOut {
  uid: number;
  date: string | null;
  from: string[];
  to: string[];
  cc: string[];
  subject: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  seen: boolean;
  answered: boolean;
  flagged: boolean;
  size: number | null;
}

export function summaryOut(m: MessageSummary): SummaryOut {
  return {
    uid: m.uid,
    date: m.date,
    from: m.from.map(formatAddress),
    to: m.to.map(formatAddress),
    cc: m.cc.map(formatAddress),
    subject: m.subject,
    message_id: m.messageId,
    in_reply_to: m.inReplyTo,
    seen: m.seen,
    answered: m.answered,
    flagged: m.flagged,
    size: m.size,
  };
}

export async function folders(deps: MailDeps, account: Account): Promise<Folder[]> {
  return withMailbox(deps, account, (conn) => listFolders(conn));
}

export async function search(
  deps: MailDeps,
  account: Account,
  folder: string,
  criteria: SearchCriteria,
  limit: number,
): Promise<{ folder: string; total: number; messages: SummaryOut[] }> {
  return withMailbox(deps, account, async (conn) => {
    await examine(conn, folder);
    const uids = await searchUids(conn, buildSearch(criteria));
    const newest = uids.slice(-limit);
    const summaries = await fetchSummaries(conn, newest);
    summaries.sort((a, b) => b.uid - a.uid);
    return { folder, total: uids.length, messages: summaries.map(summaryOut) };
  });
}

export async function read(
  deps: MailDeps,
  account: Account,
  folder: string,
  uid: number,
  maxChars: number,
): Promise<(SummaryOut & { reply_to: string[]; references: string[]; text: string; text_source: MessageDetail["textSource"]; text_truncated: boolean; attachments: MessageDetail["attachments"] }) | null> {
  return withMailbox(deps, account, async (conn) => {
    await examine(conn, folder);
    const m = await fetchMessage(conn, uid, MAX_SOURCE_BYTES);
    if (!m) return null;
    const truncated = m.text.length > maxChars || m.truncatedSource;
    return {
      ...summaryOut(m),
      reply_to: m.replyTo.map(formatAddress),
      references: m.references,
      text: m.text.slice(0, maxChars),
      text_source: m.textSource,
      text_truncated: truncated,
      attachments: m.attachments,
    };
  });
}

export interface ReplyCheck {
  replied: boolean;
  answered_flag: boolean | null;
  sent_folder: string | null;
  replies: SummaryOut[];
}

/** Has the account owner replied to a message? Looks in the Sent folder and at the original's \Answered flag. */
export async function checkReplied(deps: MailDeps, account: Account, messageId: string, folder: string): Promise<ReplyCheck> {
  const query = replySearch(messageId);
  return withMailbox(deps, account, async (conn) => {
    // The original message's \Answered flag, when the client that replied set it.
    let answeredFlag: boolean | null = null;
    try {
      await examine(conn, folder);
      const uids = await searchUids(conn, ["UID SEARCH HEADER Message-ID ", ...astring(messageId.trim())]);
      if (uids.length > 0) {
        const [original] = await fetchSummaries(conn, uids.slice(-1));
        answeredFlag = original ? original.answered : null;
      }
    } catch (e) {
      if (!(e instanceof ImapError) || e.code !== "command") throw e;
    }

    const all = await listFolders(conn);
    const sent = account.sentFolder ? (all.find((f) => f.name === account.sentFolder) ?? null) : findSentFolder(all);
    let replies: SummaryOut[] = [];
    if (sent) {
      await examine(conn, sent.name);
      const uids = await searchUids(conn, query);
      replies = (await fetchSummaries(conn, uids.slice(-20))).sort((a, b) => b.uid - a.uid).map(summaryOut);
    }
    return {
      replied: replies.length > 0 || answeredFlag === true,
      answered_flag: answeredFlag,
      sent_folder: sent?.name ?? null,
      replies,
    };
  });
}

/** Sign in and list folders, to check an account's settings. Returns a short, content-free result. */
export async function testAccount(deps: MailDeps, account: Account): Promise<{ ok: true; folders: number; sentFolder: string | null } | { ok: false; error: string }> {
  try {
    const list = await folders(deps, account);
    const sent = account.sentFolder ? (list.find((f) => f.name === account.sentFolder) ?? null) : findSentFolder(list);
    return { ok: true, folders: list.length, sentFolder: sent?.name ?? null };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

export function describeError(e: unknown): string {
  if (e instanceof ImapError) return e.message;
  if (e instanceof Error && /ENCRYPTION_KEY|decrypt|operation-specific/i.test(e.message)) {
    return "the stored password could not be decrypted; enter it again";
  }
  if (e instanceof Error) return e.message;
  return "unexpected error";
}
