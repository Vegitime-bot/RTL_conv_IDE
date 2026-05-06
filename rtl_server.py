"""
RTL Converter FastAPI Server
────────────────────────────
Node.js dev 서버와 동일한 기능을 FastAPI로 구현.
WSL + Docker 운영 환경 대응.

엔드포인트:
  GET  /            → rtl_algo_converter.html 서빙
  GET  /ping        → 헬스 체크
  GET  /env         → .env 로드 반환
  GET  /config      → rtl-converter-config.js 반환
  GET  /hooks       → rtl-converter-hooks.js 반환
  POST /save-log    → LLM 로그 저장
  POST /llm-proxy   → LLM 스트리밍 프록시
  GET  /get-proxy   → GET 프록시 (모델 목록 조회 등)
  POST /hook        → 완료 Hook URL 호출
  POST /lint        → Verilog/SystemC lint 실행
  POST /api/auto-run-analysis  → 분석 명령 큐 추가
  POST /api/auto-run-convert   → RTL 생성 명령 큐 추가
  POST /api/auto-run           → 전체 실행 명령 큐 추가
  GET  /api/poll    → 브라우저 폴링 (명령 큐 반환)
"""

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from collections import deque
from pathlib import Path
from typing import Any, Optional

import httpx
import urllib.request  # 시스템 프록시 감지용
from dotenv import dotenv_values
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ── 로깅 ─────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("rtl-server")

# ── 경로 설정 ─────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent

def make_client(**kwargs) -> httpx.AsyncClient:
    """
    Node.js처럼 시스템 프록시를 자동으로 사용하는 httpx 클라이언트 생성.
    우선순위: .env OUTBOUND_PROXY → 시스템 프록시(urllib) → 환경변수
    """
    # 1. .env에 명시된 프록시 (OUTBOUND_PROXY=http://proxy:port)
    env       = load_env()
    proxy_url = env.get('OUTBOUND_PROXY')

    # 2. 시스템 프록시 (urllib 감지)
    if not proxy_url:
        sys_prx   = urllib.request.getproxies()
        proxy_url = sys_prx.get('http') or sys_prx.get('https')

    # 3. 환경변수 (Docker 컨테이너 등)
    if not proxy_url:
        proxy_url = os.environ.get('HTTP_PROXY') or os.environ.get('http_proxy')

    if proxy_url:
        log.info(f"[http] 프록시 사용: {proxy_url}")
        return httpx.AsyncClient(
            verify=False,
            proxy=proxy_url,
            follow_redirects=True,
            **kwargs,
        )

    return httpx.AsyncClient(
        verify=False,
        trust_env=True,
        follow_redirects=True,
        **kwargs,
    )
ENV_FILE   = BASE_DIR / ".env"
CONFIG_JS  = BASE_DIR / "rtl-converter-config.js"
HOOKS_JS   = BASE_DIR / "rtl-converter-hooks.js"
LOG_DIR    = BASE_DIR / "logs"
LOG_FILE   = LOG_DIR / "rtl_converter_llm_log.json"
HTML_FILE  = BASE_DIR / "rtl_algo_converter.html"

PORT = int(os.environ.get("PORT", os.environ.get("DEV_PORT", "8080")))

# ── FastAPI 앱 ───────────────────────────────────────────────
app = FastAPI(title="RTL Converter Server", version="1.0.0")

# CORS — 개발: 전체 허용 / 운영: 필요에 따라 origins 제한
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ── API 명령 큐 (브라우저 폴링 방식) ─────────────────────────
_api_cmd_queue: deque = deque()

# ── .env 파서 ─────────────────────────────────────────────────
def load_env() -> dict:
    if not ENV_FILE.exists():
        return {}
    return {k: v for k, v in dotenv_values(ENV_FILE).items() if v is not None}

# ── 로그 저장 ─────────────────────────────────────────────────
def append_log(entry: dict) -> int:
    LOG_DIR.mkdir(exist_ok=True)
    logs = []
    if LOG_FILE.exists():
        try:
            logs = json.loads(LOG_FILE.read_text(encoding="utf-8"))
        except Exception:
            logs = []

    # REQUEST/RESPONSE 쌍 관리
    if entry.get("req_id") and entry.get("status") == "RESPONSE":
        for i, e in enumerate(logs):
            if e.get("req_id") == entry["req_id"]:
                logs[i] = {**e, **entry}
                LOG_FILE.write_text(json.dumps(logs, indent=2, ensure_ascii=False), encoding="utf-8")
                return len(logs)

    logs.append(entry)
    LOG_FILE.write_text(json.dumps(logs, indent=2, ensure_ascii=False), encoding="utf-8")
    return len(logs)

