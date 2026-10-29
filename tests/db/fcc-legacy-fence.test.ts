// Temporary localhost PostgreSQL only; uses synthetic records and no production credentials.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cfg={host:'127.0.0.1',port:55456,user:'postgres',password:'local-test-only',database:'postgres'};
let server:EmbeddedPostgres,dir:string,admin:pg.Client,service:pg.Client,fence:string;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
before(async()=>{
 dir=await mkdtemp(path.join(tmpdir(),'fcc-legacy-fence-'));
 server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:'local-test-only',port:cfg.port,persistent:false,onLog:()=>{},onError:()=>{}});
 await server.initialise();await server.start();
 admin=new pg.Client(cfg);service=new pg.Client(cfg);await admin.connect();await service.connect();
 await admin.query(await readFile(new URL('./production-shape.sql',import.meta.url),'utf8'));
 fence=await readFile(new URL('../../sql/review/fcc_legacy_fence.sql',import.meta.url),'utf8');
 await service.query('set role service_role');
});
after(async()=>{await service?.end();await admin?.end();await server?.stop();if(dir)await rm(dir,{recursive:true,force:true})});

test('aborted freeze transaction restores preexisting legacy write permissions',async()=>{
 const rollbackFence=fence.replace(/commit;\s*$/i,'rollback;');
 assert.notEqual(rollbackFence,fence);
 await admin.query(rollbackFence);
 await service.query("insert into public.furry_events(name) values('before-fence')");
 assert.equal((await service.query("select count(*) n from public.furry_events where name='before-fence'")).rows[0].n,'1');
});

test('freeze drains a running write and denies a competing write queued during revoke',async()=>{
 const inflight=new pg.Client(cfg),queued=new pg.Client(cfg);await inflight.connect();await queued.connect();
 let freezeSettled=false,queuedSettled=false;
 try{
  await inflight.query('begin');await inflight.query('set local role service_role');
  await inflight.query("insert into public.furry_events(name) values('in-flight')");
  const freezing=admin.query(fence).finally(()=>{freezeSettled=true});
  await delay(100);assert.equal(freezeSettled,false,'freeze waits for existing writer');
  await queued.query('set role service_role');
  const queuedWrite=queued.query("insert into public.furry_events(name) values('queued-writer')").then(()=>null,e=>e).finally(()=>{queuedSettled=true});
  await delay(100);assert.equal(queuedSettled,false,'competing writer is queued behind freeze');
  await inflight.query('commit');await freezing;
  const error=await queuedWrite;assert.equal(error?.code,'42501','queued writer is denied after freeze commits');
  await assert.rejects(service.query("insert into public.furry_events(name) values('after-fence')"),(e:any)=>e.code==='42501');
  await assert.rejects(service.query("select * from public.sync_furry_events('[]'::jsonb,now(),false)"),(e:any)=>e.code==='42501');
  assert.equal((await service.query("select count(*) n from public.furry_events where name='in-flight'")).rows[0].n,'1');
  assert.equal((await service.query("select count(*) n from public.furry_events where name='queued-writer'")).rows[0].n,'0');
 }finally{try{await inflight.query('rollback')}catch{}await inflight.end();await queued.end()}
});
