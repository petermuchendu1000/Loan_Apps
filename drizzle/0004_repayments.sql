CREATE TABLE repayment_accounts (
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
  owner TEXT NOT NULL,
  customer_ref TEXT NOT NULL,
  phone_hash TEXT NOT NULL,
  PRIMARY KEY (environment, owner),
  UNIQUE (environment, customer_ref)
);
--> statement-breakpoint
CREATE TABLE repayment_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL,
  owner TEXT NOT NULL,
  customer_ref TEXT NOT NULL,
  loan_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  phone_sealed TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'pending', 'awaiting-receipt', 'posting', 'credited', 'failed', 'review')),
  checkout_id TEXT,
  merchant_id TEXT,
  receipt TEXT,
  paid_at TEXT,
  result_code TEXT,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment, owner) REFERENCES repayment_accounts (environment, owner),
  UNIQUE (environment, checkout_id),
  UNIQUE (environment, receipt)
);
--> statement-breakpoint
CREATE UNIQUE INDEX repayment_single_open ON repayment_attempts (environment, owner)
  WHERE state NOT IN ('credited', 'failed');
--> statement-breakpoint
CREATE INDEX repayment_by_owner ON repayment_attempts (environment, owner, created_at DESC, id DESC);
