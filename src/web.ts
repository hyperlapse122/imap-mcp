// A small account settings page. Cloudflare Access sits in front of it, and every
// request is checked again in index.ts. Passwords are write-only: the page never shows them.

import { describeError, type MailDeps, testAccount } from "./mail";
import { type Account, type AccountStore, validateAccountInput } from "./store";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--accent:#0a66c2;--bad:#b3261e;--good:#1e7a34;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161617;--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--accent:#4da3ff;--bad:#ff6b5e;--good:#5ccf73;--card:#1f1f21}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
p.muted{color:var(--muted);margin:0 0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--muted);font-size:13px}
label{display:block;font-weight:600;margin:12px 0 4px}input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:12px}.row>div{flex:1}.hint{color:var(--muted);font-size:13px;margin-top:4px}
button,.button{display:inline-block;margin-top:16px;padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;cursor:pointer;text-decoration:none}
button.secondary,.button.secondary{background:transparent;color:var(--accent)}button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
.notice{padding:10px 12px;border-radius:8px;border:1px solid var(--line);margin:12px 0}.notice.bad{border-color:var(--bad);color:var(--bad)}.notice.good{border-color:var(--good);color:var(--good)}
.actions{display:flex;gap:8px;flex-wrap:wrap}.actions form{margin:0}a{color:var(--accent)}
@media (max-width:560px){.row{flex-direction:column;gap:0}}
`;

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      // "no-referrer" would make browsers send `Origin: null` on our own form posts.
      "Referrer-Policy": "same-origin",
    },
  });
}

function notice(kind: "good" | "bad", text: string): string {
  return `<div class="notice ${kind}">${escapeHtml(text)}</div>`;
}

function accountForm(action: string, a: Partial<Account> | null, isNew: boolean, values?: Record<string, string>): string {
  const v = (key: string, fallback: string | number | null | undefined) => escapeHtml(values?.[key] ?? String(fallback ?? ""));
  return `<form method="post" action="${escapeHtml(action)}" autocomplete="off">
<label for="label">Name</label><input id="label" name="label" required maxlength="40" value="${v("label", a?.label)}" placeholder="iCloud">
<div class="row"><div><label for="host">IMAP server</label><input id="host" name="host" required value="${v("host", a?.host)}" placeholder="imap.mail.me.com"></div>
<div style="max-width:140px"><label for="port">Port</label><input id="port" name="port" inputmode="numeric" value="${v("port", a?.port ?? 993)}"></div></div>
<p class="hint">The connection always uses TLS.</p>
<label for="username">User name</label><input id="username" name="username" required value="${v("username", a?.username)}" autocapitalize="off" spellcheck="false">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" ${isNew ? "required" : ""}>
<p class="hint">${isNew ? "For iCloud, use an app-specific password." : "Leave empty to keep the saved password."} It is stored encrypted and never shown again.</p>
<label for="sent_folder">Sent folder (optional)</label><input id="sent_folder" name="sent_folder" value="${v("sent_folder", a?.sentFolder)}" placeholder="Found automatically">
<button type="submit">${isNew ? "Add account" : "Save changes"}</button></form>`;
}

async function home(store: AccountStore, email: string | null, message = ""): Promise<Response> {
  const accounts = await store.list();
  const rows = accounts
    .map(
      (a) => `<tr><td><a href="/accounts/${encodeURIComponent(a.id)}">${escapeHtml(a.label)}</a></td><td>${escapeHtml(a.host)}:${a.port}</td><td>${escapeHtml(a.username)}</td></tr>`,
    )
    .join("");
  const list = accounts.length
    ? `<table><thead><tr><th>Name</th><th>Server</th><th>User</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted">No accounts yet.</p>`;
  return page(
    "IMAP accounts",
    `<h1>IMAP accounts</h1><p class="muted">Read-only mail access for your MCP client.${email ? ` Signed in as ${escapeHtml(email)}.` : ""}</p>
${message}<div class="card">${list}</div><h2>Add an account</h2><div class="card">${accountForm("/accounts", null, true)}</div>`,
  );
}

