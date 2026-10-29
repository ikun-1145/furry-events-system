// Local temporary PostgreSQL only; no production connection or credentials.
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeFccEvent} from '../../supabase/functions/_shared/fcc_adapter.ts';
import {createSearchHandler,createSyncHandler} from '../../supabase/functions/_shared/handlers.ts';
import {readAtomicRows} from '../../supabase/functions/_shared/query_repository.ts';
import {api,raw} from '../fixtures.ts';
import {assertPostgresSafe} from '../../scripts/fcc-batch-preflight.ts';
let server:EmbeddedPostgres, db:pg.Client,dir:string, events:any[], historical:unknown;
const cfg={host:'127.0.0.1',port:55454,user:'postgres',password:'local-test-only',database:'postgres'};
const t=(s:number)=>`2026-10-27T00:00:${String(s).padStart(2,'0')}Z`;
const all={include_inactive:true,city:'',start:'1900-01-01',end:null,include_undated:true};
async function sync(c:pg.Client,e:any[],sec:number,complete=true){assertPostgresSafe(e);return (await c.query('select public.sync_fcc_events($1::jsonb,$2,$3,$4) v',[JSON.stringify(e),t(sec),t(sec),complete])).rows[0].v}
async function page(c:pg.Client,criteria:any,after:string,limit=500){return (await c.query('select public.read_fcc_event_page($1::jsonb,$2::bigint,$3) v',[JSON.stringify(criteria),after,limit])).rows[0].v}
before(async()=>{
 dir=await mkdtemp(path.join(tmpdir(),'fcc-simple-'));server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:'local-test-only',port:cfg.port,persistent:false,onLog:()=>{},onError:()=>{}});await server.initialise();await server.start();db=new pg.Client(cfg);await db.connect();
 await db.query(await readFile(new URL('./production-shape.sql',import.meta.url),'utf8'));
 const hp=process.env.FCC_SIMPLE_HISTORY_PATH;const old=hp?JSON.parse(await readFile(hp,'utf8')).rows:Array.from({length:32},(_,i)=>({id:String(i+1),name:`历史${i+1}`,start_at:'2026-11-01T00:00:00+08:00',is_active:i<8,source:'furfantasia_event_data'}));
 assert.equal(old.length,32);
 for(const h of old)await db.query('insert into public.furry_events(id,name,start_at,end_at,city,venue,organization,is_active,source,source_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[String(h.id),h.name,h.start_at??null,h.end_at??null,h.city??null,h.venue??null,h.organization??null,h.is_active,h.source,h.source_id??null]);
 await db.query("select setval('public.furry_events_id_seq',(select max(id) from public.furry_events),true)");
 historical=(await db.query('select jsonb_agg(to_jsonb(e) order by e.id) v from public.furry_events e')).rows[0].v;
 const ep=process.env.FCC_SIMPLE_SNAPSHOT_PATH;events=ep?JSON.parse(await readFile(ep,'utf8')):Array.from({length:516},(_,i)=>normalizeFccEvent(raw(i+1,{status:['scheduled','cancelled','postponed','rescheduled'][i%4]})));
 assert.equal(events.length,516);assert.equal(new Set(events.map(x=>x.fcc_id)).size,516);
 await db.query(await readFile(new URL('../../sql/review/fcc_simple_replace.sql',import.meta.url),'utf8'));
});
after(async()=>{await db?.end();await server?.stop();if(dir)await rm(dir,{recursive:true,force:true})});
test('legacy visible before switch; public roles cannot read original or FCC private data',async()=>{
 const old=await page(db,all,'0');assert.equal(old.length,32);assert.ok(old.every((e:any)=>e.detail===null&&e.source_url===null));
 await db.query('set role service_role');try{await assert.rejects(db.query("insert into public.furry_events(name) values ('old cache writer')"),(e:any)=>e.code==='42501');await assert.rejects(db.query("select * from public.sync_furry_events('[]'::jsonb,now(),false)"),(e:any)=>e.code==='42501')}finally{await db.query('reset role')}
 for(const role of ['anon','authenticated']){await db.query(`set session authorization ${role}`);try{await assert.rejects(db.query('select raw_json from public.furry_events'),(e:any)=>e.code==='42501');await assert.rejects(db.query('select * from furry_fcc_simple_private.events'),(e:any)=>e.code==='42501');await assert.rejects(page(db,all,'0'),(e:any)=>e.code==='42501')}finally{await db.query('reset session authorization')}}
});
test('interruption during replacement rolls back both data and query source',async()=>{
 const writer=new pg.Client(cfg);await writer.connect();try{await writer.query('begin');await writer.query('set local role service_role');const r=await sync(writer,events,1);assert.equal(r.upserted,516);assert.equal((await db.query('select source from furry_fcc_simple_private.settings')).rows[0].source,'legacy');assert.equal((await db.query('select count(*) n from furry_fcc_simple_private.events')).rows[0].n,'0');await writer.query('rollback');}finally{await writer.end()}
 assert.equal((await db.query('select source from furry_fcc_simple_private.settings')).rows[0].source,'legacy');assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(e) order by e.id) v from public.furry_events e')).rows[0].v,historical);
});
test('one successful transaction switches all 516 without changing 32 legacy rows',async()=>{
 const reader=new pg.Client(cfg);await reader.connect();try{await reader.query('begin isolation level repeatable read');await reader.query('set local role service_role');assert.equal((await reader.query('select public.read_fcc_events($1::jsonb) v',[JSON.stringify(all)])).rows[0].v.length,32);
 await db.query('set role service_role');try{const r=await sync(db,events,2);assert.equal(r.upserted,516);assert.equal(r.deactivated,0);const first=await page(db,all,'0');assert.equal(first.length,500);const second=await page(db,all,first.at(-1).id);assert.equal(second.length,16);const result=first.concat(second);assert.ok(result.every((x:any)=>x.source==='fcc'&&typeof x.id==='string'&&x.detail===null));assert.equal(new Set(result.map((x:any)=>x.source_id)).size,516);assert.equal(new Set(result.map((x:any)=>x.id)).size,516);}finally{await db.query('reset role')}
 assert.equal((await reader.query('select public.read_fcc_events($1::jsonb) v',[JSON.stringify(all)])).rows[0].v.length,32);await reader.query('commit');
 }finally{await reader.end()}
 assert.equal((await db.query('select source from furry_fcc_simple_private.settings')).rows[0].source,'fcc');assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(e) order by e.id) v from public.furry_events e')).rows[0].v,historical);
});
test('real search handler retains client fields, status labels, safe detail and all pages',async()=>{
 await db.query('set role service_role');try{let count=0;const readRows=(p:any,now:Date)=>readAtomicRows(async c=>{count++;return (await db.query('select public.read_fcc_events($1::jsonb) v',[JSON.stringify(c)])).rows[0].v},p,now);const h=createSearchHandler({readRows,imageEndpoint:'https://example.invalid/functions/v1/furry-event-image',now:()=>new Date('2000-01-01T00:00:00Z')});const res=await h(new Request('https://local.example/functions/v1/furry-event-search',{method:'POST',headers:{Authorization:'Bearer fixture','content-type':'application/json'},body:'{}'}));assert.equal(res.status,200);const body=await res.json();assert.equal(body.events.length,516);assert.equal(count,1);for(const e of body.events){assert.equal(typeof e.id,'string');assert.equal(e.detail,null);assert.equal(typeof e.raw_status,'string');assert.ok(!Object.hasOwn(e,'raw_json'));assert.ok(e.cover.startsWith('https://example.invalid/functions/v1/furry-event-image'));}
 const statuses=new Set(body.events.map((e:any)=>e.native_status));for(const expected of ['scheduled','cancelled','postponed','rescheduled'])assert.ok(statuses.has(expected));assert.equal(body.events.find((e:any)=>e.native_status==='cancelled').raw_status,'已取消');assert.equal(body.events.find((e:any)=>e.native_status==='postponed').raw_status,'已延期');assert.equal(body.events.find((e:any)=>e.native_status==='rescheduled').raw_status,'已改期');
 const linked=body.events.find((e:any)=>e.source_url!==null);assert.ok(linked);assert.equal(linked.detail_available,true);assert.match(linked.source_url,/^https:\/\/(?:www\.)?furrycons\.cn\//);assert.equal(linked.sourceUrl,linked.source_url);assert.equal(linked.coverUrl,linked.cover);assert.equal(typeof linked.startAt,'string');
 }finally{await db.query('reset role')}
});
test('repeated complete snapshot reuses UUID identities and does not alter history',async()=>{
 const ids=(await db.query('select fcc_id,id from furry_fcc_simple_private.events order by fcc_id')).rows;await db.query('set role service_role');try{assert.equal((await sync(db,events,3)).upserted,516);assert.equal((await sync(db,events,3)).upserted,516);await assert.rejects(sync(db,events.map((x,i)=>i===0?{...x,name:x.name+'x'}:x),3),(e:any)=>e.message.includes('STALE_SNAPSHOT'));await assert.rejects(sync(db,events,2),(e:any)=>e.message.includes('STALE_SNAPSHOT'));}finally{await db.query('reset role')};assert.deepEqual((await db.query('select fcc_id,id from furry_fcc_simple_private.events order by fcc_id')).rows,ids);assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(e) order by e.id) v from public.furry_events e')).rows[0].v,historical);
});
test('complete snapshot hides missing FCC UUIDs, replays idempotently, and reactivates the same ID on reappearance',async()=>{
 const original=(await db.query('select id from furry_fcc_simple_private.events where fcc_id=$1',[events[0].fcc_id])).rows[0].id;
 await db.query('set role service_role');try{
  const shrink=events.slice(1);const r=await sync(db,shrink,4);assert.equal(r.upserted,515);assert.equal(r.deactivated,1);
  const retry=await sync(db,shrink,4);assert.deepEqual(retry,r);
  const row=(await db.query('select id,is_active from furry_fcc_simple_private.events where fcc_id=$1',[events[0].fcc_id])).rows[0];assert.equal(row.id,original);assert.equal(row.is_active,false);
  const publicRows=await page(db,all,'0');const second=await page(db,all,publicRows.at(-1).id);assert.equal(publicRows.length+second.length,515);assert.ok(!publicRows.concat(second).some((x:any)=>x.source_id==='fcc:'+events[0].fcc_id));
  const writer=new pg.Client(cfg);await writer.connect();try{await writer.query('begin');await writer.query('set local role service_role');await sync(writer,events,5);assert.equal((await db.query('select is_active from furry_fcc_simple_private.events where fcc_id=$1',[events[0].fcc_id])).rows[0].is_active,false);await writer.query('rollback')}finally{await writer.end()}
  assert.equal((await db.query('select is_active from furry_fcc_simple_private.events where fcc_id=$1',[events[0].fcc_id])).rows[0].is_active,false);
  const restored=await sync(db,events,5);assert.equal(restored.upserted,516);assert.equal(restored.deactivated,0);
  const reappeared=(await db.query('select id,is_active from furry_fcc_simple_private.events where fcc_id=$1',[events[0].fcc_id])).rows[0];assert.equal(reappeared.id,original);assert.equal(reappeared.is_active,true);
 }finally{await db.query('reset role')}
 assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(e) order by e.id) v from public.furry_events e')).rows[0].v,historical);
});
test('bad or incomplete snapshots fail without any partial changes',async()=>{
 const before=(await db.query('select jsonb_agg(to_jsonb(e) order by e.id) v from furry_fcc_simple_private.events e')).rows[0].v;await db.query('set role service_role');try{
 await assert.rejects(sync(db,events,6,false),(e:any)=>e.message.includes('INCOMPLETE_SNAPSHOT'));
 await assert.rejects(sync(db,[],6),(e:any)=>e.message.includes('INVALID_SNAPSHOT_COUNT'));
 await assert.rejects(sync(db,[...events,{...events[0]}],6),(e:any)=>e.message.includes('DUPLICATE_FCC_ID'));
 await assert.rejects(sync(db,events.map((x,i)=>i===1?{...x,source_url:'https://attacker.example/x'}:x),6),(e:any)=>e.message.includes('UNSAFE_EVENT_URL'));
 assert.throws(()=>assertPostgresSafe([{detail:'x\u0000y'}]),/FCC_POSTGRES_NUL/);
 }finally{await db.query('reset role')}
 assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(e) order by e.id) v from furry_fcc_simple_private.events e')).rows[0].v,before);
});
test('different UUIDs with identical name/date remain distinct',async()=>{
 const e1=normalizeFccEvent(raw(901,{name:'同名同日'})),e2=normalizeFccEvent(raw(902,{name:'同名同日'}));await db.query('set role service_role');try{assert.equal((await sync(db,[...events,e1,e2],7)).upserted,518)}finally{await db.query('reset role')};const x=await db.query("select fcc_id,id from furry_fcc_simple_private.events where name='同名同日' order by id");assert.equal(x.rows.length,2);assert.notEqual(x.rows[0].id,x.rows[1].id);
});
test('read rollback to legacy is atomic, preserves FCC and denies public raw access',async()=>{
 await db.query("update furry_fcc_simple_private.settings set source='legacy' where singleton");await db.query('set role service_role');try{const p=await page(db,all,'0');assert.equal(p.length,32);assert.ok(p.every((x:any)=>x.source!=='fcc'&&x.detail===null&&x.source_url===null));const added=[normalizeFccEvent(raw(901,{name:'同名同日'})),normalizeFccEvent(raw(902,{name:'同名同日'}))];await assert.rejects(sync(db,[...events,...added],7),(e:any)=>e.message.includes('STALE_SNAPSHOT'));}finally{await db.query('reset role')};assert.equal((await db.query('select count(*) n from furry_fcc_simple_private.events')).rows[0].n,'518');assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(e) order by e.id) v from public.furry_events e')).rows[0].v,historical);
});
test('network failure in double-pass acquisition never invokes sync',async()=>{
 let calls=0,writes=0;const fake:typeof fetch=async(u,i)=>{calls++;if(calls===2)return new Response('',{status:503});return api(Array.from({length:516},(_,n)=>raw(n+1)),20)(u,i)};const h=createSyncHandler({secret:()=> 'fixture-secret',token:()=> 'fixture-token',fetchImpl:fake,sync:async()=>{writes++;return {upserted:516,deactivated:0}}});const r=await h(new Request('https://local.example',{method:'POST',headers:{Authorization:'Bearer fixture','x-function-secret':'fixture-secret','content-type':'application/json'},body:'{}'}));assert.notEqual(r.status,200);assert.equal(writes,0);assert.equal(calls,2);
});
test('existing Edge sync handler executes a synthetic complete two-pass refresh',async()=>{
 const added=[normalizeFccEvent(raw(901,{name:'同名同日'})),normalizeFccEvent(raw(902,{name:'同名同日'}))];const inventory=[...events,...added];
 const upstream=inventory.map(e=>({id:e.fcc_id,name:e.name,status:e.native_status,startDate:e.start_at,endDate:e.end_at,address:e.address,region:e.city,thumbnail:e.cover,detail:e.detail,url:e.source_url,place:e.venue===null?null:{name:e.venue},organization:e.organization===null?null:{name:e.organization}}));
 let calls=0,writes=0;const source:typeof fetch=async(u,i)=>{calls++;return api(upstream,20)(u,i)};
 await db.query('set role service_role');try{const h=createSyncHandler({secret:()=> 'fixture-secret',token:()=> 'fixture-token',fetchImpl:source,now:()=>new Date(t(8)),sync:async s=>{writes++;assertPostgresSafe(s.events);return (await db.query('select public.sync_fcc_events($1::jsonb,$2,$3,$4) v',[JSON.stringify(s.events),s.started_at,s.completed_at,s.complete])).rows[0].v}});
 const r=await h(new Request('https://local.example',{method:'POST',headers:{Authorization:'Bearer fixture','x-function-secret':'fixture-secret','content-type':'application/json'},body:'{}'}));assert.equal(r.status,200);const body=await r.json();assert.equal(body.fetched,518);assert.equal(body.upserted,518);assert.equal(body.deactivated,0);assert.equal(calls,52);assert.equal(writes,1);assert.equal((await page(db,all,'0')).length,500);
 }finally{await db.query('reset role')}
 assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(e) order by e.id) v from public.furry_events e')).rows[0].v,historical);
});
test('full snapshot fits an enforced eight-second database budget in this isolated environment',async()=>{
 const added=[normalizeFccEvent(raw(901,{name:'同名同日'})),normalizeFccEvent(raw(902,{name:'同名同日'}))];
 await db.query('set role service_role');try{await db.query("set statement_timeout='8s'");const start=performance.now();const result=await sync(db,[...events,...added],9);const elapsed=performance.now()-start;assert.equal(result.upserted,518);assert.ok(elapsed<8000);console.log(`isolated 518-record database round trip ${elapsed.toFixed(1)} ms (not a production estimate)`)}finally{await db.query('reset statement_timeout');await db.query('reset role')}
});
test('a function-local statement_timeout cannot extend an already running RPC statement',async()=>{
 await db.query("create function pg_temp.test_timeout_override() returns void language plpgsql set statement_timeout='3s' as $$ begin perform pg_sleep(0.3); end $$");
 try{
  await db.query("set statement_timeout='100ms'");
  await assert.rejects(db.query('select pg_temp.test_timeout_override()'),(e:any)=>e.code==='57014');
 }finally{await db.query('reset statement_timeout');await db.query('drop function pg_temp.test_timeout_override()')}
});
