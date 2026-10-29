-- FCC simple replacement; production use requires explicit authorization and verified backup.
-- Fresh FCC private table, legacy table untouched; atomically switch query source after full sync.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema furry_fcc_simple_private;
revoke all on schema furry_fcc_simple_private from public,anon,authenticated;
grant usage on schema furry_fcc_simple_private to service_role;
create table furry_fcc_simple_private.settings (
 singleton boolean primary key default true check(singleton),
 source text not null check(source in ('legacy','fcc')) default 'legacy',
 last_started_at timestamptz,
 last_completed_at timestamptz,
 last_snapshot_sha256 text,
 last_deactivated_count integer
);
insert into furry_fcc_simple_private.settings(singleton) values(true);
create table furry_fcc_simple_private.events (
 id bigint primary key default nextval('public.furry_events_id_seq'::regclass),
 fcc_id uuid not null unique,
 name text not null, full_name text not null,
 start_at text, end_at text, province text, city text, address text, venue text,
 cover text, source_url text, detail text, organization text,
 native_status text not null, status_known boolean not null,
 is_active boolean not null default true, updated_at text not null
);
create index fcc_simple_events_start_idx on furry_fcc_simple_private.events(start_at,id);
alter table furry_fcc_simple_private.events enable row level security;
alter table furry_fcc_simple_private.settings enable row level security;
revoke all on all tables in schema furry_fcc_simple_private from public,anon,authenticated,service_role;
grant select,insert,update on furry_fcc_simple_private.events to service_role;
grant select,update on furry_fcc_simple_private.settings to service_role;
grant usage,select on sequence public.furry_events_id_seq to service_role;

-- Protect direct Data API paths. Column-level privileges also require revocation.
revoke select,insert,update,delete,truncate,references,trigger on public.furry_events from public,anon,authenticated;
-- Fence both old RPC and direct legacy cache writers while preserving service reads.
revoke insert,update,delete,truncate,references,trigger on public.furry_events from service_role;
revoke all on function public.sync_furry_events(jsonb,timestamptz,boolean) from public,anon,authenticated,service_role;
do $$
declare cols text;
begin
 select string_agg(quote_ident(attname),', ' order by attnum) into cols from pg_catalog.pg_attribute
 where attrelid='public.furry_events'::regclass and attnum>0 and not attisdropped;
 execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.furry_events from public,anon,authenticated',cols,cols,cols,cols);
 execute format('revoke insert (%s), update (%s), references (%s) on public.furry_events from service_role',cols,cols,cols);
end $$;

