GRANT USAGE ON SCHEMA public TO public;
-- Captured production shape only. Synthetic test data is inserted by tests.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SEQUENCE public.furry_events_id_seq;
CREATE TABLE public.furry_events (
  "id" bigint DEFAULT nextval('furry_events_id_seq'::regclass) NOT NULL,
  "cache_key" text DEFAULT md5((random())::text),
  "cached_at" timestamp with time zone DEFAULT now() NOT NULL,
  "name" text NOT NULL,
  "start_at" text,
  "end_at" text,
  "city" text,
  "venue" text,
  "cover_url" text,
  "source_url" text,
  "weather_date" text,
  "weather_code" integer,
  "temp_max" numeric,
  "temp_min" numeric,
  "precip_mm" numeric,
  "ctrip_url" text,
  "meituan_url" text,
  "raw_json" jsonb,
  "address" text,
  "cover" text,
  "days_text" text,
  "days_until" text,
  "detail" text,
  "organizer" text,
  "quality" text,
  "raw_status" text,
  "status" text,
  "updated_at" text,
  "weather" jsonb,
  "source_id" text,
  "full_name" text,
  "province" text,
  "organization" text,
  "source_state" integer,
  "source_state_text" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_seen_at" timestamp with time zone,
  "source_path" text,
  "source" text DEFAULT 'furfantasia_event_data'::text NOT NULL
);
ALTER TABLE public.furry_events ADD CONSTRAINT "furry_events_name_start_at_key" UNIQUE (name, start_at);
ALTER TABLE public.furry_events ADD CONSTRAINT "furry_events_pkey" PRIMARY KEY (id);
ALTER TABLE public.furry_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read" ON public.furry_events FOR SELECT USING(true);
GRANT SELECT,INSERT,UPDATE ON public.furry_events TO anon,authenticated;
GRANT ALL ON public.furry_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.furry_events_id_seq TO service_role;
CREATE OR REPLACE FUNCTION public.sync_furry_events(events jsonb, synced_at timestamp with time zone, allow_empty boolean DEFAULT false)
 RETURNS TABLE(upserted bigint, deactivated bigint, active bigint, inactive bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  source_name constant text := 'furfantasia_event_data';
  event_count integer;
  current_active bigint;
  upsert_count bigint := 0;
  deactivate_count bigint := 0;
  active_count bigint := 0;
  inactive_count bigint := 0;
begin
  if events is null or jsonb_typeof(events) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'INVALID_EVENTS_PAYLOAD',
      detail = 'events must be a JSON array';
  end if;
  if synced_at is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_SYNCED_AT',
      detail = 'synced_at is required';
  end if;

  event_count := jsonb_array_length(events);

  if exists (
    select 1
    from jsonb_array_elements(events) as item(value)
    where jsonb_typeof(item.value) <> 'object'
  ) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_EVENT_RECORD',
      detail = 'Every event must be a JSON object';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(events) as item(value)
    where not item.value ?& array[
      'source_id', 'name', 'full_name', 'start_at', 'end_at',
      'province', 'city', 'address', 'venue', 'cover', 'status',
      'source_state', 'source_state_text', 'source_url', 'source_path',
      'detail', 'organization', 'updated_at'
    ]
  ) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_EVENT_RECORD',
      detail = 'One or more required contract fields are missing';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(events) as item(value)
    where nullif(btrim(item.value ->> 'source_id'), '') is null
       or nullif(btrim(item.value ->> 'name'), '') is null
       or nullif(btrim(item.value ->> 'full_name'), '') is null
       or nullif(btrim(item.value ->> 'start_at'), '') is null
       or nullif(btrim(item.value ->> 'end_at'), '') is null
       or nullif(btrim(item.value ->> 'updated_at'), '') is null
       or (item.value -> 'source_state' <> 'null'::jsonb
           and jsonb_typeof(item.value -> 'source_state') <> 'number')
       or (item.value -> 'cover' <> 'null'::jsonb
           and coalesce(item.value ->> 'cover', '') !~ '^https?://')
       or (item.value -> 'source_url' <> 'null'::jsonb
           and coalesce(item.value ->> 'source_url', '') !~ '^https?://')
  ) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_EVENT_RECORD',
      detail = 'A required value or URL has an invalid type or format';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(events) as item(name text, start_at text)
    group by item.name, item.start_at
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'DUPLICATE_EVENT_KEY',
      detail = 'Duplicate (name, start_at) values are not allowed';
  end if;

  begin
    perform (item.value ->> 'start_at')::timestamptz,
            (item.value ->> 'end_at')::timestamptz,
            (item.value ->> 'updated_at')::timestamptz
    from jsonb_array_elements(events) as item(value);
  exception when others then
    raise exception using
      errcode = '22007',
      message = 'INVALID_EVENT_DATE',
      detail = 'One or more event timestamps are invalid';
  end;

  if exists (
    select 1
    from jsonb_to_recordset(events) as item(name text, start_at text)
    join public.furry_events existing
      on existing.name = item.name
     and existing.start_at = item.start_at
    where existing.source = 'legacy'
  ) then
    raise exception using
      errcode = '23505',
      message = 'LEGACY_EVENT_KEY_CONFLICT',
      detail = 'A legacy record already uses one of the incoming keys';
  end if;

  select count(*)
  into current_active
  from public.furry_events
  where source = source_name
    and is_active = true;

  if event_count = 0 and current_active > 0 and not allow_empty then
    raise exception using
      errcode = 'P0001',
      message = 'EMPTY_SNAPSHOT_REJECTED',
      detail = 'An empty snapshot cannot deactivate existing active events without allow_empty=true';
  end if;

  insert into public.furry_events (
    source_id,
    name,
    full_name,
    start_at,
    end_at,
    province,
    city,
    address,
    venue,
    cover,
    status,
    source_state,
    source_state_text,
    source_url,
    source_path,
    detail,
    organization,
    updated_at,
    source,
    is_active,
    last_seen_at
  )
  select
    item.source_id,
    item.name,
    item.full_name,
    item.start_at,
    item.end_at,
    item.province,
    item.city,
    item.address,
    item.venue,
    item.cover,
    item.status,
    item.source_state,
    item.source_state_text,
    item.source_url,
    item.source_path,
    item.detail,
    item.organization,
    item.updated_at,
    source_name,
    true,
    synced_at
  from jsonb_to_recordset(events) as item(
    source_id text,
    name text,
    full_name text,
    start_at text,
    end_at text,
    province text,
    city text,
    address text,
    venue text,
    cover text,
    status text,
    source_state integer,
    source_state_text text,
    source_url text,
    source_path text,
    detail text,
    organization text,
    updated_at text
  )
  on conflict (name, start_at) do update
  set source_id = excluded.source_id,
      full_name = excluded.full_name,
      end_at = excluded.end_at,
      province = excluded.province,
      city = excluded.city,
      address = excluded.address,
      venue = excluded.venue,
      cover = excluded.cover,
      status = excluded.status,
      source_state = excluded.source_state,
      source_state_text = excluded.source_state_text,
      source_url = excluded.source_url,
      source_path = excluded.source_path,
      detail = excluded.detail,
      organization = excluded.organization,
      updated_at = excluded.updated_at,
      source = source_name,
      is_active = true,
      last_seen_at = synced_at
  where public.furry_events.source = source_name;

  get diagnostics upsert_count = row_count;

  if upsert_count <> event_count then
    raise exception using
      errcode = 'P0001',
      message = 'SYNC_COUNT_MISMATCH',
      detail = format('Expected %s upserts but completed %s', event_count, upsert_count);
  end if;

  update public.furry_events existing
  set is_active = false
  where existing.source = source_name
    and existing.is_active = true
    and not exists (
      select 1
      from jsonb_to_recordset(events) as item(name text, start_at text)
      where item.name = existing.name
        and item.start_at = existing.start_at
    );

  get diagnostics deactivate_count = row_count;

  select count(*) filter (where is_active),
         count(*) filter (where not is_active)
  into active_count, inactive_count
  from public.furry_events
  where source = source_name;

  return query
  select upsert_count, deactivate_count, active_count, inactive_count;
end;
$function$
;
REVOKE ALL ON FUNCTION public.sync_furry_events(jsonb,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_furry_events(jsonb,timestamptz,boolean) TO service_role;
