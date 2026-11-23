create schema tala_private;
create schema tala_api;

revoke all on schema tala_private, tala_api from public, anon, authenticated;
grant usage on schema tala_private, tala_api to service_role;

create table tala_private.demo_accounts (
  owner text primary key,
  revision integer not null check (revision > 0),
  state text not null check (jsonb_typeof(state::jsonb) = 'object')
);

create table tala_private.web_verifications (
  owner text primary key,
  phone_hash text,
  phone_hint text,
  otp_id text,
  otp_hash text,
  otp_expires_at bigint not null default 0,
  otp_attempts integer not null default 0 check (otp_attempts >= 0),
  sms_retry_at bigint not null default 0,
  phone_verified_at bigint,
  id_reference text,
  id_request text,
  id_consent_at bigint,
  id_consent_version text,
  id_retry_at bigint not null default 0,
  id_poll_at bigint not null default 0,
  didit_id text,
  didit_url text,
  didit_status text
);

create table tala_private.verification_sms_limits (
  phone_hash text primary key,
  window_started bigint not null,
  request_count integer not null check (request_count > 0),
  retry_at bigint not null
);

create table tala_private.lending_applications (
  owner text primary key,
  reference text collate "C" not null unique,
  environment text not null check (environment in ('sandbox', 'live')),
  phone_hash text not null unique,
  phone_hint text not null,
  phone_sealed text not null,
  identity_id text not null,
  amount integer not null check (amount between 1000 and 50000),
  purpose text not null check (purpose in ('Business', 'Education', 'Household', 'Emergency', 'Other')),
  consent_version text not null,
  consent_at bigint not null,
  received_at bigint not null,
  review_started_at bigint,
  review_started_by text,
  check ((review_started_at is null) = (review_started_by is null))
);

create index lending_review_queue
  on tala_private.lending_applications (environment, received_at desc, reference desc);

create table tala_private.lending_contact_access (
  id text primary key,
  application_reference text not null references tala_private.lending_applications (reference),
  reviewer text not null,
  accessed_at bigint not null
);

create index lending_contact_access_history
  on tala_private.lending_contact_access (application_reference, accessed_at desc);

alter table tala_private.demo_accounts enable row level security;
alter table tala_private.web_verifications enable row level security;
alter table tala_private.verification_sms_limits enable row level security;
alter table tala_private.lending_applications enable row level security;
alter table tala_private.lending_contact_access enable row level security;

revoke all on all tables in schema tala_private from public, anon, authenticated, service_role;
grant select, insert, update on tala_private.demo_accounts, tala_private.web_verifications,
  tala_private.verification_sms_limits, tala_private.lending_applications to service_role;
grant insert on tala_private.lending_contact_access to service_role;

