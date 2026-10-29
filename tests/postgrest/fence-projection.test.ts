/** Synthetic containers on an internal Docker network, no production credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
const env={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
function docker(args:string[],input?:string){const r=spawnSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,input,encoding:'utf8'});if(r.status!==0)throw Error(`docker ${args[0]} failed: ${r.stderr.slice(0,500)}`);return r.stdout.trim()}
const sleep=()=>new Promise(r=>setTimeout(r,250));
test('isolated PostgREST JWT roles, v2 HTTP and FCC authorization',async()=>{
 const suffix=String(process.pid),net='fcc-review-net-'+suffix,db='fcc-review-db-'+suffix,rest='fcc-review-rest-'+suffix;
 const secret='isolated-fixture-jwt-secret-not-production-2026';
 function token(role:string){const enc=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');const b=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role,exp:Math.floor(Date.now()/1000)+300});return b+'.'+createHmac('sha256',secret).update(b).digest('base64url')}
 function http(path:string,role?:string,method='GET',body?:unknown){const code=`let v='';for await(const c of process.stdin)v+=c;const x=JSON.parse(v);const r=await fetch(x.url,x.init);console.log(JSON.stringify({status:r.status,body:await r.text()}));`;const init:any={method,headers:{'Content-Type':'application/json'}};if(role)init.headers.Authorization='Bearer '+token(role);if(body!==undefined)init.body=JSON.stringify(body);const x={url:`http://${rest}:3000${path}`,init};return JSON.parse(docker(['run','--rm','-i','--network',net,'node:24-bookworm-slim','node','-e',code],JSON.stringify(x)))}
 try{docker(['network','create','--internal',net]);docker(['run','-d','--name',db,'--network',net,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17']);let ready=false;for(let n=0;n<80;n++){const r=spawnSync('docker',['--host=unix:///var/run/docker.sock','exec',db,'pg_isready','-h','127.0.0.1','-U','postgres'],{env});if(r.status===0){ready=true;break}await sleep()}assert.equal(ready,true);
 const shape=await readFile('tests/db/production-shape.sql','utf8'),draft=await readFile('sql/review/fcc_write_fence_projection.sql','utf8');
 const setup=`create role authenticator login noinherit; grant anon,authenticated,service_role,fcc_review_ingest to authenticator; insert into public.furry_events(id,name,source,status,start_at,city,cover,source_url) values (1,'HTTP fixture','fcc','scheduled','2099-01-01T00:00:00+08:00','A','https://images.furrycons.cn/a.png','https://www.furrycons.cn/event/test'); insert into furry_review_private.reviewed_binding values('11111111-1111-4111-8111-111111111111',1); update furry_review_private.write_gate set state='frozen'; update furry_review_private.write_gate set state='fcc_open';`;
 docker(['exec','-i',db,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],shape+'\n'+draft+'\n'+setup);
 docker(['run','-d','--name',rest,'--network',net,'-e',`PGRST_DB_URI=postgresql://authenticator@${db}:5432/postgres`,'-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,'postgrest/postgrest:v13.0.8']);
 ready=false;for(let n=0;n<12;n++){try{if(http('/').status===200){ready=true;break}}catch{}await sleep()}assert.equal(ready,true);
 for(const role of [undefined,'authenticated']){assert.ok([401,403].includes(http('/furry_events?select=raw_json',role).status));const view=http('/furry_events_public_v2?select=*',role);assert.equal(view.status,200);const rows=JSON.parse(view.body);assert.equal(rows[0].id,'1');assert.equal(rows[0].source_url,'https://www.furrycons.cn/event/test');assert.equal(rows[0].detail,null);const rpc=http('/rpc/get_upcoming_events_v2',role,'POST',{});assert.equal(rpc.status,200);assert.equal(JSON.parse(rpc.body)[0].id,'1');assert.equal(http('/rpc/get_event_cities_v2',role,'POST',{}).status,200);assert.equal(http('/rpc/get_rescheduled_events_v2',role,'POST',{}).status,200);assert.equal(http('/rpc/get_upcoming_events_v2',role,'POST',{p_limit:0}).status,400);}
 const data={p_fcc_id:'11111111-1111-4111-8111-111111111111',p_status:'cancelled'};
 for(const role of [undefined,'authenticated','service_role'])assert.ok([401,403,404].includes(http('/rpc/fcc_review_set_status',role,'POST',data).status));
 assert.equal(http('/rpc/fcc_review_set_status','fcc_review_ingest','POST',data).status,200);
 assert.ok([401,403,404].includes(http('/rpc/fcc_review_set_status','fcc_review_executor','POST',data).status));
 }finally{for(const n of [rest,db])spawnSync('docker',['--host=unix:///var/run/docker.sock','rm','-f',n],{env});spawnSync('docker',['--host=unix:///var/run/docker.sock','network','rm',net],{env})}
});
