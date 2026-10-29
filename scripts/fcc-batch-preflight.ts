/** Offline preflight before PostgreSQL parses JSONB. Never logs data values. */
export class BatchPreflightError extends Error {
  constructor(readonly code: string, readonly paths: string[]) { super(code); }
}
export function assertPostgresSafe(value: unknown): void {
  const seen = new WeakSet<object>();
  const stack: Array<{value: unknown; path: string}> = [{value,path:'$'}];
  const paths: string[] = [];
  while (stack.length) {
    const item=stack.pop()!;
    if (typeof item.value==='string') { if (item.value.includes('\u0000')) paths.push(item.path); continue; }
    if (!item.value || typeof item.value!=='object') continue;
    if (seen.has(item.value)) throw new BatchPreflightError('FCC_INVALID_CYCLIC_INPUT', []);
    seen.add(item.value);
    if (Array.isArray(item.value)) item.value.forEach((v,i)=>stack.push({value:v,path:`${item.path}[${i}]`}));
    else for (const [key,v] of Object.entries(item.value)) {
      if (key.includes('\u0000')) paths.push(`${item.path}.[invalid_key]`);
      stack.push({value:v,path:`${item.path}.${/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)?key:'[key]'}`});
    }
  }
  if(paths.length) throw new BatchPreflightError('FCC_POSTGRES_NUL',paths.sort());
}
