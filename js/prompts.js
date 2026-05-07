// ── prompts.js ──────────────────────────────────────────
// 시스템 프롬프트 / 언어 설정 / μArch 테이블 해석 규칙
// 메인 HTML 의 inline <script> 에서 분리된 모듈.
// 글로벌 스코프 공유 (script 태그 분리만 하고 모듈 시스템 미사용).
//
// 정의: _outputLang, UARCH_TABLE_RULES, LANG_CFG, getLang(), setOutputLang()
// 외부 의존: renderRtl, updateCtxEstimate, dbgLog (메인 HTML 정의)
// ────────────────────────────────────────────────────────

// ── 출력 언어 설정 ────────────────────────────────────────
let _outputLang = 'rtl';  // 'rtl' | 'systemc'

// ── μArch 문서 테이블 해석 규칙 ─────────────────────────
// μArch 내용을 LLM에 전달할 때 항상 앞에 포함
const UARCH_TABLE_RULES = `[μArch Document Interpretation Rules]
The following μArch content may contain plain text and/or encoded table data.

Table encoding format:
  [TABLE n | SCHEMA]: column names of table n
  [TABLE n | ROW k]: row k of table n, encoded as column=value pairs separated by semicolons

Rules for interpreting tables:
- Treat tables as the PRIMARY source of factual information over plain text.
- For questions involving conditions, numbers, criteria, periods, comparisons, or lists — check table rows first.
- Each row is a complete, independent record.
- Merged cells have already been expanded into individual rows.
- Restore these markers before interpreting:
    <SAME_AS_ABOVE> = same value as the cell above in the same column
    <SAME_AS_LEFT>  = same value as the cell to the left in the same row
- If multiple rows match a query, consider ALL relevant rows.
- Do not guess missing or unclear values.
- For multiple-choice / checkbox items:
    A filled/checked/emphasized mark (■ ● ✔ ▶) means SELECTED / TRUE.
    An empty/unemphasized mark (□ ○ △) means UNSELECTED / FALSE.
    Judge by mark state only, not by shape.
`;



const LANG_CFG = {
  rtl: {
    label:        'Verilog / SystemVerilog',
    badge:        'Verilog / SystemVerilog',
    fileAccept:   '.v,.sv,.verilog',
    fileExts:     /\.(v|sv|verilog)$/i,
    dzHint:       '.v / .sv',
    modeHint:     '— .v / .sv 파일 · RTL 레벨 변환',
    expert:       'You are an expert RTL (Verilog/SystemVerilog) engineer.',
    iterExpert:   'You are an expert RTL (Verilog/SystemVerilog) engineer.',
    impactExpert: 'You are an expert RTL (Verilog/SystemVerilog) engineer.',
    commentStyle: '// ALGO: / // UARCH: / // BOTH:',
    commentIter:  '// ITER:',
    fileDesc:     'RTL',
    sampleFile:   'filename.v',
    construct:    'signal/port/always block/parameter',
    noFileHint:   'RTL 파일 없음 — Step 1에서 추가하세요',
    sigLabel:     '=== Module signature:',
    extractSig:   'verilog',
  },
  systemc: {
    label:        'SystemC (HLS)',
    badge:        'SystemC / HLS',
    fileAccept:   '.cpp,.h,.hpp,.cc',
    fileExts:     /\.(cpp|h|hpp|cc)$/i,
    dzHint:       '.cpp / .h / .hpp',
    modeHint:     '— .cpp / .h / .hpp 파일 · HLS/SystemC 레벨 변환',
    expert:       'You are an expert SystemC/HLS (High-Level Synthesis) engineer.',
    iterExpert:   'You are an expert SystemC/HLS engineer.',
    impactExpert: 'You are an expert SystemC/HLS engineer familiar with Verilog RTL concepts.',
    commentStyle: '// ALGO: / // UARCH: / // BOTH:',
    commentIter:  '// ITER:',
    fileDesc:     'SystemC',
    sampleFile:   'filename.cpp',
    construct:    'SC_MODULE/port/signal/process/channel/HLS pragma',
    noFileHint:   'SystemC 파일 없음 — Step 1에서 추가하세요',
    sigLabel:     '=== SC_MODULE signature:',
    extractSig:   'systemc',
  },
};

function getLang() { return LANG_CFG[_outputLang] || LANG_CFG.rtl; }

function setOutputLang(lang) {
  _outputLang = lang;
  const cfg = getLang();

  // 헤더 badge
  const badge = document.getElementById('langBadge');
  if (badge) badge.textContent = cfg.badge;

  // 파일 업로드 input accept
  const rtlIn = document.getElementById('rtlIn');
  if (rtlIn) rtlIn.accept = cfg.fileAccept;

  // DZ 힌트
  const dzHint = document.getElementById('dzFileHint');
  if (dzHint) dzHint.textContent = cfg.dzHint;

  // 모드 힌트
  const modeHint = document.getElementById('langModeHint');
  if (modeHint) modeHint.textContent = cfg.modeHint;

  // 파일 확장자 필터 업데이트 → 기존 파일 목록 클리어 안 함 (언어 전환 시 파일 유지)
  // Diff 패널 헤더 동적 갱신
  ['algoPanelHdr','uarchPanelHdr'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = `${cfg.fileDesc} 관련 변경점`;
  });
  document.querySelectorAll('.langFileDesc').forEach(el => {
    el.textContent = cfg.fileDesc;
  });

  // Step 1 stepbar 버튼 텍스트 업데이트
  const s0 = document.getElementById('s0');
  if (s0) s0.querySelector('.sn').nextSibling ? null : null; // 구조 유지

  renderRtl();
  updateCtxEstimate();
  dbgLog('INF', `[lang] 출력 언어 전환: ${cfg.label}`, 'inf');
}
