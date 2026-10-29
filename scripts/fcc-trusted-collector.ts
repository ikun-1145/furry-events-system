/** Trusted-only acquisition orchestrator. No API server, no production credentials or output bodies. */
import {createHash,randomUUID} from 'node:crypto';
import {boundedText,fetchFccSnapshot,normalizeFccEvent} from '../supabase/functions/_shared/fcc_adapter.ts';
import {assertPostgresSafe} from './fcc-batch-preflight.ts';
import type {FurryEvent} from '../supabase/functions/_shared/furry_event_contract.ts';
export type PrepareVerified=(args:{runId:string;startedAt:string;batchSize:number;pass1:FurryEvent[];pass2:FurryEvent[]})=>Promise<{uuid_digest:string;snapshot_digest:string;count:number}>;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** The trusted process owns both the FCC token and the collector DB identity.
 * Never expose this callback or fetch override as a caller-controlled endpoint. */
export async function collectAndPrepare(token:string,prepare:PrepareVerified, options:{fetchImpl?:typeof fetch;batchSize?:number}={}) {
 const passes:FurryEvent[][]=[[],[]];const counts=[0,0];const totals:Array<number|null>=[null,null];let pass=0;let next=1;
 const rawFetch=options.fetchImpl??fetch;
 const observed:typeof fetch=async(input,init)=>{
  const u=new URL(input instanceof Request?input.url:String(input));
  if(u.origin!=='https://api.furrycons.cn'||u.pathname!=='/open/event'||(init?.method??'GET')!=='GET')throw Error('FCC_ORIGIN_DENIED');
  const current=Number(u.searchParams.get('current'));if(current===1&&next>1){pass++;next=1}if(pass>1||current!==next)throw Error('FCC_PASS_SEQUENCE');
  const res=await rawFetch(input,init);if(!res.ok)return res;
  const body=await boundedText(res);let d:any;try{d=JSON.parse(body)}catch{throw Error('FCC_INVALID_JSON')}
  if(d.current!==current||d.pageSize!==20||!Number.isSafeInteger(d.total)||d.total<0||!Array.isArray(d.data)||d.info||('success' in d&&d.success!==true)||('error' in d&&d.error!=null))throw Error('FCC_INVALID_PAGE');
  if(totals[pass]!==null&&totals[pass]!==d.total)throw Error('FCC_PAGE_DRIFT');totals[pass]=d.total;
  if(d.data.length!==Math.max(0,Math.min(20,d.total-(current-1)*20)))throw Error('FCC_INCOMPLETE_PAGE');
  for(const e of d.data)passes[pass].push(normalizeFccEvent(e));counts[pass]++;next++;
  return new Response(body,{status:res.status,headers:res.headers});
 };
 const snapshot=await fetchFccSnapshot(token,{fetchImpl:observed});
 if(pass!==1||totals[0]===null||totals[0]!==totals[1]||counts[0]!==snapshot.pages||counts[1]!==snapshot.pages||passes.some(x=>x.length!==totals[0]))throw Error('FCC_COLLECTION_INCOMPLETE');
 const sort=(x:FurryEvent[])=>x.sort((a,b)=>a.fcc_id.localeCompare(b.fcc_id));sort(passes[0]);sort(passes[1]);
 if(JSON.stringify(passes[0])!==JSON.stringify(passes[1]))throw Error('FCC_SNAPSHOT_DRIFT');
 assertPostgresSafe(passes);
 const runId=randomUUID(), uuidDigest=digest(passes[0].map(x=>x.fcc_id).sort().join(','));
 const contentDigest=digest(JSON.stringify(passes[0]));
 const result=await prepare({runId,startedAt:snapshot.started_at,batchSize:options.batchSize??100,pass1:passes[0],pass2:passes[1]});
 if(result.count!==passes[0].length||result.uuid_digest!==uuidDigest)throw Error('FCC_PREPARE_RECEIPT_MISMATCH');
 return {run_id:runId,started_at:snapshot.started_at,completed_at:snapshot.completed_at,passes:2,pages_per_pass:snapshot.pages,total:passes[0].length,uuid_digest:uuidDigest,collector_content_digest:contentDigest,database_content_digest:result.snapshot_digest};
}
