-- Knowledge MCP — Supabase setup
--
-- Run this once in your Supabase project (SQL editor or `supabase db`). It creates:
--   - mcp_keys + validate_mcp_key()  : API-key auth for http/prod
--   - app_users                      : per-user role + resource scopes (RBAC)
--   - mcp_oauth_clients              : DCR client persistence (only if you enable OAuth)
--   - mcp_refresh_tokens             : OAuth refresh rotation / revocation
--   - mcp_sync_state                 : Drive incremental-sync page token
--   - mcp_tool_calls                 : tool-call audit log
--
-- NOTE ON SCHEMA: state tables are read via config.data.schema (default "public"). validate_mcp_key
-- is called without a schema qualifier, so keep it (and mcp_keys) in "public". If you set
-- config.data.schema to something other than "public", create the state tables in that schema.

create extension if not exists pgcrypto;   -- for digest() used by validate_mcp_key

-- ── API keys ───────────────────────────────────────────────────────────────
-- Store only a SHA-256 hash of each key. Hand the raw key to the client once.
create table if not exists public.mcp_keys (
  id          uuid primary key default gen_random_uuid(),
  key_hash    text not null unique,             -- encode(digest(raw_key,'sha256'),'hex')
  org_id      text not null default 'org',
  role        text not null default 'engineer', -- admin | engineer | viewer
  email       text,
  active      boolean not null default true,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- Provision a key:
--   insert into public.mcp_keys (key_hash, org_id, role, email)
--   values (encode(digest('PASTE_RAW_KEY_HERE','sha256'),'hex'), 'acme', 'admin', 'you@acme.com');

create or replace function public.validate_mcp_key(p_key text)
returns table (ok boolean, org_id text, role text, email text, key_id text, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare r public.mcp_keys%rowtype;
begin
  select * into r from public.mcp_keys
   where key_hash = encode(digest(p_key, 'sha256'), 'hex')
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
  update public.mcp_keys set active = active where id = r.id;  -- no-op touch point
  return query select true, r.org_id, r.role, r.email, r.id::text, null::text;
end $$;

-- ── Users (RBAC) ─────────────────────────────────────────────────────────────
create table if not exists public.app_users (
  email                   text primary key,
  role                    text not null default 'member',   -- 'admin' => admin, else engineer
  name                    text,
  allowed_slack_channels  text[],   -- null/empty = all
  allowed_drive_folders   text[],   -- null/empty = all (path prefixes)
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

-- These tables are accessed only with the service-role key from the server. RLS is on-by-default
-- for new tables in Supabase; the service role bypasses RLS, so no policies are required.
