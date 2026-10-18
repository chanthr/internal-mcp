-- Knowledge MCP — Supabase setup
--
-- Run this once in your Supabase project (SQL editor or `supabase db`). It is safe to run again: every
-- statement is idempotent, and re-running it on an existing install applies the fixes below. It creates:
--   - mcp_keys + validate_mcp_key()  : API-key auth for http/prod
--   - app_users                      : per-user role + resource scopes (RBAC)
--   - mcp_oauth_clients              : DCR client persistence (only if you enable OAuth)
--   - mcp_refresh_tokens             : OAuth refresh rotation / revocation
--   - mcp_sync_state                 : Drive incremental-sync page token
--   - mcp_tool_calls                 : tool-call audit log
--   - slack_channels                 : Slack channel purpose map (slack_list_channels)
-- and then locks every table and the key function down to the server's service-role key.
--
-- Requires Postgres 13+ (gen_random_uuid and sha256 are built in; no extension needed).
--
-- NOTE ON SCHEMA: state tables are read via config.data.schema (default "public"). validate_mcp_key
-- is called without a schema qualifier, so keep it (and mcp_keys) in "public". If you set
-- config.data.schema to something other than "public", create the state tables in that schema, add that
-- schema to "Exposed schemas" in Supabase API settings, and apply the lock-down section to it as well.

-- ── API keys ───────────────────────────────────────────────────────────────
-- Store only a SHA-256 hash of each key. Hand the raw key to the client once.
-- Use a long random key (e.g. `openssl rand -hex 32`); the hash is unsalted.
create table if not exists public.mcp_keys (
  id          uuid primary key default gen_random_uuid(),
  key_hash    text not null unique,             -- encode(sha256(convert_to(raw_key,'UTF8')),'hex')
  org_id      text not null default 'org',
  role        text not null default 'engineer', -- admin | engineer | viewer (used only when email is null)
  email       text,                             -- set => role and scopes come from app_users
  active      boolean not null default true,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- Provision a key for a person (role comes from their app_users row):
--   insert into public.app_users (email, role) values ('you@acme.com', 'admin')
--     on conflict (email) do update set role = excluded.role;
--   insert into public.mcp_keys (key_hash, org_id, email)
--   values (encode(sha256(convert_to('PASTE_RAW_KEY_HERE','UTF8')),'hex'), 'acme', 'you@acme.com');

-- sha256() over the UTF-8 bytes gives the same hash as the older digest(text,'sha256'), so existing keys
-- keep working. It avoids pgcrypto, which Supabase installs in the "extensions" schema where a function
-- pinned to search_path=public cannot see it.
create or replace function public.validate_mcp_key(p_key text)
returns table (ok boolean, org_id text, role text, email text, key_id text, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare r public.mcp_keys%rowtype;
begin
  select * into r from public.mcp_keys
   where key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
   limit 1;
  if not found then
    return query select false, null::text, null::text, null::text, null::text, 'key not found'; return;
  end if;
  if not r.active then
    return query select false, null::text, null::text, null::text, null::text, 'key inactive'; return;
  end if;
  if r.expires_at is not null and r.expires_at < now() then
    return query select false, null::text, null::text, null::text, null::text, 'key expired'; return;
  end if;
  return query select true, r.org_id, r.role, r.email, r.id::text, null::text;
end $$;

-- ── Users (RBAC) ─────────────────────────────────────────────────────────────
-- role 'admin' => admin (every tool). Any other value => engineer (limited by the allowed_* columns).
-- A signed-in email with no row here is a viewer: only `ping`, unless config access.viewerTools opens groups.
create table if not exists public.app_users (
  email                   text primary key,
  role                    text not null default 'member',
  name                    text,
  allowed_slack_channels  text[],   -- null/empty = all channels the bot is in
  allowed_drive_folders   text[],   -- null/empty = all (path prefixes under the Drive roots)
  allowed_tools           text[],   -- null/empty = all (groups: slack|drive|github|railway)
  created_at              timestamptz not null default now()
);

-- ── OAuth (only needed if you enable OAuth 2.1) ──────────────────────────────
create table if not exists public.mcp_oauth_clients (
  client_id     text primary key,
  client_data   jsonb not null,
  client_name   text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create table if not exists public.mcp_refresh_tokens (
  jti         text primary key,
  email       text not null,
  client_id   text not null,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  rotated_to  text,
  created_at  timestamptz not null default now()
);
create index if not exists mcp_refresh_tokens_email_idx on public.mcp_refresh_tokens (email);

-- ── Drive incremental sync state ─────────────────────────────────────────────
create table if not exists public.mcp_sync_state (
  key         text primary key,
  page_token  text,
  updated_at  timestamptz not null default now()
);

-- ── Tool-call audit log ──────────────────────────────────────────────────────
create table if not exists public.mcp_tool_calls (
  id           bigserial primary key,
  tool         text not null,
  email        text,
  role         text,
  ok           boolean not null,
  error        text,
  duration_ms  integer,
  source       text,
  created_at   timestamptz not null default now()
);

-- ── Slack channel purpose map (slack_list_channels) ──────────────────────────
-- New channels are added automatically with enabled=false. Fill in `purpose` and set enabled=true to list them.
create table if not exists public.slack_channels (
  id            uuid primary key default gen_random_uuid(),
  channel_name  text not null,
  channel_id    text unique,
  purpose       text not null default '',
  category      text,
  enabled       boolean not null default false,
  sort_order    integer not null default 100,
  created_at    timestamptz not null default now()
);

-- ── Lock down ────────────────────────────────────────────────────────────────
-- Only the server touches these, with the service-role key (which bypasses RLS).
-- Supabase grants new tables, sequences and functions in "public" to the anon and authenticated roles by
-- default, and tables created from SQL start with RLS off. Without this section anyone holding the
-- project's public anon key could, through the REST API, insert an admin API key, read OAuth client
-- secrets, un-revoke refresh tokens, or call validate_mcp_key to guess keys without any rate limit.
alter table public.mcp_keys           enable row level security;
alter table public.app_users          enable row level security;
alter table public.mcp_oauth_clients  enable row level security;
alter table public.mcp_refresh_tokens enable row level security;
alter table public.mcp_sync_state     enable row level security;
alter table public.mcp_tool_calls     enable row level security;
alter table public.slack_channels     enable row level security;

revoke all on function public.validate_mcp_key(text) from public;

do $$
declare
  t text;
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    continue when not exists (select 1 from pg_roles where rolname = r);
    foreach t in array array['mcp_keys', 'app_users', 'mcp_oauth_clients', 'mcp_refresh_tokens',
                             'mcp_sync_state', 'mcp_tool_calls', 'slack_channels'] loop
      execute format('revoke all on table public.%I from %I', t, r);
    end loop;
    execute format('revoke all on sequence public.mcp_tool_calls_id_seq from %I', r);
    execute format('revoke all on function public.validate_mcp_key(text) from %I', r);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.validate_mcp_key(text) to service_role;
  end if;
end $$;
