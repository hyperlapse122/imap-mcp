export default {
  async fetch(): Promise<Response> {
    return new Response("imap-mcp: not configured yet\n", { status: 503 });
  },
} satisfies ExportedHandler;
