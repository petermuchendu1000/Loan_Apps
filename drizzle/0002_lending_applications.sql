CREATE TABLE lending_applications (
  owner TEXT PRIMARY KEY NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL,
  phone_hash TEXT NOT NULL UNIQUE,
  phone_hint TEXT NOT NULL,
  phone_sealed TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  review_started_at INTEGER,
  review_started_by TEXT
);
--> statement-breakpoint
CREATE INDEX lending_review_queue ON lending_applications (environment, received_at DESC, reference DESC);
--> statement-breakpoint
CREATE TABLE lending_contact_access (
  id TEXT PRIMARY KEY NOT NULL,
  application_reference TEXT NOT NULL REFERENCES lending_applications(reference),
  reviewer TEXT NOT NULL,
  accessed_at INTEGER NOT NULL
);
