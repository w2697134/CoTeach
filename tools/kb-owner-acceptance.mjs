import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const source=process.env.CT_ACCEPTANCE_SOURCE;
if(!source)throw new Error('请用 CT_ACCEPTANCE_SOURCE 指定静止的演示数据备份');
const output=resolve('output/kb-owner'),root=join(output,'acceptance-'+Date.now());
mkdirSync(root,{recursive:true});
function snapshot(dir){const db=new DatabaseSync(join(dir,'coteach.db'),{readOnly:true});try{return Object.fromEntries(['kb_changes','kb_runs','kb_events'].map(table=>[table,{columns:db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name),rows:db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()}]));}finally{db.close();}}
const baseline=snapshot(source);
function command(dir,mode,env={}){return spawnSync(process.execPath,['--import','tsx','../tools/kb-owner.ts',mode],{cwd:resolve('server'),env:{...process.env,CT_DATA_DIR:dir,CT_MIGRATION_FAIL_AT:'',CT_MIGRATION_HARD_EXIT:'',...env},encoding:'utf8',windowsHide:true,timeout:120000});}
const reports=[];
for(const scenario of ['normal','interrupted']){
  const dir=join(root,scenario);assert.ok(resolve(dir).startsWith(output+sep));assert.ok(!existsSync(dir));cpSync(source,dir,{recursive:true});
  assert.equal(command(dir,'check').status,0);
  if(scenario==='interrupted'){const r=command(dir,'migrate',{CT_MIGRATION_FAIL_AT:'prepared',CT_MIGRATION_HARD_EXIT:'1'});assert.equal(r.status,86,r.stdout+r.stderr);}
  const first=command(dir,'migrate');assert.equal(first.status,0,first.stdout+first.stderr);
  const second=command(dir,'migrate');assert.equal(second.status,0,second.stdout+second.stderr);
  const verify=command(dir,'verify');assert.equal(verify.status,0,verify.stdout+verify.stderr);
  const report=JSON.parse(verify.stdout.slice(verify.stdout.indexOf('{')));assert.equal(report.ok,true);
  const db=new DatabaseSync(join(dir,'coteach.db'),{readOnly:true});try{for(const [table,expected] of Object.entries(baseline)){const actual=db.prepare(`SELECT ${expected.columns.join(',')} FROM ${table} ORDER BY id`).all();assert.deepEqual(actual,expected.rows,table);}}finally{db.close();}
  reports.push({scenario,repeated:true,businessRecordsIdentical:true,...report});
}
assert.deepEqual(snapshot(source),baseline,'验收不能修改来源备份');
const result={source,finishedAt:new Date().toISOString(),ok:true,reports};
writeFileSync(join(output,'migration-acceptance.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({ok:true,scenarios:reports.map(r=>({scenario:r.scenario,files:r.courses.reduce((n,c)=>n+c.files.length,0),commits:r.courses.reduce((n,c)=>n+c.commits,0),businessRecordsIdentical:r.businessRecordsIdentical})),report:'output/kb-owner/migration-acceptance.json'}));
