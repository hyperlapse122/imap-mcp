// Parser for IMAP server responses.
//
// The connection hands over each response as a list of "parts": text runs and
// literals, in the order they arrived. Text is decoded as latin1 so that one
// char equals one byte; literals stay as bytes.

export type ImapValue = string | Uint8Array | null | ImapValue[];

export interface RawResponse {
  /** Text runs, with literals between them: text[0] lit[0] text[1] lit[1] ... */
  text: string[];
  literals: Uint8Array[];
}

export class ParseError extends Error {}

/**
 * Tokenize a whole response into a flat list of values, where parenthesized
 * groups become nested arrays and bracketed sections such as BODY[HEADER] stay
 * part of the atom.
 */
export function parseValues(raw: RawResponse): ImapValue[] {
  const root: ImapValue[] = [];
  const stack: ImapValue[][] = [root];
  const push = (v: ImapValue) => stack[stack.length - 1]!.push(v);

  for (let part = 0; part < raw.text.length; part++) {
    let s = raw.text[part]!;
    // A literal announcement {n} at the end of a text run is replaced by the literal.
    let literalFollows = false;
    if (part < raw.literals.length) {
      const m = /\{(\d+)\+?\}$/.exec(s);
      if (!m) throw new ParseError("literal without announcement");
      s = s.slice(0, m.index);
      literalFollows = true;
    }
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === " " || c === "\r" || c === "\n") {
        i++;
      } else if (c === "(") {
        const list: ImapValue[] = [];
        push(list);
        stack.push(list);
        i++;
      } else if (c === ")") {
        if (stack.length === 1) throw new ParseError("unbalanced )");
        stack.pop();
        i++;
      } else if (c === '"') {
        let j = i + 1;
        let out = "";
        while (j < s.length && s[j] !== '"') {
          if (s[j] === "\\" && j + 1 < s.length) j++;
          out += s[j];
          j++;
        }
        if (j >= s.length) throw new ParseError("unterminated quoted string");
        push(out);
        i = j + 1;
      } else {
        let j = i;
        let depth = 0;
        while (j < s.length) {
          const ch = s[j]!;
          if (ch === "[") depth++;
          else if (ch === "]") depth--;
          else if (depth === 0 && (ch === " " || ch === "(" || ch === ")" || ch === "\r" || ch === "\n")) break;
          j++;
        }
        const atom = s.slice(i, j);
        push(atom.toUpperCase() === "NIL" ? null : atom);
        i = j;
      }
    }
    if (literalFollows) push(raw.literals[part]!);
  }
  if (stack.length !== 1) throw new ParseError("unbalanced (");
  return root;
}

export function asText(v: ImapValue | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return latin1(v);
  return null;
}

export function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

export function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Turn a FETCH attribute list (KEY value KEY value ...) into a map with upper-cased keys. */
export function fetchAttributes(list: ImapValue[]): Map<string, ImapValue> {
  const out = new Map<string, ImapValue>();
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = list[i];
    if (typeof key === "string") out.set(key.toUpperCase(), list[i + 1]!);
  }
  return out;
}
