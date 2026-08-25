#!/usr/bin/env bash
# Zips the repo for hand-back, excluding dependencies, caches and generated output.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="sam-ashby-integration-$(date +%Y%m%d).zip"
rm -f "$OUT"
zip -qr "$OUT" . \
  -x 'node_modules/*' '.git/*' '.cache/*' 'ashby-simulator/output/*' '*.zip'
echo "packaged: $OUT  ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -1
