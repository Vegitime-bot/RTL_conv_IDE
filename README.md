# RTL Converter IDE

Algorithm / μArch 문서 변경을 기반으로 Verilog/SystemVerilog 또는 SystemC(HLS) 코드를 자동 변환하는 단일 HTML 도구입니다.  
삼성 DS 인트라넷 환경에서 동작하며 OpenAI Compatible LLM 서버와 연동합니다.

---

## 파일 구성

```
rtl_algo_converter.html    메인 앱 (단일 HTML — 이것 하나로 동작)
rtl-dev-server.js          Node.js 개발 서버 (LLM 프록시 + lint 엔드포인트)
rtl-converter-config.js    동작 튜닝 설정 파일
env.example                .env 템플릿 (→ .env로 복사 후 작성)
```

---

## 빠른 시작

### 1. 환경 설정

```bash
cp env.example .env
```

`.env` 파일을 열어 LLM 서버 정보를 입력합니다:

```env
BASE_URL=http://your-llm-server/v1   # OpenAI Compatible 서버 주소
API_KEY=sk-...                        # API Key (없으면 빈칸)
DEFAULT_MODEL=your-model-name         # 기본 모델명
```

### 2. dev 서버 실행

```bash
node rtl-dev-server.js
```

브라우저에서 `http://localhost:3000` 접속.

### 3. 직접 열기 (dev 서버 없이)

`rtl_algo_converter.html`을 브라우저에서 직접 열어도 동작합니다.  
이 경우 `.env` 자동 로드, LLM 로그 저장, lint 검사 기능은 사용 불가합니다.

---

## 주요 기능

### 전체 변환 플로우 (7단계)

```
Step 1: RTL / SystemC 파일 업로드
Step 2: Algorithm 문서 등록 (AS-IS / TO-BE 매핑)
Step 3: Algo Diff → AI 분석 (ALGO-xxx ID 부여)
Step 4: μArch 문서 등록 (AS-IS / TO-BE 매핑)
Step 5: μArch Diff → AI 분석 (ARCH-xxx ID 부여)
Step 6: Summary (Target 파일 선정 + μArch 섹션 매핑)
Step 7: 변환 결과 (Results + Iteration)
```

### 일괄 실행 (`⚡ 일괄 실행` 버튼)

파일 등록 후 버튼 하나로 전체 흐름을 자동 실행합니다.

- Algo AI 분석 + μArch AI 분석을 **병렬** 실행
- 완료 후 Summary 분석 자동 수행
- 토큰 수 자동 계산 → 128K 초과 시 순차 처리 자동 전환

### 출력 언어 선택

Step 1에서 출력 언어를 선택합니다:

| 언어 | 입력 파일 | 특징 |
|---|---|---|
| Verilog / SystemVerilog | `.v`, `.sv` | RTL 레벨 변환 |
| SystemC (HLS) | `.cpp`, `.h`, `.hpp` | HLS 레벨 변환 |

### 변환 강도 슬라이더

cfg 바의 슬라이더로 LLM 파라미터를 조절합니다:

| 단계 | temperature | seed | 용도 |
|---|---|---|---|
| ① 정확 | 0 | 42 (고정) | 기본, 항상 동일한 결과 |
| ② 재시도 | 0.2 | 랜덤 | 결과가 아쉬울 때 |
| ③ 탐색 | 0.5 | 랜덤 | 완전히 다른 방법 시도 |

### 모듈 의존성 그래프 (2-hop)

파일 업로드 시 자동으로 모듈 간 인스턴스 연결 관계를 파싱합니다.  
Phase 1과 변환 프롬프트에 upstream/downstream 정보를 자동 주입하여 2-hop 이상의 포트 변경을 LLM이 인지하도록 합니다.

### Lint 검증 (생성 후 자동)

RTL/SystemC 변환 완료 후 dev 서버를 통해 자동으로 lint를 실행합니다.

