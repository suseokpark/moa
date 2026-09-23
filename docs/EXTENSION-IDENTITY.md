# FAVMOA: fixed development identity

Introduced in **0.1.11**. No Chrome Web Store upload or publication was performed.

현재 릴리스는 **0.1.21**입니다. Google 연결·Drive 백업은 0.1.14부터 보류했으며 현재 화면과 배포 권한에 포함하지 않습니다. 아래 OAuth 값은 과거 설정을 보존한 기록이지 현재 사용 가능한 로그인 안내가 아닙니다.

## 고정 ID와 보류한 Google 설정

**확장 프로그램 ID / Item ID**

```text
ebbgmhdbonpillbfjapebljagnbjembj
```

향후 Google 연결을 재개한다면 Chrome Extension 유형 OAuth 클라이언트의 **Item ID**와 위 고정 ID를 대조해야 합니다. `….apps.googleusercontent.com` 값은 별개의 **OAuth 클라이언트 ID**입니다. 0.1.12에는 사용자가 제공한 다음 공개 클라이언트 ID를 반영했으며, 현재는 보류 설정 파일에만 보존합니다.

```text
24454578838-6nqb1s33u6djs6inpn2jud1nfq0ojevn.apps.googleusercontent.com
```

Google Cloud 콘솔의 실제 클라이언트 유형·Item ID 연결, Drive API 활성화, OAuth 동의 화면·테스트 사용자 설정은 미확인입니다. 실제 로그인·Drive 백업/읽기·다른 PC 복원도 검증하지 않았습니다. 과거 `openid`, `email`, `https://www.googleapis.com/auth/drive.appdata` 범위는 [보류 설정](../extension/notion-favorite-sections/config/google-cloud.deferred.json)에만 남아 있습니다. 현재 manifest에는 `oauth2`, `identity`, Google API 호스트 권한이 없고 클라우드 모듈도 배포 ZIP에서 제외합니다. OAuth client secret을 소스나 확장에 넣지 마세요.

현재는 Google 연결 버튼이나 Drive 백업을 사용할 수 없습니다. 기기 간 이동은 **JSON 백업·복원**을 사용하세요. Google 재개에는 별도 결정·권한 설계·실계정 검증이 필요합니다. 현행 기능과 복원 주의 사항은 [확장 README](../extension/notion-favorite-sections/README.md)를 참고하세요.

## 무엇이 고정되는가

- `manifest.json`의 `key`는 RSA 2048-bit **공개키**의 DER SPKI 데이터를 base64로 인코딩한 값입니다. 비밀정보가 아니며 동일 파일을 다른 컴퓨터에 배포할 수 있습니다.
- 이 공개키의 SHA-256 앞 16바이트를 Chrome 확장 ID의 a–p 문자로 변환하면 위 ID가 됩니다. 설치 경로나 운영체제에 의존하지 않습니다.
- `extension-identity.json`은 승인된 ID와 공개키의 전체 SHA-256을 고정합니다. 빌드/검사는 실제 키와 이 메타데이터가 일치하지 않으면 실패합니다. 빌드마다 키를 다시 생성하지 않습니다.
- 고정 ID는 **데이터 동기화 기능이 아닙니다**. 다른 컴퓨터·Chrome 프로필에서 기존 로컬 데이터가 저절로 나타나지 않습니다.
- 기존 키 없는 설치는 경로 기반 ID였기 때문에 이 ID로 바뀝니다. 같은 설치 폴더를 사용해도 첫 전환의 데이터 이전이 자동 보장되지 않습니다.

공개키 SHA-256:

```text
4116c731edf8bb1590f41b906d194c19ed573841798846e40697095511fe5810
```

## 기존 데이터 안전하게 옮기기

**키 없는 0.1.10 이하에서 처음 전환할 때 기존 확장을 삭제·초기화하거나 키 있는 0.1.11 이상을 기존 폴더에 바로 덮어쓰지 마세요.** 이미 0.1.11~0.1.20의 고정 ID로 설치한 경우는 아래 이전 절차를 반복하지 않고 JSON 백업 후 같은 폴더에서 0.1.21로 업데이트합니다.

