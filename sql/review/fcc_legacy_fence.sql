-- REVIEW ONLY. Executing this is a production authorization boundary.
-- Stop every known legacy trigger and drain in-flight jobs/transactions FIRST.
-- Capture original GRANTs and roles before use. This does not protect against
-- owners, superusers, BYPASSRLS users with another granted role, or statements
-- that began before revocation. Recheck pending writers after commit.
-- SELECT grants and all data remain unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- Wait for existing row writers and block new table writes during revocation.
lock table public.furry_events in share row exclusive mode;
revoke all on function public.sync_furry_events(jsonb,timestamptz,boolean)
  from public, anon, authenticated, service_role;
revoke insert, update, delete, truncate, references, trigger
  on public.furry_events from public, anon, authenticated, service_role;
do $$
declare cols text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into cols
  from pg_catalog.pg_attribute
  where attrelid = 'public.furry_events'::regclass and attnum > 0 and not attisdropped;
  if cols is null then raise exception 'FCC_LEGACY_TABLE_COLUMNS_MISSING'; end if;
  execute format(
    'revoke insert (%1$s), update (%1$s), references (%1$s) on public.furry_events from public, anon, authenticated, service_role',
    cols
  );
end $$;
commit;
