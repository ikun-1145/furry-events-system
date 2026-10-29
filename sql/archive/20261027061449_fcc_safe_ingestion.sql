-- Incremental migration against the captured production schema. Never replay history.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create schema if not exists furry_private;
revoke all on schema furry_private from public, anon, authenticated;
grant usage on schema furry_private to service_role;
create table furry_private.legacy_archive (
  event_id bigint primary key, row_data jsonb not null, archived_at timestamptz not null default now()
);
insert into furry_private.legacy_archive(event_id,row_data)
select id,to_jsonb(e) from public.furry_events e;
create table furry_private.fcc_identity (
  fcc_id uuid primary key,
  event_id bigint not null unique references public.furry_events(id),
  mapping_kind text not null check(mapping_kind in ('new','reviewed_legacy')),
  created_at timestamptz not null default now()
);
-- Explicit review for genuinely distinct FCC events that collide with legacy name/day.
create table furry_private.fcc_distinct_decisions (
  fcc_id uuid primary key, reason text not null check(length(btrim(reason))>=20)
);
create table furry_private.sync_state (
  singleton boolean primary key default true check(singleton),
  last_started_at timestamptz, last_completed_at timestamptz,
  snapshot_count integer, missing_deactivation_enabled boolean not null default false check(not missing_deactivation_enabled)
);
insert into furry_private.sync_state(singleton) values(true);
create table furry_private.sync_runs (
  started_at timestamptz primary key, completed_at timestamptz not null,
  fetched integer not null, upserted integer not null, deactivated integer not null default 0 check(deactivated=0)
);
alter table furry_private.legacy_archive enable row level security;
alter table furry_private.fcc_identity enable row level security;
alter table furry_private.sync_state enable row level security;
alter table furry_private.fcc_distinct_decisions enable row level security;
alter table furry_private.sync_runs enable row level security;
grant select,insert,update on all tables in schema furry_private to service_role;
revoke all on all tables in schema furry_private from public,anon,authenticated;

-- Identity, not name+date, must distinguish separate FCC events. No rows removed.
alter table public.furry_events drop constraint furry_events_name_start_at_key;
create index furry_events_name_date_idx on public.furry_events(name,start_at);
alter table public.furry_events
  add column native_status text,
  add column status_known boolean,
  add column date_pending boolean not null default false;
-- All old rows and statuses are archived before suppressing retired public URLs.
update public.furry_events set
  cover = case when cover ~* 'furryfusion[.]net' then null else cover end,
  cover_url = case when cover_url ~* 'furryfusion[.]net' then null else cover_url end,
  source_url = case when source_url ~* 'furryfusion[.]net' then null else source_url end,
  source_path = case when source_url ~* 'furryfusion[.]net' then null else source_path end,
  detail = regexp_replace(detail,'https?://[^[:space:]<>"'']*furryfusion[.]net[^[:space:]<>"'']*','[retired link]','gi'),
  raw_json = case when raw_json::text ~* 'furryfusion[.]net' then null else raw_json end;

-- Fence stale writers even if an old deployment is invoked during cutover.
create or replace function public.sync_furry_events(events jsonb,synced_at timestamptz,allow_empty boolean default false)
returns table(upserted bigint,deactivated bigint,active bigint,inactive bigint)
language plpgsql security invoker set search_path='' as $$
begin raise exception 'RETIRED_SOURCE_SYNC_DISABLED'; end;
$$;
revoke all on function public.sync_furry_events(jsonb,timestamptz,boolean) from public,anon,authenticated,service_role;

create function public.sync_fcc_events(events jsonb,started_at timestamptz,completed_at timestamptz,complete boolean)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='5s' as $$
declare
  item jsonb; internal_id bigint; mapped_kind text; n integer; upserts integer:=0;
  last_start timestamptz; required_fields text[] := array[
    'fcc_id','name','full_name','start_at','end_at','province','city','address','venue',
    'cover','source_url','detail','organization','native_status','status_known'];
