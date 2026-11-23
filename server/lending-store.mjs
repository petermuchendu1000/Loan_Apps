function store(execute) {
  return {
    account(owner) {
      return execute("account", { owner }, "first",
        "SELECT revision, state FROM demo_accounts WHERE owner = ?");
    },

    createAccount(owner, state) {
      return execute("create_account", { owner, state }, "run",
        "INSERT INTO demo_accounts (owner, revision, state) VALUES (?, 1, ?) ON CONFLICT(owner) DO NOTHING");
    },

    updateAccount(owner, state, revision) {
      return execute("update_account", { owner, state, revision }, "run",
        "UPDATE demo_accounts SET state = ?2, revision = revision + 1 WHERE owner = ?1 AND revision = ?3");
    },

    verification(owner) {
      return execute("verification", { owner }, "first", "SELECT * FROM web_verifications WHERE owner = ?");
    },

    reserveSms(phone_hash, now, window, retry_at) {
      return execute("reserve_sms", { phone_hash, now, window, retry_at }, "run", `
        INSERT INTO verification_sms_limits (phone_hash, window_started, request_count, retry_at) VALUES (?1, ?2, 1, ?4)
        ON CONFLICT(phone_hash) DO UPDATE SET
          request_count = CASE WHEN window_started <= ?3 THEN 1 ELSE request_count + 1 END,
          window_started = CASE WHEN window_started <= ?3 THEN ?2 ELSE window_started END,
          retry_at = ?4
        WHERE retry_at <= ?2 AND (window_started <= ?3 OR request_count < 3)
      `);
    },

    reserveCode(owner, phone_hash, phone_hint, challenge, retry_at, now) {
      return execute("reserve_code", { owner, phone_hash, phone_hint, challenge, retry_at, now }, "run", `
        INSERT INTO web_verifications (owner, phone_hash, phone_hint, otp_id, sms_retry_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(owner) DO UPDATE SET phone_hash = excluded.phone_hash, phone_hint = excluded.phone_hint,
          otp_id = excluded.otp_id, sms_retry_at = excluded.sms_retry_at, otp_hash = NULL, otp_attempts = 0, otp_expires_at = 0
        WHERE phone_verified_at IS NULL AND sms_retry_at <= ?
      `);
    },

    saveCode(owner, challenge, hash, expires_at) {
      return execute("save_code", { owner, challenge, hash, expires_at }, "run",
        "UPDATE web_verifications SET otp_hash = ?3, otp_expires_at = ?4 WHERE owner = ?1 AND otp_id = ?2");
    },

    confirmCode(owner, challenge, now, max_attempts, valid) {
      return execute("confirm_code", { owner, challenge, now, max_attempts, valid }, "run", `
        UPDATE web_verifications SET
          phone_verified_at = CASE WHEN ?5 THEN ?3 ELSE phone_verified_at END,
          otp_id = CASE WHEN ?5 THEN NULL ELSE otp_id END,
          otp_hash = CASE WHEN ?5 THEN NULL ELSE otp_hash END,
          otp_expires_at = CASE WHEN ?5 THEN 0 ELSE otp_expires_at END,
          otp_attempts = CASE WHEN ?5 THEN otp_attempts ELSE otp_attempts + 1 END
        WHERE owner = ?1 AND otp_id = ?2 AND phone_verified_at IS NULL AND otp_expires_at > ?3 AND otp_attempts < ?4
      `);
    },

    reserveIdentity(owner, request, reference, now, consent_version, retry_at) {
      return execute("reserve_identity", { owner, request, reference, now, consent_version, retry_at }, "run", `
        UPDATE web_verifications SET id_request = ?2, id_reference = ?3, id_consent_at = ?4, id_consent_version = ?5,
          id_retry_at = ?6, id_poll_at = 0, didit_id = NULL, didit_url = NULL, didit_status = NULL
        WHERE owner = ?1 AND phone_verified_at IS NOT NULL AND id_retry_at <= ?4
          AND (didit_id IS NULL OR didit_status IN ('expired', 'abandoned'))
      `);
    },

    saveIdentity(owner, request, identity_id, url) {
      return execute("save_identity", { owner, request, identity_id, url }, "run", `
        UPDATE web_verifications SET didit_id = ?3, didit_url = ?4, didit_status = 'not-started'
        WHERE owner = ?1 AND id_request = ?2 AND didit_id IS NULL
      `);
    },

    reserveIdentityPoll(owner, identity_id, now, poll_at) {
      return execute("reserve_identity_poll", { owner, identity_id, now, poll_at }, "run", `
        UPDATE web_verifications SET id_poll_at = ?4 WHERE owner = ?1 AND didit_id = ?2 AND id_poll_at <= ?3
      `);
    },

    saveIdentityDecision(owner, identity_id, poll_at, status, url) {
      return execute("save_identity_decision", { owner, identity_id, poll_at, status, url }, "run", `
        UPDATE web_verifications SET didit_status = ?4, didit_url = COALESCE(?5, didit_url)
        WHERE owner = ?1 AND didit_id = ?2 AND id_poll_at = ?3
      `);
    },

    application(owner) {
      return execute("application", { owner }, "first", `
        SELECT reference, amount, purpose, received_at, review_started_at FROM lending_applications WHERE owner = ?
      `);
    },

    createApplication(record) {
      const { owner, reference, environment, phone_hash, phone_hint, phone_sealed, identity_id,
        amount, purpose, consent_version, received_at } = record;
      return execute("create_application", { owner, reference, environment, phone_hash, phone_hint, phone_sealed,
        identity_id, amount, purpose, consent_version, received_at }, "run", `
        INSERT INTO lending_applications (
          owner, reference, environment, phone_hash, phone_hint, phone_sealed, identity_id,
          amount, purpose, consent_version, consent_at, received_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11) ON CONFLICT DO NOTHING
      `);
    },

    reviewApplication(environment, reference) {
      return execute("review_application", { environment, reference }, "first", `
        SELECT reference, environment, amount, purpose, received_at, review_started_at, phone_hint, identity_id
        FROM lending_applications WHERE environment = ? AND reference = ?
      `);
    },

    reviewQueue(environment, before = null) {
      if (!before) {
        return execute("review_queue", { environment }, "all", `
          SELECT reference, environment, amount, purpose, received_at, review_started_at, phone_hint, identity_id
          FROM lending_applications WHERE environment = ? ORDER BY received_at DESC, reference DESC LIMIT 21
        `);
      }
      return execute("review_queue", { environment, received_at: before.received_at, reference: before.reference }, "all", `
        SELECT reference, environment, amount, purpose, received_at, review_started_at, phone_hint, identity_id
        FROM lending_applications WHERE environment = ? AND (received_at, reference) < (?, ?)
        ORDER BY received_at DESC, reference DESC LIMIT 21
      `);
    },

    startReview(environment, reference, reviewer, now) {
      return execute("start_review", { environment, reference, reviewer, now }, "run", `
        UPDATE lending_applications SET review_started_at = ?4, review_started_by = ?3
        WHERE environment = ?1 AND reference = ?2 AND review_started_at IS NULL
      `);
    },

    applicationContact(environment, reference) {
      return execute("application_contact", { environment, reference }, "first", `
        SELECT phone_sealed FROM lending_applications WHERE environment = ? AND reference = ?
      `);
    },

    recordContactAccess(id, reference, reviewer, now) {
      return execute("record_contact_access", { id, reference, reviewer, now }, "run", `
        INSERT INTO lending_contact_access (id, application_reference, reviewer, accessed_at) VALUES (?, ?, ?, ?)
      `);
    },

    borrower(environment, phone_hash) {
      return execute("borrower", { environment, phone_hash }, "first", `
        SELECT owner, pin_salt, pin_hash, pin_version FROM borrower_accounts WHERE environment = ? AND phone_hash = ?
      `);
    },

    createBorrower(owner, environment, verification_owner, pin_salt, pin_hash, now, cutoff) {
      return execute("create_borrower", { owner, environment, verification_owner, pin_salt, pin_hash, now, cutoff }, "run", `
        INSERT INTO borrower_accounts (owner, environment, phone_hash, pin_salt, pin_hash, created_at)
        SELECT ?1, ?2, phone_hash, ?4, ?5, ?6 FROM web_verifications
        WHERE owner = ?3 AND phone_verified_at >= ?7
        ON CONFLICT DO NOTHING
      `);
    },

    resetBorrowerPin(owner, verification_owner, version, pin_salt, pin_hash, cutoff) {
      return execute("reset_borrower_pin", { owner, verification_owner, version, pin_salt, pin_hash, cutoff }, "run", `
        UPDATE borrower_accounts SET pin_salt = ?4, pin_hash = ?5, pin_version = pin_version + 1
        WHERE owner = ?1 AND pin_version = ?3 AND EXISTS (
          SELECT 1 FROM web_verifications WHERE owner = ?2 AND phone_verified_at >= ?6
            AND phone_hash = borrower_accounts.phone_hash
        )
      `);
    },

    consumeAuthLimit(scope, now, cutoff, cap) {
      return execute("consume_auth_limit", { scope, now, cutoff, cap }, "run", `
        INSERT INTO borrower_auth_limits (scope, window_started, attempts) VALUES (?1, ?2, 1)
        ON CONFLICT(scope) DO UPDATE SET
          attempts = CASE WHEN window_started <= ?3 THEN 1 ELSE attempts + 1 END,
          window_started = CASE WHEN window_started <= ?3 THEN ?2 ELSE window_started END
        WHERE window_started <= ?3 OR attempts < ?4
      `);
    },

    createBorrowerSession(token_hash, flow_owner, owner, version, expires_at) {
      return execute("create_borrower_session", { token_hash, flow_owner, owner, version, expires_at }, "run", `
        INSERT INTO borrower_sessions (token_hash, flow_owner, owner, pin_version, expires_at)
        SELECT ?1, ?2, owner, pin_version, ?5 FROM borrower_accounts WHERE owner = ?3 AND pin_version = ?4
        ON CONFLICT DO NOTHING
      `);
    },

    borrowerSession(environment, token_hash, now) {
      return execute("borrower_session", { environment, token_hash, now }, "first", `
        SELECT a.owner FROM borrower_accounts a JOIN borrower_sessions s ON s.owner = a.owner
        WHERE a.environment = ?1 AND s.token_hash = ?2 AND s.expires_at > ?3
          AND s.revoked_at IS NULL AND s.pin_version = a.pin_version
      `);
    },

    revokeBorrowerSession(token_hash, now) {
      return execute("revoke_borrower_session", { token_hash, now }, "run", `
        UPDATE borrower_sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL
      `);
    },

    repaymentAccount(environment, owner) {
      return execute("repayment_account", { environment, owner }, "first", `
        SELECT customer_ref, phone_hash FROM repayment_accounts WHERE environment = ? AND owner = ?
      `);
    },

    listRepayments(environment, owner) {
      return execute("list_repayments", { environment, owner }, "all", `
        SELECT id, amount, state, receipt, result_code, created_at, updated_at FROM repayment_attempts
        WHERE environment = ? AND owner = ? ORDER BY created_at DESC, id DESC LIMIT 20
      `);
    },

    activeRepayment(environment, owner) {
      return execute("active_repayment", { environment, owner }, "first", `
        SELECT id, amount, state, receipt, result_code, created_at, updated_at FROM repayment_attempts
        WHERE environment = ? AND owner = ? AND state NOT IN ('credited', 'failed')
      `);
    },

    repayment(environment, id) {
      return execute("repayment", { environment, id }, "first", `
        SELECT * FROM repayment_attempts WHERE environment = ? AND id = ?
      `);
    },

    createRepayment(record) {
      const { id, environment, owner, customer_ref, loan_id, amount, phone_sealed, phone_hash, created_at } = record;
      return execute("create_repayment", {
        id, environment, owner, customer_ref, loan_id, amount, phone_sealed, phone_hash, created_at,
      }, "run", `
        INSERT INTO repayment_attempts (id, environment, owner, customer_ref, loan_id, amount, phone_sealed, state, created_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'starting', ?9, ?9 FROM repayment_accounts
        WHERE environment = ?2 AND owner = ?3 AND customer_ref = ?4 AND phone_hash = ?8
        ON CONFLICT DO NOTHING
      `);
    },

    updateRepayment(record) {
      const { environment, id, revision, state, checkout_id, merchant_id, receipt, paid_at, result_code, next_check_at, updated_at } = record;
      return execute("update_repayment", {
        environment, id, revision, state, checkout_id, merchant_id, receipt, paid_at, result_code, next_check_at, updated_at,
      }, "run", `
        UPDATE repayment_attempts SET state = ?4, checkout_id = ?5, merchant_id = ?6, receipt = ?7, paid_at = ?8,
          result_code = ?9, next_check_at = ?10, updated_at = ?11, revision = revision + 1
        WHERE environment = ?1 AND id = ?2 AND revision = ?3
      `);
    },
  };
}