# ════════════════════════════════════════════════════════════
# 기본 엔드포인트
# ════════════════════════════════════════════════════════════

@app.get("/ping")
async def ping():
    return {"ok": True, "server": "rtl-fastapi-server"}


@app.get("/env")
async def get_env():
    env = load_env()
    return {
        "BASE_URL":      env.get("BASE_URL", ""),
        "API_KEY":       env.get("API_KEY", ""),
        "DEFAULT_MODEL": env.get("DEFAULT_MODEL", ""),
        "OLLAMA_MODE":   env.get("OLLAMA_MODE", "").lower() == "true",
        "loaded":        ENV_FILE.exists(),
        "path":          str(ENV_FILE),
    }


@app.get("/config")
async def get_config():
    if not CONFIG_JS.exists():
        raise HTTPException(404, "rtl-converter-config.js 없음")
    return Response(
        content=CONFIG_JS.read_text(encoding="utf-8"),
        media_type="application/javascript",
    )


@app.get("/hooks")
async def get_hooks():
    if not HOOKS_JS.exists():
        raise HTTPException(404, "rtl-converter-hooks.js 없음")
    return Response(
        content=HOOKS_JS.read_text(encoding="utf-8"),
        media_type="application/javascript",
    )


# ════════════════════════════════════════════════════════════
# 로그 저장
# ════════════════════════════════════════════════════════════

@app.post("/save-log")
async def save_log(request: Request):
    try:
        entry = await request.json()
    except Exception as e:
        raise HTTPException(400, f"JSON 파싱 실패: {e}")

    count = append_log(entry)

    tag  = ("→ REQ " if entry.get("status") == "REQUEST"
            else "← RES " if entry.get("status") == "RESPONSE"
            else "○ LOG ")
    info = (f"req_id:{entry['req_id']}  model:{entry.get('model','?')}  mode:{entry.get('mode','?')}"
            if entry.get("req_id")
            else f"model:{entry.get('model','?')}  mode:{entry.get('mode','?')}")
    log.info(f"[log] {tag} #{count}  {info}")

    if t := entry.get("timing"):
        log.info(f"       http:{t.get('http_ms')}ms  "
                 f"first_byte:{t.get('first_byte_ms')}ms  "
                 f"total:{t.get('total_ms')}ms")

    return {"ok": True, "count": count, "file": str(LOG_FILE)}


# ════════════════════════════════════════════════════════════
# LLM 프록시 (스트리밍 지원)
# ════════════════════════════════════════════════════════════

@app.post("/llm-proxy")
async def llm_proxy(request: Request):
    target_url = request.headers.get("x-target-url")
    if not target_url:
        raise HTTPException(400, "X-Target-URL 헤더 필요")

    body    = await request.body()
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "x-target-url")
    }

    log.info(f"[proxy] POST → {target_url}")

    # 스트리밍 응답 여부 확인
    try:
        req_json = json.loads(body)
        is_stream = req_json.get("stream", False)
    except Exception:
        is_stream = False

    async def stream_response():
        async with make_client(timeout=None) as client:
            async with client.stream("POST", target_url,
                                     content=body, headers=headers) as resp:
                log.info(f"[proxy] ← HTTP {resp.status_code}")
                async for chunk in resp.aiter_bytes():
                    yield chunk

    if is_stream:
        return StreamingResponse(
            stream_response(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache",
                     "X-Accel-Buffering": "no"},
        )
    else:
        timeout_ns = httpx.Timeout(connect=5.0, read=60.0, write=10.0, pool=5.0)
        async with make_client(timeout=timeout_ns) as client:
            resp = await client.post(target_url, content=body, headers=headers)
            log.info(f"[proxy] ← HTTP {resp.status_code}")
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                media_type=resp.headers.get("content-type", "application/json"),
            )


