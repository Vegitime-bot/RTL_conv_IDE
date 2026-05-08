// ── llm-client.js ───────────────────────────────────────
// LLM 호출 / 대화 로그 저장 / 다운로드
// 메인 HTML 의 inline <script> 에서 분리된 모듈.
// 글로벌 스코프 공유 (script 태그 분리만 하고 모듈 시스템 미사용).
//
// 정의: llmLog, saveReqLog(), saveLlmLog(), downloadLlmLog(), callLLM()
// 외부 의존: dbgLog, devUrl, estimateTokens, getLang, _pset, document.*
// ────────────────────────────────────────────────────────

// ── LLM 대화 로그 저장 ────────────────────────────────────
const llmLog = [];
// LOG_SERVER: devUrl('/save-log') 를 직접 사용 (포트 동적 감지 보장)

// REQUEST 단계 즉시 기록 (응답 여부와 무관) — fire-and-forget
function saveReqLog(entry) {
  llmLog.push(entry);
  if (!window._devServerAvailable) return;  // dev 서버 없으면 메모리만
  // await 없이 즉시 반환 — pending 상태에서도 기록 보장
  fetch(devUrl('/save-log'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(entry),
  }).then(res => {
    if (res.ok) res.json().then(d =>
      dbgLog('INF', `[req-log] #${d.count} 저장 → ${d.file}`, 'inf')
    );
  }).catch(e => {
    dbgLog('INF', `[req-log] 저장 실패 (${e.message}) — 메모리 누적 (${llmLog.length}건)`, 'inf');
  });
}

// RESPONSE 완료 후 기존 REQ 항목을 업데이트해서 저장
async function saveLlmLog(entry) {
  // 메모리 로그에서 같은 req_id 찾아 업데이트
  const existing = llmLog.find(e => e.req_id && e.req_id === entry.req_id);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    llmLog.push(entry);
  }
  try {
    const res = await fetch(devUrl('/save-log'), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(entry),
    });
    if (res.ok) {
      const d = await res.json();
      dbgLog('INF', `[res-log] #${d.count} 저장 → ${d.file}`, 'inf');
    } else {
      dbgLog('INF', `[res-log] 서버 응답 오류 HTTP ${res.status}`, 'inf');
    }
  } catch(e) {
    dbgLog('INF', `[res-log] dev 서버 없음 — 메모리 누적 (${llmLog.length}건)`, 'inf');
  }
}

