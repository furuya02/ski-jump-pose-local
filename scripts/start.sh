#!/usr/bin/env bash
# 画面をビルドして（初回・更新時）、ローカルサーバを起動する。
#   ./scripts/start.sh            → http://127.0.0.1:8000/
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d frontend/node_modules ]; then
  (cd frontend && pnpm install)
fi
# src の方が新しければビルドし直す
if [ ! -d frontend/dist ] || [ -n "$(find frontend/src frontend/index.html -newer frontend/dist -print -quit)" ]; then
  (cd frontend && pnpm build)
fi

PY="${PYTHON:-python3}"
[ -x .venv/bin/python ] && PY=.venv/bin/python
exec "$PY" server/app.py
