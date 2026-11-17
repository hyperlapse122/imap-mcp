# imap-mcp

A read-only IMAP server for MCP clients, running on Cloudflare Workers. It lets an assistant such as Claude list folders, search, and read mail in any IMAP account that accepts a password over TLS. iCloud Mail with an app-specific password was the first target.

The server cannot change a mailbox. It opens folders with `EXAMINE`, fetches with `BODY.PEEK`, and refuses `STORE`, `COPY`, `MOVE`, `EXPUNGE`, `APPEND`, `DELETE` and similar commands before they reach the server. Reading a message does not mark it as read.

## Tools

| Tool | What it returns |
| --- | --- |
| `list_accounts` | The configured accounts: name, server, user name. Never the password. |
| `list_folders` | Folders with their special-use role (inbox, sent, trash and so on). |
| `search_messages` | Newest matching messages first, headers and flags only. Filters: date range, from, to, subject, text, unseen, unanswered. |
| `read_message` | One message by UID: headers, plain-text body (HTML converted to text), attachment names and sizes. |
| `check_replied` | Whether a message has a reply in the Sent folder, matched on `In-Reply-To` and `References`, plus the original's `\Answered` flag. |

Every tool marks mail content as untrusted: whoever sent a message wrote its headers and body.

## How access works

Cloudflare Access sits in front of the whole Worker, and the Worker checks the Access JWT (`Cf-Access-Jwt-Assertion`) on every request: signature, issuer, audience and expiry.

- **The account page** (`/`) uses the normal Access browser login.
- **The MCP endpoint** (`/mcp`) uses Access [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/). The MCP client gets a 401 from Access, registers itself, and sends you through the same Access login. Access then forwards the request to the Worker with the same JWT a browser session gets.

The `workers.dev` and preview URLs are turned off in `wrangler.jsonc`, so the custom domain behind Access is the only way in.

## Where passwords live

Accounts are rows in a D1 database. Each password is encrypted with AES-GCM before it is written, using a 32-byte key held only in the `ENCRYPTION_KEY` Worker secret, and the row id is bound into the ciphertext. You type passwords into the account page; the page never shows them again, and the server never logs them or any mail content.

## Setup

You need a Cloudflare account with Zero Trust, and a domain on that account for the Worker.

1. Install dependencies and run the checks.

   ```sh
   npm install
   npm run check
   ```

2. Create a self-hosted Access application for the Worker's hostname, with a policy that allows only you. Under **Advanced settings**, turn on **Managed OAuth** and dynamic client registration. Add your MCP client's callback URL to the allowed redirect URIs. For Claude that is `https://claude.ai/api/mcp/auth_callback`. Copy the application's **Application Audience (AUD) tag**.

3. Deploy to your hostname. Wrangler creates the `imap-mcp` D1 database on the first deploy. Then apply the schema.

   ```sh
   npx wrangler deploy --domain mail-mcp.example.com
   npx wrangler d1 migrations apply imap-mcp --remote
   ```

4. Set the secrets. Each command prompts for its value, except the first, which generates the key.

   ```sh
   openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # your-team.cloudflareaccess.com
   npx wrangler secret put ACCESS_AUD           # the AUD tag from step 2
   npx wrangler secret put ALLOWED_EMAILS       # optional: comma-separated emails
   ```

   Keep `ENCRYPTION_KEY` the same across deploys. If it changes, saved passwords can no longer be decrypted and you have to enter them again. Until all three required secrets are set, the Worker answers every request with 403 or 500.

5. Open `https://mail-mcp.example.com/`, sign in through Access, and add an account. For iCloud, create an app-specific password at account.apple.com and use:

   | Field | Value |
   | --- | --- |
   | IMAP server | `imap.mail.me.com` |
   | Port | `993` |
   | User name | your iCloud Mail address |

   Use **Test connection** to confirm the sign-in and see which folder holds sent mail.

6. Add `https://mail-mcp.example.com/mcp` to your MCP client as a remote server. The client opens the Access login the first time it connects.

## Development

```sh
cp .dev.vars.example .dev.vars
npm run dev
npm run check
```

The tests run the IMAP client against a scripted fake server, check the Access JWT verification with generated keys, and exercise the MCP tools and the account page against an in-memory database.
