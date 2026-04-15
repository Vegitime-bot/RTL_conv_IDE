#!/usr/bin/env node
'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = 3000;
const HTML = 'rtl_algo_converter.html';
const LOG  = path.resolve(__dirname, 'rtl_converter_llm_log.json');
const ENV  = path.resolve(__dirname, '.env');

// ── .env 파서 ─────────────────────────────────────────────
function parseEnv(filepath) {
  const result = {};
  if (!fs.existsSync(filepath)) return result;
  fs.readFileSync(filepath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  });
  return result;
}

let envVars = parseEnv(ENV);
console.log('[env] 로드:', Object.keys(envVars).filter(k => k !== 'API_KEY').join(', '),
  envVars.API_KEY ? '+ API_KEY(****)' : '(API_KEY 없음)');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Target-URL');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end',  () => resolve(Buffer.concat(buf)));
    req.on('error', reject);
  });
}

function appendLog(entry) {
  let arr = [];
  try { if (fs.existsSync(LOG)) arr = JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch {}

  // REQUEST/RESPONSE 쌍 관리: req_id 기준으로 업데이트 또는 추가
  if (entry.req_id && entry.status === 'RESPONSE') {
    const idx = arr.findIndex(e => e.req_id === entry.req_id);
    if (idx >= 0) {
      arr[idx] = { ...arr[idx], ...entry };  // REQUEST 항목을 RESPONSE로 업데이트
      fs.writeFileSync(LOG, JSON.stringify(arr, null, 2), 'utf8');
      return arr.length;
    }
  }
  arr.push(entry);
  fs.writeFileSync(LOG, JSON.stringify(arr, null, 2), 'utf8');
  return arr.length;
}

// ── 공통 프록시 함수 (GET/POST 모두 처리, 리다이렉트 자동 추적) ──
function doProxy(method, targetUrl, reqHeaders, body, res) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch(e) {
    res.writeHead(400); res.end('URL 파싱 실패: ' + e.message); return;
  }

  console.log(`[proxy] ${method} → ${targetUrl}`);

  const isHttps  = parsed.protocol === 'https:';
  const mod      = isHttps ? https : http;
  const outHdrs  = { 'Accept': 'application/json' };
  if (reqHeaders['authorization']) outHdrs['Authorization'] = reqHeaders['authorization'];
  if (method === 'POST' && body) {
    outHdrs['Content-Type']   = 'application/json';
    outHdrs['Content-Length'] = Buffer.byteLength(body);
  }

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 80),
    path:     parsed.pathname + (parsed.search || ''),
    method,
    headers:  outHdrs,
  };

  const proxyReq = mod.request(options, proxyRes => {
    const code = proxyRes.statusCode;
    console.log(`[proxy] ← HTTP ${code}`);

    // 리다이렉트 자동 추적 (301/302/307/308)
    if ([301, 302, 307, 308].includes(code) && proxyRes.headers['location']) {
      const redirectUrl = proxyRes.headers['location'];
      console.log(`[proxy] redirect → ${redirectUrl}`);
      proxyRes.resume();
      doProxy(method, redirectUrl, reqHeaders, body, res);
      return;
    }

    const outHeaders = { 'Access-Control-Allow-Origin': '*' };
    if (proxyRes.headers['content-type'])     outHeaders['Content-Type']     = proxyRes.headers['content-type'];
    if (proxyRes.headers['transfer-encoding']) outHeaders['Transfer-Encoding'] = proxyRes.headers['transfer-encoding'];

    res.writeHead(code, outHeaders);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', e => {
    console.error('[proxy] 오류:', e.message);
    if (!res.headersSent) { res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({error: e.message})); }
  });

  if (method === 'POST' && body) proxyReq.write(body);
  proxyReq.end();
}

