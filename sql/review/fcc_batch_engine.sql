-- ISOLATED REVIEW PROTOTYPE. Not a migration, not production compatible.
-- Requires fcc_write_fence_projection.sql in a fresh isolated database.
begin;
create role fcc_review_operator nologin noinherit;
create role fcc_review_collector nologin noinherit;
create table furry_review_private.fcc_runs (
 run_id uuid primary key, started_at timestamptz not null,
 snapshot_count integer not null check(snapshot_count>0 and snapshot_count<=10000),
 batch_size integer not null check(batch_size between 1 and 500),
 uuid_digest text not null, snapshot_digest text not null,
 state text not null check(state in ('prepared','processing','committed','aborted')),
 created_at timestamptz not null default now(), committed_at timestamptz
);
create unique index fcc_one_unfinished_run on furry_review_private.fcc_runs ((true)) where state in ('prepared','processing');
create table furry_review_private.fcc_stage (
 run_id uuid not null references furry_review_private.fcc_runs(run_id),
 fcc_id uuid not null, batch_no integer not null, event jsonb not null,
 primary key(run_id,fcc_id)
);
create table furry_review_private.fcc_identity_shadow (
 fcc_id uuid primary key, event_id bigint not null unique
);
-- Only explicit reviewed distinct decisions. No automatic history bindings.
create table furry_review_private.fcc_distinct_review (
 fcc_id uuid primary key, reason text not null check(length(trim(reason))>=20)
);
create table furry_review_private.fcc_batch_rows (
 run_id uuid not null, fcc_id uuid not null, event_id bigint not null,
 primary key(run_id,fcc_id), foreign key(run_id,fcc_id) references furry_review_private.fcc_stage(run_id,fcc_id)
);
create table furry_review_private.fcc_batch_receipts (
 run_id uuid not null references furry_review_private.fcc_runs(run_id),batch_no integer not null,
 row_count integer not null, primary key(run_id,batch_no)
);
create table furry_review_private.fcc_published (
 singleton boolean primary key default true check(singleton),run_id uuid references furry_review_private.fcc_runs(run_id),watermark timestamptz
);
insert into furry_review_private.fcc_published(singleton) values(true);
create table furry_review_private.fcc_restore_audit (
 prior_run uuid, restored_run uuid not null, restored_at timestamptz not null default clock_timestamp()
);
revoke all on furry_review_private.fcc_runs,furry_review_private.fcc_stage,furry_review_private.fcc_identity_shadow,furry_review_private.fcc_distinct_review,furry_review_private.fcc_batch_rows,furry_review_private.fcc_batch_receipts,furry_review_private.fcc_published from public,anon,authenticated,service_role,fcc_review_ingest,fcc_review_executor;
grant select,insert,update on furry_review_private.fcc_runs,furry_review_private.fcc_stage,furry_review_private.fcc_identity_shadow,furry_review_private.fcc_batch_rows,furry_review_private.fcc_batch_receipts,furry_review_private.fcc_published to fcc_review_executor;
revoke update on furry_review_private.fcc_stage from fcc_review_executor;
create function furry_review_private.reject_stage_mutation() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'FCC_IMMUTABLE_STAGE' using errcode='55000'; end $$;
create trigger fcc_stage_immutable before update or delete on furry_review_private.fcc_stage
for each statement execute function furry_review_private.reject_stage_mutation();
revoke all on furry_review_private.fcc_restore_audit from public,anon,authenticated,service_role,fcc_review_ingest,fcc_review_operator;
grant insert on furry_review_private.fcc_restore_audit to fcc_review_executor;
grant select on furry_review_private.fcc_distinct_review to fcc_review_executor;
grant usage,select on sequence public.furry_events_id_seq to fcc_review_executor;

