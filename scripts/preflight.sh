#!/usr/bin/env bash
#
# Friday preflight. Runs the whole demo end to end and reports PASS/FAIL per step,
# so you find out something is broken now rather than in front of Ash.
#
#   npm run preflight
#
# Starts both halves on their real ports, exercises every path the walkthrough uses,
# then shuts everything down and leaves the repo clean.

set -uo pipefail
set +m          # no job-control notices when background servers are killed
cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; DIM=$'\033[90m'; OFF=$'\033[0m'
GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'

PASS=0; FAIL=0
step() { printf "  %-52s" "$1"; }
ok()   { PASS=$((PASS+1)); printf "%sPASS%s %s%s%s\n" "$GREEN" "$OFF" "$DIM" "${1:-}" "$OFF"; }
bad()  { FAIL=$((FAIL+1)); printf "%sFAIL%s %s%s%s\n" "$RED" "$OFF" "$DIM" "${1:-}" "$OFF"; }

# Wait for a port to accept connections instead of guessing with sleep. The simulator now
# seeds 41 applicants at boot, so a fixed sleep was long enough yesterday and is not today.
wait_for_port() {
  local port="$1" tries=0
  until nc -z localhost "$port" 2>/dev/null; do
    tries=$((tries+1))
    [ "$tries" -gt 100 ] && return 1
    sleep 0.1
  done
  sleep 0.3
  return 0
}

cleanup() {
  pkill -f "mock_ashby_api.js"        >/dev/null 2>&1
  pkill -f "sam-integration/server.js" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup; sleep 1

echo
echo "${BOLD}Sam ↔ Ashby · preflight${OFF}"
echo "${DIM}$(date '+%A %d %B %Y, %H:%M')${OFF}"
echo

# ── environment ──────────────────────────────────────────────────────────────
echo "${CYAN}Environment${OFF}"

step "node 20 or newer"
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 20 ] && ok "v$(node -p process.versions.node)" || bad "found v$(node -v 2>/dev/null)"

step "dependencies installed"
if [ -d node_modules/pdf-lib ]; then ok "pdf-lib present"
else npm install --silent >/dev/null 2>&1 && ok "installed just now" || bad "npm install failed"; fi

step "no vulnerable dependencies"
AUDIT=$(npm audit --json 2>/dev/null | node -pe "try{JSON.parse(require('fs').readFileSync(0)).metadata.vulnerabilities.total}catch(e){'?'}" 2>/dev/null || echo "?")
[ "$AUDIT" = "0" ] && ok "0 vulnerabilities" || bad "$AUDIT reported"

step "seed data present"
MISSING=""
for f in "data/survey_agree.com_business_development_representative.xlsx" \
         "data/Sales Account Executive.pdf" "data/Sam_Resume_Snapshot_Design.pdf"; do
  [ -f "$f" ] || MISSING="$MISSING $(basename "$f")"
done
[ -z "$MISSING" ] && ok "3 source files" || bad "missing:$MISSING"

# ── tests ────────────────────────────────────────────────────────────────────
echo
echo "${CYAN}Tests${OFF}"
step "unit and contract tests"
T=$(npm test 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' ')
TP=$(echo "$T" | sed -n 's/.*# pass \([0-9]*\).*/\1/p')
TF=$(echo "$T" | sed -n 's/.*# fail \([0-9]*\).*/\1/p')
[ "${TF:-1}" = "0" ] && ok "$TP passing" || bad "$TF failing"

# ── boot both halves ─────────────────────────────────────────────────────────
echo
echo "${CYAN}Both halves${OFF}"

npm run ashby >/tmp/pf_ashby.log 2>&1 & disown
wait_for_port 3001
npm run sam   >/tmp/pf_sam.log   2>&1 & disown
wait_for_port 3000

step "Ashby stand-in on :3001"
grep -q "listening on :3001" /tmp/pf_ashby.log && ok "up" || bad "see /tmp/pf_ashby.log"

step "Sam integration on :3000"
grep -q "listening on :3000" /tmp/pf_sam.log && ok "up" || bad "see /tmp/pf_sam.log"

step "pool scored at boot"
grep -q "pool calibrated" /tmp/pf_sam.log && ok "$(grep -o '[0-9]* responses scored' /tmp/pf_sam.log | head -1)" || bad "no calibration line"

