create table tala_private.borrower_accounts (
  owner text primary key,
  environment text not null check (environment in ('sandbox', 'live')),
  phone_hash text not null,
  pin_salt text not null,
  pin_hash text not null,
  pin_version integer not null default 1 check (pin_version > 0),
  created_at bigint not null,
  unique (environment, phone_hash)
);

create table tala_private.borrower_sessions (
  token_hash text primary key,
  flow_owner text not null unique,
  owner text not null references tala_private.borrower_accounts (owner),
  pin_version integer not null,
  expires_at bigint not null,
  revoked_at bigint
);

create index borrower_session_expiry on tala_private.borrower_sessions (expires_at);

create table tala_private.borrower_auth_limits (
  scope text primary key,
  window_started bigint not null,
  attempts integer not null check (attempts > 0)
);

alter table tala_private.borrower_accounts enable row level security;
alter table tala_private.borrower_sessions enable row level security;
alter table tala_private.borrower_auth_limits enable row level security;

revoke all on tala_private.borrower_accounts, tala_private.borrower_sessions, tala_private.borrower_auth_limits
  from public, anon, authenticated, service_role;
grant select, insert, update on tala_private.borrower_accounts, tala_private.borrower_sessions,
  tala_private.borrower_auth_limits to service_role;

create function tala_api.borrower(p_environment text, p_phone_hash text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select to_jsonb(a) from (
    select owner, pin_salt, pin_hash, pin_version from tala_private.borrower_accounts
    where environment = p_environment and phone_hash = p_phone_hash
  ) a;
$$;

create function tala_api.create_borrower(
  p_owner text, p_environment text, p_verification_owner text, p_pin_salt text, p_pin_hash text, p_now bigint, p_cutoff bigint
) returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    insert into tala_private.borrower_accounts (owner, environment, phone_hash, pin_salt, pin_hash, created_at)
    select p_owner, p_environment, phone_hash, p_pin_salt, p_pin_hash, p_now
    from tala_private.web_verifications where owner = p_verification_owner and phone_verified_at >= p_cutoff
    on conflict do nothing
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.reset_borrower_pin(
  p_owner text, p_verification_owner text, p_version integer, p_pin_salt text, p_pin_hash text, p_cutoff bigint
) returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.borrower_accounts a set pin_salt = p_pin_salt, pin_hash = p_pin_hash, pin_version = a.pin_version + 1
    where a.owner = p_owner and a.pin_version = p_version and exists (
      select 1 from tala_private.web_verifications v
      where v.owner = p_verification_owner and v.phone_verified_at >= p_cutoff and v.phone_hash = a.phone_hash
    )
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.consume_auth_limit(p_scope text, p_now bigint, p_cutoff bigint, p_cap integer)
returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    insert into tala_private.borrower_auth_limits as r (scope, window_started, attempts) values (p_scope, p_now, 1)
    on conflict (scope) do update set
      attempts = case when r.window_started <= p_cutoff then 1 else r.attempts + 1 end,
      window_started = case when r.window_started <= p_cutoff then p_now else r.window_started end
    where r.window_started <= p_cutoff or r.attempts < p_cap
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.create_borrower_session(
  p_token_hash text, p_flow_owner text, p_owner text, p_version integer, p_expires_at bigint
) returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    insert into tala_private.borrower_sessions (token_hash, flow_owner, owner, pin_version, expires_at)
    select p_token_hash, p_flow_owner, owner, pin_version, p_expires_at from tala_private.borrower_accounts
    where owner = p_owner and pin_version = p_version
    on conflict do nothing
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.borrower_session(p_environment text, p_token_hash text, p_now bigint) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('owner', a.owner)
  from tala_private.borrower_accounts a join tala_private.borrower_sessions s on s.owner = a.owner
  where a.environment = p_environment and s.token_hash = p_token_hash and s.expires_at > p_now
    and s.revoked_at is null and s.pin_version = a.pin_version;
$$;

create function tala_api.revoke_borrower_session(p_token_hash text, p_now bigint) returns boolean
language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.borrower_sessions set revoked_at = p_now where token_hash = p_token_hash and revoked_at is null
    returning 1
  )
  select exists (select 1 from affected);
$$;

revoke execute on all functions in schema tala_api from public, anon, authenticated;
grant execute on all functions in schema tala_api to service_role;