- 오류 발견 시 LLM에 자동 재시도 (최대 2회)
- Results 탭에 `✓ lint` / `⚠ lint N개 오류` 배지 표시
- 우측 패널에 오류 목록과 라인 번호 표시

---

## Lint 도구 설치 (선택)

dev 서버가 실행 중일 때만 동작합니다. 미설치 시 lint 건너뜀.

### Verilog / SystemVerilog

```bash
# Debian / Ubuntu (WSL2)
# verible 권장
apt install verible

# 또는 iverilog (fallback)
apt install iverilog
```

verible이 없으면 iverilog로 자동 fallback됩니다.

### SystemC (HLS)

```bash
apt install clang
```

---

## 설정 파일 (`rtl-converter-config.js`)

dev 서버 실행 시 `/config` 엔드포인트로 자동 로드됩니다.  
직접 열기 시에는 HTML 내 기본값이 사용됩니다.

### 주요 설정 항목

```js
RTL_CONVERTER_CONFIG = {
  // μArch 문서 청크 분할 전략
  uarchChunk: {
    strategy: 'both',          // 'heading' | 'token' | 'both'
    activeHeadingLevel: 2,     // ## 까지 헤딩으로 분할
    maxChunkTokens: 1500,      // 청크당 최대 토큰
    overlapTokens: 200,        // 청크 간 overlap
    bothMergeSmall: true,      // 작은 청크 병합
    bothMergeThreshold: 300,   // 병합 기준 토큰 수
  },

  // Phase 1 Target 선정
  targetRtl: {
    includeExcludedAsRef: false,  // 제외 파일 참조용 포함 여부
    signatureOnly: true,           // 참조 포함 시 시그니처만 전달
  },

  // Phase 2 μArch 섹션 매핑
  uarchMapping: {
    maxSectionsPerFile: 5,  // 파일당 최대 관련 섹션 수
  },

  // 128K 초과에도 단일 컨텍스트로 실행할 모델 목록
  // 대소문자 무시 + 부분 일치로 비교
  largeCxtModels: [
    'Kimi-K2.5',   // Moonshot Kimi K2.5 — 256K context
  ],
};
```

---

## μArch 문서 테이블 포맷

μArch 문서에 테이블이 포함된 경우 아래 형식으로 인코딩하면 LLM이 정확히 해석합니다:

```
[TABLE 1 | SCHEMA]: 항목; 값; 비고
[TABLE 1 | ROW 1]: 항목=data_width; 값=64; 비고=ALU 출력 폭
[TABLE 1 | ROW 2]: 항목=pipeline_stage; 값=3; 비고=<SAME_AS_ABOVE>

<SAME_AS_ABOVE>  = 위 셀과 동일한 값
<SAME_AS_LEFT>   = 왼쪽 셀과 동일한 값
■, ●, ✔, ▶      = 선택/True
□, ○, △          = 미선택/False
```

---

## dev 서버 엔드포인트

| 경로 | 메서드 | 설명 |
|---|---|---|
| `/ping` | GET | 서버 상태 확인 |
| `/env` | GET | `.env` 설정값 반환 |
| `/config` | GET | `rtl-converter-config.js` 반환 |
| `/llm-proxy` | POST | LLM 요청 프록시 (`X-Target-URL` 헤더 필요) |
| `/get-proxy` | GET | GET 요청 프록시 (모델 목록 조회 등) |
| `/save-log` | POST | LLM 대화 로그 저장 (`rtl_converter_llm_log.json`) |
| `/lint` | POST | Verilog/SystemC lint 실행 |

---

## 주의 사항

- 일괄 실행 시 사용자 확인 없이 자동으로 변환됩니다. AI 분석 결과가 부정확하면 변환 결과도 부정확할 수 있습니다.
- 변환 결과는 사람이 검토 후 사용하는 것을 전제로 합니다.
- 인트라넷 환경에서는 외부 CDN 없이 동작하도록 설계되어 있습니다.