1. **Moa 0.1.9 사용자는 먼저** 원래 설치 폴더에 보관된 **키 없는 FAVMOA 0.1.10**의 파일로 업데이트하고 `chrome://extensions`에서 기존 확장을 새로고침합니다. 기존 ID가 유지되는지 확인합니다. 0.1.9에는 범용 JSON 내보내기 기능이 없습니다.
2. 0.1.10 사이드 패널의 **기존 Moa 목록 가져오기**로 필요한 구형 Notion 트리를 범용 보관함으로 복사합니다. 이름이 ID로 보이면 기존 Notion 화면에서 제목을 복구한 뒤 가져옵니다. 범용 보관함만 사용했다면 이 단계는 불필요합니다.
3. 보관함·링크 개수·이름·그룹/섹션을 확인하고 **전체 보관함 내보내기**로 JSON을 안전하게 보관합니다. 이 JSON에는 링크 제목과 URL이 포함됩니다.
4. **0.1.11 이상 ZIP은 새 폴더에 압축 해제**하여 별도 확장으로 로드합니다. 현재 배포 파일은 `favmoa-v0.1.21.zip`입니다. 표시된 ID가 위 고정 ID와 일치하는지 확인합니다.
5. 새 확장에서 **백업 파일 가져오기**를 눌러 JSON을 선택하고 전체 보관함 교체 확인 후 복원합니다. 새 확장에 따로 만든 링크가 있다면 먼저 내보내세요.
6. 제목·링크 개수·분류를 비교합니다. 기존 확장은 보존하고, Notion 메뉴가 이중으로 나타나면 구형 확장을 **비활성화**합니다. 삭제할 필요는 없습니다.

이전 Notion 원본 `nfs:workspace:` / `nfs:metadata:` 저장소 자체를 새 ID로 복사하는 기능은 아닙니다. 2단계에서 변환한 **범용 보관함 복사본**을 옮깁니다. 구형 Notion 내부 트리는 기존 확장에 남으며 새 범용 트리와 자동 동기화되지 않습니다.

**0.1.11~0.1.20 → 0.1.21:** 공개키·확장 ID가 같습니다. 안전을 위해 JSON을 먼저 내보내고 기존 설치 폴더의 파일을 업데이트한 뒤 `chrome://extensions`에서 새로고침하세요. 확장을 삭제하거나 초기화할 필요가 없습니다. 이후에도 같은 공개키의 업데이트는 이 경로를 유지합니다. 이전용 키 없는 0.1.10 ZIP은 삭제하지 않고 보존합니다.

개발 컴퓨터에서 Chrome에 등록한 경로 `artifacts/favmoa-v0.1.13`은 폴더 이름만 역사적으로 유지합니다. 현재 그 안의 프로그램은 **0.1.21**이며, 폴더 이름으로 설치 버전을 판단하지 않습니다. Chrome 관리 화면의 버전과 `manifest.json`을 확인하세요. 이 경로는 다른 사용자가 반드시 따라야 하는 설치 경로가 아닙니다.

0.1.21에서 색상을 지정한 그룹의 저장 데이터·백업은 0.1.20 이하에서 읽을 수 없습니다. 기존 저장소 위에 구버전을 덮는 다운그레이드는 지원하지 않으므로 업데이트 전 JSON을 별도로 보관하세요.

## 개인키 보관

- 대응하는 서명 개인키는 개발 컴퓨터 저장소의 `.private/favmoa-signing-key.pem`에만 생성했습니다. 디렉터리 권한은 700, 파일 권한은 600입니다.
- `.private/`, `*.pem`, `*.key`는 Git에서 제외합니다. 개인키는 확장 소스 디렉터리 밖에 있으며 배포 ZIP·로그·manifest에는 포함하지 않습니다.
- 같은 개발용 ID로 압축 해제 설치를 하는 데에는 개인키가 필요 없습니다. 배포에는 공개키가 포함된 ZIP만 전달합니다.
- 서명 키는 필요시 접근이 제한된 보관소에 별도로 백업하세요. 재생성하면 같은 공개키/ID가 되지 않습니다. 개인키 내용을 채팅에 붙여 넣지 마세요.

## 향후 웹스토어 등록

현재 고정된 것은 **개발용 압축 해제 설치의 ID**입니다. 스토어에서 할당·서명하는 ID까지 이번 작업으로 확보한 것은 아닙니다. 최초 등록 시 스토어의 Item ID/공개키를 비교하고, ID가 다르면 OAuth 설정과 데이터 이전 계획을 함께 검토해야 합니다. 기존 사용자에게 키를 조용히 교체하여 배포하지 마세요. 스토어 등록·서명 패키지 제출·실제 다른 PC 설치는 이번 작업에서 수행하지 않았습니다.

공식 설명: [Chrome manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key), [Chrome OAuth 설정](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth).

## 재검증

```sh
npm test
npm run check:extension-package
npm run package:extension
node extension/notion-favorite-sections/scripts/package-extension.mjs --verify artifacts/favmoa-v0.1.21.zip
```

ID 검증은 실제 공개키에서 계산하며 경로가 다른 소스 복사본에서도 반복합니다. Chrome 설치 후에는 `chrome://extensions`의 실제 ID와 위 값을 별도로 비교하세요. 단위 테스트 통과만으로 Google 인증이나 기기 간 복원이 검증되는 것은 아닙니다.
