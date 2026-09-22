# Moa · 모아

자주 찾는 Notion 페이지를 한곳에 모아.

Moa는 Notion 웹앱의 즐겨찾기를 **그룹 → 섹션 → 즐겨찾기**로 정리하는 Chrome 확장입니다. 수신함 옆 Moa 메뉴에서 그룹과 섹션을 접고 펼치며 페이지를 탐색할 수 있습니다.

현재 버전: **0.1.9** · 최소 Chrome: **111**

## 기능

- Notion 즐겨찾기에서 검색·복수 선택하여 원하는 그룹과 섹션에 추가
- 그룹·섹션 생성, 이름 변경, 이동, 접기 및 최근 변경 되돌리기
- 현재 열린 페이지 표시와 로드된 하위 페이지의 링크 트리
- 원본 목록이 접혀 있어도 저장한 제목·아이콘과 링크 유지
- 워크스페이스별 브라우저 로컬 저장, 별도 로그인 없음

Notion 원본 페이지나 즐겨찾기는 수정하지 않습니다. 전체 페이지 계층을 서버에서 가져오는 기능이나 기기 간 동기화는 제공하지 않습니다.

## 설치

1. 이 저장소를 다운로드하거나 clone합니다.
2. Chrome에서 `chrome://extensions`를 열고 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**에서 `extension/notion-favorite-sections` 폴더를 선택합니다.
4. 로그인된 `https://app.notion.com/` 탭을 새로고침하고 수신함 옆 Moa를 누릅니다.

업데이트 시에는 **기존 설치 경로를 유지**하고 확장 카드와 Notion 탭을 새로고침하세요. 다른 폴더로 새로 설치하면 기존 로컬 정리 목록이 이어지지 않을 수 있습니다. 확장을 삭제하거나 트리를 초기화할 필요는 없습니다.

0.1.8에서 업그레이드한 뒤 제목 대신 ID가 보이면, 원본 Notion 즐겨찾기를 한 번 펼친 다음 Moa의 **목록 갱신**을 실행하세요. 확인한 제목을 이후에도 보관합니다.

## 개발 및 검증

Node.js가 필요합니다. 테스트·로컬 데모·패키징에는 외부 npm 패키지가 필요하지 않습니다.

```sh
npm test
npm run check:extension-package
npm start
```

- 데모: `http://127.0.0.1:4173/extension/notion-favorite-sections/test/browser-live-demo.html`
- 브라우저 검사: `http://127.0.0.1:4173/extension/notion-favorite-sections/test/browser-suite.html`
- 다른 포트: `PORT=4174 npm start`

`npm test`는 Node 검사만 실행합니다. 브라우저 검사는 별도 페이지에서 **전체 검사 실행**을 누릅니다. 데모는 합성 데이터와 테스트 저장소를 사용하며 실제 Notion 계정을 변경하지 않습니다.

```sh
npm run package:extension
node extension/notion-favorite-sections/scripts/package-extension.mjs --verify artifacts/moa-v0.1.9.zip
```

ZIP은 `artifacts/moa-v0.1.9.zip`에 생성됩니다. 이 디렉터리는 Git에서 제외됩니다. 아이콘을 다시 생성할 때만 `sharp`가 추가로 필요합니다.

## 개인정보와 범위

명시적 권한은 `storage` 하나이며 `app.notion.com`에서만 실행합니다. 그룹·섹션 설정, 페이지 ID, 관리 중인 즐겨찾기의 제목과 이모지를 로컬에 저장합니다. 페이지 본문·쿠키·인증 토큰을 읽거나 외부 서버로 전송하지 않습니다. 공식 Notion 제품이 아닌 독립 확장입니다.

자세한 사용법, 데이터 저장 계약, 제한 사항은 [확장 README](extension/notion-favorite-sections/README.md)를 참고하세요.
