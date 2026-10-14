#!/usr/bin/env bash
# Build, serve dist on :4173 and run the headless screenshot + XR emulation tests.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build >/tmp/build.log 2>&1 || { tail -40 /tmp/build.log; exit 1; }
npx vite preview --port 4173 --strictPort >/tmp/preview.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf http://localhost:4173/ >/dev/null && break; sleep 0.25; done
status=0
node tests/screenshots.mjs "$@" || status=$?
node tests/xr.mjs "$@" || status=$?
exit $status
