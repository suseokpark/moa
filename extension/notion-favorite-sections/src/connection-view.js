// Presentation-only guidance. Never include raw OAuth errors, tokens or account data.
const GUIDES = {
  IDENTITY_UNAVAILABLE: ["이 브라우저에서는 Google 연결을 사용할 수 없어요", "일반 Google Chrome에 설치한 확장에서 다시 시도하세요. 현재 브라우저에서는 로컬 링크 정리와 파일 백업을 사용할 수 있습니다."],
  AUTH_NETWORK: ["Google 로그인 서버에 연결하지 못했어요", "인터넷 연결과 회사 네트워크의 Google 접속 제한을 확인한 뒤 다시 시도하세요."],
  AUTH_ACCOUNT_UNAVAILABLE: ["이 브라우저에서 Google 계정을 확인해 주세요", "일반 Chrome 창에서 Google 로그인을 확인한 뒤 다시 연결하세요. 브라우저가 로그인을 요청하면 해당 창에서 완료해 주세요."],
  BACKGROUND_UNAVAILABLE: ["확장과의 연결이 끊겼어요", "chrome://extensions에서 팹모아를 새로고침한 뒤 사이드패널을 닫았다가 다시 여세요. 저장한 링크는 유지됩니다."],
  ACCOUNT_PERMISSION: ["Google 계정 정보를 확인하지 못했어요", "계정 확인 권한과 조직의 앱 접근 정책을 확인하세요. 아직 Drive 백업 단계에는 도달하지 않았습니다."],
  OAUTH_CONFIG: ["Google 로그인 설정을 확인해 주세요", "Google Cloud의 클라이언트 유형이 ‘Chrome 확장 프로그램’인지, 등록한 확장 ID가 아래 현재 ID와 같은지 확인하세요."],
  CONFIG_REQUIRED: ["Google 로그인 설정이 필요해요", "설치한 확장을 최신 버전으로 새로고침하세요. OAuth 클라이언트와 확장 ID는 서로 다른 값입니다."],
  AUTH_CANCELLED: ["Google 연결을 취소했어요", "다시 연결할 수 있어요. 로그인하지 않아도 링크 저장과 파일 백업은 계속 사용할 수 있습니다."],
  AUTH_DENIED: ["Google에서 연결을 허용하지 않았어요", "테스트 앱이라면 Google Cloud의 테스트 사용자에 사용할 계정이 등록되어 있는지 확인하세요. 회사 계정은 관리자 정책도 확인해야 합니다."],
  AUTH_TIMEOUT: ["Google 연결 응답을 기다리는 중이에요", "열려 있는 Google 창을 완료하거나 닫아 주세요. 창이 없거나 계속 막히면 확장을 새로고침하세요. 로컬 목록은 유지됩니다."],
  AUTH_IN_PROGRESS: ["이미 Google 연결을 진행하고 있어요", "열려 있는 Google 로그인 창을 완료하거나 닫은 뒤 다시 시도해 주세요."],
  AUTH_REQUIRED: ["Google에 다시 연결해 주세요", "인증이 만료되었거나 완료되지 않았습니다. 연결을 다시 진행해도 저장한 링크는 삭제되지 않습니다."],
  PERMISSION_REQUIRED: ["백업에 필요한 권한을 확인해 주세요", "계정 확인과 팹모아 전용 Drive 앱 데이터 권한이 필요합니다. 일반 Drive 문서 읽기 권한은 요청하지 않습니다."],
  DRIVE_PERMISSION: ["Drive 백업 권한을 확인해 주세요", "Google Cloud에서 Drive API 사용 설정과 앱 데이터 권한 승인을 확인하세요. 로그인 성공과 Drive 백업 성공은 별개입니다."],
  NETWORK_ERROR: ["Google에 연결하지 못했어요", "인터넷 연결을 확인한 뒤 다시 시도하세요. 회사 네트워크의 Google 접속 제한이 있는지도 확인해 주세요."],
  TIMEOUT: ["Google 응답 시간이 길어지고 있어요", "연결 상태를 확인하고 잠시 뒤 다시 시도해 주세요. 로컬 링크는 계속 사용할 수 있어요."],
  EXTENSION_UNAVAILABLE: ["확장을 다시 열어주세요", "chrome://extensions에서 팹모아를 새로고침한 뒤 사이드패널을 닫았다가 다시 여세요."],
  DEMO_ONLY: ["이 화면은 브라우저 미리보기예요", "실제 Google 로그인은 설치한 Chrome 확장의 사이드패널에서 진행하세요. 이 화면은 Google에 데이터를 전송하지 않습니다."],
  BACKUP_RESULT_UNKNOWN: ["백업 결과를 먼저 확인해 주세요", "이미 저장되었을 수 있습니다. ‘다른 기기의 백업 가져오기’에서 목록을 확인한 뒤 다시 백업하세요."],
  AUTH_FAILED: ["Google 연결을 완료하지 못했어요", "아래 연결 진단을 복사해 알려주세요. Google 창에 오류가 보인다면 그 문구도 함께 보내주세요. 로컬 링크는 유지됩니다."]
};

export function connectionGuide(code) {
  const safeCode = Object.hasOwn(GUIDES, code) ? code : "AUTH_FAILED";
  const [title, action] = GUIDES[safeCode];
  return { code: safeCode, title, action };
}

export function connectionDiagnostic(status = {}, error = {}) {
  const safe = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : "확인 불가";
  return [
    "FAVMOA 연결 진단 (계정·링크·토큰 제외)",
    `버전: ${safe(status.version, /^\d+\.\d+\.\d+(?:\.\d+)?$/u)}`,
    `실행 환경: ${status.demo ? "브라우저 미리보기" : "Chrome 확장"}`,
    `확장 ID: ${safe(status.extensionId, /^[a-p]{32}$/u)}`,
    `OAuth 클라이언트 ID: ${safe(status.clientId, /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u)}`,
    `로컬 설정 형식: ${status.demo ? "미리보기에서는 검사하지 않음" : status.configured ? "확인됨 (Cloud 등록 상태 미검증)" : "확인 필요"}`,
    `인증 API: ${status.demo ? "미리보기에서는 사용 안 함" : status.identityAvailable ? "사용 가능" : "확인 필요"}`,
    `오류 코드: ${error.code ? connectionGuide(error.code).code : "없음"}`,
    `오류 단계: ${["authorization", "account", "drive", "configuration", "runtime", "storage"].includes(error.stage) ? error.stage : "없음"}`,
    "Google Cloud의 클라이언트 유형·확장 ID 등록·테스트 사용자·Drive API 설정은 별도 확인이 필요합니다."
  ].join("\n");
}
