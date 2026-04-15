# CLAUDE.md — RTL Converter IDE 개발 컨텍스트

이 파일은 Claude Code 등 AI 에이전트가 이 프로젝트를 이해하고 작업할 때 참조하는 컨텍스트 문서입니다.

---

## 프로젝트 개요

삼성 DS 인트라넷 배포용 단일 HTML 파일 RTL 변환 도구입니다.  
Algorithm / μArch 문서 diff를 LLM에 분석시키고, 그 결과를 바탕으로 Verilog/SystemVerilog 또는 SystemC(HLS) 파일을 자동 변환합니다.

**핵심 원칙:** 변환 결과는 RTL 엔지니어가 직접 읽고 수정하는 중간 산출물입니다.  
따라서 원본 코드 구조/스타일/주석을 최대한 보존하고, 변경점만 최소한으로 적용합니다.

---

## 파일 구조

```
rtl_algo_converter.html    메인 앱 (~5,500줄 단일 HTML+CSS+JS)
rtl-dev-server.js          Node.js 개발 서버
rtl-converter-config.js    튜닝 설정
env.example                .env 템플릿
```

**단일 파일 정책:** 인트라넷 배포 특성상 모든 기능은 `rtl_algo_converter.html` 한 파일에 포함됩니다. 외부 CDN 의존 없음.

---

## 아키텍처

```
브라우저 (rtl_algo_converter.html)
    │
    ├── /env, /config           환경 설정 로드
    ├── /llm-proxy              LLM 요청 프록시 (CORS 우회)
    ├── /save-log               LLM 대화 로그 저장
    └── /lint                   Verilog/SystemC lint 실행
         ↓
    rtl-dev-server.js (Node.js, localhost:3000)
         ↓
    ├── OpenAI Compatible LLM 서버 (사내 서버)
    └── verible / iverilog / clang++ (로컬 설치)
```

---

## 전체 변환 플로우

```
Step 0 (cur=0): RTL 파일 업로드
  → addRtlFiles() → buildDepGraph() 자동 실행
  → _depGraph: 모듈 인스턴스 관계 (2-hop BFS용)

Step 1 (cur=1): Algorithm AS-IS/TO-BE 등록
Step 2 (cur=2): Algo Diff + AI 분석
  → reAnalyzeImpact('algo') → _impactData.algo
  → ALGO-001, ALGO-002 ... ID 부여 (항상 001부터 시작)

Step 3 (cur=3): μArch AS-IS/TO-BE 등록
Step 4 (cur=4): μArch Diff + AI 분석
  → reAnalyzeImpact('uarch') → _impactData.uarch
  → ARCH-001, ARCH-002 ... ID 부여 (항상 001부터 시작)

Step 5 (cur=5): Summary
  → Phase 1: runSummaryPhase1() — Target RTL 선정
    dep graph 힌트 포함하여 LLM이 target/ref/exclude 판단
  → Phase 2: runSummaryPhase2() — μArch 섹션 매핑

Step 6 (cur=6): RTL 변환
  → checkTokensAndRun()
    < 128K → _runBatchNow('single')
    ≥ 128K + largeCxtModel → _runBatchNow('single') 그대로
    ≥ 128K + 일반 모델 → 경고 모달 (순차/단일 선택)
  → 변환 후 lintAndFix() 자동 실행 (dev 서버 연결 시)
    오류 시 LLM 자동 재시도 최대 2회
```

---

## 핵심 전역 상태

```javascript
// 파일 목록
rtlFiles[]        // { name, content, status, result, changes, history, lintResult, _p1Excluded, _p1Ref }
algoPairs[]       // Algo diff 페어
uarchPairs[]      // μArch diff 페어

// AI 분석 결과
_impactData       // { algo: {items[], summary}, uarch: {items[], summary} }
_impactHistory    // undo 스택
_impactRedo       // redo 스택

// Summary 결과
_summaryTargetFiles[]     // Phase 1 결과
_summaryUarchSections[]   // Phase 2 결과
_summaryAnalysisDone      // Summary 완료 여부

// 의존성 그래프
_depGraph         // { fname: { moduleNames, instantiates[], instantiatedBy[], portBindings{} } }

// 출력 언어
_outputLang       // 'rtl' | 'systemc'
getLang()         // LANG_CFG[_outputLang] — 언어별 설정 객체

// 실행 모드
_currentRunMode   // 'single' | 'sequential'
convMode          // 'single' (고정 상수)
```

---

## 언어별 설정 (LANG_CFG)

```javascript
LANG_CFG = {
  rtl: {
    fileExts:     /\.(v|sv|verilog)$/i,
    expert:       'You are an expert RTL (Verilog/SystemVerilog) engineer.',
    construct:    'signal/port/always block/parameter',
    extractSig:   'verilog',   // extractSignature() 분기 기준
    ...
  },
  systemc: {
    fileExts:     /\.(cpp|h|hpp|cc)$/i,
    expert:       'You are an expert SystemC/HLS engineer.',
    construct:    'SC_MODULE/port/signal/process/channel/HLS pragma',
    extractSig:   'systemc',
    ...
  }
}
```

---

## LLM 호출 구조

모든 LLM 호출은 `callLLM(host, model, systemMsg, userMsg, onChunk, mode, signal)` 단일 함수를 통합니다.

```javascript
mode 값:
  'rtl'      변환 프롬프트 (temperature 슬라이더 적용)
  'json'     분석 프롬프트 (JSON 응답)
  'json-sel' 파일 선택 분석
  'json-sm'  항목 분류 (소형)
```

### LLM Freeze/Abort 시스템

