export interface Env {
  /** D1 database that holds the mail server accounts. */
  DB: D1Database;
  /** 32 random bytes, base64. Encrypts mail server passwords at rest. Set with `wrangler secret put`. */
  ENCRYPTION_KEY: string;
  /** Your Zero Trust team domain, such as "example.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string;
  /** The Application Audience (AUD) tag of the Access application in front of this Worker. */
  ACCESS_AUD: string;
  /** Optional comma-separated list of emails allowed in, on top of the Access policy. */
  ALLOWED_EMAILS?: string;
}
