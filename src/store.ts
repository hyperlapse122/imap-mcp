// Account list in D1. Passwords are encrypted before they reach the database.

import { decryptSecret, encryptSecret } from "./crypto";

export interface Account {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  sentFolder: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInput {
  label: string;
  host: string;
  port: number;
  username: string;
  sentFolder: string | null;
}

interface Row {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  sent_folder: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id, label, host, port, username, sent_folder, created_at, updated_at";

function toAccount(row: Omit<Row, "password_enc">): Account {
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    sentFolder: row.sent_folder,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AccountStore {
  constructor(
    private db: D1Database,
    private key: CryptoKey,
  ) {}

  async list(): Promise<Account[]> {
    const { results } = await this.db.prepare(`SELECT ${COLUMNS} FROM accounts ORDER BY label`).all<Row>();
    return results.map(toAccount);
  }

  async get(id: string): Promise<Account | null> {
    const row = await this.db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).bind(id).first<Row>();
    return row ? toAccount(row) : null;
  }

  /** Find an account by id or label (case-insensitive). With no reference, the only account if there is just one. */
  async resolve(ref: string | undefined): Promise<Account> {
    const all = await this.list();
    if (!ref) {
      if (all.length === 1) return all[0]!;
      if (all.length === 0) throw new Error("no mail accounts are set up yet");
      throw new Error(`several accounts exist; pass one of: ${all.map((a) => a.label).join(", ")}`);
    }
    const lower = ref.toLowerCase();
    const found = all.find((a) => a.id === ref) ?? all.find((a) => a.label.toLowerCase() === lower);
    if (!found) throw new Error(`no account named ${ref}`);
    return found;
  }

  async password(id: string): Promise<string> {
    const row = await this.db.prepare("SELECT password_enc FROM accounts WHERE id = ?").bind(id).first<Pick<Row, "password_enc">>();
    if (!row) throw new Error("account not found");
    return decryptSecret(this.key, row.password_enc, id);
  }

  async create(input: AccountInput, password: string): Promise<Account> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordEnc = await encryptSecret(this.key, password, id);
    await this.db
      .prepare(
        "INSERT INTO accounts (id, label, host, port, username, password_enc, sent_folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, input.label, input.host, input.port, input.username, passwordEnc, input.sentFolder, now, now)
      .run();
    return { id, ...input, createdAt: now, updatedAt: now };
  }

  /** Update an account. A null password keeps the stored one. */
  async update(id: string, input: AccountInput, password: string | null): Promise<void> {
    const now = new Date().toISOString();
    if (password) {
      const passwordEnc = await encryptSecret(this.key, password, id);
      await this.db
        .prepare(
          "UPDATE accounts SET label = ?, host = ?, port = ?, username = ?, sent_folder = ?, password_enc = ?, updated_at = ? WHERE id = ?",
        )
        .bind(input.label, input.host, input.port, input.username, input.sentFolder, passwordEnc, now, id)
        .run();
    } else {
      await this.db
        .prepare("UPDATE accounts SET label = ?, host = ?, port = ?, username = ?, sent_folder = ?, updated_at = ? WHERE id = ?")
        .bind(input.label, input.host, input.port, input.username, input.sentFolder, now, id)
        .run();
    }
  }

  async remove(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
  }
}

/** Check and normalize account fields from a form. Throws with a readable message. */
export function validateAccountInput(raw: Record<string, string | undefined>): AccountInput {
  const label = (raw.label ?? "").trim();
  const host = (raw.host ?? "").trim().toLowerCase();
  const username = (raw.username ?? "").trim();
  const portText = (raw.port ?? "993").trim() || "993";
  const sentFolder = (raw.sent_folder ?? "").trim() || null;
  if (!/^[\p{L}\p{N} _.-]{1,40}$/u.test(label)) throw new Error("Name: 1 to 40 letters, numbers, spaces, dots, dashes or underscores.");
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) throw new Error("Server: enter a host name such as imap.example.com.");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port: a number from 1 to 65535.");
  if (username.length < 1 || username.length > 254 || /[\r\n]/.test(username)) throw new Error("User name is required.");
  if (sentFolder && (sentFolder.length > 200 || /[\r\n]/.test(sentFolder))) throw new Error("Sent folder name is too long.");
  return { label, host, port, username, sentFolder };
}
