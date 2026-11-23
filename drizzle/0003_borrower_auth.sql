CREATE TABLE borrower_accounts (
  owner TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
  phone_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_version INTEGER NOT NULL DEFAULT 1 CHECK (pin_version > 0),
  created_at INTEGER NOT NULL,
  UNIQUE (environment, phone_hash)
);
--> statement-breakpoint
CREATE TABLE borrower_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  flow_owner TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL REFERENCES borrower_accounts(owner),
  pin_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX borrower_session_expiry ON borrower_sessions (expires_at);
--> statement-breakpoint
CREATE TABLE borrower_auth_limits (
  scope TEXT PRIMARY KEY NOT NULL,
  window_started INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);
