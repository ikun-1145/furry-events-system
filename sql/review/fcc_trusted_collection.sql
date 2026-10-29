-- ISOLATED REVIEW ONLY. Defense-in-depth assertions; never grant collector to app roles.
begin;
revoke execute on function public.fcc_batch_prepare(uuid,timestamptz,integer,jsonb,jsonb) from public,anon,authenticated,service_role,fcc_review_ingest;
grant execute on function public.fcc_batch_prepare(uuid,timestamptz,integer,jsonb,jsonb) to fcc_review_collector;
commit;
