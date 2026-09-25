import { createHash } from "node:crypto";
import { fixture, flush } from "../../extension/notion-favorite-sections/test-support/candidate-picker-fixture.mjs";
import { flattenGroups, SYSTEM_GROUP_ID } from "../../extension/notion-favorite-sections/src/link-library.js";
import { FAVMOA_RESTORE_POINT_KEY } from "../../extension/notion-favorite-sections/src/favmoa-service.js";
import { personaCatalog, serviceFixture, groupIn, allLinks, clone, PRIMARY_LIBRARY, SECONDARY_LIBRARY } from "./model-fixture.mjs";

export const FIND_SCENARIOS = [
  "제목 전체 검색", "영문 대소문자와 부분 검색", "주소 도메인 검색", "상위 그룹 이름 검색", "깊은 하위 그룹 검색",
  "공백 검색과 접힘 유지", "검색 결과 없음과 복귀", "한 번 클릭으로 링크 열기", "보조 키로 새 탭 열기", "현재 페이지 저장 위치 찾기"
];
export const ORGANIZE_SCENARIOS = [
  "여러 링크 원자적 이동과 되돌리기", "그룹 이름과 색상", "그룹 순환 이동 방지", "링크와 그룹 순서 변경", "그룹만 제거하고 내용 보존",
  "보관함별 초기화 격리", "백업 복원 후 이전 목록 복구", "동시 변경 충돌과 재시도", "저장 실패 후 원본 보존", "한 단계 되돌리기 경계"
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function evidence(value) {
  const digest = () => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  if (value?.schemaVersion && Array.isArray(value.libraries)) return { sha256: digest(), libraries: value.libraries.length, links: allLinks(value).length, groups: value.libraries.reduce((count, library) => count + flattenGroups(library).length, 0) };
  if (Array.isArray(value) && value.length > 15) return { sha256: digest(), count: value.length, first: value.slice(0, 3), last: value.slice(-3) };
  return value;
}
function output(kind, persona, scenario) {
  const checks = [], observations = [], friction = [];
  return {
    checks, observations, friction,
    limitations: [kind === "find" ? "실제 sidepanel 렌더·이벤트 코드를 합성 DOM에서 실행했습니다. 실제 Chrome 탭 전환, 화면 배치·반응 속도, 스크린리더 경험은 증명하지 않습니다." : "실제 저장 서비스·리듀서를 메모리 저장소에서 실행했습니다. Chrome 저장소 할당량·디스크·권한 동작은 증명하지 않습니다.", "관심사·자료 수·중첩 깊이는 실행 데이터에 반영했습니다. 경험 수준·입력 선호 라벨은 사람의 숙련도나 보조 기술을 시뮬레이션하지 않습니다.", "합성 관심사 프로필은 실제 사용자 관찰·만족도·사용성 성공률의 대체물이 아닙니다."],
    check(name, actual, expected) { checks.push({ name, pass: same(actual, expected), actual: evidence(actual), expected: evidence(expected) }); },
    note(text) { observations.push(text); },
    issue(id, title, evidence, recommendation) { friction.push({ id, title, evidence, recommendation }); },
    result() { return { scenarioName: (kind === "find" ? FIND_SCENARIOS : ORGANIZE_SCENARIOS)[scenario], checks, observations, limitations: this.limitations, friction }; }
  };
}
function scenarioError(result, message) {
  const error = new Error(message); error.auditDetails = result.result(); return error;
}

function uiFixture(data) {
  const f = fixture([]);
  f.context.auditCatalog = clone(data.catalog);
  f.run('adopt({catalog: auditCatalog, revision: 7, canUndo: false});');
  f.$("search").tagName = "INPUT";
  const rows = () => f.document.querySelectorAll("#tree .link-row");
  return { ...f, rows, row: id => rows().find(row => row.dataset.linkId === id),
    async query(value) { f.$("search").value = value; await f.$("search").emit("input"); },
    renderedIds: () => rows().map(row => row.dataset.linkId) };
}

export async function runFind(persona) {
  const scenario = persona.scenarios.find, r = output("find", persona, scenario), data = personaCatalog(persona), f = uiFixture(data);
  r.check("요청한 관심사 자료 수로 카탈로그 구성", allLinks(data.catalog).length - 1, data.size);
  r.check("요청한 중첩 깊이 구성", data.pathIds.length, data.depth);
  const before = clone(f.run("state.catalog"));
  switch (scenario) {
    case 0: {
      await f.query(data.target.title);
      r.check("전체 제목으로 대상 하나 찾음", f.renderedIds(), [data.target.id]);
      r.check("검색 결과 수 안내", f.$("link-count").textContent, `검색 결과 1개 / 전체 ${data.size}개`);
      r.check("정확한 링크 주소 보존", f.row(data.target.id)?.querySelector("a")?.href, data.target.url);
      break;
    }
    case 1: {
      await f.query("fOcUs");
      r.check("영문 대소문자 구분 없이 부분 제목 검색", f.renderedIds(), [data.target.id]);
      await f.query(`focus ${persona.interest}`);
      r.note(`단어 순서를 바꾼 검색어 ${JSON.stringify(`focus ${persona.interest}`)}에서 ${f.rows().length}개가 표시되었습니다.`);
      if (f.rows().length === 0) r.issue("search-ordered-substring", "단어 순서를 바꾸면 같은 제목을 찾기 어려움", `제목 ${JSON.stringify(data.target.title)}는 focus로 검색되지만 focus + 관심사 역순 조합은 0건입니다.`, "여러 검색어를 공백으로 나누어 모두 포함하는 제목·주소·경로를 찾는 방식을 검토합니다.");
      await f.query("FOCUS");
      r.check("검색어를 줄이면 동일 대상으로 복귀", f.renderedIds(), [data.target.id]);
      break;
    }
    case 2: {
      const hostname = new URL(data.target.url).hostname; await f.query(hostname);
      r.check("호스트 이름으로 대상 찾음", f.renderedIds(), [data.target.id]);
      r.check("주소의 경로 쿼리 앵커를 유지", f.row(data.target.id)?.querySelector("a")?.href, data.target.url);
      r.check("제목이 아닌 주소 검색도 결과 수 안내", f.$("link-count").textContent, `검색 결과 1개 / 전체 ${data.size}개`);
      break;
    }
    case 3: {
      await f.query(groupIn(data.catalog, data.rootId).name);
      r.check("상위 그룹 검색은 하위 자료까지 표시", f.rows().length, data.size);
      r.check("깊은 대상도 표시", f.renderedIds().includes(data.target.id), true);
      r.check("검색 중 폴딩 조작 비활성화", f.document.querySelectorAll("#tree .fold").every(fold => fold.disabled), true);
      break;
    }
    case 4: {
      const leaf = groupIn(data.catalog, data.leafId); await f.query(leaf.name);
      r.check("하위 그룹 이름의 정확한 범위", f.renderedIds(), leaf.links.map(link => link.id));
      const ancestry = f.document.querySelectorAll("#tree .group").map(group => group.dataset.groupId);
      r.check("검색 결과의 상위 경로 유지", ancestry, data.pathIds);
      r.check("검색 중에도 원래 접힘 상태 불변", clone(f.run("state.catalog")), before);
      break;
    }
    case 5: {
      const visibleBefore = f.renderedIds(); await f.query("  \t  ");
      r.check("공백만 입력하면 평상시 목록 유지", f.renderedIds(), visibleBefore);
      r.check("공백에 지우기 버튼을 강요하지 않음", f.$("clear-search").hidden, true);
      r.check("접힌 그룹 자료는 평상시 숨겨짐", f.rows().length, groupIn(data.catalog, data.rootId).links.length);
      await f.query("참고 자료");
      f.$("library-picker").value = SECONDARY_LIBRARY; await f.$("library-picker").emit("change");
      r.check("보관함 전환은 선택한 보관함으로 이동", f.run("libraryId"), SECONDARY_LIBRARY);
      r.check("다른 보관함 선택은 이전 검색을 자동 해제", f.$("search").value, "");
      r.check("별도 검색 해제 없이 새 보관함 자료 발견", f.renderedIds(), ["audit-other-focus"]);
      r.check("전환 후 검색 지우기를 강요하지 않음", f.$("clear-search").hidden, true);
      r.note("0.1.38부터 명시적 보관함 전환은 검색을 비우는 계약입니다. 검색 잔존 마찰 기록을 회귀 기대값으로 전환했으며 기존 감사 원장은 보존합니다.");
      break;
    }
    case 6: {
      await f.query(`unmatched-audit-query-${persona.index}`);
      r.check("없는 검색의 결과 수 0", f.rows().length, 0);
      r.check("검색 실패의 다음 행동 안내", f.$("tree").textContent.includes("검색 지우고 전체 보기"), true);
      const clear = f.$("tree").querySelectorAll("button").find(button => button.textContent === "검색 지우고 전체 보기");
      if (!clear) throw scenarioError(r, "No-result recovery control missing");
      await clear.emit("click");
      r.check("복귀 동작은 검색어를 지움", f.$("search").value, "");
      r.check("복귀 후 검색창에 초점", f.document.activeElement === f.$("search"), true);
      break;
    }
    case 7:
    case 8: {
      await f.query("focus"); const anchor = f.row(data.target.id)?.querySelector("a");
      if (!anchor) throw scenarioError(r, "Target link did not render");
      const titleBefore = anchor.textContent;
      await anchor.emit("click", scenario === 8 ? { ctrlKey: true } : {}); await flush();
      r.check("클릭 한 번이 탐색 한 번을 요청", f.opened.length, 1);
      r.check("주소 경로 쿼리 앵커 그대로 열기 요청", f.opened[0]?.[0], data.target.url);
      r.check("보조 키는 새 탭 의도 전달", Boolean(f.opened[0]?.[1]?.newTab), scenario === 8);
      r.check("열기 완료 후 제목 텍스트 유지", anchor.textContent, titleBefore);
      break;
    }
    case 9: {
      f.context.auditPage = { title: data.target.title, url: data.target.url };
      f.run('applyTabSnapshot({page: auditPage, tabs: [auditPage]});');
      await f.query("unmatched-before-reveal");
      r.check("현재 페이지가 이미 저장되었음을 안내", f.$("save-current").textContent, "저장 위치 보기");
      await f.$("save-current").emit("click");
      r.check("저장 위치 보기는 검색어 초기화", f.$("search").value, "");
      r.check("같은 URL의 다른 보관함보다 현재 보관함 우선", f.run("libraryId"), PRIMARY_LIBRARY);
      r.check("저장 링크로 키보드 초점 이동", f.document.activeElement?.dataset.focusKey, `open:${PRIMARY_LIBRARY}:${data.target.id}`);
      r.check("현재 페이지 접근성 표시", f.row(data.target.id)?.querySelector("a")?.getAttribute("aria-current"), "page");
      break;
    }
    default: throw scenarioError(r, `Unknown find scenario ${scenario}`);
  }
  r.check("찾기·열기 과정에서 저장 명령 없음", f.actions.length, 0);
  r.check("찾기·열기 과정에서 사용자 카탈로그 불변", clone(f.run("state.catalog")), before);
  r.note(`${data.size}개 관심사 링크, 최대 ${data.depth}단계 그룹. VM 이벤트 처리는 실제 sidepanel.js를 사용하고 실제 브라우저 호출만 기록합니다.`);
  return r.result();
}

export async function runOrganize(persona) {
  const scenario = persona.scenarios.organize, r = output("organize", persona, scenario), data = personaCatalog(persona), f = serviceFixture(data.catalog);
  const original = clone(data.catalog), originalLinks = allLinks(original).map(link => link.id).sort();
  const checkPreserved = catalog => r.check("전체 링크 ID와 개수 보존", allLinks(catalog).map(link => link.id).sort(), originalLinks);
  const assertSuccess = (name, result) => { r.check(name, result.ok, true); if (!result.ok) throw scenarioError(r, `${name}: ${result.code}: ${result.error}`); };
  r.check("서비스 초기 읽기 성공", (await f.send({ type: "FAVMOA_GET" })).ok, true);
  switch (scenario) {
    case 0: {
      const ids = [data.target.id, "audit-link-1"];
      const moved = await f.action({ type: "moveLinks", linkIds: ids, targetGroupId: data.destinationId }); assertSuccess("일괄 이동 성공", moved);
      r.check("이동은 한 번의 저장", f.writes.length, 1);
      r.check("선택한 두 링크만 목적지에 이동", groupIn(moved.catalog, data.destinationId).links.map(link => link.id).sort(), [...ids].sort());
      r.check("목적지를 펼쳐 이동 결과 표시", groupIn(moved.catalog, data.destinationId).collapsed, false); checkPreserved(moved.catalog);
      const undo = await f.undo(); assertSuccess("한 번에 일괄 이동 취소", undo); r.check("일괄 이동 전 전체 카탈로그 복구", undo.catalog, original);
      break;
    }
    case 1: {
      const renamed = await f.action({ type: "renameGroup", groupId: data.rootId, name: `  ${persona.interest} 정리 완료  ` }); assertSuccess("그룹 이름 변경", renamed);
      r.check("그룹 이름 앞뒤 공백 정리", groupIn(renamed.catalog, data.rootId).name, `${persona.interest} 정리 완료`);
      const colored = await f.action({ type: "setGroupColor", groupId: data.rootId, color: "#A855F7" }); assertSuccess("그룹 색상 변경", colored);
      r.check("색상 표준화", groupIn(colored.catalog, data.rootId).color, "#a855f7");
      const invalid = await f.action({ type: "renameGroup", groupId: data.rootId, name: " " });
      r.check("빈 그룹 이름 거절", invalid.code, "INVALID_DATA"); r.check("입력 오류에 저장 안 함", f.writes.length, 2); checkPreserved(f.current().catalog);
      break;
    }
    case 2: {
      const target = data.depth > 1 ? data.leafId : data.rootId;
      const cyclic = await f.action({ type: "moveGroup", groupId: data.rootId, targetParentGroupId: target });
      r.check("자기 자신 또는 하위 그룹 이동 거절", cyclic.code, "INVALID_DATA");
      r.check("순환 요청 후 데이터 유지", f.current().catalog, original); r.check("순환 요청 저장 없음", f.writes.length, 0);
      const legal = await f.action({ type: "moveGroup", groupId: data.rootId, targetParentGroupId: data.destinationId }); assertSuccess("별도 그룹 안으로 정상 이동", legal);
      r.check("이동 후 전체 하위 트리 보존", groupIn(legal.catalog, data.destinationId).groups[0].id, data.rootId); checkPreserved(legal.catalog);
      break;
    }
    case 3: {
      const root = groupIn(original, data.rootId); const second = root.links[1] || root.links[0];
      const beforeIds = root.links.map(link => link.id);
      const ordered = await f.action({ type: "reorderLink", linkId: second.id, direction: "up" }); assertSuccess("링크 위로 이동", ordered);
      const expected = [...beforeIds]; if (expected.length > 1) [expected[0], expected[1]] = [expected[1], expected[0]];
      r.check("동일 그룹 안 링크 순서 변경", groupIn(ordered.catalog, data.rootId).links.map(link => link.id), expected);
      const groups = await f.action({ type: "reorderGroup", groupId: data.destinationId, direction: "up" }); assertSuccess("그룹 순서 변경", groups);
      r.check("미분류 위치를 유지한 그룹 순서", groups.catalog.libraries[0].groups.map(group => group.id), [SYSTEM_GROUP_ID, data.destinationId, data.rootId]); checkPreserved(groups.catalog);
      break;
    }
    case 4: {
      const removed = await f.action({ type: "removeGroup", groupId: data.rootId }); assertSuccess("그룹만 제거 성공", removed);
      r.check("제거한 그룹 노드 사라짐", Boolean(groupIn(removed.catalog, data.rootId)), false); checkPreserved(removed.catalog);
      r.check("하위 그룹과 경로에 접근 가능", Boolean(groupIn(removed.catalog, data.depth > 1 ? data.leafId : SYSTEM_GROUP_ID)), true);
      const undo = await f.undo(); assertSuccess("그룹 제거 취소", undo); r.check("그룹 색상·중첩·링크 복원", undo.catalog, original);
      break;
    }
    case 5: {
      const other = clone(original.libraries.find(library => library.id === SECONDARY_LIBRARY));
      const reset = await f.action({ type: "resetLibrary" }); assertSuccess("선택한 보관함 초기화", reset);
      r.check("선택한 보관함만 비움", flattenGroups(reset.catalog.libraries[0]).flatMap(({ group }) => group.links).length, 0);
      r.check("다른 보관함 그대로 유지", reset.catalog.libraries.find(library => library.id === SECONDARY_LIBRARY), other);
      const undo = await f.undo(); assertSuccess("초기화 되돌리기", undo); r.check("초기화 전 두 보관함 복구", undo.catalog, original);
      break;
    }
    case 6: {
      const backup = clone(original); backup.libraries[0].name = "합성 백업에서 복원";
      const imported = await f.send({ type: "FAVMOA_IMPORT_BACKUP", catalog: backup, expectedRevision: 0 }); assertSuccess("검증된 카탈로그 백업 복원", imported);
      r.check("복원 전 별도 안전 사본 있음", imported.hasRestorePoint, true);
      const edited = await f.action({ type: "renameLibrary", name: "복원 후 추가 편집" }); assertSuccess("복원 이후 편집", edited);
      const recovered = await f.send({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: edited.revision }); assertSuccess("일반 편집 뒤에도 복원 전 목록 복구", recovered);
      r.check("복원 전 전체 목록 일치", recovered.catalog, original);
      r.check("복구 사용 후 안전 사본 소비", f.data[FAVMOA_RESTORE_POINT_KEY], null);
      const undo = await f.undo(); assertSuccess("복구 자체도 한 번 취소", undo); r.check("복구 취소는 직전 편집 상태로", undo.catalog, edited.catalog);
      break;
    }
    case 7: {
      const [first, stale] = await Promise.all([
        f.action({ type: "renameGroup", groupId: data.rootId, name: "먼저 저장한 이름" }, 0),
        f.action({ type: "renameGroup", groupId: data.rootId, name: "다른 창의 이름" }, 0)
      ]); assertSuccess("첫 번째 창의 변경 저장", first);
      r.check("동일 이전 버전 요청은 충돌", stale.code, "CONFLICT");
      r.check("충돌에는 최신 카탈로그 제공", stale.catalog, first.catalog); r.check("충돌 요청 저장 없음", f.writes.length, 1);
      const retry = await f.action({ type: "renameGroup", groupId: data.rootId, name: "확인 후 다시 저장" }, stale.revision); assertSuccess("최신 버전 확인 후 재시도", retry);
      r.check("확인한 최신 변경 반영", groupIn(retry.catalog, data.rootId).name, "확인 후 다시 저장"); checkPreserved(retry.catalog);
      break;
    }
    case 8: {
      f.failWrites(true); const failed = await f.action({ type: "removeLink", linkId: data.target.id });
      r.check("저장 실패를 성공으로 알리지 않음", failed.code, "SAVE_FAILED"); r.check("실패 후 원본 불변", f.current().catalog, original); r.check("실패 후 버전 증가 없음", f.current().revision, 0);
      f.failWrites(false); const retry = await f.action({ type: "removeLink", linkId: data.target.id }); assertSuccess("재시도 성공", retry);
      r.check("재시도 한 번만 저장", f.writes.length, 1);
      const undo = await f.undo(); assertSuccess("재시도 작업도 복구 가능", undo); r.check("원본 전체 복구", undo.catalog, original);
      break;
    }
    case 9: {
      const removed = await f.action({ type: "removeLink", linkId: data.target.id }); assertSuccess("첫 번째 변경인 링크 제거", removed);
      const renamed = await f.action({ type: "renameGroup", groupId: data.rootId, name: "다음 작업" }); assertSuccess("두 번째 변경인 이름 수정", renamed);
      const undo = await f.undo(); assertSuccess("직전 변경 하나 취소", undo);
      r.check("직전 이름 수정만 복구", undo.catalog, removed.catalog);
      const twice = await f.undo(); r.check("두 번째 취소가 없는 기록을 만들지 않음", twice.code, "NOTHING_TO_UNDO");
      r.check("추가 취소 시 저장 없음", f.writes.length, 3);
      r.issue("one-step-undo", "연속 작업 전 단계까지 되돌릴 수 없음", "링크 제거 후 그룹 이름을 바꾸면 되돌리기는 이름 수정만 취소하며, 추가 취소는 NOTHING_TO_UNDO입니다. 링크 제거 이력은 일반 되돌리기로 복구할 수 없습니다.", "원본 보존 정책은 유지하면서 최근 변경 기록이나 휴지통의 필요성을 검토하고, 현재는 '직전 변경만 되돌림'을 명확히 안내합니다.");
      const foldCase = serviceFixture(original);
      const removedBeforeFold = await foldCase.action({ type: "removeLink", linkId: data.target.id }); assertSuccess("접힘 경계 확인용 링크 제거", removedBeforeFold);
      const folded = await foldCase.action({ type: "toggleGroup", groupId: data.rootId }); assertSuccess("그룹 펼침 상태 변경", folded);
      const undoFold = await foldCase.undo(); assertSuccess("접힘 직후 되돌리기", undoFold);
      const expectedAfterUndo = clone(original);
      groupIn(expectedAfterUndo, data.rootId).collapsed = groupIn(folded.catalog, data.rootId).collapsed;
      r.check("접힘 후 되돌리기는 삭제한 링크를 복구하고 선택한 보기 상태 유지", undoFold.catalog, expectedAfterUndo);
      r.check("직전 내용 편집 취소 후 복구 기록 소진", undoFold.canUndo, false);
      r.note(`제거→그룹 접기→되돌리기 이후 대상 링크 존재=${allLinks(undoFold.catalog).some(link => link.id === data.target.id)}, canUndo=${undoFold.canUndo}.`);
      break;
    }
    default: throw scenarioError(r, `Unknown organize scenario ${scenario}`);
  }
  r.note(`${data.size}개 관심사 링크와 ${data.depth}단계 그룹에서 ${ORGANIZE_SCENARIOS[scenario]}를 실제 서비스 큐로 실행했습니다.`);
  r.check("입력 카탈로그를 직접 변경하지 않음", data.catalog, original);
  return r.result();
}