-- The trusted Edge function MUST acquire two independently paginated consistent passes.
-- The database cannot prove FCC source/complete flag: no untrusted caller may execute this.
create function public.sync_fcc_events(events jsonb, started_at timestamptz, completed_at timestamptz, complete boolean)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='5s' as $$
declare n integer; upserts integer; deactivations integer; last_start timestamptz; last_complete timestamptz; last_sha text; last_deactivated integer; current_source text; snapshot_sha text; item jsonb; required_fields text[]:=array['fcc_id','name','full_name','start_at','end_at','province','city','address','venue','cover','source_url','detail','organization','native_status','status_known'];
begin
 perform pg_advisory_xact_lock(771284616231::bigint);
 select last_started_at,last_completed_at,last_snapshot_sha256,last_deactivated_count,source into last_start,last_complete,last_sha,last_deactivated,current_source from furry_fcc_simple_private.settings where singleton for update;
 if complete is distinct from true or events is null or jsonb_typeof(events)<>'array' then raise exception 'INCOMPLETE_SNAPSHOT'; end if;
 n:=jsonb_array_length(events);
 if n=0 or n>10000 then raise exception 'INVALID_SNAPSHOT_COUNT'; end if;
 if started_at is null or completed_at is null or completed_at<started_at or completed_at>clock_timestamp()+interval '5 minutes' then raise exception 'INVALID_SNAPSHOT_TIME'; end if;
 snapshot_sha:=encode(sha256(convert_to(events::text,'UTF8')),'hex');
 if last_start is not null and started_at<=last_start then
  -- Only an exact retry of the committed snapshot may return the original
  -- receipt. Never let an old retry reactivate FCC after an operator rollback.
  if started_at=last_start and completed_at=last_complete and snapshot_sha=last_sha and current_source='fcc' then
   return jsonb_build_object('upserted',n,'deactivated',last_deactivated);
  end if;
  raise exception 'STALE_SNAPSHOT';
 end if;
 for item in select value from jsonb_array_elements(events) loop
  if jsonb_typeof(item)<>'object' or not item ?& required_fields then raise exception 'INVALID_EVENT_CONTRACT'; end if;
  if jsonb_typeof(item->'fcc_id')<>'string' or item->>'fcc_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or jsonb_typeof(item->'name')<>'string' or nullif(btrim(item->>'name'),'') is null or jsonb_typeof(item->'full_name')<>'string' or nullif(btrim(item->>'full_name'),'') is null or jsonb_typeof(item->'native_status')<>'string' or nullif(btrim(item->>'native_status'),'') is null or jsonb_typeof(item->'status_known')<>'boolean' then raise exception 'INVALID_EVENT_CONTRACT'; end if;
  if (item->>'status_known')::boolean is distinct from ((item->>'native_status')=any(array['cancelled','movedOnline','postponed','rescheduled','scheduled'])) then raise exception 'INVALID_EVENT_STATUS'; end if;
  if exists(select 1 from jsonb_each(item) kv where kv.key=any(array['province','city','address','venue','cover','source_url','detail','organization','start_at','end_at']) and jsonb_typeof(kv.value) not in ('string','null')) then raise exception 'INVALID_EVENT_CONTRACT'; end if;
  if (item->>'cover' is not null and item->>'cover' !~ '^https://images[.]furrycons[.]cn/[^[:space:]<>"'']*$') or (item->>'source_url' is not null and item->>'source_url' !~ '^https://(www[.])?furrycons[.]cn/[^[:space:]<>"'']*$') then raise exception 'UNSAFE_EVENT_URL'; end if;
  if (item->>'start_at' is not null and item->>'start_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+08:00$') or (item->>'end_at' is not null and item->>'end_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+08:00$') then raise exception 'INVALID_EVENT_DATE'; end if;
  begin
   perform (item->>'start_at')::timestamptz,(item->>'end_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
   raise exception 'INVALID_EVENT_DATE';
  end;
  if (item->>'end_at')::timestamptz<(item->>'start_at')::timestamptz then raise exception 'INVALID_EVENT_DATE_RANGE'; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(events) x group by (x->>'fcc_id')::uuid having count(*)>1) then raise exception 'DUPLICATE_FCC_ID'; end if;
 insert into furry_fcc_simple_private.events(fcc_id,name,full_name,start_at,end_at,province,city,address,venue,cover,source_url,detail,organization,native_status,status_known,is_active,updated_at)
 select (x->>'fcc_id')::uuid,x->>'name',x->>'full_name',x->>'start_at',x->>'end_at',x->>'province',x->>'city',x->>'address',x->>'venue',x->>'cover',x->>'source_url',x->>'detail',x->>'organization',x->>'native_status',(x->>'status_known')::boolean,true,completed_at::text from jsonb_array_elements(events) x
 on conflict(fcc_id) do update set name=excluded.name,full_name=excluded.full_name,start_at=excluded.start_at,end_at=excluded.end_at,province=excluded.province,city=excluded.city,address=excluded.address,venue=excluded.venue,cover=excluded.cover,source_url=excluded.source_url,detail=excluded.detail,organization=excluded.organization,native_status=excluded.native_status,status_known=excluded.status_known,is_active=true,updated_at=excluded.updated_at;
 get diagnostics upserts=row_count;
 if upserts<>n then raise exception 'FCC_COUNT_MISMATCH'; end if;
 -- The trusted Edge collector independently validates two full nonempty passes.
 -- Hide missing FCC records only after all validation, in this same transaction;
 -- retain their UUID and bigint ID for reappearance. Never touch legacy rows.
 update furry_fcc_simple_private.events e set is_active=false
 where e.is_active and e.fcc_id in (
  (select f.fcc_id from furry_fcc_simple_private.events f where f.is_active)
  except (select (x->>'fcc_id')::uuid from jsonb_array_elements(events) x)
 );
 get diagnostics deactivations=row_count;
 update furry_fcc_simple_private.settings set source='fcc',last_started_at=started_at,last_completed_at=completed_at,last_snapshot_sha256=snapshot_sha,last_deactivated_count=deactivations where singleton;
 return jsonb_build_object('upserted',upserts,'deactivated',deactivations);
