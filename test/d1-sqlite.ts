/// <reference types="node" />
// A small D1Database stand-in backed by node:sqlite, enough for the account store.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function memoryD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_accounts.sql", import.meta.url), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])), success: true, meta: {} }),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    run: async () => {
      db.prepare(sql).run(...(params as never[]));
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}
