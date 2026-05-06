FROM python:3.12-slim

# ── 시스템 의존성 (lint 도구 선택 설치) ──────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    iverilog \
    clang \
    curl \
    && rm -rf /var/lib/apt/lists/*

# verible 설치 (선택 — 없으면 iverilog fallback 사용)
# ARG VERIBLE_VERSION=v0.0-3899-g29e3d261
# RUN curl -L "https://github.com/chipsalliance/verible/releases/download/${VERIBLE_VERSION}/verible-${VERIBLE_VERSION}-linux-static-x86_64.tar.gz" \
#     | tar -xz -C /usr/local/bin --strip-components=2 --wildcards "*/bin/verible-verilog-syntax"

WORKDIR /app

# ── Python 의존성 ────────────────────────────────────────────
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── 앱 파일 복사 ─────────────────────────────────────────────
COPY rtl_server.py              .
COPY rtl_algo_converter.html    .
COPY rtl-converter-config.js    .

# rtl-converter-hooks.js 는 선택 파일 — 없으면 hook 미사용
# rtl-converter-hooks.js — 없어도 서버 실행 가능
RUN touch /app/rtl-converter-hooks.js.placeholder

# .env 는 런타임에 마운트 (이미지에 포함하지 않음)
# docker run -v $(pwd)/.env:/app/.env ...

# ── 포트 ─────────────────────────────────────────────────────
ENV PORT=8080
EXPOSE 3000

# ── 실행 ─────────────────────────────────────────────────────
CMD ["python", "-m", "uvicorn", "rtl_server:app",\
     "--host", "0.0.0.0", "--port", "8080",\
     "--log-level", "info"]