async function d1Query(db, parameters, mode, sql) {
  const values = Object.values(parameters).map((value) => typeof value === "boolean" ? Number(value) : value);
  const statement = db.prepare(sql).bind(...values);
  if (mode === "first") return statement.first();
  if (mode === "all") return (await statement.all()).results;
  return (await statement.run()).meta.changes === 1;
}

function supabaseStore(env, fetcher) {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(env.SUPABASE_URL ?? "") ||
      !/^sb_secret_[\w-]+$/.test(env.SUPABASE_SECRET_KEY ?? "")) return null;
  const base = new URL("/rest/v1/rpc/", env.SUPABASE_URL);
  const headers = {
    apikey: env.SUPABASE_SECRET_KEY,
    "content-profile": "tala_api",
    "content-type": "application/json",
  };
  return store(async (name, parameters, mode) => {
    const args = Object.fromEntries(Object.entries(parameters).map(([key, value]) => ["p_" + key, value]));
    const response = await fetcher(new URL(name, base), {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("Supabase database request failed.");
    const result = await response.json();
    if ((mode === "run" && typeof result !== "boolean") ||
        (mode === "all" && !Array.isArray(result)) ||
        (mode === "first" && result !== null && (typeof result !== "object" || Array.isArray(result)))) {
      throw new Error("Supabase returned an invalid database result.");
    }
    return result;
  });
}

export function lendingStore(env, fetcher = fetch) {
  if (env.TALA_DATABASE === "supabase") return supabaseStore(env, fetcher);
  if ([undefined, "d1"].includes(env.TALA_DATABASE) && env.DB) {
    return store((_name, parameters, mode, sql) => d1Query(env.DB, parameters, mode, sql));
  }
  return null;
}