async function detail(store: AccountStore, id: string, message = "", values?: Record<string, string>): Promise<Response> {
  const a = await store.get(id);
  if (!a) return page("Not found", `<h1>Account not found</h1><p><a href="/">Back to accounts</a></p>`, 404);
  const base = `/accounts/${encodeURIComponent(a.id)}`;
  return page(
    a.label,
    `<p><a href="/">&larr; Accounts</a></p><h1>${escapeHtml(a.label)}</h1>${message}
<div class="card">${accountForm(base, a, false, values)}</div>
<div class="actions"><form method="post" action="${base}/test"><button class="secondary" type="submit">Test connection</button></form>
<form method="post" action="${base}/delete"><button class="danger" type="submit">Remove account</button></form></div>
<p class="hint">Removing an account only deletes it from this server. Nothing changes in the mailbox.</p>`,
  );
}

async function formFields(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form) if (typeof v === "string") out[k] = v;
  return out;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

/** Reject cross-site form posts. Access cookies would otherwise ride along. */
export function sameOrigin(request: Request): boolean {
  // Sec-Fetch-Site is set by the browser and cannot be forged by a page, so trust it first.
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("Origin");
  if (!origin || origin === "null") return true;
  return origin === new URL(request.url).origin;
}

export async function handleWeb(request: Request, store: AccountStore, deps: MailDeps, email: string | null): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET") {
    if (path === "/") {
      const done = url.searchParams.get("done");
      const msg = done === "added" ? notice("good", "Account added.") : done === "removed" ? notice("good", "Account removed.") : "";
      return home(store, email, msg);
    }
    const m = /^\/accounts\/([0-9a-f-]{36})$/.exec(path);
    if (m) return detail(store, m[1]!, url.searchParams.get("done") === "saved" ? notice("good", "Saved.") : "");
    return page("Not found", `<h1>Not found</h1><p><a href="/">Back to accounts</a></p>`, 404);
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!sameOrigin(request)) return new Response("Cross-site request refused", { status: 403 });

  if (path === "/accounts") {
    const fields = await formFields(request);
    try {
      const input = validateAccountInput(fields);
      const password = fields.password ?? "";
      if (!password) throw new Error("Password is required.");
      if ((await store.list()).some((a) => a.label.toLowerCase() === input.label.toLowerCase())) {
        throw new Error("An account with that name already exists.");
      }
      const created = await store.create(input, password);
      return redirect(`/accounts/${created.id}?done=saved`);
    } catch (e) {
      delete fields.password;
      return page(
        "IMAP accounts",
        `<p><a href="/">&larr; Accounts</a></p><h1>Add an account</h1>${notice("bad", describeError(e))}<div class="card">${accountForm("/accounts", null, true, fields)}</div>`,
        400,
      );
    }
  }

  const m = /^\/accounts\/([0-9a-f-]{36})(\/test|\/delete)?$/.exec(path);
  if (!m) return page("Not found", `<h1>Not found</h1>`, 404);
  const id = m[1]!;
  const account = await store.get(id);
  if (!account) return page("Not found", `<h1>Account not found</h1><p><a href="/">Back to accounts</a></p>`, 404);

  if (m[2] === "/delete") {
    await store.remove(id);
    return redirect("/?done=removed");
  }
  if (m[2] === "/test") {
    const result = await testAccount(deps, account);
    const msg = result.ok
      ? notice("good", `Signed in. ${result.folders} folders found${result.sentFolder ? `, sent mail in "${result.sentFolder}"` : ", no sent folder found"}.`)
      : notice("bad", `Could not read this account: ${result.error}.`);
    return detail(store, id, msg);
  }

  const fields = await formFields(request);
  try {
    const input = validateAccountInput(fields);
    const others = (await store.list()).filter((a) => a.id !== id);
    if (others.some((a) => a.label.toLowerCase() === input.label.toLowerCase())) throw new Error("An account with that name already exists.");
    await store.update(id, input, fields.password ? fields.password : null);
    return redirect(`/accounts/${id}?done=saved`);
  } catch (e) {
    delete fields.password;
    return detail(store, id, notice("bad", describeError(e)), fields);
  }
}
