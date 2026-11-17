import { connect } from "cloudflare:sockets";
import type { Transport } from "./imap/connection";

/** Open a TLS connection to an IMAP server. */
export function openTls(host: string, port: number): Transport {
  const socket = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
  return {
    readable: socket.readable,
    writable: socket.writable,
    close: () => socket.close(),
  };
}
