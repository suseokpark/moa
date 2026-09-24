/**
 * Purpose-built synthetic personas, not surveyed people or demographic samples.
 * Interest/goal copy varies; experience and operating conditions are deliberately
 * assigned for regression coverage and do not describe anyone's psychology.
 */
const families = [
  ["소프트웨어 개발", [
    ["웹 접근성", "web-accessibility", "접근성 참고 자료를 구현 과제별로 모아 필요한 지침을 다시 찾는다.", "accessibility"],
    ["백엔드 API", "backend-api", "API 설계 문서와 오류 해결 링크를 서비스별로 정리한다.", "backend"],
    ["모바일 앱", "mobile-apps", "모바일 화면 구현 예제와 배포 체크리스트를 구분해 보관한다.", "mobile"],
    ["데이터 엔지니어링", "data-engineering", "데이터 파이프라인 예제와 운영 참고 자료를 작업별로 찾는다.", "pipeline"],
    ["오픈소스 기여", "open-source", "기여하려는 저장소의 이슈와 참여 안내를 프로젝트별로 묶는다.", "opensource"],
  ]],
  ["인공지능 탐구", [
    ["언어 모델 평가", "language-model-evaluation", "평가 방법과 공개 벤치마크 문서를 비교 주제별로 모은다.", "evaluation"],
    ["이미지 생성", "image-generation", "이미지 생성 기법과 예시를 실험 아이디어별로 정리한다.", "generation"],
    ["음성 인터페이스", "voice-interface", "음성 인터페이스 사례와 구현 자료를 다시 찾기 쉽게 분류한다.", "voice"],
    ["AI 안전성", "ai-safety", "안전성 연구와 검증 가이드를 논점별로 나누어 보관한다.", "safety"],
    ["로컬 AI 도구", "local-ai-tools", "로컬 실행 도구의 설치 안내와 사용 예제를 도구별로 묶는다.", "localai"],
  ]],
  ["디자인", [
    ["타이포그래피", "typography", "서체 사용 예시와 조판 참고 자료를 편집 작업별로 찾는다.", "typography"],
    ["디자인 시스템", "design-systems", "컴포넌트 문서와 토큰 사례를 디자인 시스템별로 정리한다.", "tokens"],
    ["브랜드 디자인", "brand-design", "브랜드 사례와 시각 참고 자료를 프로젝트별로 모은다.", "branding"],
    ["모션 디자인", "motion-design", "전환 효과 예제와 제작 튜토리얼을 동작 유형별로 보관한다.", "motion"],
    ["서비스 디자인", "service-design", "여정 지도와 서비스 개선 사례를 조사 주제별로 연결한다.", "journey"],
  ]],
  ["제품 기획", [
    ["사용자 조사", "user-research", "인터뷰 가이드와 조사 사례를 진행 중인 질문별로 모은다.", "research"],
    ["제품 분석", "product-analytics", "지표 정의 자료와 분석 예시를 제품 과제별로 정리한다.", "analytics"],
    ["로드맵 작성", "roadmap-planning", "우선순위 결정법과 로드맵 사례를 계획 단계별로 찾는다.", "roadmap"],
    ["온보딩 설계", "onboarding-design", "첫 사용 흐름과 도움말 사례를 온보딩 단계별로 보관한다.", "onboarding"],
    ["실험 설계", "experiment-design", "제품 실험 설계 자료를 가설과 검증 방식별로 모은다.", "experiment"],
  ]],
  ["마케팅", [
    ["검색 콘텐츠", "search-content", "검색 의도와 콘텐츠 제작 자료를 주제별로 다시 찾는다.", "searchcontent"],
    ["뉴스레터 운영", "newsletter-operations", "뉴스레터 구성 예시와 운영 참고 자료를 발행 단계별로 묶는다.", "newsletter"],
    ["커뮤니티 운영", "community-operations", "커뮤니티 활동 사례와 운영 가이드를 행사별로 정리한다.", "community"],
    ["캠페인 기획", "campaign-planning", "캠페인 사례와 제작 참고 링크를 캠페인별로 보관한다.", "campaign"],
    ["시장 조사", "market-research", "공개 시장 자료와 조사 방법을 검토 주제별로 모은다.", "market"],
  ]],
  ["영업과 고객 지원", [
    ["제안서 구성", "proposal-writing", "제안서 구성 예시와 공개 템플릿을 제안 단계별로 정리한다.", "proposal"],
    ["제품 데모", "product-demos", "제품 시연 아이디어와 데모 자료를 소개 시나리오별로 모은다.", "demo"],
    ["고객 교육", "customer-education", "교육 과정 예시와 안내 자료를 학습 단계별로 찾는다.", "education"],
    ["지원 문서", "support-docs", "문제 해결 안내와 도움말 작성 사례를 문의 유형별로 묶는다.", "support"],
    ["파트너 협업", "partner-collaboration", "공개 파트너 프로그램과 협업 사례를 검토 목적별로 보관한다.", "partners"],
  ]],
  ["창업과 업무 운영", [
    ["사업 아이디어", "business-ideas", "문제 탐색 자료와 사업 사례를 아이디어별로 모은다.", "ideas"],
    ["업무 자동화", "workflow-automation", "반복 작업 자동화 예제를 업무 흐름별로 찾아 적용한다.", "automation"],
    ["원격 협업", "remote-collaboration", "비동기 협업 안내와 팀 운영 사례를 협업 방식별로 정리한다.", "remote"],
    ["지식 관리", "knowledge-management", "지식 정리 방식과 도구 설명을 보관 목적별로 비교한다.", "knowledge"],
    ["프로젝트 운영", "project-operations", "프로젝트 운영 체크리스트와 회고 방법을 단계별로 보관한다.", "projects"],
  ]],
  ["개인 재무 학습", [
    ["가계부 정리", "budget-tracking", "가계부 도구 안내와 기록 양식을 사용 목적별로 정리한다.", "budget"],
    ["금융 용어 학습", "finance-vocabulary", "금융 용어 설명 자료를 학습 단원별로 모아 다시 읽는다.", "finance"],
    ["공공 지원 정보", "public-support", "공개 지원 제도 안내를 확인할 주제별로 보관한다.", "publicsupport"],
    ["소비 계획", "purchase-planning", "구매 후보의 공개 제품 정보를 비교 항목별로 모은다.", "purchase"],
    ["재무 독서", "finance-reading", "재무 관련 도서 소개와 읽기 기록 참고 자료를 독서 계획별로 묶는다.", "financereading"],
  ]],
  ["학습과 언어", [
    ["영어 작문", "english-writing", "영어 작문 연습과 표현 자료를 글쓰기 과제별로 모은다.", "english"],
    ["일본어 읽기", "japanese-reading", "일본어 읽기 연습 자료를 학습 주제와 단계별로 찾는다.", "japanese"],
    ["수학 학습", "mathematics-learning", "수학 설명과 연습 자료를 개념별로 묶어 복습한다.", "mathematics"],
    ["역사 탐구", "history-exploration", "역사 자료와 해설을 탐구할 사건별로 보관한다.", "history"],
    ["온라인 강좌", "online-courses", "강좌 소개와 수강 참고 링크를 학습 계획별로 정리한다.", "courses"],
  ]],
  ["글쓰기와 출판", [
    ["에세이 쓰기", "essay-writing", "에세이 참고 글과 구성 자료를 쓰고 있는 주제별로 모은다.", "essay"],
    ["소설 자료 조사", "fiction-research", "소설 배경 조사 자료를 장면과 설정별로 다시 찾는다.", "fiction"],
    ["기술 문서 작성", "technical-writing", "기술 문서 구성 안내와 예시를 문서 유형별로 보관한다.", "documentation"],
    ["독립 출판", "independent-publishing", "출판 과정 안내와 제작 자료를 준비 단계별로 정리한다.", "publishing"],
    ["인터뷰 편집", "interview-editing", "인터뷰 질문법과 편집 사례를 글의 주제별로 모은다.", "interview"],
  ]],
  ["사진과 영상", [
    ["풍경 사진", "landscape-photography", "풍경 촬영 참고 자료를 촬영 장소 유형별로 보관한다.", "landscape"],
    ["인물 조명", "portrait-lighting", "인물 조명 예시와 장비 설명을 촬영 구성별로 묶는다.", "portrait"],
    ["영상 편집", "video-editing", "편집 기법과 도구 안내를 제작 단계별로 다시 찾는다.", "editing"],
    ["다큐멘터리 제작", "documentary-production", "다큐멘터리 구성 사례와 제작 참고 자료를 조사 주제별로 정리한다.", "documentary"],
    ["색 보정", "color-grading", "색 보정 예시와 작업 흐름 자료를 표현 목적별로 모은다.", "grading"],
  ]],
  ["음악과 오디오", [
    ["기타 연습", "guitar-practice", "기타 연습 자료와 곡 해설을 연습 목표별로 보관한다.", "guitar"],
    ["피아노 학습", "piano-learning", "피아노 학습 자료를 연습곡과 기법별로 다시 찾는다.", "piano"],
    ["홈 레코딩", "home-recording", "녹음 장비 안내와 작업 예시를 녹음 단계별로 묶는다.", "recording"],
    ["전자음악 제작", "electronic-music", "사운드 제작 예제와 도구 설명을 제작 실험별로 정리한다.", "electronic"],
    ["팟캐스트 제작", "podcast-production", "진행 구성과 편집 참고 자료를 에피소드 준비별로 모은다.", "podcast"],
  ]],
  ["게임과 놀이", [
    ["보드게임 규칙", "board-game-rules", "보드게임 규칙 설명과 공개 자료를 게임별로 보관한다.", "boardgames"],
    ["인디 게임 탐색", "indie-game-discovery", "인디 게임 소개와 제작 이야기를 관심 장르별로 모은다.", "indiegames"],
    ["게임 제작", "game-development", "게임 제작 튜토리얼을 구현할 기능별로 다시 찾는다.", "gamedev"],
    ["퍼즐 탐구", "puzzle-exploration", "퍼즐 설명과 풀이 기법 자료를 퍼즐 유형별로 묶는다.", "puzzles"],
    ["테이블탑 이야기", "tabletop-storytelling", "공개 규칙과 이야기 구성 자료를 플레이 준비별로 정리한다.", "tabletop"],
  ]],
  ["여행과 지역 탐방", [
    ["도보 여행", "walking-travel", "도보 경로 소개와 지역 안내를 여행 구간별로 모은다.", "walking"],
    ["박물관 탐방", "museum-visits", "박물관 공식 안내와 전시 소개를 방문 계획별로 보관한다.", "museums"],
    ["철도 여행", "rail-travel", "철도 여행 안내와 목적지 자료를 여행 일정별로 묶는다.", "rail"],
    ["도시 건축 탐방", "architecture-walks", "건축물 소개와 도시 탐방 자료를 방문 지역별로 찾는다.", "architecture"],
    ["지역 축제 탐색", "local-festivals", "지역 축제 공개 안내를 관심 행사별로 정리한다.", "festivals"],
  ]],
  ["요리와 식문화", [
    ["집밥 조리", "home-cooking", "집밥 조리법을 재료와 요리 계획별로 다시 찾는다.", "cooking"],
    ["빵 만들기", "bread-baking", "제빵 과정 자료와 조리법을 만들 빵별로 보관한다.", "baking"],
    ["커피 추출", "coffee-brewing", "커피 추출 방법과 도구 안내를 추출 실험별로 묶는다.", "coffee"],
    ["발효 음식", "fermented-foods", "발효 음식의 식문화와 조리 참고 자료를 음식별로 모은다.", "fermentation"],
    ["세계 음식 문화", "food-cultures", "세계 음식 소개와 문화 자료를 탐구할 지역별로 정리한다.", "foodculture"],
  ]],
  ["운동과 야외 활동", [
    ["달리기 기록", "running-journals", "달리기 기록 도구와 공개 코스 정보를 활동 계획별로 정리한다.", "running"],
    ["자전거 탐방", "cycling-routes", "자전거 경로 소개와 장비 안내를 탐방 계획별로 모은다.", "cycling"],
    ["등산 준비", "hiking-preparation", "공식 탐방 안내와 준비 자료를 산행 계획별로 보관한다.", "hiking"],
    ["수영 학습", "swimming-learning", "수영 학습 자료와 시설 안내를 확인할 주제별로 찾는다.", "swimming"],
    ["스포츠 관람", "sports-viewing", "공식 경기 안내와 종목 설명을 관람 관심사별로 묶는다.", "sports"],
  ]],
  ["생활과 공간", [
    ["집 정리", "home-organization", "공간 정리 사례와 수납 정보를 정리할 공간별로 모은다.", "organization"],
    ["작업 공간 꾸미기", "workspace-design", "작업 공간 사례와 제품 정보를 배치 구상별로 보관한다.", "workspace"],
    ["식물 기르기", "plant-growing", "식물 관리 참고 자료를 기르는 식물별로 다시 찾는다.", "plants"],
    ["생활 수리", "household-repairs", "생활용품의 공식 사용 안내와 수리 정보를 물건별로 묶는다.", "repairs"],
    ["이사 준비", "moving-plans", "이사 체크리스트와 공간 계획 자료를 준비 단계별로 정리한다.", "moving"],
  ]],
  ["환경과 과학", [
    ["천문 관측", "astronomy-observation", "천문 현상 설명과 관측 안내를 관심 천체별로 보관한다.", "astronomy"],
    ["생태 관찰", "ecology-observation", "공개 생태 자료와 관찰 안내를 탐구할 생물별로 모은다.", "ecology"],
    ["기후 학습", "climate-learning", "기후 설명 자료와 공개 데이터 안내를 학습 주제별로 정리한다.", "climate"],
    ["자원 순환", "resource-circulation", "지역 자원 순환 안내와 재사용 사례를 실천 과제별로 묶는다.", "recycling"],
    ["시민 과학", "citizen-science", "공개 시민 과학 프로젝트 안내를 참여 관심사별로 찾는다.", "citizenscience"],
  ]],
  ["메이커와 공예", [
    ["목공 제작", "woodworking", "목공 제작 과정과 도구 안내를 만들 작품별로 모은다.", "woodworking"],
    ["3D 프린팅", "three-dimensional-printing", "공개 모델과 프린터 안내를 출력 프로젝트별로 보관한다.", "3dprinting"],
    ["전자 공작", "electronics-making", "전자 공작 예제와 부품 문서를 제작 기능별로 묶는다.", "electronics"],
    ["뜨개질", "knitting", "뜨개 기법과 공개 패턴 안내를 만들 소품별로 정리한다.", "knitting"],
    ["도자기 공예", "ceramic-craft", "도자기 제작 참고 자료와 작품 사례를 표현 기법별로 찾는다.", "ceramics"],
  ]],
  ["독서와 인문", [
    ["철학 읽기", "philosophy-reading", "철학 개념 해설과 도서 소개를 읽을 주제별로 모은다.", "philosophy"],
    ["문학 감상", "literature-reading", "문학 작품 소개와 비평 자료를 독서 목록별로 보관한다.", "literature"],
    ["과학 교양 독서", "popular-science-reading", "과학 교양 도서와 관련 설명 자료를 탐구 질문별로 묶는다.", "popularscience"],
    ["미술사 탐구", "art-history", "미술사 자료와 작품 해설을 시대와 주제별로 정리한다.", "arthistory"],
    ["독서 모임", "reading-club", "독서 모임 운영 사례와 토론 자료를 함께 읽을 책별로 찾는다.", "readingclub"],
  ]],
];

