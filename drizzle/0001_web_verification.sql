CREATE TABLE web_verifications (
  owner TEXT PRIMARY KEY NOT NULL,
  phone_hash TEXT,
  phone_hint TEXT,
  otp_id TEXT,
  otp_hash TEXT,
  otp_expires_at INTEGER NOT NULL DEFAULT 0,
  otp_attempts INTEGER NOT NULL DEFAULT 0,
  sms_retry_at INTEGER NOT NULL DEFAULT 0,
  phone_verified_at INTEGER,
  id_reference TEXT,
  id_request TEXT,
  id_consent_at INTEGER,
  id_consent_version TEXT,
  id_retry_at INTEGER NOT NULL DEFAULT 0,
  id_poll_at INTEGER NOT NULL DEFAULT 0,
  didit_id TEXT,
  didit_url TEXT,
  didit_status TEXT
);
--> statement-breakpoint
CREATE TABLE verification_sms_limits (
  phone_hash TEXT PRIMARY KEY NOT NULL,
  window_started INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  retry_at INTEGER NOT NULL
);
