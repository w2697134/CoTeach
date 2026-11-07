import { DatabaseSync } from 'node:sqlite';
import { createHash, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir=resolve(process.env.CT_MEASURE_DATA||'server/data');
const db=new DatabaseSync(join(dir,'coteach.db'),{readOnly:true});
try{
  const row=db.prepare("SELECT api_key_enc FROM providers WHERE kind='deepseek' AND enabled=1 LIMIT 1").get();
  if(!row)throw new Error('未找到已启用的 DeepSeek 账户');
  const secret=process.env.CT_SECRET||readFileSync(join(dir,'.secret'),'utf8').trim();
  const [,iv,tag,data]=row.api_key_enc.split('.');
  const d=createDecipheriv('aes-256-gcm',createHash('sha256').update('tv2-aes:'+secret).digest(),Buffer.from(iv,'base64url'));
  d.setAuthTag(Buffer.from(tag,'base64url'));
  const key=Buffer.concat([d.update(Buffer.from(data,'base64url')),d.final()]).toString('utf8');
  const r=await fetch('https://api.deepseek.com/user/balance',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),status:r.status,balance:await r.json()}));
}finally{db.close();}
