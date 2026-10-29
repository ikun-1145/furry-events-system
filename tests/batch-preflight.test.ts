import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPostgresSafe,BatchPreflightError} from '../scripts/fcc-batch-preflight.ts';
test('NUL rejected with sanitized paths and no value output',()=>{assert.throws(()=>assertPostgresSafe([{detail:'secret\u0000text'},{name:'ok'}]),(e:any)=>e instanceof BatchPreflightError&&e.code==='FCC_POSTGRES_NUL'&&e.paths.join()==='$[0].detail'&&!e.message.includes('secret'))});
test('non-NUL controls, null, empty string remain unchanged',()=>{assert.doesNotThrow(()=>assertPostgresSafe([{detail:'\u0003\n'},{detail:null},{detail:''}]))});
