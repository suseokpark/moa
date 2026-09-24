import assert from 'node:assert/strict';
import { fixture, deferred, flush } from '../../extension/notion-favorite-sections/test-support/candidate-picker-fixture.mjs';

export const CAPTURE_SCENARIOS = [
  '선택한 링크만 원자적으로 담기', '검색 뒤 숨겨진 선택 보존', '전체 선택 해제 후 검색 유지',
  '200개 이후 후보까지 탐색', '기저장·중복·지원 불가 주소 제외', '긴 제목 정리 후 저장',
  '조회 취소 후 늦은 응답 격리', '읽기 실패와 명시적 재시도', '저장 중 중복 제출 방지', '다른 창 변경 충돌 시 선택 보존'
];

export async function runCapture(p) {
  const checks=[], observations=[], friction=[], variant=p.scenarios.capture;
  const check=(name,actual,expected)=>{
    let pass=true; try{assert.deepEqual(actual,expected);}catch{pass=false;}
    checks.push({name,pass,actual,expected});
    if(!pass) throw Object.assign(new Error(name), {auditDetails:{checks,observations,friction}});
  };
  const size=variant===3?Math.max(205,p.profile.collectionSize):p.profile.collectionSize;
  const rows=Array.from({length:size},(_,i)=>({title:`${p.interest} 자료 ${i+1}`,url:`https://example.org/${p.slug}/${i+1}`,folderPath:`${p.family} / ${p.interest}`}));
  const original=JSON.stringify(rows);
  const bookmarks=p.profile.source==='bookmarks';
  const success=items=>({ok:true,...(bookmarks?{candidates:items}:{tabs:items}),excludedCount:0});
  let input=rows;
  if(variant===4) input=[...rows, {...rows[0]}, {title:'이미 저장',url:'https://example.com/saved'}, {title:'지원하지 않는 주소',url:'javascript:void(0)'}];
  if(variant===5) input=[{...rows[0],title:`\u0000${p.interest}\n${'자료 '.repeat(140)}`},...rows.slice(1)];
  const f=fixture(input,{bookmarks});
  f.context.initial.catalog.libraries[0].groups[1].name=p.family;
  f.context.initial.catalog.libraries[0].groups[1].groups[0].name=p.interest;
  f.run('render();');
  if(variant===6) {
    const pending=deferred(); f.setCandidates(()=>pending.promise); await f.open();
    check('로딩 중 저장 비활성',f.$('dialog-submit').disabled,true);
    await f.$('dialog-cancel').emit('click'); await f.$('add-group').emit('click');
    const before=f.$('dialog-body').textContent;
    pending.resolve(success(rows)); await flush();
    check('새 입력창 제목 유지',f.$('dialog-title').textContent,'그룹 만들기');
    check('늦은 조회가 새 입력을 덮지 않음',f.$('dialog-body').textContent,before);
    check('취소는 저장하지 않음',f.actions.length,0);
  } else if(variant===7) {
    f.setCandidates(async()=>({ok:false,error:'목록 읽기 권한을 확인해 주세요.'})); await f.open();
    check('실패 안내 표시',f.$('dialog-body').textContent.includes('권한'),true);
    check('실패 시 저장 비활성',f.$('dialog-submit').disabled,true);
    f.setCandidates(async()=>success(rows)); await f.clickText('다시 불러오기');
    check('명시적 재조회',f.fetches(),2);
    await f.check(rows[0].title); await f.submit(); check('재시도 후 단일 저장',f.actions.length,1);
    observations.push('브라우저 권한창 자체가 아닌 API 실패 응답과 UI 재시도 처리 점검');
  } else {
    await f.open(); check('선택 없이 저장 금지',f.$('dialog-submit').disabled,true);
    check('초기 200개까지만 표시',f.checks().length,Math.min(input.length-(variant===4?3:0),200));
    if(variant===0){
      await f.check(rows[0].title); await f.check(rows[1].title);
      await f.target('destination'); f.$('search').value='외부 검색으로 숨김'; await f.submit();
      check('선택한 두 개만 저장',f.actions[0].action.links.length,2);
      check('저장 위치 일치',f.actions[0].action.groupId,'destination');
      check('원자적 단일 명령',f.actions.length,1);
      check('저장 뒤 외부 검색 해제',f.$('search').value,'');
      check('대상 그룹 펼침',f.run('library().groups.find(g=>g.id==="parent").collapsed'),false);
    } else if(variant===1){
      await f.check(rows[0].title); await f.search('이 결과는 없어야 합니다');
      check('숨겨진 선택 개수',f.count(),'1개 선택 · 화면 밖 1개 포함');
      check('비어 있는 결과는 전체 선택 불가',f.all().disabled,true);
      await f.submit(); check('숨겨진 선택만 저장',f.actions[0].action.links[0].url,rows[0].url);
    } else if(variant===2){
      await f.check(rows[0].title); await f.search(rows[1].url); await f.clickText('선택 해제');
      check('전체 선택 제거',f.count(),'0개 선택'); check('검색어 유지',f.filter().value,rows[1].url);
      check('저장 비활성 복원',f.$('dialog-submit').disabled,true); check('취소성 조작 무저장',f.actions.length,0);
    } else if(variant===3){
      let pages=0; while(f.checks().length<rows.length){await f.clickText('더 보기');pages++;}
      await f.check(rows.at(-1).title); await f.submit();
      check('첫 200개 이후 마지막 링크 저장',f.actions[0].action.links[0].url,rows.at(-1).url);
      check('전체 후보 접근 가능',f.actions[0].action.links.length,1);
      observations.push(`후보 ${rows.length}개에 더 보기 ${pages}회 필요`);
      friction.push({id:'large-list-pagination',title:'대량 가져오기는 반복적인 더 보기 필요',evidence:`${rows.length}개 후보를 모두 보려면 추가 버튼 ${pages}회`,recommendation:'선택 범위를 유지하면서 검색 결과 전체 선택을 별도 제안하거나 페이지 이동을 단순화'});
    } else if(variant===4){
      check('중복 제외 안내',f.$('dialog-body').textContent.includes('중복'),true);
      check('저장된 주소 제외 안내',f.$('dialog-body').textContent.includes('이미 저장 1개'),true);
      await f.search('javascript:'); check('위험 주소는 표시하지 않음',f.checks().length,0);
      await f.search(rows[0].url); await f.check(rows[0].title); await f.submit();
      check('중복 없이 한 번만 담음',f.actions[0].action.links.length,1);
    } else if(variant===5){
      const title=f.checks()[0].getAttribute('aria-label').replace(/ 선택$/u,'');
      check('긴 제목은 비어 있지 않고 300자 이내',title.length>0&&title.length<=300,true); check('제어 문자 제거',/[\u0000-\u001f]/u.test(title),false);
      await f.check(title); await f.submit(); check('정리된 제목 저장',f.actions[0].action.links[0].title,title);
      observations.push('300자 이후 제목은 정리 과정에서 잘림. 사용자 인지 여부는 별도 확인 필요');
    } else if(variant===8){
      await f.check(rows[0].title); const pending=deferred(); f.setResponse(()=>pending.promise);
      const first=f.submit(); await flush(); await f.submit(); await f.$('dialog-cancel').emit('click');
      check('대기 중 중복 명령 금지',f.actions.length,1); check('대기 중 입력창 유지',f.$('dialog').open,true);
      pending.resolve({ok:false,code:'SAVE_FAILED',error:'저장하지 못했습니다.'}); await first;
      check('실패 시 선택 보존',f.count(),'1개 선택'); check('실패 후 재시도 가능',f.$('dialog-submit').disabled,false);
    } else if(variant===9){
      await f.check(rows[0].title); await f.target('destination');
      const fresh=structuredClone(f.context.initial.catalog); fresh.libraries[0].name='다른 창에서 변경';
      f.setResponse(async()=>({ok:false,conflict:true,code:'CONFLICT',error:'다른 창에서 목록이 변경되었습니다.',revision:8,catalog:fresh}));
      await f.submit(); check('충돌 시 부분 저장 없음',f.run('linksOf(library()).length'),1);
      check('선택 유지',f.count(),'1개 선택'); check('충돌 명시',f.$('dialog-error').textContent.includes('다른 창'),true);
      check('이전 변경 버전 기준 저장 요청',f.actions[0].expectedRevision,7);
      await f.submit(); check('같은 창 재제출은 여전히 이전 버전 사용',f.actions[1].expectedRevision,7);
      check('재제출 후에도 충돌 안내 유지',f.$('dialog-error').textContent.includes('다른 창'),true);
      friction.push({id:'conflict-reopen',title:'충돌 후 선택을 유지하지만 다시 열어야 함',evidence:'목록 변경 충돌 후 원래 revision 요청을 유지하므로 같은 창 재제출로는 복구되지 않음',recommendation:'선택을 유지한 최신 목록 재검토 또는 다시 열기 안내를 명확히 제공'});
    }
  }
  if([0,1,3,4,5,7].includes(variant)) {
    const action=f.actions.at(-1)?.action;
    const committed=JSON.parse(f.run('JSON.stringify(flattenGroups(library()).map(({group})=>group))'));
    const destination=committed.find(g=>g.id===action.groupId);
    check('성공 후 대화상자 닫힘',f.$('dialog').open,false);
    check('카탈로그 실제 링크 개수 증가',f.run('linksOf(library()).length'),1+action.links.length);
    check('지정 그룹에 선택한 제목·주소 모두 반영',action.links.every(item=>destination?.links.some(link=>link.title===item.title&&link.url===item.url)),true);
    check('기존 저장 링크 보존',f.run('linksOf(library()).some(link=>link.id==="saved"&&link.url==="https://example.com/saved")'),true);
  }
  check('후보 원본 데이터 불변',JSON.stringify(rows)===original,true);
  return {checks,observations,friction,limitations:['실제 sidepanel 소스를 모의 DOM에서 실행; 브라우저 권한·레이아웃·인지 부담·포인터 동작 자체는 검증하지 않음','capture의 대상 트리는 공통 2단계 fixture. 경험·입력 방식은 가정이며 해당 경로를 재현한 접근성 증거가 아님. pagination 분기는 실제 후보를 최소 205개로 확대'],evidenceLevel:'shipped-ui-handler-with-mocked-platform',dataset:{candidateCount:input.length,profileCollectionSize:p.profile.collectionSize,actualTargetDepth:2,source:p.profile.source,interest:p.interest}};
}