step "Ashby product UI serves"
UI=$(curl -s -o /tmp/pf_ui -w "%{http_code}" http://localhost:3001/)
UIB=$(wc -c < /tmp/pf_ui | tr -d ' ')
[ "$UI" = "200" ] && [ "$UIB" -gt 5000 ] && ok "http://localhost:3001 · ${UIB}b" || bad "HTTP $UI"

AUTH="Authorization: Basic $(printf 'demo_ashby_key:' | base64)"
step "Ashby read endpoints answer"
READS_OK=0
for EP in /candidate.list /application.list /job.info /interviewStage.list /customField.list; do
  curl -s -X POST "http://localhost:3001$EP" -H "$AUTH" -H 'content-type: application/json' -d '{}' \
    | grep '"success":true' > /dev/null && READS_OK=$((READS_OK+1))
done
[ "$READS_OK" = "5" ] && ok "5 of 5" || bad "$READS_OK of 5"

step "nothing from Sam before delivery"
SCORED0=$(curl -s -X POST http://localhost:3001/application.list -H "$AUTH" -H 'content-type: application/json' -d '{}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).results.filter(a=>a.customFields.length).length")
[ "$SCORED0" = "0" ] && ok "41 applications, 0 scored" || bad "$SCORED0 already scored"

step "uncollected anchors flagged"
NC=$(grep -c "NOT COLLECTED" /tmp/pf_sam.log)
[ "$NC" -ge 2 ] && ok "$NC anchors, as expected" || bad "expected 2, saw $NC"

# ── the main run ─────────────────────────────────────────────────────────────
echo
echo "${CYAN}Delivery${OFF}"

step "application scored and delivered"
R=$(npm run trigger -- --row 6 2>&1 | grep -o '{.*}' | tail -1)
OUTCOME=$(echo "$R" | node -pe "try{JSON.parse(require('fs').readFileSync(0)).outcome}catch(e){'error'}")
[ "$OUTCOME" = "complete" ] && ok "outcome: complete" || bad "outcome: $OUTCOME"

for D in "dashboard scores:customField.setValues" "attachment:candidate.uploadFile" "rich note:candidate.createNote"; do
  NAME="${D%%:*}"; EP="${D##*:}"
  step "  $NAME"
  echo "$R" | grep "\"endpoint\":\"/$EP\",\"ok\":true" > /dev/null && ok "/$EP" || bad "/$EP did not land"
done

step "note references the attachment"
grep -q "references the attachment" /tmp/pf_sam.log && ok "" || bad "note did not name the file"

step "values readable back through the Ashby API"
APP=$(curl -s -X POST http://localhost:3001/application.list -H "$AUTH" -H 'content-type: application/json' -d '{}' \
  | node -pe "const r=JSON.parse(require('fs').readFileSync(0)).results;const a=r.find(x=>x.candidate.name==='Aditya Alapati');JSON.stringify(a.customFieldValues)")
echo "$APP" | grep '"Sam Role Fit"' > /dev/null && ok "$(echo "$APP" | cut -c1-52)…" || bad "no values on the application"

step "Snapshot attached, resume untouched"
CID=$(curl -s -X POST http://localhost:3001/application.list -H "$AUTH" -H 'content-type: application/json' -d '{}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).results.find(x=>x.candidate.name==='Aditya Alapati').candidate.id")
CHK=$(curl -s -X POST http://localhost:3001/candidate.info -H "$AUTH" -H 'content-type: application/json' -d "{\"id\":\"$CID\"}" \
  | node -pe "const c=JSON.parse(require('fs').readFileSync(0)).results;(c.resumeFileHandle&&c.resumeFileHandle.source==='candidate'?'resume-intact':'RESUME-TOUCHED')+' '+c.fileHandles.filter(f=>f.source==='Sam').length")
[ "$CHK" = "resume-intact 1" ] && ok "1 Sam file added, resume untouched" || bad "$CHK"

step "the note is readable from the feed endpoint"
NOTES=$(curl -s -X POST http://localhost:3001/candidate.listNotes -H "$AUTH" -H 'content-type: application/json' -d "{\"candidateId\":\"$CID\"}" \
  | node -pe "const n=JSON.parse(require('fs').readFileSync(0)).results;n.length?n.length+' × '+n[0].content.type:'none'")
echo "$NOTES" | grep "text/html" > /dev/null && ok "$NOTES" || bad "$NOTES"

step "the Snapshot opens in the viewer"
FID=$(curl -s -X POST http://localhost:3001/candidate.info -H "$AUTH" -H 'content-type: application/json' -d "{\"id\":\"$CID\"}" \
  | node -pe "const f=JSON.parse(require('fs').readFileSync(0)).results.fileHandles.find(x=>x.source==='Sam');f?f.id:''")
FCODE=$(curl -s -o /tmp/pf_pdf -w "%{http_code}" "http://localhost:3001/files/$FID")
[ "$FCODE" = "200" ] && head -c4 /tmp/pf_pdf | grep "%PDF" > /dev/null && ok "inline pdf, $(wc -c < /tmp/pf_pdf | tr -d ' ')b" || bad "HTTP $FCODE"

# The attachment is one document carrying two things. Checking only that a PDF came back
# would pass even if the resume silently stopped binding in, which is the failure this
# whole stage exists to prevent — so we read the file and count its pages.
step "their own resume is bound in behind it"
STITCH=$(node -e '
  const fs = require("fs");
  import("pdf-lib").then(async ({PDFDocument}) => {
    const bytes = fs.readFileSync("/tmp/pf_pdf");
    const doc = await PDFDocument.load(bytes, {ignoreEncryption: true});
    const { extractPdfText } = await import("./sam-integration/ingest/pdf.js");
    const text = extractPdfText(bytes);
    const divider = /SOURCE DOCUMENT/.test(text);
    const disclaimer = /Everything above this page is Sam/.test(text);
    console.log((divider && disclaimer && doc.getPageCount() > 2 ? "OK " : "FAIL ")
      + doc.getPageCount() + " pages, divider=" + divider);
  }).catch((e) => console.log("FAIL " + e.message));
' 2>&1 | tail -1)
case "$STITCH" in
  OK*)   ok "${STITCH#OK }" ;;
  *)     bad "${STITCH#FAIL }" ;;
esac

step "snapshot pdf written"
[ -s ashby-simulator/output/sam_snapshot_aditya_alapati.pdf ] \
  && ok "$(wc -c < ashby-simulator/output/sam_snapshot_aditya_alapati.pdf | tr -d ' ') bytes" || bad "no pdf"

# ── the walkthrough surfaces ─────────────────────────────────────────────────
echo
echo "${CYAN}Browser tabs${OFF}"
for U in "canvas/aditya_alapati:the dashboard and three surfaces" \
         "dossier/aditya_alapati:the hosted evidence page" \
         "pool.csv:all candidates ranked"; do
  PATH_="${U%%:*}"; DESC="${U##*:}"
  step "/$PATH_"
  CODE=$(curl -s -o /tmp/pf_out -w "%{http_code}" "http://localhost:3000/$PATH_")
  SIZE=$(wc -c < /tmp/pf_out | tr -d ' ')
  [ "$CODE" = "200" ] && [ "$SIZE" -gt 500 ] && ok "$DESC · ${SIZE}b" || bad "HTTP $CODE"
done

# Grepped from a file, never through a pipe. `grep -q` exits at the first match, and
# under `set -o pipefail` a still-streaming curl then dies of SIGPIPE and fails the
# check even though the text was there. The canvas is 80KB; the race is real.
# And we match the opening tag plus a Sam column, not the bare class name — the class
# also appears in the stylesheet, so a grep for it alone passes with no table at all.
step "pipeline table present on the canvas"
curl -s -o /tmp/pf_canvas "http://localhost:3000/canvas/aditya_alapati"
ROWS=$(grep -c "sam num" /tmp/pf_canvas || true)
grep -q '<table class="ab-ptable">' /tmp/pf_canvas && [ "${ROWS:-0}" -gt 3 ] \
  && ok "table renders with Sam columns · ${ROWS} cells" || bad "missing"

# ── the four moves ───────────────────────────────────────────────────────────
echo
echo "${CYAN}Walkthrough moves${OFF}"

step "A · runs on a different candidate"
R2=$(npm run trigger -- --row 11 2>&1 | grep -o '{.*}' | tail -1)
N2=$(echo "$R2" | node -pe "try{const d=JSON.parse(require('fs').readFileSync(0));d.candidate+' '+Math.round(d.roleFit*100)+'%'}catch(e){'error'}")
echo "$R2" | grep '"outcome":"complete"' > /dev/null && ok "$N2" || bad "$N2"

step "B · retried delivery is deduplicated"
npm run trigger -- --row 6 --replay >/dev/null 2>&1
npm run trigger -- --row 6 --replay 2>&1 | grep '"duplicate":true' > /dev/null && ok "no double-write" || bad "reprocessed"

step "C · forged signature rejected"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/webhooks/applicationSubmit \
  -H 'content-type: application/json' -H 'ashby-signature: sha256=deadbeef' -d '{"a":1}')
[ "$CODE" = "401" ] && ok "401, payload never parsed" || bad "got $CODE"

step "D · partial delivery when a surface is down"
pkill -f "mock_ashby_api.js" >/dev/null 2>&1; sleep 1
ASHBY_PORT=3001 ASHBY_FAIL=/candidate.uploadFile node ashby-simulator/mock_ashby_api.js >/tmp/pf_ashby2.log 2>&1 & disown
wait_for_port 3001
R3=$(npm run trigger -- --row 16 2>&1 | grep -o '{.*}' | tail -1)
O3=$(echo "$R3" | node -pe "try{JSON.parse(require('fs').readFileSync(0)).outcome}catch(e){'error'}")
NOTE_OK=$(echo "$R3" | grep -c '"endpoint":"/candidate.createNote","ok":true')
[ "$O3" = "partial" ] && [ "$NOTE_OK" = "1" ] && ok "partial, note still shipped" || bad "outcome: $O3"

step "E · an application for an unregistered job"
R4=$(npm run trigger -- --row 20 --job other 2>&1 | grep -o '{.*}' | tail -1)
REASON=$(echo "$R4" | node -pe "try{JSON.parse(require('fs').readFileSync(0)).reason}catch(e){'error'}")
[ "$REASON" = "no_rubric_for_job" ] && ok "declined, not mis-scored" || bad "got: $REASON"

step "     and it was not written into Ashby"
UNSCORED=$(curl -s -X POST http://localhost:3001/application.list -H "$AUTH" -H 'content-type: application/json' -d '{}' \
  | node -pe "const r=JSON.parse(require('fs').readFileSync(0)).results;const a=r.find(x=>x.candidate.rowNumber===20)||r[18];JSON.stringify(a.customFields)")
[ "$UNSCORED" = "[]" ] && ok "no values written for a job we cannot score" || bad "wrote $UNSCORED"

step "     and the note drops the file reference"
grep -q "no attachment to reference" /tmp/pf_sam.log && ok "never advertises a missing file" || bad "still references it"

step "F · a merged candidate keeps their score"
pkill -f "mock_ashby_api.js" >/dev/null 2>&1
npm run ashby >/tmp/pf_ashby3.log 2>&1 & disown
wait_for_port 3001
npm run trigger -- --row 6 >/dev/null 2>&1
R5=$(npm run trigger -- --merge --row 6 --into 11 2>&1 | grep -o '{.*}' | tail -1)
M=$(echo "$R5" | node -pe "try{JSON.parse(require('fs').readFileSync(0)).outcome}catch(e){'error'}")
[ "$M" = "resynced" ] && ok "re-synced onto the surviving record" || bad "outcome: $M"

step "     and the survivor carries the values"
SURV=$(curl -s -X POST http://localhost:3001/application.list -H "$AUTH" -H 'content-type: application/json' -d '{}' \
  | node -pe "const r=JSON.parse(require('fs').readFileSync(0)).results;const c=r.find(x=>x.candidate.name==='Craig DeMary');Object.keys(c.customFieldValues).length")
[ "$SURV" = "4" ] && ok "4 fields on the surviving candidate" || bad "$SURV fields"

step "G · a lost response does not duplicate the note"
pkill -f "mock_ashby_api.js" >/dev/null 2>&1
ASHBY_PORT=3001 ASHBY_FLAKY=/candidate.createNote node ashby-simulator/mock_ashby_api.js >/tmp/pf_ashby4.log 2>&1 & disown
wait_for_port 3001
npm run trigger -- --row 17 >/dev/null 2>&1
NCID=$(curl -s -X POST http://localhost:3001/application.list -H "$AUTH" -H 'content-type: application/json' -d '{}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).results.find(x=>x.candidate.name==='Joe tinaglia').candidate.id")
NCOUNT=$(curl -s -X POST http://localhost:3001/candidate.listNotes -H "$AUTH" -H 'content-type: application/json' -d "{\"candidateId\":\"$NCID\"}" \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).results.length")
[ "$NCOUNT" = "1" ] && ok "write applied, response dropped, still 1 note" || bad "$NCOUNT notes"

# ── summary ──────────────────────────────────────────────────────────────────
cleanup
echo
if [ "$FAIL" -eq 0 ]; then
  echo "${GREEN}${BOLD}  ✓ $PASS checks passed. Ready for Friday.${OFF}"
  echo
  echo "  ${BOLD}Then run, in three terminals:${OFF}"
  echo "    npm run ashby"
  echo "    npm run sam"
  echo "    npm run trigger -- --row 6"
  echo "  ${BOLD}And open:${OFF} ${CYAN}http://localhost:3001${OFF}  ${DIM}← the interactive Ashby record${OFF}"
  echo "            http://localhost:3000/canvas/aditya_alapati  ${DIM}← the side-by-side comparison${OFF}"
  echo "  ${DIM}Talking points and the four moves are in DEMO.md${OFF}"
else
  echo "${RED}${BOLD}  ✗ $FAIL of $((PASS+FAIL)) checks failed.${OFF}"
  echo "  ${DIM}Logs: /tmp/pf_sam.log  /tmp/pf_ashby.log${OFF}"
fi
echo
exit $((FAIL > 0))