@app.get("/get-proxy")
async def get_proxy(request: Request):
    target_url = request.headers.get("x-target-url")
    if not target_url:
        raise HTTPException(400, "X-Target-URL 헤더 필요")

    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "x-target-url")
    }

    log.info(f"[proxy] GET → {target_url}")
    try:
        # 브라우저 timeout(15s)보다 짧게 설정 → 브라우저가 먼저 끊기기 전에 에러 반환
        timeout = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
        async with make_client(timeout=timeout) as client:
            resp = await client.get(target_url, headers=headers)
            log.info(f"[proxy] ← HTTP {resp.status_code}")
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                media_type=resp.headers.get("content-type", "application/json"),
            )
    except httpx.ConnectTimeout:
        log.error(f"[proxy] 연결 timeout → {target_url}")
        return JSONResponse({"error": f"연결 timeout (5s): {target_url}"}, status_code=504)
    except httpx.ReadTimeout:
        log.error(f"[proxy] 읽기 timeout → {target_url}")
        return JSONResponse({"error": f"응답 timeout (10s): {target_url}"}, status_code=504)
    except httpx.ConnectError as e:
        log.error(f"[proxy] 연결 오류 → {target_url}: {e}")
        return JSONResponse({"error": f"연결 실패: {e}"}, status_code=502)
    except Exception as e:
        log.error(f"[proxy] 오류 → {target_url}: {e}")
        return JSONResponse({"error": str(e)}, status_code=502)


# ════════════════════════════════════════════════════════════
# Hook 호출
# ════════════════════════════════════════════════════════════

class HookRequest(BaseModel):
    name:        Optional[str] = None
    url:         str
    method:      str           = "GET"
    headers:     dict          = {}
    bodyPayload: Optional[Any] = None


@app.post("/hook")
async def call_hook(body: HookRequest):
    name = body.name or body.url
    log.info(f'[hook] "{name}" → {body.method} {body.url}')

    try:
        async with make_client(timeout=10) as client:
            if body.method.upper() == "GET":
                resp = await client.get(body.url, headers=body.headers)
            else:
                resp = await client.post(
                    body.url,
                    json=body.bodyPayload,
                    headers=body.headers,
                )
            ok = 200 <= resp.status_code < 300
            resp_text = resp.text[:500]
            log.info(f'[hook] "{name}" ← HTTP {resp.status_code}  {resp_text[:100]}')
            return {"ok": ok, "status": resp.status_code, "response": resp_text}
    except httpx.TimeoutException:
        log.error(f'[hook] "{name}" 타임아웃')
        return {"ok": False, "error": "timeout (10s)"}
    except Exception as e:
        log.error(f'[hook] "{name}" 오류: {e}')
        return {"ok": False, "error": str(e)}


# ════════════════════════════════════════════════════════════
# Lint (Verilog / SystemC)
# ════════════════════════════════════════════════════════════

class LintRequest(BaseModel):
    code:     str
    filename: Optional[str] = "unnamed"
    lang:     str           = "rtl"   # 'rtl' | 'systemc'


def _which(cmd: str) -> bool:
    return shutil.which(cmd) is not None


@app.post("/lint")
async def lint_code(body: LintRequest):
    ext = ".cpp" if body.lang == "systemc" else (
        ".sv" if (body.filename or "").endswith(".sv") else ".v"
    )

    with tempfile.NamedTemporaryFile(
        suffix=ext, prefix="rtl_lint_", mode="w",
        encoding="utf-8", delete=False
    ) as tmp:
        tmp.write(body.code)
        tmp_path = tmp.name

    try:
        if body.lang == "systemc":
            if not _which("clang++"):
                return {"ok": True, "errors": [], "warnings": [],
                        "note": "clang++ 미설치 — lint 건너뜀"}
            linter = "clang++"
            args   = ["--syntax-only", "-std=c++17",
                      "-I/usr/include/systemc", tmp_path]
        else:
            if _which("verible-verilog-syntax"):
                linter = "verible-verilog-syntax"
                args   = ["--error_on_unimplemented", tmp_path]
            elif _which("iverilog"):
                linter = "iverilog"
                args   = ["-t", "null", "-Wall", tmp_path]
            else:
                return {"ok": True, "errors": [], "warnings": [],
                        "note": "verible/iverilog 미설치 — lint 건너뜀"}

        result = await asyncio.to_thread(
            subprocess.run,
            [linter, *args],
            capture_output=True, text=True, timeout=15
        )
        output = (result.stderr or result.stdout or "").strip()
        log.info(f"[lint] {linter} exit={result.returncode}  {output[:120]}")

        errors, warnings = [], []
        for m in re.finditer(
            r"(?:.*?):(\d+):(\d+)?:?\s*(error|warning|note):\s*(.+)",
            output, re.IGNORECASE
        ):
            item = {"line": int(m.group(1)),
                    "col":  int(m.group(2) or 0),
                    "msg":  m.group(4).strip()}
            (errors if m.group(3).lower() == "error" else warnings).append(item)

        return {"ok": len(errors) == 0,
                "errors": errors, "warnings": warnings,
                "raw": output, "linter": linter}

    except subprocess.TimeoutExpired:
        return {"ok": False, "errors": [{"line": 0, "col": 0,
                "msg": "lint 타임아웃 (15s)"}], "warnings": [], "raw": "", "linter": ""}
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


