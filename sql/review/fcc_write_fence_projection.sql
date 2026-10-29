-- ISOLATED REVIEW DRAFT ONLY. Not a deployable migration.
-- Requires owner review, dependency/ACL inventory and an independently approved rollout.
begin;
create schema if not exists furry_review_private;
revoke all on schema furry_review_private from public, anon, authenticated, service_role;
-- These names are isolated test roles. Never grant membership to legacy callers.
create role fcc_review_executor nologin noinherit;
create role fcc_review_ingest nologin noinherit;
create table furry_review_private.write_gate (
 singleton boolean primary key default true check(singleton),
 state text not null default 'legacy_open' check(state in ('legacy_open','frozen','fcc_open'))
);
insert into furry_review_private.write_gate(singleton,state) values(true,'legacy_open');
revoke all on furry_review_private.write_gate from public,anon,authenticated,service_role,fcc_review_ingest,fcc_review_executor;
create function furry_review_private.check_transition() returns trigger language plpgsql set search_path='' as $$
begin
 if new.singleton is distinct from old.singleton or
    (new.state<>old.state and old.state<>'frozen' and new.state<>'frozen') then
   raise exception 'FURRY_INVALID_TRANSITION' using errcode='55000';
 end if;
 return new;
end $$;
create trigger gate_transition before update on furry_review_private.write_gate for each row execute function furry_review_private.check_transition();
-- Lock and state evaluation execute under owner. The invoker trigger supplies the
-- database current_user, not a caller-controlled setting or request parameter.
create function furry_review_private.check_write(actor name) returns void
language plpgsql security definer set search_path='' as $$
declare current_state text;
begin
 select state into current_state from furry_review_private.write_gate where singleton for share;
 if not ((current_state='legacy_open' and actor <> 'fcc_review_executor') or
         (current_state='fcc_open' and actor = 'fcc_review_executor')) then
   raise exception 'FURRY_WRITES_FROZEN_OR_UNAUTHORIZED' using errcode='55000';
 end if;
end $$;
revoke all on function furry_review_private.check_write(name) from public;
grant usage on schema furry_review_private to service_role,fcc_review_executor;
grant execute on function furry_review_private.check_write(name) to service_role,fcc_review_executor;
create function furry_review_private.guard_event_write() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 perform furry_review_private.check_write(current_user);
 return null;
end $$;
create trigger furry_write_gate before insert or update or delete or truncate on public.furry_events
for each statement execute function furry_review_private.guard_event_write();
-- Narrow demonstrator: update only status for an already reviewed binding.
-- This is NOT a full FCC ingestion or mapping implementation.
create table furry_review_private.reviewed_binding(fcc_id uuid primary key,event_id bigint not null unique references public.furry_events(id));
revoke all on furry_review_private.reviewed_binding from public,anon,authenticated,service_role,fcc_review_ingest,fcc_review_executor;
grant usage on schema public to fcc_review_executor;
grant select on furry_review_private.reviewed_binding to fcc_review_executor;
grant select (id,source), update(status) on public.furry_events to fcc_review_executor;
create policy furry_review_fcc_update on public.furry_events for update to fcc_review_executor
 using (source='fcc') with check (source='fcc');
create function public.fcc_review_set_status(p_fcc_id uuid,p_status text) returns bigint
language plpgsql security definer set search_path='' as $$
declare target bigint;
begin
 if p_status not in ('scheduled','cancelled','postponed','rescheduled','movedOnline') or p_status is null then
  raise exception 'INVALID_STATUS' using errcode='22023';
 end if;
 select event_id into target from furry_review_private.reviewed_binding where fcc_id=p_fcc_id;
 if target is null then raise exception 'FCC_BINDING_REQUIRED' using errcode='22023'; end if;
 update public.furry_events set status=p_status where id=target and source='fcc';
 if not found then raise exception 'FCC_TARGET_REQUIRED' using errcode='22023'; end if;
 return target;
end $$;
alter function public.fcc_review_set_status(uuid,text) owner to fcc_review_executor;
revoke all on function public.fcc_review_set_status(uuid,text) from public,anon,authenticated,service_role,fcc_review_executor;
grant execute on function public.fcc_review_set_status(uuid,text) to fcc_review_ingest;

-- Do not use SELECT *: public data contract is explicit. Detail stays private;
-- link fields permit only a conservative HTTPS allowlist.
revoke select,insert,update,delete,truncate,references,trigger on public.furry_events from public,anon,authenticated;
-- Table REVOKE does not remove independent column-level grants.
do $$
declare cols text;
begin
 select string_agg(quote_ident(attname), ', ' order by attnum) into cols
 from pg_catalog.pg_attribute where attrelid='public.furry_events'::regclass
 and attnum>0 and not attisdropped;
 execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.furry_events from public,anon,authenticated', cols,cols,cols,cols);