create function tala_api.account(p_owner text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select to_jsonb(a) from (
    select revision, state from tala_private.demo_accounts where owner = p_owner
  ) a;
$$;

create function tala_api.create_account(p_owner text, p_state text) returns boolean
language sql security invoker set search_path = '' as $$
  with affected as (
    insert into tala_private.demo_accounts (owner, revision, state) values (p_owner, 1, p_state)
    on conflict (owner) do nothing
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.update_account(p_owner text, p_state text, p_revision integer) returns boolean
language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.demo_accounts set state = p_state, revision = revision + 1
    where owner = p_owner and revision = p_revision
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.verification(p_owner text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select to_jsonb(v) from tala_private.web_verifications v where v.owner = p_owner;
$$;

create function tala_api.reserve_sms(p_phone_hash text, p_now bigint, p_window bigint, p_retry_at bigint)
returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    insert into tala_private.verification_sms_limits as s (phone_hash, window_started, request_count, retry_at)
    values (p_phone_hash, p_now, 1, p_retry_at)
    on conflict (phone_hash) do update set
      request_count = case when s.window_started <= p_window then 1 else s.request_count + 1 end,
      window_started = case when s.window_started <= p_window then p_now else s.window_started end,
      retry_at = p_retry_at
    where s.retry_at <= p_now and (s.window_started <= p_window or s.request_count < 3)
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.reserve_code(
  p_owner text, p_phone_hash text, p_phone_hint text, p_challenge text, p_retry_at bigint, p_now bigint
) returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    insert into tala_private.web_verifications as v (owner, phone_hash, phone_hint, otp_id, sms_retry_at)
    values (p_owner, p_phone_hash, p_phone_hint, p_challenge, p_retry_at)
    on conflict (owner) do update set
      phone_hash = excluded.phone_hash, phone_hint = excluded.phone_hint, otp_id = excluded.otp_id,
      sms_retry_at = excluded.sms_retry_at, otp_hash = null, otp_attempts = 0, otp_expires_at = 0
    where v.phone_verified_at is null and v.sms_retry_at <= p_now
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.save_code(p_owner text, p_challenge text, p_hash text, p_expires_at bigint)
returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.web_verifications set otp_hash = p_hash, otp_expires_at = p_expires_at
    where owner = p_owner and otp_id = p_challenge
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.confirm_code(
  p_owner text, p_challenge text, p_now bigint, p_max_attempts integer, p_valid boolean
) returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.web_verifications set
      phone_verified_at = case when p_valid then p_now else phone_verified_at end,
      otp_id = case when p_valid then null else otp_id end,
      otp_hash = case when p_valid then null else otp_hash end,
      otp_expires_at = case when p_valid then 0 else otp_expires_at end,
      otp_attempts = case when p_valid then otp_attempts else otp_attempts + 1 end
    where owner = p_owner and otp_id = p_challenge and phone_verified_at is null
      and otp_expires_at > p_now and otp_attempts < p_max_attempts
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.reserve_identity(
  p_owner text, p_request text, p_reference text, p_now bigint, p_consent_version text, p_retry_at bigint
) returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.web_verifications set
      id_request = p_request, id_reference = p_reference, id_consent_at = p_now, id_consent_version = p_consent_version,
      id_retry_at = p_retry_at, id_poll_at = 0, didit_id = null, didit_url = null, didit_status = null
    where owner = p_owner and phone_verified_at is not null and id_retry_at <= p_now
      and (didit_id is null or didit_status in ('expired', 'abandoned'))
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.save_identity(p_owner text, p_request text, p_identity_id text, p_url text)
returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.web_verifications set didit_id = p_identity_id, didit_url = p_url, didit_status = 'not-started'
    where owner = p_owner and id_request = p_request and didit_id is null
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.reserve_identity_poll(p_owner text, p_identity_id text, p_now bigint, p_poll_at bigint)
returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.web_verifications set id_poll_at = p_poll_at
    where owner = p_owner and didit_id = p_identity_id and id_poll_at <= p_now
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.save_identity_decision(p_owner text, p_identity_id text, p_poll_at bigint, p_status text, p_url text)
returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.web_verifications set didit_status = p_status, didit_url = coalesce(p_url, didit_url)
    where owner = p_owner and didit_id = p_identity_id and id_poll_at = p_poll_at
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.application(p_owner text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select to_jsonb(a) from (
    select reference, amount, purpose, received_at, review_started_at
    from tala_private.lending_applications where owner = p_owner
  ) a;
$$;

create function tala_api.create_application(
  p_owner text, p_reference text, p_environment text, p_phone_hash text, p_phone_hint text, p_phone_sealed text,
  p_identity_id text, p_amount integer, p_purpose text, p_consent_version text, p_received_at bigint
) returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    insert into tala_private.lending_applications (
      owner, reference, environment, phone_hash, phone_hint, phone_sealed, identity_id,
      amount, purpose, consent_version, consent_at, received_at
    ) values (
      p_owner, p_reference, p_environment, p_phone_hash, p_phone_hint, p_phone_sealed, p_identity_id,
      p_amount, p_purpose, p_consent_version, p_received_at, p_received_at
    ) on conflict do nothing
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.review_application(p_environment text, p_reference text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select to_jsonb(a) from (
    select reference, environment, amount, purpose, received_at, review_started_at, phone_hint, identity_id
    from tala_private.lending_applications where environment = p_environment and reference = p_reference
  ) a;
$$;

create function tala_api.review_queue(p_environment text, p_received_at bigint default null, p_reference text default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(a order by a.received_at desc, a.reference desc), '[]'::jsonb)
  from (
    select reference, environment, amount, purpose, received_at, review_started_at, phone_hint, identity_id
    from tala_private.lending_applications
    where environment = p_environment and (
      p_received_at is null or (received_at, reference) < (p_received_at, p_reference)
    )
    order by received_at desc, reference desc limit 21
  ) a;
$$;

create function tala_api.start_review(p_environment text, p_reference text, p_reviewer text, p_now bigint)
returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.lending_applications set review_started_at = p_now, review_started_by = p_reviewer
    where environment = p_environment and reference = p_reference and review_started_at is null
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.application_contact(p_environment text, p_reference text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select to_jsonb(a) from (
    select phone_sealed from tala_private.lending_applications
    where environment = p_environment and reference = p_reference
  ) a;
$$;

create function tala_api.record_contact_access(p_id text, p_reference text, p_reviewer text, p_now bigint)
returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    insert into tala_private.lending_contact_access (id, application_reference, reviewer, accessed_at)
    values (p_id, p_reference, p_reviewer, p_now)
    returning 1
  )
  select exists (select 1 from affected);
$$;

revoke execute on all functions in schema tala_api from public, anon, authenticated;
grant execute on all functions in schema tala_api to service_role;
