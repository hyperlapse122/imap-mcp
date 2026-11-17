// Read-only mailbox operations on top of ImapConnection.

import PostalMime from "postal-mime";
import { astring, type CommandPart, ImapConnection, ImapError } from "./connection";
import { asText, fetchAttributes, type ImapValue, latin1Bytes, parseValues, type RawResponse } from "./parser";
import { decodeMailboxName, encodeMailboxName } from "./utf7";

export interface Folder {
  /** Display name, decoded from modified UTF-7. Pass this back to other calls. */
  name: string;
  delimiter: string | null;
  /** Special-use role from RFC 6154, such as "sent" or "inbox", when the server reports one. */
  role: string | null;
  selectable: boolean;
}

export interface MailAddress {
  name: string | null;
  address: string | null;
}

export interface MessageSummary {
  uid: number;
  date: string | null;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  seen: boolean;
  answered: boolean;
  flagged: boolean;
  size: number | null;
}

export interface MessageDetail extends MessageSummary {
  references: string[];
  replyTo: MailAddress[];
  text: string;
  textSource: "text" | "html" | "none";
  attachments: { filename: string | null; mimeType: string; size: number }[];
  truncatedSource: boolean;
}

export interface SearchCriteria {
  since?: string;
  before?: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  unseen?: boolean;
  unanswered?: boolean;
}

const SPECIAL_USE = ["\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\Archive", "\\All", "\\Flagged"];
const HEADER_FIELDS = "FROM TO CC REPLY-TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES";

function untaggedValues(responses: RawResponse[], kind: string): ImapValue[][] {
  const out: ImapValue[][] = [];
  for (const res of responses) {
    const values = parseValues(res);
    // "*" KIND ... or "*" n KIND ...
    if (values[0] !== "*") continue;
    if (typeof values[1] === "string" && values[1].toUpperCase() === kind) out.push(values.slice(2));
    else if (typeof values[2] === "string" && values[2].toUpperCase() === kind) out.push([values[1]!, ...values.slice(3)]);
  }
  return out;
}

export async function listFolders(conn: ImapConnection): Promise<Folder[]> {
  const result = await conn.command(['LIST "" "*"']);
  const folders: Folder[] = [];
  for (const values of untaggedValues(result.untagged, "LIST")) {
    const [flagsValue, delimValue, nameValue] = values;
    const flags = Array.isArray(flagsValue) ? flagsValue.map((f) => String(f)) : [];
    const rawName = asText(nameValue as ImapValue) ?? "";
    const name = decodeMailboxName(rawName);
    const special = flags.find((f) => SPECIAL_USE.some((s) => s.toLowerCase() === f.toLowerCase()));
    folders.push({
      name,
      delimiter: asText(delimValue as ImapValue),
      role: name.toUpperCase() === "INBOX" ? "inbox" : special ? special.slice(1).toLowerCase() : null,
      selectable: !flags.some((f) => f.toLowerCase() === "\\noselect" || f.toLowerCase() === "\\nonexistent"),
    });
  }
  return folders;
}

/** Find the Sent folder: its special-use flag first, then common names. */
export function findSentFolder(folders: Folder[]): Folder | null {
  const byRole = folders.find((f) => f.role === "sent");
  if (byRole) return byRole;
  const names = ["Sent Messages", "Sent", "Sent Items", "Sent Mail", "[Gmail]/Sent Mail", "INBOX.Sent"];
  for (const n of names) {
    const f = folders.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (f) return f;
  }
  return null;
}

/** Open a folder read-only (EXAMINE). The server cannot change flags while it is open this way. */
export async function examine(conn: ImapConnection, folder: string): Promise<{ exists: number; uidValidity: string | null }> {
  const result = await conn.command(["EXAMINE ", ...astring(encodeMailboxName(folder))], { allowNo: true });
  if (result.status !== "OK") throw new ImapError(`folder not found: ${folder}`, "command");
  let exists = 0;
  let uidValidity: string | null = null;
  for (const res of result.untagged) {
    const head = res.text[0] ?? "";
    const e = /^\* (\d+) EXISTS/i.exec(head);
    if (e) exists = Number(e[1]);
    const u = /\[UIDVALIDITY (\d+)\]/i.exec(head);
    if (u) uidValidity = u[1]!;
  }
  return { exists, uidValidity };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Turn YYYY-MM-DD into the IMAP date form 1-Jan-2026. */
export function imapDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new ImapError(`dates must look like 2026-11-17, got: ${value}`, "command");
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) throw new ImapError(`not a valid month: ${value}`, "command");
  return `${Number(m[3])}-${month}-${m[1]}`;
}

export function buildSearch(criteria: SearchCriteria): CommandPart[] {
  const keys: CommandPart[][] = [];
  if (criteria.since) keys.push([`SINCE ${imapDate(criteria.since)}`]);
  if (criteria.before) keys.push([`BEFORE ${imapDate(criteria.before)}`]);
  if (criteria.unseen) keys.push(["UNSEEN"]);
  if (criteria.unanswered) keys.push(["UNANSWERED"]);
  for (const key of ["from", "to", "subject", "text"] as const) {
    const v = criteria[key];
    if (v) keys.push([`${key.toUpperCase()} `, ...astring(v)]);
  }
  if (keys.length === 0) keys.push(["ALL"]);
  const needsCharset = keys.some((k) => k.some((p) => typeof p !== "string"));
  const parts: CommandPart[] = [needsCharset ? "UID SEARCH CHARSET UTF-8 " : "UID SEARCH "];
  keys.forEach((k, i) => {
    if (i > 0) parts.push(" ");
    parts.push(...k);
  });
  return parts;
}