-- Server validates normalized arrays and compares both passes independent of order.
-- Only trusted acquisition can attest both came from complete FCC pagination.
create function public.fcc_batch_prepare(p_run uuid,p_started timestamptz,p_batch_size integer,p_pass1 jsonb,p_pass2 jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a jsonb; b jsonb; n int; ud text; sd text; oldrow furry_review_private.fcc_runs%rowtype; wm timestamptz; prev uuid; missing int;
begin
 perform furry_review_private.check_write(current_user);
 if p_run is null or p_started is null or p_started>clock_timestamp()+interval '5 minutes' or p_batch_size is null or p_batch_size not between 1 and 500 or jsonb_typeof(p_pass1) is distinct from 'array' or jsonb_typeof(p_pass2) is distinct from 'array' then raise exception 'FCC_PREPARE_INVALID' using errcode='22023'; end if;
 n:=jsonb_array_length(p_pass1); if n=0 or n>10000 or n<>jsonb_array_length(p_pass2) then raise exception 'FCC_SNAPSHOT_COUNT' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_pass1) x where jsonb_typeof(x)<>'object' or not x ?& array['fcc_id','name','full_name','start_at','end_at','province','city','address','venue','cover','source_url','detail','organization','native_status','status_known'] or jsonb_typeof(x->'fcc_id')<>'string' or (x->>'fcc_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or jsonb_typeof(x->'name')<>'string' or coalesce(trim(x->>'name'),'')='' or jsonb_typeof(x->'full_name')<>'string' or jsonb_typeof(x->'native_status')<>'string' or (x->>'native_status') not in ('scheduled','cancelled','postponed','rescheduled','movedOnline') or jsonb_typeof(x->'status_known')<>'boolean' or (x->>'status_known')::boolean is distinct from true or exists(select 1 from jsonb_each(x) kv where kv.key=any(array['start_at','end_at','province','city','address','venue','cover','source_url','detail','organization']) and jsonb_typeof(kv.value) not in ('null','string'))) then raise exception 'FCC_INVALID_EVENT' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_pass1) x group by lower(x->>'fcc_id') having count(*)>1) or exists(select 1 from jsonb_array_elements(p_pass2) x group by lower(x->>'fcc_id') having count(*)>1) then raise exception 'FCC_DUPLICATE_UUID' using errcode='22023'; end if;
 select jsonb_agg(x order by lower(x->>'fcc_id')) into a from jsonb_array_elements(p_pass1) x;
 select jsonb_agg(x order by lower(x->>'fcc_id')) into b from jsonb_array_elements(p_pass2) x;
 if a is distinct from b then raise exception 'FCC_PASS_DRIFT' using errcode='22023'; end if;
 select encode(sha256(convert_to(string_agg(lower(x->>'fcc_id'),',' order by lower(x->>'fcc_id')),'UTF8')),'hex') into ud from jsonb_array_elements(a) x;
 sd:=encode(sha256(convert_to(a::text,'UTF8')),'hex');
 select * into oldrow from furry_review_private.fcc_runs where run_id=p_run;
 if found then
  if oldrow.snapshot_digest<>sd or oldrow.uuid_digest<>ud or oldrow.started_at<>p_started or oldrow.batch_size<>p_batch_size then raise exception 'FCC_RUN_CONFLICT' using errcode='22023'; end if;
  return jsonb_build_object('run_id',p_run,'state',oldrow.state,'count',oldrow.snapshot_count,'uuid_digest',ud);
 end if;
 select watermark,run_id into wm,prev from furry_review_private.fcc_published where singleton for update;
 if wm is not null and p_started<=wm then raise exception 'FCC_STALE_RUN' using errcode='22023'; end if;
 if exists(select 1 from furry_review_private.fcc_runs where state in ('prepared','processing')) then raise exception 'FCC_RUN_IN_PROGRESS' using errcode='55000'; end if;
 select count(*) into missing from furry_review_private.fcc_stage s where s.run_id=prev and not exists(select 1 from jsonb_array_elements(a) x where (x->>'fcc_id')::uuid=s.fcc_id);
 if missing>0 then raise exception 'FCC_MISSING_REQUIRES_REVIEW' using errcode='22023'; end if;
 insert into furry_review_private.fcc_runs(run_id,started_at,snapshot_count,batch_size,uuid_digest,snapshot_digest,state) values(p_run,p_started,n,p_batch_size,ud,sd,'prepared');
 insert into furry_review_private.fcc_stage(run_id,fcc_id,batch_no,event)
 select p_run,(x->>'fcc_id')::uuid,((row_number() over(order by lower(x->>'fcc_id'))-1)/p_batch_size)::integer+1,x from jsonb_array_elements(a) x;
 return jsonb_build_object('run_id',p_run,'state','prepared','count',n,'uuid_digest',ud,'snapshot_digest',sd);
end $$;

create function public.fcc_batch_preview(p_run uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r furry_review_private.fcc_runs%rowtype; prev uuid; added int; changed int; same int; missing_review int;
begin
 perform furry_review_private.check_write(current_user);
 select * into r from furry_review_private.fcc_runs where run_id=p_run;
 if not found then raise exception 'FCC_RUN_UNKNOWN' using errcode='22023'; end if;
 select run_id into prev from furry_review_private.fcc_published where singleton;
 select count(*) filter(where prior.fcc_id is null),count(*) filter(where prior.fcc_id is not null and prior.event is distinct from s.event),count(*) filter(where prior.fcc_id is not null and prior.event=s.event),count(*) filter(where prior.fcc_id is null and d.fcc_id is null)
 into added,changed,same,missing_review from furry_review_private.fcc_stage s left join furry_review_private.fcc_stage prior on prior.run_id=prev and prior.fcc_id=s.fcc_id left join furry_review_private.fcc_distinct_review d on d.fcc_id=s.fcc_id where s.run_id=p_run;
 return jsonb_build_object('run_id',p_run,'state',r.state,'new',added,'update',changed,'retain',same,'deactivate',0,'unreviewed_new',missing_review,'history_touched',0);
end $$;

create function public.fcc_batch_process(p_run uuid,p_batch integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r furry_review_private.fcc_runs%rowtype; rec record; chosen bigint; n int:=0; receipt integer;
begin
 perform furry_review_private.check_write(current_user);
 select * into r from furry_review_private.fcc_runs where run_id=p_run for update;
 if not found then raise exception 'FCC_RUN_UNKNOWN' using errcode='22023'; end if;
 if r.state not in ('prepared','processing','committed') then raise exception 'FCC_RUN_NOT_WRITABLE' using errcode='55000'; end if;
 if p_batch is null or p_batch<1 or p_batch>ceil(r.snapshot_count::numeric/r.batch_size)::int then raise exception 'FCC_BATCH_INVALID' using errcode='22023'; end if;
 select row_count into receipt from furry_review_private.fcc_batch_receipts where run_id=p_run and batch_no=p_batch;
 if found then return jsonb_build_object('batch',p_batch,'processed',receipt,'replayed',true); end if;
 if r.state='committed' then raise exception 'FCC_RUN_NOT_WRITABLE' using errcode='55000'; end if;
 for rec in select * from furry_review_private.fcc_stage where run_id=p_run and batch_no=p_batch order by fcc_id loop
  select event_id into chosen from furry_review_private.fcc_identity_shadow where fcc_id=rec.fcc_id;
  if chosen is null then
   if not exists(select 1 from furry_review_private.fcc_distinct_review where fcc_id=rec.fcc_id) then raise exception 'FCC_REVIEW_REQUIRED' using errcode='22023'; end if;
   chosen:=nextval('public.furry_events_id_seq'::regclass);
   if exists(select 1 from public.furry_events where id=chosen) then raise exception 'FCC_ID_SEQUENCE_COLLISION' using errcode='23505'; end if;
   insert into furry_review_private.fcc_identity_shadow values(rec.fcc_id,chosen);
  end if;
  insert into furry_review_private.fcc_batch_rows values(p_run,rec.fcc_id,chosen); n:=n+1;
 end loop;
 if n=0 then raise exception 'FCC_BATCH_EMPTY' using errcode='22023'; end if;
 insert into furry_review_private.fcc_batch_receipts values(p_run,p_batch,n);
 update furry_review_private.fcc_runs set state='processing' where run_id=p_run;
 return jsonb_build_object('batch',p_batch,'processed',n,'replayed',false);
end $$;

create function public.fcc_batch_commit(p_run uuid,p_uuid_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r furry_review_private.fcc_runs%rowtype; n integer; batches integer; stage_digest text; content_digest text; wm timestamptz;
begin
 perform furry_review_private.check_write(current_user);
 select * into r from furry_review_private.fcc_runs where run_id=p_run for update;
 if not found then raise exception 'FCC_RUN_UNKNOWN' using errcode='22023'; end if;
 if p_uuid_digest is distinct from r.uuid_digest then raise exception 'FCC_UUID_DIGEST_MISMATCH' using errcode='22023'; end if;
 if r.state='committed' then return jsonb_build_object('run_id',p_run,'state','committed','replayed',true); end if;
 if r.state not in ('prepared','processing') then raise exception 'FCC_RUN_NOT_WRITABLE' using errcode='55000'; end if;
 select count(*) into n from furry_review_private.fcc_batch_rows where run_id=p_run;
 select count(*) into batches from furry_review_private.fcc_batch_receipts where run_id=p_run;
 select encode(sha256(convert_to(string_agg(fcc_id::text,',' order by fcc_id::text),'UTF8')),'hex') into stage_digest from furry_review_private.fcc_stage where run_id=p_run;
 select encode(sha256(convert_to(jsonb_agg(event order by fcc_id::text)::text,'UTF8')),'hex') into content_digest from furry_review_private.fcc_stage where run_id=p_run;
 if n<>r.snapshot_count or batches<>ceil(r.snapshot_count::numeric/r.batch_size)::int or stage_digest is distinct from r.uuid_digest or content_digest is distinct from r.snapshot_digest or exists(select 1 from furry_review_private.fcc_stage s left join furry_review_private.fcc_batch_rows x using(run_id,fcc_id) where s.run_id=p_run and x.fcc_id is null) or exists(select 1 from furry_review_private.fcc_batch_rows x join furry_review_private.fcc_identity_shadow i using(fcc_id) where x.run_id=p_run and x.event_id<>i.event_id) or exists(select 1 from furry_review_private.fcc_batch_receipts t where t.run_id=p_run and t.row_count<>(select count(*) from furry_review_private.fcc_batch_rows x join furry_review_private.fcc_stage s using(run_id,fcc_id) where x.run_id=t.run_id and s.batch_no=t.batch_no)) then raise exception 'FCC_INCOMPLETE_BATCHES' using errcode='22023'; end if;
 select watermark into wm from furry_review_private.fcc_published where singleton for update;
 if wm is not null and r.started_at<=wm then raise exception 'FCC_STALE_RUN' using errcode='22023'; end if;
 update furry_review_private.fcc_runs set state='committed',committed_at=clock_timestamp() where run_id=p_run;
 update furry_review_private.fcc_published set run_id=p_run,watermark=r.started_at where singleton;
 return jsonb_build_object('run_id',p_run,'state','committed','count',n,'deactivated',0,'replayed',false);
end $$;
create function public.fcc_batch_abort(p_run uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform furry_review_private.check_write(current_user);
 update furry_review_private.fcc_runs set state='aborted' where run_id=p_run and state in ('prepared','processing');
 if not found then raise exception 'FCC_RUN_NOT_ABORTABLE' using errcode='22023'; end if;
end $$;
-- Restore only a previously committed shadow version; watermark never moves backwards.
create function furry_review_private.check_frozen() returns void
language plpgsql security definer set search_path='' as $$
declare gate text;
begin
 select state into gate from furry_review_private.write_gate where singleton for share;
 if gate is distinct from 'frozen' then raise exception 'FCC_RESTORE_REQUIRES_FROZEN' using errcode='55000'; end if;
end $$;
revoke all on function furry_review_private.check_frozen() from public,anon,authenticated,service_role,fcc_review_ingest,fcc_review_operator;
grant execute on function furry_review_private.check_frozen() to fcc_review_executor;
create function public.fcc_batch_restore(p_target uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous uuid;
begin
 perform furry_review_private.check_frozen();
 if not exists(select 1 from furry_review_private.fcc_runs where run_id=p_target and state='committed') then raise exception 'FCC_RESTORE_TARGET_INVALID' using errcode='22023'; end if;
 select run_id into previous from furry_review_private.fcc_published where singleton for update;
 if previous is distinct from p_target then
  update furry_review_private.fcc_published set run_id=p_target where singleton;
  insert into furry_review_private.fcc_restore_audit(prior_run,restored_run) values(previous,p_target);
 end if;
 return jsonb_build_object('run_id',p_target,'replayed',previous is not distinct from p_target);
end $$;
-- Safe service-only committed projection. Never emits the raw event/detail.
-- Existing public query functions are NOT automatically switched to this source.
create function public.fcc_batch_read_published(p_after bigint default 0,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_after is null or p_after<0 or p_limit is null or p_limit<1 or p_limit>500 then raise exception 'FCC_INVALID_PAGE' using errcode='22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object(
  'id',q.event_id::text,'fcc_id',q.fcc_id::text,'name',q.event->'name',
  'start_at',q.event->'start_at','end_at',q.event->'end_at','city',q.event->'city',
  'venue',q.event->'venue','organization',q.event->'organization','status',q.event->'native_status',
  'detail',null,
  'cover',case when q.event->>'cover' ~ '^https://images[.]furrycons[.]cn/[^[:space:]<>"'']*$' then q.event->>'cover' else null end,
  'source_url',case when q.event->>'source_url' ~ '^https://(www[.])?furrycons[.]cn/[^[:space:]<>"'']*$' then q.event->>'source_url' else null end
 ) order by q.event_id),'[]'::jsonb) from (
  select b.event_id,s.fcc_id,s.event from furry_review_private.fcc_published p
  join furry_review_private.fcc_stage s on s.run_id=p.run_id
  join furry_review_private.fcc_batch_rows b on b.run_id=s.run_id and b.fcc_id=s.fcc_id
  where p.singleton and b.event_id>p_after order by b.event_id limit p_limit
 ) q);
end $$;
alter function public.fcc_batch_prepare(uuid,timestamptz,integer,jsonb,jsonb) owner to fcc_review_executor;
alter function public.fcc_batch_preview(uuid) owner to fcc_review_executor;
alter function public.fcc_batch_process(uuid,integer) owner to fcc_review_executor;
alter function public.fcc_batch_commit(uuid,text) owner to fcc_review_executor;
alter function public.fcc_batch_abort(uuid) owner to fcc_review_executor;
alter function public.fcc_batch_restore(uuid) owner to fcc_review_executor;
alter function public.fcc_batch_read_published(bigint,integer) owner to fcc_review_executor;
revoke all on function public.fcc_batch_prepare(uuid,timestamptz,integer,jsonb,jsonb),public.fcc_batch_preview(uuid),public.fcc_batch_process(uuid,integer),public.fcc_batch_commit(uuid,text),public.fcc_batch_abort(uuid) from public,anon,authenticated,service_role;
grant execute on function public.fcc_batch_preview(uuid),public.fcc_batch_process(uuid,integer),public.fcc_batch_commit(uuid,text),public.fcc_batch_abort(uuid) to fcc_review_ingest;
grant execute on function public.fcc_batch_prepare(uuid,timestamptz,integer,jsonb,jsonb) to fcc_review_collector;
revoke all on function public.fcc_batch_read_published(bigint,integer) from public,anon,authenticated,fcc_review_ingest;
grant execute on function public.fcc_batch_read_published(bigint,integer) to service_role;
revoke all on function public.fcc_batch_restore(uuid) from public,anon,authenticated,service_role,fcc_review_ingest;
grant execute on function public.fcc_batch_restore(uuid) to fcc_review_operator;
commit;