function downloadLlmLog() {
  if (!llmLog.length) { alert('저장된 LLM 대화 로그가 없습니다.'); return; }
  const blob = new Blob([JSON.stringify(llmLog, null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rtl_converter_llm_log.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── 공통 fetch (streaming) ────────────────────────────────
//
// mode 별 파라미터 전략:
//  'rtl'     — RTL 코드 변환 (큰 출력, 엄격한 temperature/top_p)
//  'json'    — 구조화 분석 (중간 출력, 약간 유연한 top_p)
//  'json-sm' — 단일 항목 JSON (소형 출력)
//
// opts (선택):
//  Stall 감지는 phase 별로 다른 임계값 사용:
//    phase='thinking'  — 첫 청크 수신 전 (추론 모델의 thinking, 입력 처리 중)
//    phase='streaming' — 첫 청크 이후 (실제 토큰 생성 중)
//
//  firstByteWarnMs  : 첫 청크 전 이 값(ms) 초과 시 dbgLog 경고
//                     기본 300000 (5분). 추론 모델의 긴 thinking 허용
//  firstByteAbortMs : 첫 청크 전 이 값(ms) 초과 시 자동 abort
//                     기본 -1 (비활성)
//  idleWarnMs       : 청크 간 idle 시간이 이 값(ms) 초과 시 dbgLog 경고
//                     기본 60000 (60s). 사내 슬로우 LLM 의 자연스런 갭 흡수
//  idleAbortMs      : 청크 간 idle 이 이 값(ms) 초과 시 자동 abort
//                     기본 -1 (비활성). RTL 변환은 사용자 직접 중단 권장
//  onProgress       : ({ phase, stalled, idleMs, lastChunkAt, tokens, elapsedMs, firstByteAt }) => void
//                     약 1초 주기로 호출. 청크 유무와 무관하게 호출되므로
//                     UI 측 live timer 갱신용으로 활용 가능
//  onChunk(full, meta) : meta = { tokens, lastChunkAt, elapsedMs }
//                     기존 호출자(meta 무시) 와 호환됨
async function callLLM(host, model, systemMsg, userMsg, onChunk, mode = 'rtl', signal = null, opts = {}) {
  const inputTok = estimateTokens(systemMsg + userMsg);
  const apiKey   = document.getElementById('oApiKey')?.value.trim() || '';
  const endpoint = host.replace(/\/+$/, '') + '/chat/completions';

  // ── 파라미터: use=true인 것만 body에 포함 ──────────────
  const temperature = getParam('temperature', mode, inputTok);
  const seed        = getParam('seed',        mode, inputTok);
  const top_p       = getParam('top_p',       mode, inputTok);
  const thinkBuf    = getThinkingBuf(); // 계산용 (전송 안 함)

  // ── Stall watchdog 옵션 ────────────────────────────────
  // 정상 동작 false positive 최소화 위해 phase 분리:
  //   thinking — 첫 청크 전 (5분까지 정상으로 간주)
  //   streaming — 청크 흐름 중 (60s 이상 idle 이면 의심, 180s 이상이면 명백한 stall)
  const firstByteWarnMs  = (opts.firstByteWarnMs  ?? 300000);   // 5분
  const firstByteAbortMs = (opts.firstByteAbortMs ?? -1);
  const idleWarnMs       = (opts.idleWarnMs       ?? 60000);    // 1분
  const idleAbortMs      = (opts.idleAbortMs      ?? -1);
  const onProgress       = opts.onProgress;


  // dev 서버 연결 시 /llm-proxy 경유, 미연결 시 브라우저 직접 연결
  const useProxy = window._devServerAvailable;
  const fetchUrl = useProxy ? devUrl('/llm-proxy') : endpoint;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey)   headers['Authorization'] = `Bearer ${apiKey}`;
  if (useProxy) headers['X-Target-URL']  = endpoint;

  // OpenAI Compatible 표준 필드만 body에 포함
  const bodyObj = {
    model,
    stream:   true,
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user',   content: userMsg   }
    ]
  };
  if (temperature !== undefined) bodyObj.temperature = temperature;
  if (top_p       !== undefined) bodyObj.top_p       = top_p;
  if (seed !== undefined && seed !== -999) bodyObj.seed = seed;

  // ── REQUEST 로그 즉시 기록 (응답 전 — pending 진단용) ──
  const req_id   = `req-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  const t_req    = Date.now();
  const logParts = [`[callLLM:${mode}]`, `input:~${inputTok}tok`];
  if (temperature !== undefined) logParts.push(`temperature:${temperature}`);
  if (top_p       !== undefined) logParts.push(`top_p:${top_p}`);
  if (seed !== undefined && seed !== -999) logParts.push(`seed:${seed}`);
  if (thinkBuf > 0) logParts.push(`thinking_buf:${thinkBuf}(calc_only)`);
  dbgLog('REQ', `${logParts.join(' ')}  req_id:${req_id}`, 'req');

  // fetch 직전에 파일로 기록 (응답 안 와도 요청 내역 보존)
  saveReqLog({
    req_id,
    status:     'REQUEST',
    timestamp:  new Date(t_req).toISOString(),
    endpoint,
    model,
    mode,
    params: {
      ...(temperature !== undefined && { temperature }),
      ...(top_p       !== undefined && { top_p }),
      ...(seed !== undefined && seed !== -999 && { seed }),
    },
    prompt_tokens_est: inputTok,
    request: {
      system: systemMsg.slice(0, 300) + (systemMsg.length > 300 ? '…' : ''),
      user_preview: userMsg.slice(0, 500) + (userMsg.length > 500 ? '…' : ''),
      user_tokens_est: estimateTokens(userMsg),
    },
  });

  let t_first_byte = null;

  // ── 내부 AbortController ───────────────────────────────
  // 외부 signal 과 stall watchdog 의 자동 abort 를 하나로 합쳐 fetch 에 전달.
  // 외부 signal 이 abort 되면 internal 도 abort, watchdog 이 timeout 으로
  // internal.abort() 하면 fetch / reader.read() 가 즉시 reject 됨.
  const internalCtrl = new AbortController();
  let _stallAbort = false;   // 자동 abort 인지 사용자 abort 인지 구분용
  if (signal) {
    if (signal.aborted) internalCtrl.abort();
    else signal.addEventListener('abort', () => internalCtrl.abort(), { once: true });
  }

  const res = await fetch(fetchUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify(bodyObj),
    signal:  internalCtrl.signal,
  });
  const t_http = Date.now();
  dbgLog('INF', `[callLLM] HTTP ${res.status} — ${t_http - t_req}ms  req_id:${req_id}`, 'inf');

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    dbgLog('ERR', `[callLLM] HTTP ${res.status} — ${errText.slice(0,200)}`, 'err');
    let errMsg = `HTTP ${res.status}`;
    try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch (_) {}
    throw new Error(errMsg);
  }

  // Content-Type 확인 — non-streaming JSON 응답 fallback
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream') && !ct.includes('application/stream')) {
    // 일부 서버는 stream:true 요청에도 일반 JSON으로 응답
    const data = await res.json().catch(() => null);
    if (data) {
      const content = data.choices?.[0]?.message?.content
                   || data.choices?.[0]?.delta?.content
                   || '';
      const reason  = data.choices?.[0]?.finish_reason || '';
      dbgLog('INF', `[callLLM] non-streaming 응답 감지 (${ct}) — ${content.length}자`, 'inf');
      if (content) {
        if (onChunk) onChunk(content);
        await saveLlmLog({ timestamp: new Date().toISOString(), endpoint, model, mode,
          finish_reason: reason, request: { system: systemMsg, user: userMsg },
          response: content, stats: { prompt_tokens_est: inputTok, response_tokens_est: Math.round(content.length/3.5) }
        });
        return { raw: content, finish: reason };
      }
    }
    dbgLog('ERR', `[callLLM] non-streaming 응답에서 content 없음`, 'err');
    throw new Error('응답이 비어 있습니다 (non-streaming)');
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let full   = '';
  let finish = '';
  let buf    = '';   // 청크 경계에 걸린 불완전 라인 누적
  let t_last_chunk  = null;
  let stallReported = false;

  // ── Stall watchdog (1초 주기) ──────────────────────────
  // reader.read() 는 timeout 이 없어 청크가 안 오면 무한 대기. 이 watchdog 이
  // 청크 간 idle 시간을 측정해서:
  //   1) phase 별 warn 임계값 초과 시 → dbgLog 경고 + onProgress 콜백
  //   2) phase 별 abort 임계값 초과 시 → internalCtrl.abort() 로 fetch 강제 종료
  //
  // Phase 분리 — 정상 동작 false positive 최소화:
  //   thinking  (첫 청크 전)  : 추론 모델 thinking / 입력 처리 중. 5분까지 정상.
  //   streaming (첫 청크 후)  : 토큰 생성 중. 60s+ idle 이면 의심, 180s+ 면 명백.
  //
  // onProgress 는 청크 유무와 무관하게 1초 주기로 호출되므로 UI 측의
  // live timer (elapsed / idle / throughput 표시) 갱신에 사용.
  const watchdog = setInterval(() => {
    const now   = Date.now();
    const phase = t_first_byte ? 'streaming' : 'thinking';
    // streaming phase 의 idle 은 마지막 청크 기준, thinking phase 는 요청 시각 기준
    const ref    = t_last_chunk || t_req;
    const idleMs = now - ref;

    // phase 별 임계값 선택
    const warnMs  = phase === 'thinking' ? firstByteWarnMs  : idleWarnMs;
    const abortMs = phase === 'thinking' ? firstByteAbortMs : idleAbortMs;
    const stalled = warnMs > 0 && idleMs > warnMs;

    // 청크 안 와도 호출자에게 진행 상태 알림
    if (onProgress) {
      try {
        onProgress({
          phase,
          stalled,
          idleMs,
          lastChunkAt:  t_last_chunk,
          tokens:       Math.round(full.length / 3.5),
          elapsedMs:    now - t_req,
          firstByteAt:  t_first_byte,
        });
      } catch(_) {}
    }

    // 첫 stall 진입 시 1회 dbgLog
    if (stalled && !stallReported) {
      stallReported = true;
      const phaseLabel = phase === 'thinking' ? '첫 청크 대기 (thinking)' : '청크 idle';
      dbgLog('INF',
        `[callLLM] ⏸ stall 의심 — ${phaseLabel} ${(idleMs/1000).toFixed(0)}s  req_id:${req_id}`,
        'inf');
    }

    // 자동 abort (옵션)
    if (abortMs > 0 && idleMs > abortMs) {
      dbgLog('ERR',
        `[callLLM] ${phase} idle ${(idleMs/1000).toFixed(0)}s > ${(abortMs/1000).toFixed(0)}s — 자동 중단  req_id:${req_id}`,
        'err');
      _stallAbort = true;
      try { internalCtrl.abort(); } catch(_) {}
    }
  }, 1000);

  try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const _now = Date.now();
    if (!t_first_byte) {
      t_first_byte = _now;
      dbgLog('INF', `[callLLM] 첫 청크 수신 — ${_now - t_req}ms  req_id:${req_id}`, 'inf');
    }
    t_last_chunk = _now;
    if (stallReported) {
      stallReported = false;
      dbgLog('INF', `[callLLM] ▶ 청크 재개  req_id:${req_id}`, 'inf');
    }
    buf += decoder.decode(value, { stream: true });

    // 완전한 라인 단위로 처리
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';   // 마지막 불완전 라인은 다음 청크로

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;

      // SSE 형식: "data: {...}"
      const jsonStr = trimmed.startsWith('data: ')
        ? trimmed.slice(6)
        : trimmed;   // 일부 서버는 data: 없이 바로 JSON

      try {
        const json   = JSON.parse(jsonStr);
        const delta  = json.choices?.[0]?.delta?.content ?? '';
        const reason = json.choices?.[0]?.finish_reason;
        if (delta) {
          full += delta;
          if (onChunk) {
            onChunk(full, {
              tokens:      Math.round(full.length / 3.5),
              lastChunkAt: _now,
              elapsedMs:   _now - t_req,
            });
          }
        }
        if (reason) finish = reason;
      } catch (_) {
        // JSON 파싱 실패 라인은 무시 (헤더, 빈 줄 등)
      }
    }
  }

  // 버퍼 잔여 처리
  if (buf.trim() && buf.trim() !== 'data: [DONE]') {
    const jsonStr = buf.trim().startsWith('data: ') ? buf.trim().slice(6) : buf.trim();
    try {
      const json  = JSON.parse(jsonStr);
      const delta = json.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        full += delta;
        if (onChunk) onChunk(full, {
          tokens:      Math.round(full.length / 3.5),
          lastChunkAt: t_last_chunk,
          elapsedMs:   Date.now() - t_req,
        });
      }
      const reason = json.choices?.[0]?.finish_reason;
      if (reason) finish = reason;
    } catch (_) {}
  }
  } catch (e) {
    // stall watchdog 의 자동 abort 인 경우 → 명확한 timeout 에러로 변환.
    // (AbortError 그대로 throw 하면 호출자의 사용자-중단 분기로 잘못 들어감)
    if ((e?.name === 'AbortError' || e?.code === 'ABORT_ERR') && _stallAbort) {
      throw new Error(`LLM 무응답 timeout — ${(idleAbortMs/1000).toFixed(0)}s 동안 청크 미수신`);
    }
    throw e;
  } finally {
    clearInterval(watchdog);
  }

  if (!full) {
    // abort된 경우는 조용히 AbortError를 다시 throw해 상위에서 처리
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // stall watchdog 의 자동 abort 인 경우 — 명확한 에러 메시지로 구분
    if (_stallAbort) {
      throw new Error(`LLM 무응답 timeout — ${(idleAbortMs/1000).toFixed(0)}s 동안 청크 미수신`);
    }
    dbgLog('ERR', `[callLLM] 응답이 비어 있음. mode:${mode} endpoint:${endpoint}`, 'err');
    throw new Error('응답이 비어 있습니다 — 서버 로그 또는 콘솔을 확인하세요');
  }

  // LLM 대화 로그 기록 (REQUEST 로그를 RESPONSE로 업데이트)
  const t_done = Date.now();
  dbgLog('RES', `[callLLM] 완료 — 전체:${t_done - t_req}ms  첫청크:${t_first_byte ? t_first_byte - t_req : '-'}ms  req_id:${req_id}`, 'res');
  await saveLlmLog({
    req_id,
    status:     'RESPONSE',
    timestamp:  new Date().toISOString(),
    endpoint,   model,   mode,
    timing: {
      req_at:         new Date(t_req).toISOString(),
      http_ms:        t_http - t_req,
      first_byte_ms:  t_first_byte ? t_first_byte - t_req : null,
      total_ms:       t_done - t_req,
    },
    params: {
      ...(temperature !== undefined && { temperature }),
      ...(top_p       !== undefined && { top_p }),
      ...(seed !== undefined && seed !== -999 && { seed }),
    },
    finish_reason: finish,
    request:  { system: systemMsg, user: userMsg },
    response: full,
    stats: {
      prompt_chars:        (systemMsg + userMsg).length,
      response_chars:      full.length,
      prompt_tokens_est:   Math.round((systemMsg + userMsg).length / 3.5),
      response_tokens_est: Math.round(full.length / 3.5),
    }
  });

  return { raw: full, finish };
}
