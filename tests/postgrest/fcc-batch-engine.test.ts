/** Synthetic containers on an internal Docker network, no production credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
const env={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
function docker(args:string[],input?:string){const r=spawnSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,input,encoding:'utf8'});if(r.status!==0)throw Error(`docker ${args[0]} failed: ${r.stderr.slice(0,500)}`);return r.stdout.trim()}
const sleep=()=>new Promise(r=>setTimeout(r,250));
test('isolated PostgREST batch prepare, preview, commit and authorization',async()=>{
 const suffix=String(process.pid),net='fcc-review-net-'+suffix,db='fcc-review-db-'+suffix,rest='fcc-review-rest-'+suffix;
 const secret='isolated-fixture-jwt-secret-not-production-2026';
 function token(role:string){const enc=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');const b=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role,exp:Math.floor(Date.now()/1000)+300});return b+'.'+createHmac('sha256',secret).update(b).digest('base64url')}
 function http(path:string,role?:string,method='GET',body?:unknown){const code=`let v='';for await(const c of process.stdin)v+=c;const x=JSON.parse(v);const r=await fetch(x.url,x.init);console.log(JSON.stringify({status:r.status,body:await r.text()}));`;const init:any={method,headers:{'Content-Type':'application/json'}};if(role)init.headers.Authorization='Bearer '+token(role);if(body!==undefined)init.body=JSON.stringify(body);const x={url:`http://${rest}:3000${path}`,init};return JSON.parse(docker(['run','--rm','-i','--network',net,'node:24-bookworm-slim','node','-e',code],JSON.stringify(x)))}
 try{docker(['network','create','--internal',net]);docker(['run','-d','--name',db,'--network',net,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17']);let ready=false;for(let n=0;n<80;n++){const r=spawnSync('docker',['--host=unix:///var/run/docker.sock','exec',db,'pg_isready','-h','127.0.0.1','-U','postgres'],{env});if(r.status===0){ready=true;break}await sleep()}assert.equal(ready,true);
 const shape=await readFile('tests/db/production-shape.sql','utf8'),draft=await readFile('sql/review/fcc_write_fence_projection.sql','utf8'),engine=await readFile('sql/review/fcc_batch_engine.sql','utf8'),trusted=await readFile('sql/review/fcc_trusted_collection.sql','utf8'),query=await readFile('sql/review/fcc_shadow_query.sql','utf8');
 const setup=`create role authenticator login noinherit; grant anon,authenticated,service_role,fcc_review_ingest,fcc_review_collector to authenticator; insert into public.furry_events(id,name,source,status,start_at,city,cover,source_url) values (1,'HTTP fixture','fcc','scheduled','2099-01-01T00:00:00+08:00','A','https://images.furrycons.cn/a.png','https://www.furrycons.cn/event/test'); insert into furry_review_private.reviewed_binding values('11111111-1111-4111-8111-111111111111',1); update furry_review_private.write_gate set state='frozen'; update furry_review_private.write_gate set state='fcc_open';`;
 docker(['exec','-i',db,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],shape+'\n'+draft+'\n'+engine+'\n'+trusted+'\n'+query+'\n'+setup+"\nselect setval('public.furry_events_id_seq',1,true); insert into furry_review_private.fcc_distinct_review values('22222222-2222-4222-8222-222222222222','Approved distinct synthetic test event');");
 docker(['run','-d','--name',rest,'--network',net,'-e',`PGRST_DB_URI=postgresql://authenticator@${db}:5432/postgres`,'-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,'postgrest/postgrest:v13.0.8']);
 ready=false;for(let n=0;n<12;n++){try{if(http('/').status===200){ready=true;break}}catch{}await sleep()}assert.equal(ready,true);
 const event={fcc_id:'22222222-2222-4222-8222-222222222222',name:'HTTP test',full_name:'HTTP test',start_at:'2099-01-01T00:00:00+08:00',end_at:null,province:null,city:'A',address:null,venue:null,cover:null,source_url:null,detail:'',organization:null,native_status:'scheduled',status_known:true};
 const run='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';const params={p_run:run,p_started:'2026-10-27T00:00:00Z',p_batch_size:1,p_pass1:[event],p_pass2:[event]};
 for(const role of [undefined,'authenticated','service_role','fcc_review_ingest'])assert.ok([401,403,404].includes(http('/rpc/fcc_batch_prepare',role,'POST',params).status));
 const p=http('/rpc/fcc_batch_prepare','fcc_review_collector','POST',params);assert.equal(p.status,200);const digest=JSON.parse(p.body).uuid_digest;
 const preview=http('/rpc/fcc_batch_preview','fcc_review_ingest','POST',{p_run:run});assert.equal(preview.status,200);assert.equal(JSON.parse(preview.body).new,1);
 const part=http('/rpc/fcc_batch_process','fcc_review_ingest','POST',{p_run:run,p_batch:1});assert.equal(part.status,200);
 const again=http('/rpc/fcc_batch_process','fcc_review_ingest','POST',{p_run:run,p_batch:1});assert.equal(JSON.parse(again.body).replayed,true);
 const commit=http('/rpc/fcc_batch_commit','fcc_review_ingest','POST',{p_run:run,p_uuid_digest:digest});assert.equal(commit.status,200);assert.equal(JSON.parse(commit.body).deactivated,0);
 const view=http('/rpc/fcc_batch_read_published','service_role','POST',{});assert.equal(view.status,200);assert.equal(JSON.parse(view.body)[0].id,'2');assert.equal(JSON.parse(view.body)[0].detail,null);
 assert.ok([401,403,404].includes(http('/rpc/fcc_batch_read_published','authenticated','POST',{}).status));
 const opened=http('/rpc/fcc_shadow_open','service_role','POST',{});assert.equal(JSON.parse(opened.body).version,run);const paged=http('/rpc/fcc_shadow_page','service_role','POST',{p_version:run});assert.equal(paged.status,200);assert.equal(JSON.parse(paged.body).events[0].id,'2');const detail=http('/rpc/fcc_shadow_detail','service_role','POST',{p_version:run,p_id:2});assert.equal(detail.status,200);assert.equal(JSON.parse(detail.body).detail,null);assert.ok([401,403,404].includes(http('/rpc/fcc_shadow_open','authenticated','POST',{}).status));
 }finally{for(const n of [rest,db])spawnSync('docker',['--host=unix:///var/run/docker.sock','rm','-f',n],{env});spawnSync('docker',['--host=unix:///var/run/docker.sock','network','rm',net],{env})}
});
