// Actual backup script against a disposable local PostgreSQL container with no network.
// Client wrappers only forward local commands over the Docker Unix socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const dockerEnv={...process.env};
for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) delete dockerEnv[k];
const docker=(args:string[],input?:string)=>{
  const r=spawnSync('docker',['--host=unix:///var/run/docker.sock',...args],{env:dockerEnv,input,encoding:'utf8',maxBuffer:8*1024*1024});
  if(r.status!==0) throw Error(`local isolated docker ${args[0]} failed`);
  return r.stdout;
};

test('backup script captures data, sequence, roles, column/RPC ACL and RLS in isolated PostgreSQL',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'fcc-backup-script-'));
  const db=`fcc-script-backup-${process.pid}`;
  try {
    const bin=path.join(dir,'bin'), target=path.join(dir,'backups');
    await mkdir(bin); await mkdir(target);
    docker(['run','-d','--name',db,'--network','none','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17']);
    let ready=false;
    for(let i=0;i<80;i++){
      const r=spawnSync('docker',['--host=unix:///var/run/docker.sock','exec',db,'pg_isready','-h','127.0.0.1','-U','postgres'],{env:dockerEnv});
      if(r.status===0){ready=true;break} await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.equal(ready,true);
    docker(['exec','-i',db,'psql','-X','-U','postgres','-v','ON_ERROR_STOP=1'],await readFile('tests/db/production-shape.sql','utf8'));
    docker(['exec','-i',db,'psql','-X','-U','postgres','-v','ON_ERROR_STOP=1'],
      `insert into public.furry_events(id,name) values (809,'synthetic');
       select setval('public.furry_events_id_seq',841,true);
       create role fcc_test_caller; grant service_role to fcc_test_caller;
       grant select (raw_json),update (name) on public.furry_events to authenticated;`);
    const prefix=`docker --host=unix:///var/run/docker.sock exec -i -e "PGOPTIONS=$PGOPTIONS" ${db}`;
    await writeFile(path.join(bin,'pg_dump'),`#!/bin/bash\nset -euo pipefail\nargs=()\nfor x in "$@"; do case "$x" in --file=*) out="\${x#--file=}";; *) args+=("$x");; esac; done\n${prefix} pg_dump -U postgres "\${args[@]}" > "$out"\n`,{mode:0o700});
    await writeFile(path.join(bin,'pg_restore'),`#!/bin/bash\nset -euo pipefail\n[[ "$1" = --list ]]\n${prefix} pg_restore --list < "$2"\n`,{mode:0o700});
    await writeFile(path.join(bin,'psql'),`#!/bin/bash\nset -euo pipefail\nargs=()\nfile=\nfor x in "$@"; do case "$x" in --file=*) file="\${x#--file=}";; *) args+=("$x");; esac; done\nif [[ -n "$file" ]]; then ${prefix} psql -U postgres "\${args[@]}" < "$file"; else ${prefix} psql -U postgres "\${args[@]}"; fi\n`,{mode:0o700});
    const result=spawnSync('bash',['scripts/fcc-backup.sh'],{
      env:{...dockerEnv,PATH:bin+':'+process.env.PATH,FCC_BACKUP_PARENT:target,FCC_FREEZE_ATTESTED:'YES',PGSERVICE:'fcc_prod_readonly'},
      encoding:'utf8',maxBuffer:2*1024*1024,
    });
    assert.equal(result.status,0,'isolated backup must finish');
    const [name]=await readdir(target), backup=path.join(target,name);
    const watermark=JSON.parse(await readFile(path.join(backup,'watermark.json'),'utf8'));
    assert.deepEqual(watermark,{legacy_rows:1,legacy_max_id:809,sequence_last_value:841,sequence_is_called:true,sequence_increment:1});
    const security=JSON.parse(await readFile(path.join(backup,'legacy-security.json'),'utf8'));
    assert.equal(security.rls_enabled,true);
    assert.ok(security.table_acl.some((x:any)=>x.grantee==='service_role'&&x.privilege==='UPDATE'));
    assert.ok(security.column_acl.some((x:any)=>x.grantee==='authenticated'&&x.column==='raw_json'&&x.privilege==='SELECT'));
    assert.ok(security.rpc_acl.some((x:any)=>x.grantee==='service_role'&&x.privilege==='EXECUTE'));
    assert.ok(security.policies.some((x:any)=>x.command==='SELECT'));
    assert.ok(security.role_memberships.some((x:any)=>x.role==='service_role'&&x.member==='fcc_test_caller'));
    assert.equal((await stat(path.join(backup,'legacy-security.json'))).mode&0o777,0o600);
    assert.ok(!JSON.stringify(security).includes('rolpassword'));
  } finally {
    spawnSync('docker',['--host=unix:///var/run/docker.sock','rm','-f',db],{env:dockerEnv});
    await rm(dir,{recursive:true,force:true});
  }
});