// ── HTTP 서버 ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // 감지용 ping
  if (pathname === '/ping') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: true, server: 'rtl-dev-server'}));
    return;
  }

  // .env 값 반환 (API_KEY는 존재 여부만, 값은 마스킹)
  if (pathname === '/env') {
    // 요청 시마다 파일을 다시 읽음 (핫 리로드)
    envVars = parseEnv(ENV);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      BASE_URL:      envVars.BASE_URL      || '',
      API_KEY:       envVars.API_KEY       || '',
      DEFAULT_MODEL: envVars.DEFAULT_MODEL || '',
      OLLAMA_MODE:   envVars.OLLAMA_MODE === 'true',  // Ollama 개발 테스트용
      loaded:        fs.existsSync(ENV),
      path:          ENV,
    }));
    return;
  }

  // config 파일 반환
  if (pathname === '/config') {
    const configPath = path.join(__dirname, 'rtl-converter-config.js');
    if (!fs.existsSync(configPath)) {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'rtl-converter-config.js 없음'}));
      return;
    }
    // JS 파일을 텍스트로 그대로 반환 (브라우저에서 eval)
    res.writeHead(200, {'Content-Type': 'application/javascript'});
    fs.createReadStream(configPath).pipe(res);
    return;
  }


  // ── /lint: verible(RTL) 또는 clangd(SystemC) 로 문법/포트 검사 ──
  if (req.method === 'POST' && pathname === '/lint') {
    const { execFile } = require('child_process');
    const os   = require('os');
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    const { code, filename, lang } = body;  // lang: 'rtl' | 'systemc'

    // 임시 파일 작성
    const ext     = lang === 'systemc' ? '.cpp' : (filename?.endsWith('.sv') ? '.sv' : '.v');
    const tmpFile = path.join(os.tmpdir(), `rtl_lint_${Date.now()}${ext}`);
    fs.writeFileSync(tmpFile, code, 'utf8');

    const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch {} };

    // 사용 가능한 linter 탐색
    const { execSync } = require('child_process');
    function which(cmd) {
      try { execSync(`which ${cmd}`, {stdio:'ignore'}); return true; } catch { return false; }
    }

    let linter, args;
    if (lang === 'systemc') {
      // clangd 기반 간이 체크 (clang --syntax-only)
      if (which('clang++')) {
        linter = 'clang++';
        args   = ['--syntax-only', '-std=c++17', '-I/usr/include/systemc', tmpFile];
      } else {
        cleanup();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, errors: [], warnings: [],
          note: 'clang++ 미설치 — lint 건너뜀' }));
        return;
      }
    } else {
      // Verilog/SV: verible 우선, 없으면 iverilog
      if (which('verible-verilog-syntax')) {
        linter = 'verible-verilog-syntax';
        args   = ['--error_on_unimplemented', tmpFile];
      } else if (which('iverilog')) {
        linter = 'iverilog';
        args   = ['-t', 'null', '-Wall', tmpFile];
      } else {
        cleanup();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, errors: [], warnings: [],
          note: 'verible/iverilog 미설치 — lint 건너뜀' }));
        return;
      }
    }

    execFile(linter, args, { timeout: 15000 }, (err, stdout, stderr) => {
      cleanup();
      const output = (stderr || stdout || '').trim();
      console.log(`[lint] ${linter} → exit=${err?.code ?? 0}  output=${output.slice(0,120)}`);

      // 오류 파싱: "file:line:col: error: msg" 형태
      const errors   = [];
      const warnings = [];
      const lineRe   = /(?:.*?):(\d+):(\d+)?:?\s*(error|warning|note):\s*(.+)/gi;
      let m;
      while ((m = lineRe.exec(output)) !== null) {
        const item = { line: parseInt(m[1]), col: parseInt(m[2]||'0'), msg: m[4].trim() };
        if (m[3].toLowerCase() === 'error') errors.push(item);
        else if (m[3].toLowerCase() === 'warning') warnings.push(item);
      }
      // verible는 다른 포맷일 수 있으므로 raw도 포함
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        ok:       errors.length === 0,
        errors,
        warnings,
        raw:      output,
        linter,
      }));
    });
    return;
  }

  // 로그 저장
  if (req.method === 'POST' && pathname === '/save-log') {
    try {
      const entry = JSON.parse((await readBody(req)).toString('utf8'));
      const count = appendLog(entry);
      const tag   = entry.status === 'REQUEST'  ? '→ REQ ' :
                    entry.status === 'RESPONSE' ? '← RES ' : '○ LOG ';
      const info  = entry.req_id
        ? `req_id:${entry.req_id}  model:${entry.model||'?'}  mode:${entry.mode||'?'}`
        : `model:${entry.model||'?'}  mode:${entry.mode||'?'}`;
      console.log(`[log] ${tag} #${count}  ${info}`);
      if (entry.timing) {
        console.log(`       http:${entry.timing.http_ms}ms  first_byte:${entry.timing.first_byte_ms}ms  total:${entry.timing.total_ms}ms`);
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true, count, file: LOG}));
    } catch(e) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: e.message}));
    }
    return;
  }

  // POST 프록시 (LLM 변환 요청)
  if (req.method === 'POST' && pathname === '/llm-proxy') {
    const targetUrl = req.headers['x-target-url'];
    if (!targetUrl) { res.writeHead(400); res.end('X-Target-URL 헤더 필요'); return; }
    const body = await readBody(req);
    doProxy('POST', targetUrl, req.headers, body, res);
    return;
  }

  // GET 프록시 (연결 테스트 /models 등)
  if (req.method === 'GET' && pathname === '/get-proxy') {
    const targetUrl = req.headers['x-target-url'];
    if (!targetUrl) { res.writeHead(400); res.end('X-Target-URL 헤더 필요'); return; }
    doProxy('GET', targetUrl, req.headers, null, res);
    return;
  }

  // 정적 파일 서빙
  const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
  const filename = pathname === '/' ? HTML : pathname.slice(1);
  const filepath = path.join(__dirname, filename);
  if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found: ' + filename); return; }
  res.writeHead(200, {'Content-Type': MIME[path.extname(filepath)] || 'application/octet-stream'});
  fs.createReadStream(filepath).pipe(res);
});

server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `포트 ${PORT} 이미 사용 중` : e.message); process.exit(1); });
server.listen(PORT, () => {
  console.log('');
  console.log('=== RTL Converter Dev Server ===');
  console.log(`  앱         : http://localhost:${PORT}`);
  console.log(`  환경설정   : http://localhost:${PORT}/env  (.env 파일 읽기)`);
  console.log(`  POST 프록시: http://localhost:${PORT}/llm-proxy  (X-Target-URL 헤더)`);
  console.log(`  Lint 검사  : http://localhost:${PORT}/lint  (verible/iverilog/clang++ 필요)`);
  console.log(`  GET  프록시: http://localhost:${PORT}/get-proxy   (X-Target-URL 헤더)`);
  console.log(`  로그파일   : ${LOG}`);
  console.log(`  .env 파일  : ${fs.existsSync(ENV) ? ENV : '(없음 — .env 생성 권장)'}`);
  console.log('  Ctrl+C 종료');
  console.log('');
});
process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
