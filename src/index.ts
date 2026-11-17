import { AccessError, verifyAccessJwt } from "./access";
import { importKey } from "./crypto";
import type { Env } from "./env";
import type { MailDeps } from "./mail";
import { handleMcp } from "./mcp";
import { openTls } from "./socket";
import { AccountStore } from "./store";
import { handleWeb } from "./web";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Every request must carry a valid Cloudflare Access JWT, whether it came from a
    // browser login or from an MCP client signed in through Access Managed OAuth.
    let email: string | null;
    try {
      const identity = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_AUD,
        allowedEmails: env.ALLOWED_EMAILS,
      });
      email = identity.email;
    } catch (e) {
      const reason = e instanceof AccessError ? e.message : "access check failed";
      console.warn(JSON.stringify({ event: "access_denied", reason, path: url.pathname }));
      return new Response("Forbidden", { status: 403 });
    }

    let store: AccountStore;
    try {
      store = new AccountStore(env.DB, await importKey(env.ENCRYPTION_KEY));
    } catch (e) {
      console.error(JSON.stringify({ event: "config_error", reason: e instanceof Error ? e.message : "unknown" }));
      return new Response("Server is not configured", { status: 500 });
    }
    const deps: MailDeps = {
      open: openTls,
      password: (account) => store.password(account.id),
    };

    if (url.pathname === "/mcp") return handleMcp(request, store, deps);
    return handleWeb(request, store, deps, email);
  },
} satisfies ExportedHandler<Env>;