export async function searchUids(conn: ImapConnection, parts: CommandPart[]): Promise<number[]> {
  const result = await conn.command(parts);
  const uids: number[] = [];
  for (const values of untaggedValues(result.untagged, "SEARCH")) {
    for (const v of values) if (typeof v === "string" && /^\d+$/.test(v)) uids.push(Number(v));
  }
  return uids.sort((a, b) => a - b);
}

function toAddresses(value: unknown): MailAddress[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: MailAddress[] = [];
  for (const item of list as { name?: string; address?: string; group?: { name: string; address: string }[] }[]) {
    if (item.group) for (const g of item.group) out.push({ name: g.name || null, address: g.address || null });
    else out.push({ name: item.name || null, address: item.address || null });
  }
  return out;
}

function splitReferences(value: string | undefined): string[] {
  return value ? (value.match(/<[^>]+>/g) ?? []) : [];
}

function flagsOf(attrs: Map<string, ImapValue>): string[] {
  const f = attrs.get("FLAGS");
  return Array.isArray(f) ? f.map((x) => String(x).toLowerCase()) : [];
}

function bodySection(attrs: Map<string, ImapValue>): Uint8Array | null {
  for (const [key, value] of attrs) {
    if (key.startsWith("BODY[")) {
      if (value instanceof Uint8Array) return value;
      if (typeof value === "string") return latin1Bytes(value);
    }
  }
  return null;
}

async function summarize(attrs: Map<string, ImapValue>, headerBytes: Uint8Array | null): Promise<MessageSummary> {
  const header = headerBytes ? await PostalMime.parse(concat(headerBytes, latin1Bytes("\r\n\r\n"))) : null;
  const flags = flagsOf(attrs);
  const size = asText(attrs.get("RFC822.SIZE"));
  return {
    uid: Number(asText(attrs.get("UID"))),
    date: header?.date ?? asText(attrs.get("INTERNALDATE")),
    from: toAddresses(header?.from),
    to: toAddresses(header?.to),
    cc: toAddresses(header?.cc),
    subject: header?.subject ?? null,
    messageId: header?.messageId ?? null,
    inReplyTo: header?.inReplyTo ?? null,
    seen: flags.includes("\\seen"),
    answered: flags.includes("\\answered"),
    flagged: flags.includes("\\flagged"),
    size: size ? Number(size) : null,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function fetchResponses(responses: RawResponse[]): Map<string, ImapValue>[] {
  const out: Map<string, ImapValue>[] = [];
  for (const values of untaggedValues(responses, "FETCH")) {
    const list = values[1];
    if (Array.isArray(list)) out.push(fetchAttributes(list));
  }
  return out;
}

/** Fetch header summaries for the given UIDs without touching the \Seen flag. */
export async function fetchSummaries(conn: ImapConnection, uids: number[]): Promise<MessageSummary[]> {
  if (uids.length === 0) return [];
  const result = await conn.command([
    `UID FETCH ${uids.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])`,
  ]);
  const summaries: MessageSummary[] = [];
  for (const attrs of fetchResponses(result.untagged)) {
    if (!attrs.has("UID")) continue;
    summaries.push(await summarize(attrs, bodySection(attrs)));
  }
  return summaries;
}

/** Fetch one whole message (up to maxBytes of source) without touching the \Seen flag. */
export async function fetchMessage(conn: ImapConnection, uid: number, maxBytes: number): Promise<MessageDetail | null> {
  const result = await conn.command([`UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.${maxBytes}>)`]);
  const attrs = fetchResponses(result.untagged).find((a) => Number(asText(a.get("UID"))) === uid);
  if (!attrs) return null;
  const source = bodySection(attrs) ?? new Uint8Array(0);
  const email = await PostalMime.parse(source, { attachmentEncoding: "arraybuffer" });
  const header = await summarize(attrs, null);
  let text = email.text?.trim() ?? "";
  let textSource: MessageDetail["textSource"] = text ? "text" : "none";
  if (!text && email.html) {
    text = htmlToText(email.html);
    textSource = text ? "html" : "none";
  }
  const size = header.size;
  return {
    ...header,
    date: email.date ?? header.date,
    from: toAddresses(email.from),
    to: toAddresses(email.to),
    cc: toAddresses(email.cc),
    replyTo: toAddresses(email.replyTo),
    subject: email.subject ?? null,
    messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? null,
    references: splitReferences(email.references),
    text,
    textSource,
    attachments: email.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
    })),
    truncatedSource: size !== null && size > maxBytes,
  };
}

/** Search a folder for messages that reply to or reference the given Message-ID. */
export function replySearch(messageId: string): CommandPart[] {
  const id = messageId.trim();
  if (!/^<[^<>\s]+>$/.test(id)) throw new ImapError("message_id must look like <id@host>", "command");
  return ["UID SEARCH OR HEADER In-Reply-To ", ...astring(id), " HEADER References ", ...astring(id)];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