# ════════════════════════════════════════════════════════════
# API 트리거 (브라우저 폴링 방식)
# ════════════════════════════════════════════════════════════

_ACTION_MAP = {
    "/api/auto-run-analysis": "auto-run-analysis",
    "/api/auto-run-convert":  "auto-run-convert",
    "/api/auto-run":          "auto-run-all",
}


@app.post("/api/auto-run-analysis")
async def api_analysis():
    _api_cmd_queue.append({"action": "auto-run-analysis", "ts": int(time.time() * 1000)})
    log.info("[api] auto-run-analysis 명령 큐 추가")
    return {"ok": True, "action": "auto-run-analysis", "queued": True,
            "note": "브라우저가 열려있고 dev 서버에 연결된 경우 자동 실행됩니다."}


@app.post("/api/auto-run-convert")
async def api_convert():
    _api_cmd_queue.append({"action": "auto-run-convert", "ts": int(time.time() * 1000)})
    log.info("[api] auto-run-convert 명령 큐 추가")
    return {"ok": True, "action": "auto-run-convert", "queued": True,
            "note": "브라우저가 열려있고 dev 서버에 연결된 경우 자동 실행됩니다."}


@app.post("/api/auto-run")
async def api_auto_run():
    _api_cmd_queue.append({"action": "auto-run-all", "ts": int(time.time() * 1000)})
    log.info("[api] auto-run-all 명령 큐 추가")
    return {"ok": True, "action": "auto-run-all", "queued": True,
            "note": "브라우저가 열려있고 dev 서버에 연결된 경우 자동 실행됩니다."}


@app.get("/api/poll")
async def api_poll():
    cmd = _api_cmd_queue.popleft() if _api_cmd_queue else None
    return {"ok": True, "command": cmd}


# ════════════════════════════════════════════════════════════
# 정적 파일 서빙 (HTML + JS 설정 파일들)
# ════════════════════════════════════════════════════════════

@app.get("/")
async def serve_html():
    if not HTML_FILE.exists():
        raise HTTPException(404, "rtl_algo_converter.html 없음")
    return FileResponse(HTML_FILE, media_type="text/html")


@app.get("/{filename:path}")
async def serve_static(filename: str):
    filepath = BASE_DIR / filename
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(404, f"파일 없음: {filename}")
    # 경로 traversal 방지
    try:
        filepath.resolve().relative_to(BASE_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "접근 불가")

    ext_map = {
        ".html": "text/html; charset=utf-8",
        ".js":   "application/javascript",
        ".css":  "text/css",
        ".json": "application/json",
        ".svg":  "image/svg+xml",
        ".md":   "text/markdown",
    }
    media_type = ext_map.get(filepath.suffix.lower(), "application/octet-stream")
    return FileResponse(filepath, media_type=media_type)


# ════════════════════════════════════════════════════════════
# 시작
# ════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn

    env = load_env()
    log.info("=== RTL Converter FastAPI Server ===")
    log.info(f"  앱         : http://localhost:{PORT}")
    log.info(f"  환경설정   : http://localhost:{PORT}/env")
    log.info(f"  LLM 프록시 : POST http://localhost:{PORT}/llm-proxy")
    log.info(f"  Lint 검사  : POST http://localhost:{PORT}/lint")
    log.info(f"  Hook 실행  : POST http://localhost:{PORT}/hook")
    log.info(f"  .env 파일  : {ENV_FILE if ENV_FILE.exists() else '(없음)'}")
    log.info(f"  hooks 파일 : {HOOKS_JS if HOOKS_JS.exists() else '(없음 — rtl-converter-hooks.js 를 이 폴더에 복사하세요)'}")
    log.info("")
    log.info("  [API 엔드포인트]")
    log.info(f"  분석 실행  : POST http://localhost:{PORT}/api/auto-run-analysis")
    log.info(f"  RTL 생성   : POST http://localhost:{PORT}/api/auto-run-convert")
    log.info(f"  전체 실행  : POST http://localhost:{PORT}/api/auto-run")
    log.info("")
    if env.get("BASE_URL"):
        log.info(f"  BASE_URL={env['BASE_URL']}  MODEL={env.get('DEFAULT_MODEL','(미설정)')}")

    uvicorn.run(
        "rtl_server:app",
        host="0.0.0.0",
        port=PORT,
        reload=False,
        log_level="info",
    )