```javascript
_llmFreeze(key, btnId, stopBtnId, label)  // 버튼 비활성화 + stop 버튼 표시 + AbortController 생성
_llmUnfreeze(key)                          // 복구
_llmAbort(key)                             // fetch abort + 복구
```

| key | 버튼 |
|---|---|
| `'algo-analyze'` | `adAnalyzeBtn` / `adStopBtn` |
| `'uarch-analyze'` | `udAnalyzeBtn` / `udStopBtn` |
| `'sum-analyze'` | `sumAnalyzeBtn` / `sumStopBtn` |
| `'iter-analyze'` | `iterAnalyzeBtn` / `iterAnalyzeStopBtn` |
| `'iter-run'` | `iterRunBtn` / `iterRunStopBtn` |

---

## 변환 프롬프트 핵심 규칙

변환 프롬프트(단일/순차/iteration) 모두 아래 규칙을 포함합니다:

```
- Preserve the original code EXACTLY — structure, indentation, whitespace,
  naming, and comments — unless a change point explicitly requires modification
- Do NOT refactor, reorganize, reorder, or rename anything not listed
- Do NOT remove or alter existing comments
- Do NOT change coding style or formatting of unmodified lines
- If a change is unavoidable in adjacent lines, keep it minimal and note in CHANGES
```

---

## CHANGES 포맷

```
SOURCE|TYPE|IDS|description

SOURCE: ALGO | UARCH | BOTH | ITER | LINT
TYPE:   ADD | MOD | REMOVE | FIX
IDS:    ALGO-001,ARCH-002  또는  NONE
```

파싱: `parseChangeLine(line)` → `{ source, type, ids[], desc, raw }`  
렌더링: `renderIdBadges(ids, clickable)` → ALGO(파란색), ARCH(보라색) 뱃지

---

## 의존성 그래프

```javascript
buildDepGraph()              // 파일 업로드 시 자동 실행
getAffectedFiles(files, 2)   // 2-hop BFS → { upstream, downstream }
buildDepGraphHint(targets)   // Phase 1 완료 후 변환 프롬프트용
buildDepGraphHintAll()       // Phase 1 미실행 시 전체 관계 요약
```

파서:
- `parseVerilogInstances()` — `ModuleName #(params) instName (ports);` 세미콜론 단위 분리
- `parseSystemCInstances()` — SC_MODULE 멤버 선언 + `.bind()` 패턴

---

## Lint 시스템

```javascript
lintFile(code, filename)              // POST /lint → { ok, errors[], warnings[], linter }
autoFixLint(f, lintResult, host, model, attempt)  // LLM 자동 수정
lintAndFix(f, host, model, stepId)   // 전체 흐름 (lint → 재시도 최대 2회)
```

`f.lintResult` 저장 후 Results 탭에 배지 + 오류 목록 표시.  
dev 서버 미연결 시 `note` 필드로 조용히 건너뜀 (기존 동작 무영향).

dev 서버 `/lint` 엔드포인트:
- RTL: `verible-verilog-syntax` → fallback `iverilog`
- SystemC: `clang++ --syntax-only`

---

## μArch 테이블 해석 규칙

μArch 내용을 LLM에 전달하는 모든 프롬프트에 `UARCH_TABLE_RULES` 상수가 포함됩니다.

적용 지점:
- `reAnalyzeImpact('uarch')` — diff 분석
- `_autoRunAnalyze('uarch')` — 일괄 실행 분석
- `runSummaryPhase2()` — μArch 섹션 매핑
- `buildContextSection()` — 변환 컨텍스트의 uarchRefSection

---

## ID 추적 시스템

```
ALGO-001, ARCH-003 등 ID가 전체 플로우에서 추적됨:

Diff AI 분석 → impact item에 ID 부여
    ↓
buildImpactText() → 프롬프트에 [ALGO-001] 포함
    ↓
LLM 변환 → // ALGO-001: 인라인 코멘트
         → CHANGES: ALGO|MOD|ALGO-001|설명
    ↓
parseChangeLine() → ids 배열 파싱
renderIdBadges(ids, clickable=true)
    ↓
클릭 → navigateToImpactId(id) → Diff 탭 이동 + 하이라이트
```

재분석 시 ID는 항상 001부터 새로 시작 (`existingIds = 'none'` 고정).

---

## 코드 수정 시 주의사항

1. **단일 파일 유지:** 외부 스크립트/CSS import 추가 금지 (인트라넷 환경)
2. **`_impactData` 선언 보존:** 코드 정리 시 실수로 삭제되지 않도록 주의  
   (`_impactSave`, `impactUndo`, `impactRedo`, `updateUndoRedoBtns`, `getImpactEl/Add/Input/Cnt` 함께 존재)
3. **`getLang()` 사용:** 언어별 분기는 하드코딩 대신 `getLang().fileDesc`, `getLang().expert` 등을 사용
4. **ID는 항상 001부터:** `reAnalyzeImpact`와 `_autoRunAnalyze`에서 `existingIds = 'none'` 유지
5. **정규식 이스케이프:** JS 정규식을 Python 스크립트로 삽입할 때 반드시 raw string `r"""..."""` 사용
6. **LLM 호출에 signal 연결:** 새 LLM 호출 추가 시 `_llmFreeze` + `signal` 파라미터 패턴 준수

---

## 개발 환경

- **OS:** Debian WSL2 (intranet)
- **런타임:** Node.js (dev 서버)
- **브라우저:** Chrome / Edge (webkit)
- **LLM:** OpenAI Compatible 서버 (현재 Kimi-K2.5 256K context)
- **Git:** `Vegitime-bot/RTL_conv_IDE`
