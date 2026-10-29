// Fully synthetic database in a disposable Docker --internal network.
// The optional inventory is a local previously collected FCC snapshot, never a DB connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { normalizeFccEvent } from '../../supabase/functions/_shared/fcc_adapter.ts';
import { raw } from '../fixtures.ts';

const env={...process.env};
for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) delete env[k];
function docker(args:string[],input?:Buffer|string):Buffer {
  const r=spawnSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,input,maxBuffer:16*1024*1024});
  // Do not print SQL, encoded inventory, pg_dump contents, or database errors.
  if(r.status!==0) throw Error(`Local Docker ${args[0]} failed`);
  return r.stdout;
}
test('local isolated full-table backup/restore and full-snapshot transaction timing',async()=>{
  const suffix=String(process.pid),net=`fcc-backup-net-${suffix}`,db=`fcc-backup-db-${suffix}`;
  const psql=(database:string,sql:string)=>docker(['exec','-i',db,'psql','-X','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-A','-t'],sql).toString();
  try {
    docker(['network','create','--internal',net]);
    docker(['run','-d','--name',db,'--network',net,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17']);
    let ready=false;
    for(let n=0;n<80;n++){
      const r=spawnSync('docker',['--host=unix:///var/run/docker.sock','exec',db,'pg_isready','-h','127.0.0.1','-U','postgres'],{env});
      if(r.status===0){ready=true;break} await new Promise(r=>setTimeout(r,250));
    }
    assert.equal(ready,true);
    psql('postgres',await readFile('tests/db/production-shape.sql','utf8'));
    const historyPath=process.env.FCC_SIMPLE_COMPLETE_HISTORY_PATH;
    if(historyPath){
      const history=JSON.parse(await readFile(historyPath,'utf8'));
      assert.equal(history.rows.length,32);
      const fields=psql('postgres',"select array_to_json(array_agg(attname order by attname)) from pg_attribute where attrelid='public.furry_events'::regclass and attnum>0 and not attisdropped;").trim();
      assert.deepEqual(Object.keys(history.rows[0]).sort(),JSON.parse(fields));
      const payload=Buffer.from(JSON.stringify(history.rows)).toString('base64');
      psql('postgres',`insert into public.furry_events select * from jsonb_populate_recordset(null::public.furry_events,convert_from(decode('${payload}','base64'),'UTF8')::jsonb);
        select setval('public.furry_events_id_seq',(select greatest(max(id),1) from public.furry_events),true);`);
    }else{
      psql('postgres',`insert into public.furry_events(id,name,start_at,detail,raw_json,city,organization,is_active,source)
        select n,'synthetic history '||n,'2026-11-01T00:00:00+08:00','synthetic detail '||n,jsonb_build_object('synthetic',n),'synthetic city','synthetic organizer',n<=8,'furfantasia_event_data' from generate_series(1,32)n;
        select setval('public.furry_events_id_seq',32,true);`);
    }
    const archive=docker(['exec',db,'pg_dump','-U','postgres','-Fc','postgres']);
    docker(['exec',db,'createdb','-U','postgres','restored']);
    docker(['exec','-i',db,'pg_restore','-U','postgres','-d','restored','--no-owner','--exit-on-error'],archive);
    const inspect=`select count(*),md5(jsonb_agg(to_jsonb(e) order by id)::text) from public.furry_events e;
      select relrowsecurity from pg_class where oid='public.furry_events'::regclass;
      select has_table_privilege('anon','public.furry_events','select'),has_table_privilege('authenticated','public.furry_events','select'),has_table_privilege('service_role','public.furry_events','update');
      select count(*) from pg_policies where schemaname='public' and tablename='furry_events';
      select last_value,is_called from public.furry_events_id_seq;`;
    const before=psql('postgres',inspect); assert.equal(psql('restored',inspect),before);
    assert.match(before,/^32\|/);
    psql('postgres',await readFile('sql/review/fcc_simple_replace.sql','utf8'));
    const path=process.env.FCC_SIMPLE_SNAPSHOT_PATH;
    const events=path?JSON.parse(await readFile(path,'utf8')):Array.from({length:516},(_,i)=>normalizeFccEvent(raw(i+1)));
    assert.equal(events.length,516);assert.equal(new Set(events.map((e:any)=>e.fcc_id)).size,516);
    // Same timestamp format as Date.toISOString() in the Edge collector.
    const started_at='2026-10-28T00:00:00.000Z',completed_at=started_at;
    const request=JSON.stringify({events,started_at,completed_at,complete:true});
    const encoded=Buffer.from(JSON.stringify(events)).toString('base64');
    const sql=`do $x$ declare start_time timestamptz:=clock_timestamp(); result jsonb; begin
      result:=public.sync_fcc_events(convert_from(decode('${encoded}','base64'),'UTF8')::jsonb,'${started_at}'::timestamptz,'${completed_at}'::timestamptz,true);
      if (result->>'upserted')::int<>516 then raise exception 'count mismatch'; end if;
      perform set_config('fcc_rehearsal.elapsed_ms',round((extract(epoch from clock_timestamp()-start_time)*1000)::numeric,2)::text,false);
      end $x$; select current_setting('fcc_rehearsal.elapsed_ms');`;
    const t=Date.now();const timingOutput=psql('postgres',sql);const psqlWallMs=Date.now()-t;
    const sqlMs=Number(timingOutput.trim().split('\n').at(-1));assert.ok(Number.isFinite(sqlMs));
    const check=psql('postgres',"select source,(select count(*) from furry_fcc_simple_private.events),(select count(*) from public.furry_events) from furry_fcc_simple_private.settings where singleton;");
    assert.match(check,/fcc\|516\|32/);
    console.log(JSON.stringify({snapshot_records:516,history_rows:32,history_source:historyPath?'readonly_export':'synthetic',rpc_json_utf8_bytes:Buffer.byteLength(request),pg_dump_archive_bytes:archive.length,local_function_ms:sqlMs,local_psql_wall_ms:psqlWallMs}));
  } finally {
    spawnSync('docker',['--host=unix:///var/run/docker.sock','rm','-f',db],{env});
    spawnSync('docker',['--host=unix:///var/run/docker.sock','network','rm',net],{env});
  }
});
