-- Mail server accounts. Passwords are stored encrypted (AES-GCM) with a key
-- that lives only in the Worker's ENCRYPTION_KEY secret.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  sent_folder TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
