// A scripted IMAP server for tests. It speaks just enough IMAP4rev1 for the client.

import type { Transport } from "../src/imap/connection";

export interface FakeMessage {
  uid: number;
  flags: string[];
  source: string;
}

export interface FakeMailbox {
  user: string;
  pass: string;
  folders: { name: string; flags: string[]; messages: FakeMessage[] }[];
}

const enc = new TextEncoder();
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

export class FakeImapServer {
  /** Every complete command the client sent, without its tag. Literals are inlined as UTF-8 text. */
  readonly commands: string[] = [];
  private selected: FakeMailbox["folders"][number] | null = null;

  constructor(private box: FakeMailbox) {}

  transport(): Transport {
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const toServer = new TransformStream<Uint8Array, Uint8Array>();
    const writer = toClient.writable.getWriter();
    void this.run(toServer.readable.getReader(), writer);
    return {
      readable: toClient.readable,
      writable: toServer.writable,
      close: async () => {
        try {
          await writer.close();
        } catch {
          // already closed
        }
      },
    };
  }

  private async run(reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>) {
    const send = (s: string | Uint8Array) => writer.write(typeof s === "string" ? enc.encode(s) : s);
    let buf = new Uint8Array(0);
    const fill = async () => {
      const { value, done } = await reader.read();
      if (done || !value) throw new Error("closed");
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;
    };
    const line = async () => {
      for (;;) {
        for (let i = 0; i + 1 < buf.length; i++) {
          if (buf[i] === 13 && buf[i + 1] === 10) {
            const out = latin1(buf.subarray(0, i));
            buf = buf.subarray(i + 2);
            return out;
          }
        }
        await fill();
      }
    };
    const bytes = async (n: number) => {
      while (buf.length < n) await fill();
      const out = buf.slice(0, n);
      buf = buf.subarray(n);
      return out;
    };

    try {
      await send("* OK [CAPABILITY IMAP4rev1] fake ready\r\n");
      for (;;) {
        let text = await line();
        let m: RegExpExecArray | null;
        while ((m = /\{(\d+)\}$/.exec(text))) {
          await send("+ go ahead\r\n");
          const lit = await bytes(Number(m[1]));
          text = text.slice(0, m.index) + `"${new TextDecoder().decode(lit)}"` + (await line());
        }
        const sp = text.indexOf(" ");
        const tag = text.slice(0, sp);
        const cmd = text.slice(sp + 1);
        this.commands.push(cmd);
        const done = await this.handle(tag, cmd, send);
        if (done) break;
      }
    } catch {
      // client went away
    } finally {
      try {
        await writer.close();
      } catch {
        // ignore
      }
    }
  }

