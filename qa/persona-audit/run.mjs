import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {personas,metadata} from './personas.mjs';
import {runCapture,CAPTURE_SCENARIOS} from './capture.mjs';
import {runFind,runOrganize,FIND_SCENARIOS,ORGANIZE_SCENARIOS} from './find-organize.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const out=resolve(process.argv[2]||join(root,'artifacts/persona-audit-'+Date.now()));
if(personas.length!==100||new Set(personas.map(p=>p.id)).size!==100) throw Error('100 unique personas required');
await mkdir(out,{recursive:true});
const startedAt=new Date().toISOString();
const runners={capture:runCapture,find:runFind,organize:runOrganize};
const names={capture:CAPTURE_SCENARIOS,find:FIND_SCENARIOS,organize:ORGANIZE_SCENARIOS};
const files=execFileSync('git',['ls-files','extension/notion-favorite-sections'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(p=>/\.(js|html|css|json)$/u.test(p)&&!p.includes('/test/'));
const sourceHash=createHash('sha256');
for(const file of files) sourceHash.update(file).update(await readFile(join(root,file)));
const harnessHash=createHash('sha256');
for(const file of ['capture.mjs','find-organize.mjs','model-fixture.mjs','personas.mjs','run.mjs']) harnessHash.update(file).update(await readFile(join(root,'qa/persona-audit',file)));
const runs=[];
for(const p of personas){
  for(const [phase,execute] of Object.entries(runners)){
    const start=performance.now(); let result;
    try{result=await execute(p);}catch(error){result={...error.auditDetails,executionError:error.message,checks:[...(error.auditDetails?.checks||[]),{name:'scenario completed without harness/contract exception',pass:false,actual:error.message,expected:'no exception'}]};}
    const checks=result.checks||[];
    runs.push({id:`${p.id}-${phase}`,personaId:p.id,phase,variant:p.scenarios[phase],...result,scenarioName:names[phase][p.scenarios[phase]],outcome:checks.length&&checks.every(c=>c.pass)&&!result.executionError?'contract-pass':'contract-fail',machineDurationMs:Math.round((performance.now()-start)*100)/100});
  }
  if((p.index+1)%20===0) console.log(`${runs.length}/300 scenarios executed`);
}
const summary={total:runs.length,contractPass:runs.filter(r=>r.outcome==='contract-pass').length,contractFail:runs.filter(r=>r.outcome==='contract-fail').length,withFriction:runs.filter(r=>r.friction?.length).length,assertions:runs.reduce((n,r)=>n+r.checks.length,0),assertionFailures:runs.reduce((n,r)=>n+r.checks.filter(c=>!c.pass).length,0)};
const result={schemaVersion:1,productVersion:JSON.parse(await readFile(join(root,'package.json'))).version,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceSha256:sourceHash.digest('hex'),harnessSha256:harnessHash.digest('hex'),startedAt,finishedAt:new Date().toISOString(),methodology:metadata,limits:['300개는 UI-handler/저장모델 합성 시나리오 실행 수. 300번의 실제 브라우저 사용이나 실사용자 테스트가 아님.','contract-pass는 구현 계약 검증 통과이며 사용성 마찰이 없음을 뜻하지 않음.','경험·입력 방식은 페르소나 맥락. 키보드/포인터 실제 경로 검증으로 집계하지 않음.','machineDurationMs는 Node 실행 계측값으로 체감속도나 사용자 과업 시간 아님.'],summary,personas,runs};
await writeFile(join(out,'results.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
await writeFile(join(out,'personas.json'),JSON.stringify(personas,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary)); console.log('Results: '+join(out,'results.json'));
if(summary.total!==300||summary.contractFail) process.exitCode=1;
