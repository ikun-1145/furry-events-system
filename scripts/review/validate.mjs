import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
export function validateReview(evidenceText,review){
 const hash=createHash('sha256').update(evidenceText).digest('hex'),evidence=JSON.parse(evidenceText);const errors=[];
 if(!review||review.schema!=='fcc-review-decisions-v1'||review.evidence_id!==hash||review.snapshot_time!==evidence.snapshot_time||!Array.isArray(review.decisions))return {valid:false,errors:['INVALID_SCHEMA_OR_SNAPSHOT']};
 const expected=new Map(evidence.rows.map(x=>[String(x.id),x]));const seen=new Set(),selected=new Set();
 for(const d of review.decisions){if(!d||typeof d.historical_id!=='string'||!/^\d+$/.test(d.historical_id)){errors.push('INVALID_HISTORY_ID_TYPE');continue}const id=d.historical_id;const old=expected.get(id);if(!old||seen.has(id)){errors.push(`INVALID_OR_DUPLICATE_HISTORY:${id}`);continue}seen.add(id);
 if(!['pending','link','keep_legacy'].includes(d.decision)){errors.push(`INVALID_DECISION:${id}`);continue}
 if(d.decision==='link'){if(typeof d.fcc_id!=='string'||!old.candidates.some(x=>x.fcc_id===d.fcc_id))errors.push(`INVALID_CANDIDATE:${id}`);else if(selected.has(d.fcc_id))errors.push(`DUPLICATE_FCC_BINDING:${id}`);else selected.add(d.fcc_id)}else if(d.fcc_id!==null)errors.push(`UNEXPECTED_FCC_ID:${id}`);
 if(d.decision==='pending'){if(d.reviewed_at!==null)errors.push(`PENDING_HAS_TIME:${id}`)}else if(typeof d.reviewed_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(d.reviewed_at)||!Number.isFinite(Date.parse(d.reviewed_at)))errors.push(`INVALID_REVIEW_TIME:${id}`);
 }
 if(seen.size!==expected.size||review.decisions.length!==expected.size)errors.push('INCOMPLETE_HISTORY_SET');
 return {valid:errors.length===0,errors,counts:{total:seen.size,pending:review.decisions.filter(x=>x.decision==='pending').length,link:review.decisions.filter(x=>x.decision==='link').length,keep_legacy:review.decisions.filter(x=>x.decision==='keep_legacy').length},warning:'VALIDATION_IS_NOT_APPROVAL_OR_AUTHORIZATION'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+pathResolve(process.argv[1])).href){const [e,r]=process.argv.slice(2);if(!e||!r)throw Error('Usage: node scripts/review/validate.mjs EVIDENCE_JSON DECISIONS_JSON');try{const result=validateReview(await readFile(e,'utf8'),JSON.parse(await readFile(r,'utf8')));console.log(JSON.stringify(result,null,2));if(!result.valid)process.exitCode=1}catch{console.error('INVALID_INPUT');process.exitCode=1}}
function pathResolve(p){return p.startsWith('/')?p:process.cwd()+'/'+p}