export const metadata = {
  kind: "purposeful-synthetic-coverage",
  language: "ko",
  personaCount: 100,
  interestFamilyCount: 20,
  interestsPerFamily: 5,
  scenarioFamilies: ["capture", "find", "organize"],
  runsPerPersona: 3,
  intendedRunCount: 300,
  assignment: {
    capture: "index % 10",
    find: "(index + 3) % 10",
    organize: "(index + 7) % 10",
    experience: "[beginner, regular, power][index % 3]",
    inputMode: "[pointer, keyboard, mixed][floor(index / 3) % 3]",
    collectionSize: "[5, 25, 80, 205, 405][(index + floor(index / 10)) % 5]",
    depth: "[1, 2, 3, 5][floor(index / 5) % 4]",
    source: "(index + floor(index / 10)) % 2: 0 = bookmarks; 1 = tabs",
  },
  assumptions: [
    "실제 사람을 조사하거나 관찰한 결과가 아닌, 관심사와 테스트 조건을 조합한 합성 페르소나입니다.",
    "경험 수준·입력 방식·자료 수·트리 깊이·가져오기 원본은 목적에 맞게 배정한 테스트 가정입니다. 관심사에서 성향을 추론하지 않았습니다.",
    "키워드와 목표는 합성 링크 자료에 의미 있는 맥락을 부여하기 위한 것으로, 외부 정보의 사실성이나 추천 적합성을 평가하지 않습니다.",
    "각 시나리오 계열의 10개 분기를 각각 10회 배정합니다. 인구 대표 표본이나 독립적인 실제 사용자 300회의 사용 기록이 아닙니다.",
    "100개 관심 맥락은 문구·정리 목표의 다양성을 제공합니다. 반복된 로직 검증이 사람의 이해도·만족도·완료 시간을 입증하지는 않습니다.",
  ],
  limitations: [
    "목적별 균형 배정이며 모든 경험 수준·입력 방식·자료 수·원본·분기의 조합을 교차 검증한 전수 설계는 아닙니다.",
    "각 시나리오 분기에 두 원본을 각각 5회, 다섯 자료 수를 각각 2회 배정합니다. 이것만으로 원본·자료 수·깊이·입력 방식 전체의 교차 조합을 검증했다고 볼 수 없습니다.",
    "입력 방식 프로필은 테스트 조건입니다. 실행기가 실제 키보드·포인터 경로를 재현하지 않은 경우 접근성이나 해당 입력 방식 검증으로 집계하면 안 됩니다.",
  ],
};

export const personas = families.flatMap(([family, interests], familyIndex) =>
  interests.map(([interest, slug, goal, english], interestIndex) => {
    const index = familyIndex * 5 + interestIndex;
    return {
      index,
      id: `P${String(index + 1).padStart(3, "0")}`,
      family,
      interest,
      goal,
      slug,
      keywords: [interest, english],
      profile: {
        experience: ["beginner", "regular", "power"][index % 3],
        inputMode: ["pointer", "keyboard", "mixed"][Math.floor(index / 3) % 3],
        collectionSize: [5, 25, 80, 205, 405][(index + Math.floor(index / 10)) % 5],
        depth: [1, 2, 3, 5][Math.floor(index / 5) % 4],
        source: (index + Math.floor(index / 10)) % 2 === 0 ? "bookmarks" : "tabs",
      },
      scenarios: {
        capture: index % 10,
        find: (index + 3) % 10,
        organize: (index + 7) % 10,
      },
    };
  }),
);
