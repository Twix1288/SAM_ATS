#!/usr/bin/env bash
# Zips the repo for hand-back, excluding dependencies, caches and generated output.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="sam-ashby-integration-$(date +%Y%m%d).zip"
rm -f "$OUT"
# data/ carries 41 real people's names, emails and interview transcripts, and .env carries a
# live Ashby credential. Neither goes to a recipient — the seed data comes from the Drive
# folder, and the key is issued per environment.
zip -qr "$OUT" . \
  -x 'node_modules/*' '.git/*' '.cache/*' 'ashby-simulator/output/*' '*.zip' \
     '.env' '.env.*' 'data/*' '.alerts.jsonl'
echo "packaged: $OUT  ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -1

# A secret in a hand-back zip is unrecoverable once sent, so this is asserted rather than
# assumed: fail loudly instead of printing a reassuring size line over a leaked key.
if unzip -l "$OUT" | grep -qE '(^|/)\.env|(^|/)data/|\.alerts\.jsonl'; then
  echo "REFUSING: $OUT contains credentials or seed data. Not safe to send." >&2
  rm -f "$OUT"
  exit 1
fi