  private async handle(tag: string, cmd: string, send: (s: string | Uint8Array) => Promise<void>): Promise<boolean> {
    const upper = cmd.toUpperCase();
    if (upper.startsWith("LOGIN ")) {
      const args = [...cmd.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\(.)/g, "$1"));
      if (args[0] === this.box.user && args[1] === this.box.pass) await send(`${tag} OK logged in\r\n`);
      else await send(`${tag} NO [AUTHENTICATIONFAILED] bad\r\n`);
      return false;
    }
    if (upper === "LOGOUT") {
      await send("* BYE bye\r\n");
      await send(`${tag} OK done\r\n`);
      return true;
    }
    if (upper.startsWith("LIST ")) {
      for (const f of this.box.folders) await send(`* LIST (${f.flags.join(" ")}) "/" "${f.name}"\r\n`);
      await send(`${tag} OK listed\r\n`);
      return false;
    }
    if (upper.startsWith("EXAMINE ")) {
      const name = /^EXAMINE "(.*)"$/i.exec(cmd)?.[1];
      const f = this.box.folders.find((x) => x.name === name);
      if (!f) {
        await send(`${tag} NO no such folder\r\n`);
        return false;
      }
      this.selected = f;
      await send(`* ${f.messages.length} EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n${tag} OK [READ-ONLY] examined\r\n`);
      return false;
    }
    if (upper.startsWith("UID SEARCH")) {
      const msgs = this.selected?.messages ?? [];
      let hits = msgs;
      const quoted = [...cmd.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!);
      if (/HEADER Message-ID/i.test(cmd)) hits = msgs.filter((x) => x.source.includes(`Message-ID: ${quoted[0]}`));
      else if (/HEADER In-Reply-To/i.test(cmd)) hits = msgs.filter((x) => x.source.includes(quoted[0]!));
      else if (/ FROM /i.test(cmd)) hits = msgs.filter((x) => new RegExp(`^From:.*${quoted[0]}`, "im").test(x.source));
      else if (/ SUBJECT /i.test(cmd)) hits = msgs.filter((x) => new RegExp(`^Subject:.*${quoted[0]}`, "im").test(x.source));
      else if (/UNANSWERED/i.test(cmd)) hits = msgs.filter((x) => !x.flags.includes("\\Answered"));
      await send(`* SEARCH ${hits.map((x) => x.uid).join(" ")}\r\n${tag} OK searched\r\n`);
      return false;
    }
    if (upper.startsWith("UID FETCH ")) {
      const set = cmd.split(" ")[2]!.split(",").map(Number);
      let seq = 0;
      for (const msg of this.selected?.messages ?? []) {
        seq++;
        if (!set.includes(msg.uid)) continue;
        const raw = enc.encode(msg.source.replace(/\r?\n/g, "\r\n"));
        let section: string;
        let body: Uint8Array;
        if (/HEADER\.FIELDS/i.test(cmd)) {
          const text = latin1(raw);
          const end = text.indexOf("\r\n\r\n");
          body = raw.subarray(0, end + 2);
          section = /BODY\.PEEK(\[HEADER\.FIELDS \([^)]*\)\])/i.exec(cmd)![1]!;
          section = "BODY" + section;
        } else {
          const max = Number(/<0\.(\d+)>/.exec(cmd)?.[1] ?? raw.length);
          body = raw.subarray(0, max);
          section = "BODY[]<0>";
        }
        await send(
          `* ${seq} FETCH (UID ${msg.uid} FLAGS (${msg.flags.join(" ")}) INTERNALDATE "17-Nov-2026 10:00:00 +0900" RFC822.SIZE ${raw.length} ${section} {${body.length}}\r\n`,
        );
        await send(body);
        await send(")\r\n");
      }
      await send(`${tag} OK fetched\r\n`);
      return false;
    }
    await send(`${tag} BAD unknown command\r\n`);
    return false;
  }
}

export function sampleMailbox(): FakeMailbox {
  return {
    user: "me@example.com",
    pass: "app-pass-1234",
    folders: [
      {
        name: "INBOX",
        flags: ["\\HasNoChildren"],
        messages: [
          {
            uid: 11,
            flags: ["\\Seen"],
            source: [
              "From: Alice Kim <alice@example.org>",
              "To: me@example.com",
              "Subject: Lunch on Friday?",
              "Date: Mon, 16 Nov 2026 09:00:00 +0900",
              "Message-ID: <lunch-1@example.org>",
              "Content-Type: text/plain; charset=utf-8",
              "",
              "Are you free for lunch on Friday?",
              "",
            ].join("\n"),
          },
          {
            uid: 12,
            flags: [],
            source: [
              "From: =?UTF-8?B?7ZmN6ri464+Z?= <hong@example.kr>",
              "To: me@example.com",
              "Subject: =?UTF-8?B?7ZqM7J2YIOyekOujjA==?=",
              "Date: Tue, 17 Nov 2026 08:30:00 +0900",
              "Message-ID: <report-2@example.kr>",
              "Content-Type: text/html; charset=utf-8",
              "",
              "<html><body><p>Hello,</p><p>Please review the <b>report</b>.</p><script>x()</script></body></html>",
              "",
            ].join("\n"),
          },
        ],
      },
      {
        name: "Sent Messages",
        flags: ["\\HasNoChildren", "\\Sent"],
        messages: [
          {
            uid: 3,
            flags: ["\\Seen"],
            source: [
              "From: me@example.com",
              "To: Alice Kim <alice@example.org>",
              "Subject: Re: Lunch on Friday?",
              "Date: Mon, 16 Nov 2026 10:00:00 +0900",
              "Message-ID: <reply-3@example.com>",
              "In-Reply-To: <lunch-1@example.org>",
              "References: <lunch-1@example.org>",
              "",
              "Yes, see you then.",
              "",
            ].join("\n"),
          },
        ],
      },
      { name: "&ycDGtA- &wtTQ3A-", flags: ["\\HasNoChildren"], messages: [] },
    ],
  };
}
