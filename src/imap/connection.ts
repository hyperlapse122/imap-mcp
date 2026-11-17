// A small IMAP4rev1 client connection: enough for read-only access.
// It never sends STORE, COPY, MOVE, EXPUNGE, APPEND or DELETE.

import { latin1, latin1Bytes, type RawResponse } from "./parser";

export interface Transport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
}

export type CommandPart = string | { literal: Uint8Array };

export interface TaggedResult {
  status: "OK" | "NO" | "BAD";
  text: string;
  untagged: RawResponse[];
}

export class ImapError extends Error {
  constructor(
    message: string,
    readonly code: "connection" | "timeout" | "auth" | "command" | "protocol",
  ) {
    super(message);
  }
}

const CRLF = "\r\n";
const FORBIDDEN = /^(STORE|COPY|MOVE|EXPUNGE|APPEND|DELETE|RENAME|CREATE|SUBSCRIBE|UNSUBSCRIBE|SELECT)\b/i;

export class ImapConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);
  private tagCounter = 0;
  private closed = false;

  private constructor(
    private transport: Transport,
    private deadline: number,
  ) {
    this.reader = transport.readable.getReader();
    this.writer = transport.writable.getWriter();
  }

  /** Open a connection and read the server greeting. */
  static async open(transport: Transport, timeoutMs: number): Promise<ImapConnection> {
    const conn = new ImapConnection(transport, Date.now() + timeoutMs);
    const greeting = await conn.readResponse();
    const first = greeting.text[0] ?? "";
    if (/^\* BYE/i.test(first)) throw new ImapError("server refused the connection", "connection");
    if (!/^\* (OK|PREAUTH)/i.test(first)) throw new ImapError("unexpected greeting", "protocol");
    return conn;
  }

  async login(username: string, password: string): Promise<void> {
    const result = await this.command(["LOGIN ", ...astring(username), " ", ...astring(password)], {
      allowNo: true,
    });
    if (result.status !== "OK") throw new ImapError("sign-in to the mail server was refused", "auth");
  }

  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await this.command(["LOGOUT"], { allowNo: true });
    } catch {
      // The server may close the socket right after BYE.
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();
    } catch {
      // ignore
    }
    try {
      await this.transport.close();
    } catch {
      // ignore
    }
  }

  /** Send one tagged command and collect its untagged responses. */
  async command(parts: CommandPart[], options: { allowNo?: boolean } = {}): Promise<TaggedResult> {
    const first = parts[0];
    if (typeof first === "string" && FORBIDDEN.test(first.trimStart().replace(/^UID /i, ""))) {
      throw new ImapError("refusing a command that could change the mailbox", "protocol");
    }
    const tag = `A${(++this.tagCounter).toString().padStart(4, "0")}`;
    const untagged: RawResponse[] = [];

    // Split the command at each literal: send text with {n}, wait for "+", send the bytes.
    let chunk = tag + " ";
    for (const part of parts) {
      if (typeof part === "string") {
        if (/[\r\n]/.test(part)) throw new ImapError("line breaks are not allowed in a command", "protocol");
        chunk += part;
      } else {
        chunk += `{${part.literal.length}}` + CRLF;
        await this.write(latin1Bytes(chunk));
        chunk = "";
        await this.waitForContinuation(tag, untagged);
        await this.write(part.literal);
      }
    }
    await this.write(latin1Bytes(chunk + CRLF));

    for (;;) {
      const res = await this.readResponse();
      const head = res.text[0] ?? "";
      if (head.startsWith(tag + " ")) {
        const m = /^\S+ (OK|NO|BAD)\b ?(.*)$/i.exec(head);
        if (!m) throw new ImapError("malformed tagged response", "protocol");
        const status = m[1]!.toUpperCase() as TaggedResult["status"];
        const result = { status, text: m[2] ?? "", untagged };
        if (status === "BAD" || (status === "NO" && !options.allowNo)) {
          throw new ImapError(`mail server rejected the request (${status})`, "command");
        }
        return result;
      }
      if (head.startsWith("+")) continue;
      if (/^\* BYE/i.test(head) && !/^LOGOUT/i.test(String(first))) {
        throw new ImapError("mail server closed the connection", "connection");
      }
      untagged.push(res);
    }
  }

  private async waitForContinuation(tag: string, untagged: RawResponse[]): Promise<void> {
    for (;;) {
      const res = await this.readResponse();
      const head = res.text[0] ?? "";
      if (head.startsWith("+")) return;
      if (head.startsWith(tag + " ")) throw new ImapError("mail server rejected the request", "command");
      untagged.push(res);
    }
  }

  private async write(bytes: Uint8Array): Promise<void> {
    await this.withDeadline(this.writer.write(bytes));
  }

  private async withDeadline<T>(promise: Promise<T>): Promise<T> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new ImapError("mail server did not answer in time", "timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ImapError("mail server did not answer in time", "timeout")), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fill(): Promise<void> {
    const { value, done } = await this.withDeadline(this.reader.read());
    if (done || !value) throw new ImapError("mail server closed the connection", "connection");
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer);
    merged.set(value, this.buffer.length);
    this.buffer = merged;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = indexOfCrlf(this.buffer);
      if (idx >= 0) {
        const line = latin1(this.buffer.subarray(0, idx));
        this.buffer = this.buffer.subarray(idx + 2);
        return line;
      }
      await this.fill();
    }
  }

  private async readBytes(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) await this.fill();
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** Read one complete response: a line, plus any literals and the lines that follow them. */
  async readResponse(): Promise<RawResponse> {
    const text: string[] = [];
    const literals: Uint8Array[] = [];
    for (;;) {
      const line = await this.readLine();
      text.push(line);
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (!m) return { text, literals };
      literals.push(await this.readBytes(Number(m[1])));
    }
  }
}

function indexOfCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

/** Encode a string argument: quoted when it is plain ASCII, otherwise a UTF-8 literal. */
export function astring(value: string): CommandPart[] {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return ['"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'];
  }
  return [{ literal: new TextEncoder().encode(value) }];
}