end $$;
revoke all on function public.sync_fcc_events(jsonb,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.sync_fcc_events(jsonb,timestamptz,timestamptz,boolean) to service_role;

-- Same input/output shape as current Edge query repository. No raw_json or raw detail.
create function public.read_fcc_event_page(p_criteria jsonb,p_after_id bigint,p_limit integer)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare active_source text;
begin
 if p_limit is null or p_after_id is null or p_limit<1 or p_limit>500 or p_after_id<0 or p_criteria is null or jsonb_typeof(p_criteria)<>'object' then raise exception 'INVALID_QUERY_PAGE'; end if;
 select source into active_source from furry_fcc_simple_private.settings where singleton;
 if active_source='fcc' then
  return (select coalesce(jsonb_agg(jsonb_build_object('id',q.id::text,'source','fcc','source_id','fcc:'||q.fcc_id::text,'name',q.name,'full_name',q.full_name,'start_at',q.start_at,'end_at',q.end_at,'province',q.province,'city',q.city,'address',q.address,'venue',q.venue,'cover',q.cover,'source_url',q.source_url,'detail',null,'organization',q.organization,'native_status',q.native_status,'status_known',q.status_known,'is_active',q.is_active,'updated_at',q.updated_at) order by q.id),'[]'::jsonb)
  from (select e.* from furry_fcc_simple_private.events e where e.id>p_after_id and e.is_active
   and (coalesce(p_criteria->>'city','')='' or exists(select 1 from unnest(array[e.address,e.province,e.city]) v where strpos(lower(v),p_criteria->>'city')>0))
   and (((e.start_at is null or e.start_at='') and coalesce((p_criteria->>'include_undated')::boolean,false)) or (left(e.start_at,10)>=p_criteria->>'start' and (p_criteria->>'end' is null or left(e.start_at,10)<p_criteria->>'end')))
   order by e.id limit p_limit) q);
 elsif active_source='legacy' then
  return (select coalesce(jsonb_agg(jsonb_build_object('id',q.id::text,'source',q.source,'source_id',null,'name',q.name,'full_name',q.full_name,'start_at',q.start_at,'end_at',q.end_at,'province',q.province,'city',q.city,'address',q.address,'venue',q.venue,'cover',null,'source_url',null,'detail',null,'organization',q.organization,'status',q.status,'raw_status',q.raw_status,'source_state_text',q.source_state_text,'is_active',q.is_active,'updated_at',q.updated_at) order by q.id),'[]'::jsonb)
  from (select e.* from public.furry_events e where e.source in ('furfantasia_event_data','legacy') and e.id>p_after_id and (coalesce((p_criteria->>'include_inactive')::boolean,false) or e.is_active)
   and (coalesce(p_criteria->>'city','')='' or exists(select 1 from unnest(array[e.address,e.province,e.city]) v where strpos(lower(v),p_criteria->>'city')>0))
   and (((e.start_at is null or e.start_at='') and coalesce((p_criteria->>'include_undated')::boolean,false)) or (left(e.start_at,10)>=p_criteria->>'start' and (p_criteria->>'end' is null or left(e.start_at,10)<p_criteria->>'end')))
   order by e.id limit p_limit) q);
 end if;
 raise exception 'INVALID_SOURCE_MODE';
end $$;
revoke all on function public.read_fcc_event_page(jsonb,bigint,integer) from public,anon,authenticated;
grant execute on function public.read_fcc_event_page(jsonb,bigint,integer) to service_role;

-- Return all bounded pages from one STABLE SQL statement/snapshot. This avoids
-- mixing sources or sync generations across separate PostgREST requests.
create function public.read_fcc_events(p_criteria jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb:='[]'::jsonb; one_page jsonb; after_id bigint:=0; n integer;
begin
 for i in 0..20 loop
  one_page:=public.read_fcc_event_page(p_criteria,after_id,500);
  n:=jsonb_array_length(one_page);
  result:=result||one_page;
  if jsonb_array_length(result)>10000 then raise exception 'QUERY_LIMIT_EXCEEDED'; end if;
  if n<500 then return result; end if;
  after_id:=(one_page->-1->>'id')::bigint;
 end loop;
 raise exception 'QUERY_LIMIT_EXCEEDED';
end $$;
revoke all on function public.read_fcc_events(jsonb) from public,anon,authenticated;
grant execute on function public.read_fcc_events(jsonb) to service_role;
commit;
