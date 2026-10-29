-- ISOLATED REVIEW ONLY. Requires fcc_batch_engine.sql; not a migration.
begin;
-- Each caller opens a version once and must pin it for all pages and detail reads.
create function public.fcc_shadow_open() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',p.run_id,'count',r.snapshot_count,'watermark',p.watermark)
 from furry_review_private.fcc_published p left join furry_review_private.fcc_runs r on r.run_id=p.run_id and r.state='committed' where p.singleton;
$$;
create function public.fcc_shadow_page(p_version uuid,p_after bigint default 0,p_limit integer default 100,p_status text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_version is null or p_after is null or p_after<0 or p_limit is null or p_limit<1 or p_limit>500 or (p_status is not null and p_status not in ('scheduled','cancelled','postponed','rescheduled','movedOnline')) then raise exception 'FCC_INVALID_PAGE' using errcode='22023'; end if;
 if not exists(select 1 from furry_review_private.fcc_runs where run_id=p_version and state='committed') then raise exception 'FCC_VERSION_NOT_COMMITTED' using errcode='22023'; end if;
 return (select jsonb_build_object('version',p_version,'events',coalesce(jsonb_agg(jsonb_build_object(
  'id',q.event_id::text,'fcc_id',q.fcc_id::text,'name',q.event->'name',
  'start_at',q.event->'start_at','end_at',q.event->'end_at','city',q.event->'city',
  'venue',q.event->'venue','organization',q.event->'organization','status',q.event->'native_status',
  'detail',null,
  'cover',case when q.event->>'cover' ~ '^https://images[.]furrycons[.]cn/[^[:space:]<>"'']*$' then q.event->>'cover' else null end,
  'source_url',case when q.event->>'source_url' ~ '^https://(www[.])?furrycons[.]cn/[^[:space:]<>"'']*$' then q.event->>'source_url' else null end
 ) order by q.event_id),'[]'::jsonb)) from (
 select b.event_id,s.fcc_id,s.event from furry_review_private.fcc_stage s
 join furry_review_private.fcc_batch_rows b on b.run_id=s.run_id and b.fcc_id=s.fcc_id
 where s.run_id=p_version and b.event_id>p_after and (p_status is null or s.event->>'native_status'=p_status)
 order by b.event_id limit p_limit) q);
end $$;
create function public.fcc_shadow_detail(p_version uuid,p_id bigint) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if p_version is null or p_id is null or p_id<1 then raise exception 'FCC_INVALID_ID' using errcode='22023'; end if;
 if not exists(select 1 from furry_review_private.fcc_runs where run_id=p_version and state='committed') then raise exception 'FCC_VERSION_NOT_COMMITTED' using errcode='22023'; end if;
 select item into result from jsonb_array_elements(public.fcc_shadow_page(p_version,p_id-1,1,null)->'events') item where (item->>'id')::bigint=p_id;
 return result;
end $$;
alter function public.fcc_shadow_open() owner to fcc_review_executor;
alter function public.fcc_shadow_page(uuid,bigint,integer,text) owner to fcc_review_executor;
alter function public.fcc_shadow_detail(uuid,bigint) owner to fcc_review_executor;
revoke all on function public.fcc_shadow_open(),public.fcc_shadow_page(uuid,bigint,integer,text),public.fcc_shadow_detail(uuid,bigint) from public,anon,authenticated,fcc_review_ingest;
grant execute on function public.fcc_shadow_open(),public.fcc_shadow_page(uuid,bigint,integer,text),public.fcc_shadow_detail(uuid,bigint) to service_role;
commit;