end $$;
create view public.furry_events_public_v2 with (security_barrier=true) as
select id::text as id, name, full_name, start_at, end_at, province, city,
 address, venue, status, is_active, organization,
 case when coalesce(cover,cover_url) ~ '^https://images[.]furrycons[.]cn/[^[:space:]<>"'']*$' then coalesce(cover,cover_url) else null end as cover,
 case when coalesce(cover,cover_url) ~ '^https://images[.]furrycons[.]cn/[^[:space:]<>"'']*$' then coalesce(cover,cover_url) else null end as cover_url,
 case when source_url ~ '^https://(www[.])?furrycons[.]cn/[^[:space:]<>"'']*$' then source_url else null end as source_url,
 null::text as detail, null::text as source_id,
 start_at as "startAt",end_at as "endAt",
 case when source_url ~ '^https://(www[.])?furrycons[.]cn/[^[:space:]<>"'']*$' then source_url else null end as "sourceUrl"
from public.furry_events where is_active is true;
revoke all on public.furry_events_public_v2 from public;
grant select on public.furry_events_public_v2 to anon,authenticated,service_role;

-- Helper explicitly maps malformed or absent timestamps to NULL; no implicit
-- session timezone for bare dates. Only offset-qualified ISO timestamps accepted.
create function furry_review_private.parse_iso_time(v text) returns timestamptz
language plpgsql stable set search_path='' as $$
begin
 if v is null or v !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then return null; end if;
 return v::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end $$;
revoke all on function furry_review_private.parse_iso_time(text) from public;
-- Invoker needs schema usage and execute on helper; it contains no private data.
grant usage on schema furry_review_private to anon,authenticated,service_role;
grant execute on function furry_review_private.parse_iso_time(text) to anon,authenticated,service_role;
create function public.get_upcoming_events_v2(p_city text default null,p_status text default null,p_limit integer default 50,p_offset integer default 0)
returns table(id text,name text,event_date text,event_time text,city text,venue text,address text,cover text,status text,source_url text,start_at timestamptz,end_at timestamptz)
language plpgsql stable security invoker set search_path='' as $$
begin
 if p_limit is null or p_limit<1 or p_limit>500 or p_offset is null or p_offset<0 or p_offset>10000 then
  raise exception 'INVALID_QUERY_PAGE' using errcode='22023';
 end if;
 return query
 select e.id,e.name,to_char(t.start_time at time zone 'Asia/Shanghai','YYYY-MM-DD'),to_char(t.start_time at time zone 'Asia/Shanghai','HH24:MI'),e.city,e.venue,e.address,e.cover,e.status,e.source_url,t.start_time,furry_review_private.parse_iso_time(e.end_at)
 from public.furry_events_public_v2 e cross join lateral (select furry_review_private.parse_iso_time(e.start_at) as start_time) t
 where t.start_time>=now() and (p_city is null or e.city=p_city)
 and (p_status='all' or (p_status is null and e.status is distinct from 'cancelled') or (p_status is not null and p_status<>'all' and e.status=p_status))
 order by t.start_time,e.id::bigint limit p_limit offset p_offset;
end
$$;
create function public.get_rescheduled_events_v2(p_limit integer default 20)
returns table(id text,name text,event_date text,city text,venue text,cover text,status text,start_at timestamptz)
language sql stable security invoker set search_path='' as $$
 select e.id,e.name,e.event_date,e.city,e.venue,e.cover,e.status,e.start_at from public.get_upcoming_events_v2(null,'rescheduled',p_limit) e;
$$;
create function public.get_event_cities_v2()
returns table(city text,event_count bigint) language sql stable security invoker set search_path='' as $$
 select e.city,count(*) from public.furry_events_public_v2 e
 where e.city is not null and e.status is distinct from 'cancelled'
 and furry_review_private.parse_iso_time(e.start_at)>=now()
 group by e.city order by count(*) desc,e.city;
$$;
revoke all on function public.get_upcoming_events_v2(text,text,integer,integer), public.get_rescheduled_events_v2(integer), public.get_event_cities_v2() from public;
grant execute on function public.get_upcoming_events_v2(text,text,integer,integer), public.get_rescheduled_events_v2(integer), public.get_event_cities_v2() to anon,authenticated,service_role;
commit;
