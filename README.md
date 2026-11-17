# imap-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for IMAP mailboxes, running on Cloudflare Workers.

Work in progress. The goal is a small server that lets an MCP client list folders, search and read messages, and check whether a message has been answered, without ever changing the mailbox: no sending, deleting, moving, flagging or marking as read.

It works with any IMAP server that accepts password sign-in over TLS. iCloud Mail (with an app-specific password) is the first target.
