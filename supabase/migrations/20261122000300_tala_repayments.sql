create table tala_private.repayment_accounts (
  environment text not null check (environment in ('sandbox', 'live')),
  owner text not null,
  customer_ref text not null,
  phone_hash text not null,
  primary key (environment, owner),
  unique (environment, customer_ref)
);

create table tala_private.repayment_attempts (
  id text primary key,
  environment text not null,
  owner text not null,
  customer_ref text not null,
  loan_id text not null,
  amount integer not null check (amount > 0),
  phone_sealed text not null,
  state text not null check (state in ('starting', 'pending', 'awaiting-receipt', 'posting', 'credited', 'failed', 'review')),
  checkout_id text,
  merchant_id text,
  receipt text,
  paid_at text,
  result_code text,
  next_check_at bigint not null default 0,
  revision integer not null default 1,
  created_at bigint not null,
  updated_at bigint not null,
  foreign key (environment, owner) references tala_private.repayment_accounts (environment, owner),
  unique (environment, checkout_id),
  unique (environment, receipt)
);

create unique index repayment_single_open on tala_private.repayment_attempts (environment, owner)
  where state not in ('credited', 'failed');
create index repayment_by_owner on tala_private.repayment_attempts (environment, owner, created_at desc, id desc);

alter table tala_private.repayment_accounts enable row level security;
alter table tala_private.repayment_attempts enable row level security;
revoke all on tala_private.repayment_accounts, tala_private.repayment_attempts from public, anon, authenticated, service_role;
grant select on tala_private.repayment_accounts to service_role;
grant select, insert, update on tala_private.repayment_attempts to service_role;

create function tala_api.repayment_account(p_environment text, p_owner text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('customer_ref', customer_ref, 'phone_hash', phone_hash)
  from tala_private.repayment_accounts where environment = p_environment and owner = p_owner;
$$;

create function tala_api.list_repayments(p_environment text, p_owner text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(p order by p.created_at desc, p.id desc), '[]'::jsonb) from (
    select id, amount, state, receipt, result_code, created_at, updated_at
    from tala_private.repayment_attempts where environment = p_environment and owner = p_owner
    order by created_at desc, id desc limit 20
  ) p;
$$;

create function tala_api.active_repayment(p_environment text, p_owner text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select to_jsonb(p) from (
    select id, amount, state, receipt, result_code, created_at, updated_at from tala_private.repayment_attempts
    where environment = p_environment and owner = p_owner and state not in ('credited', 'failed')
  ) p;
$$;

create function tala_api.repayment(p_environment text, p_id text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select to_jsonb(p) from tala_private.repayment_attempts p where environment = p_environment and id = p_id;
$$;

create function tala_api.create_repayment(
  p_id text, p_environment text, p_owner text, p_customer_ref text, p_loan_id text, p_amount integer,
  p_phone_sealed text, p_phone_hash text, p_created_at bigint
) returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    insert into tala_private.repayment_attempts
      (id, environment, owner, customer_ref, loan_id, amount, phone_sealed, state, created_at, updated_at)
    select p_id, p_environment, p_owner, p_customer_ref, p_loan_id, p_amount, p_phone_sealed, 'starting', p_created_at, p_created_at
    from tala_private.repayment_accounts
    where environment = p_environment and owner = p_owner and customer_ref = p_customer_ref and phone_hash = p_phone_hash
    on conflict do nothing
    returning 1
  )
  select exists (select 1 from affected);
$$;

create function tala_api.update_repayment(
  p_environment text, p_id text, p_revision integer, p_state text, p_checkout_id text, p_merchant_id text, p_receipt text,
  p_paid_at text, p_result_code text, p_next_check_at bigint, p_updated_at bigint
) returns boolean language sql security invoker set search_path = '' as $$
  with affected as (
    update tala_private.repayment_attempts set state = p_state, checkout_id = p_checkout_id, merchant_id = p_merchant_id,
      receipt = p_receipt, paid_at = p_paid_at, result_code = p_result_code, next_check_at = p_next_check_at,
      updated_at = p_updated_at, revision = revision + 1
    where environment = p_environment and id = p_id and revision = p_revision
    returning 1
  )
  select exists (select 1 from affected);
$$;

revoke execute on all functions in schema tala_api from public, anon, authenticated;
grant execute on all functions in schema tala_api to service_role;