begin
  -- Serializes all FCC snapshots; transaction rollback releases this lock.
  perform pg_advisory_xact_lock(771284616231::bigint);
  select last_started_at into last_start from furry_private.sync_state where singleton for update;
  if complete is distinct from true or events is null or jsonb_typeof(events)<>'array' then raise exception 'INCOMPLETE_SNAPSHOT'; end if;
  if started_at is null or completed_at is null or completed_at<started_at
     or completed_at>clock_timestamp()+interval '5 minutes' then raise exception 'INVALID_SNAPSHOT_TIME'; end if;
  if last_start is not null and started_at<=last_start then raise exception 'STALE_SNAPSHOT'; end if;
  n:=jsonb_array_length(events);
  if n>10000 then raise exception 'SNAPSHOT_TOO_LARGE'; end if;
  -- Empty FCC inventory must not change legacy data or the last successful watermark.
  if n=0 then return jsonb_build_object('upserted',0,'deactivated',0,'empty',true); end if;
  if exists(select 1 from jsonb_array_elements(events) x group by (x->>'fcc_id')::uuid having count(*)>1) then raise exception 'DUPLICATE_FCC_ID'; end if;
  for item in select value from jsonb_array_elements(events) loop
    if jsonb_typeof(item)<>'object' or not item ?& required_fields then raise exception 'INVALID_EVENT_CONTRACT'; end if;
    if jsonb_typeof(item->'fcc_id')<>'string' or jsonb_typeof(item->'name')<>'string' or nullif(btrim(item->>'name'),'') is null
       or jsonb_typeof(item->'full_name')<>'string' or nullif(btrim(item->>'full_name'),'') is null
       or jsonb_typeof(item->'native_status')<>'string' or nullif(btrim(item->>'native_status'),'') is null
       or jsonb_typeof(item->'status_known')<>'boolean'
       or (item->>'status_known')::boolean is distinct from ((item->>'native_status')=any(array['cancelled','movedOnline','postponed','rescheduled','scheduled']))
       or (item->>'fcc_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then raise exception 'INVALID_EVENT_CONTRACT'; end if;
    if exists(select 1 from jsonb_each(item) kv where kv.key=any(array['province','city','address','venue','cover','source_url','detail','organization','start_at','end_at']) and jsonb_typeof(kv.value) not in ('string','null')) then raise exception 'INVALID_EVENT_CONTRACT'; end if;
    if (item->>'start_at' is not null and item->>'start_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+08:00$')
       or (item->>'end_at' is not null and item->>'end_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+08:00$') then raise exception 'INVALID_EVENT_DATE'; end if;
    perform (item->>'start_at')::timestamptz, (item->>'end_at')::timestamptz;
    if (item->>'end_at')::timestamptz<(item->>'start_at')::timestamptz then raise exception 'INVALID_EVENT_DATE_RANGE'; end if;
    if (item->>'cover' is not null and item->>'cover' !~ '^https://images[.]furrycons[.]cn/')
      or (item->>'source_url' is not null and item->>'source_url' !~ '^https://(www[.])?furrycons[.]cn/')
      or item::text ~* 'https?[^"[:space:]]*furryfusion[.]net' then raise exception 'UNSAFE_PUBLIC_URL'; end if;
    select event_id,mapping_kind into internal_id,mapped_kind from furry_private.fcc_identity where fcc_id=(item->>'fcc_id')::uuid;
    if internal_id is null then
      -- Never guess identity from a duplicate historical source_id or name+date alone.
      if (nullif(btrim(item->>'city'),'') is null or nullif(btrim(item->>'organization'),'') is null
        or exists(select 1 from furry_private.legacy_archive a where
          lower(btrim(a.row_data->>'name'))=lower(btrim(item->>'name'))
          or (length(btrim(a.row_data->>'name'))>=3 and length(btrim(item->>'name'))>=3 and
            (strpos(lower(btrim(a.row_data->>'name')),lower(btrim(item->>'name')))>0
             or strpos(lower(btrim(item->>'name')),lower(btrim(a.row_data->>'name')))>0))
          or (nullif(btrim(a.row_data->>'organization'),'') is not null and lower(btrim(a.row_data->>'organization'))=lower(btrim(item->>'organization')))
          or (nullif(btrim(a.row_data->>'city'),'') is not null and lower(btrim(a.row_data->>'city'))=lower(btrim(item->>'city'))
              and left(a.row_data->>'start_at',10)=left(item->>'start_at',10))))
         and not exists(select 1 from furry_private.fcc_distinct_decisions where fcc_id=(item->>'fcc_id')::uuid)
      then raise exception 'HISTORY_MAPPING_REQUIRED'; end if;
      insert into public.furry_events(source_id,source,name,full_name,start_at,end_at,city,province,address,venue,cover,source_url,detail,organization,
        status,native_status,status_known,date_pending,updated_at,last_seen_at,is_active)
      values('fcc:'||(item->>'fcc_id'),'fcc',item->>'name',item->>'full_name',item->>'start_at',item->>'end_at',item->>'city',item->>'province',
        item->>'address',item->>'venue',item->>'cover',item->>'source_url',item->>'detail',item->>'organization',item->>'native_status',
        item->>'native_status',(item->>'status_known')::boolean,item->>'start_at' is null,completed_at::text,completed_at,true) returning id into internal_id;
      insert into furry_private.fcc_identity(fcc_id,event_id,mapping_kind) values((item->>'fcc_id')::uuid,internal_id,'new');
    else
      update public.furry_events e set
        name=item->>'name',full_name=item->>'full_name',start_at=item->>'start_at',end_at=item->>'end_at',
        city=coalesce(item->>'city',e.city),province=coalesce(item->>'province',e.province),address=coalesce(item->>'address',e.address),
        venue=coalesce(item->>'venue',e.venue),cover=item->>'cover',source_url=item->>'source_url',
        detail=coalesce(item->>'detail',e.detail),organization=coalesce(item->>'organization',e.organization),
        native_status=item->>'native_status',status_known=(item->>'status_known')::boolean,date_pending=item->>'start_at' is null,
        status=case when mapped_kind='new' then item->>'native_status' else e.status end,
        updated_at=completed_at::text,last_seen_at=completed_at
      where id=internal_id;
      -- Deliberately preserve legacy source_id/source and every existing is_active value.
    end if;
    upserts:=upserts+1;
  end loop;
  update furry_private.sync_state set last_started_at=started_at,last_completed_at=completed_at,snapshot_count=n where singleton;
  insert into furry_private.sync_runs values(started_at,completed_at,n,upserts,0);
  return jsonb_build_object('upserted',upserts,'deactivated',0,'empty',false);
end;
$$;
revoke all on function public.sync_fcc_events(jsonb,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.sync_fcc_events(jsonb,timestamptz,timestamptz,boolean) to service_role;
-- Service-only projection: bigint is converted by PostgreSQL, not JS or select casts.
create function public.read_fcc_event_page(p_criteria jsonb,p_after_id bigint,p_limit integer)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if p_limit is null or p_after_id is null or p_limit<1 or p_limit>500 or p_after_id<0 or p_criteria is null or jsonb_typeof(p_criteria)<>'object' then raise exception 'INVALID_QUERY_PAGE'; end if;
 return (select coalesce(jsonb_agg((to_jsonb(q)-'raw_json'-'source_path') || jsonb_build_object('id',q.id::text) order by q.id),'[]'::jsonb)
 from (select e.* from public.furry_events e where e.id>p_after_id
  and e.source in ('fcc','furfantasia_event_data','legacy')
  and (coalesce((p_criteria->>'include_inactive')::boolean,false) or e.is_active)
  and (coalesce(p_criteria->>'city','')='' or exists(select 1 from unnest(array[e.address,e.province,e.city]) v where strpos(lower(v),p_criteria->>'city')>0))
  and (((e.start_at is null or e.start_at='') and coalesce((p_criteria->>'include_undated')::boolean,false))
    or (left(e.start_at,10)>=p_criteria->>'start' and (p_criteria->>'end' is null or left(e.start_at,10)<p_criteria->>'end')))
  order by e.id limit p_limit) q);
end $$;
revoke all on function public.read_fcc_event_page(jsonb,bigint,integer) from public,anon,authenticated;
grant execute on function public.read_fcc_event_page(jsonb,bigint,integer) to service_role;
commit;
