// Modified UTF-7 for IMAP mailbox names (RFC 3501 section 5.1.3).

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_match, chunk: string) => {
    if (chunk === "") return "&";
    const b64 = chunk.replace(/,/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = fromBase64(padded);
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    }
    return out;
  });
}

export function encodeMailboxName(name: string): string {
  let out = "";
  let pending: number[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const bytes = new Uint8Array(pending.length * 2);
    pending.forEach((code, i) => {
      bytes[i * 2] = code >> 8;
      bytes[i * 2 + 1] = code & 0xff;
    });
    out += "&" + toBase64(bytes).replace(/=+$/, "").replace(/\//g, ",") + "-";
    pending = [];
  };
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += code === 0x26 ? "&-" : name[i];
    } else {
      pending.push(code);
    }
  }
  flush();
  return out;
}
