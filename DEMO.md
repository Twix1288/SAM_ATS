# Friday walkthrough

Everything below is verified working. Total run time ~10 minutes plus discussion.

---

## Before the meeting (1 minute)

```bash
cd "path/to/ATS_SAM_Deliverable"
npm run preflight
```

One command. It installs, runs the tests, boots both halves, fires a real application,
checks every browser tab, and exercises all four walkthrough moves — then shuts everything
down and tells you whether you are ready:

```
  ✓ 37 checks passed. Ready for Friday.
```

If anything is red, it names what broke and points at the log. Do not walk into the room
without seeing that green line.

Open three terminals in the repo. Make the font big.

**Have these browser tabs ready but not loaded** (they need the server running):

| Tab | URL |
|---|---|
| **Ashby** — the live record you click through | `http://localhost:3001` |
| The side-by-side comparison | `http://localhost:3000/canvas/aditya_alapati` |
| The hosted page | `http://localhost:3000/dossier/aditya_alapati` |
| The Snapshot design | `data/Sam_Resume_Snapshot_Design.pdf` — for side-by-side |

---

## The run

**Terminal 1 — Ashby**

```bash
npm run ashby
```
```
[Ashby] 41 applications seeded  Sales Account Executive · Application Review · nothing from Sam yet
[Ashby] open http://localhost:3001  the Ashby product UI, reading this store
```

**Open `http://localhost:3001` now, before Sam runs.** This is the whole setup:

> "This is Ashby with 41 people who applied. Ashby knows who they are, their email, their
> location, and the resume they uploaded. The four Sam columns are there because the fields
> exist — and they are all empty, because we have not run yet."

Show the empty **Sam Role Fit** column. Click into a candidate — the Feed says *"Nothing from
Sam yet."* Files shows only their own resume.

**Terminal 2 — the Sam integration**

```bash
npm run sam
```

Two amber lines at boot. **Don't skip them:**

```
anchor A4 ($5M+ annualized invoice volume) NOT COLLECTED — Question Q4 collected no response.
anchor A6 (Competitive displacement)       NOT COLLECTED — No survey question maps to this requirement.
```

> "Before anyone applies we already know two of the six things this job asks for cannot be
> measured. The hardest requirement — $5M+ invoice volume — maps to one survey question, and
> not one of the 41 answered it."

**Terminal 3 — an application arrives**

```bash
npm run trigger -- --row 6
```

Terminal 2 prints nine stages. The last four are the ones to read out:

```
05 ✓ Bind in their resume               4 pages · 2 Snapshot + 1 resume · layout intact
06 ✓ Write scores into Ashby's fields   → DELIVERABLE 1 · dashboard scores
07 ✓ Append the Snapshot to their files → DELIVERABLE 2 · attachment
08 ✓ Write the note that points at it   → DELIVERABLE 3 · rich note
09 ✓ Confirm all three landed           3 of 3 deliverables on the record — complete
```

> "Scores first, so the candidate is findable the moment anything lands. The note last,
> because it names the attachment — write it first and you publish a reference to a
> document that does not exist yet. The order is load-bearing.

**Now switch to the browser without touching anything.** The UI polls Ashby every three
seconds, so a toast appears — *"Sam scored 1 new application"* — and Aditya's row fills in.

> "I did not refresh that. The page is reading Ashby's own `application.list` endpoint. Those
> numbers are in Ashby now, because three real API calls put them there."

Then walk it:

1. **Click "Sam Role Fit"** to sort. Aditya jumps to the top; everyone else still shows `—`.
2. **Click his row.** The record opens on the Feed.
3. **Feed** — Sam's note, rendered after Ashby's sanitiser stripped the styling.
4. **Files** — `sam_snapshot_aditya_alapati.pdf` *added by Sam*, above `Aditya Alapati_CV.pdf`
   *from candidate*. **Click the Snapshot** — it opens inline in the viewer. **Scroll past
   the last Snapshot page**: a divider page, then his own resume, bound in behind it.
5. **Application tab** — the four custom field values on the application itself.

> "Their document is still theirs — untouched, right there in the list. Ours is added
> beside it. That is `candidate.uploadFile` rather than `candidate.uploadResume`, and it is
> the one call in this integration I would not make differently."

> "And we bind a copy of their documents into ours, because the Files list has no ordering
> and no way to say *read this one first*. One file, judgement first, evidence behind it. If
> they sent a Word document we typeset it, and the divider page says so — we do not pretend
> to a fidelity we do not have."

**Optional, if you want the sharper version — trigger row 33, James Hare.** He attached a
cover letter as well as a resume. His document runs seven pages: the Snapshot, a divider
reading **SOURCE DOCUMENT**, his resume, then a second divider reading **ALSO SUBMITTED**
with the line *Sam did not score this document.*

> "Sam reads the resume and the interview answers. It never opened his cover letter, so it
> does not get to sit behind a page captioned *source*. It is in there because you should
> have it, not because it counted."

---

## Then the canvas

Open **`http://localhost:3000/canvas/aditya_alapati`**. Start at the dashboard section — it is the whole point of writing custom fields.

Scroll order:

1. **Version A vs Version B** — the comparison table at the top. This is the argument.
2. **How each one gets there** — one API call versus three.
3. **Both versions at real size** — slow down here.
4. **And the score becomes data** — the pipeline, sorted.
5. **What each one carries** — the field matrix the percentages come from.
6. **The one surface we refuse** — the resume slot.
7. **Questions for Ashby** — 7 open, 2 high-risk.

Three things worth saying out loud:

> **"There are two ways to display this, and the difference is who renders it."** Hand
> Ashby the content and it draws it in their house style — read instantly, no brand. Hand
> Ashby a finished PDF and every pixel survives — behind a click. A gets read, B gets
> studied, and the note names the document so they are one path, not two.

> **"Neither of those helps you find the right person among 41."** That is the third write:
> the scores go into Ashby's own custom fields, which makes a graded candidate
> searchable and filterable.

> **Say this before anyone asks it.** "The ranked pipeline you're looking at is our
> biggest assumption. Filtering by a custom field is documented. Columns are documented
> for Projects. But the only column you can add on Application Review is Ashby's *own*
> AI criteria percentage — and you can sort by it. They may already occupy this screen."

> **"Coverage is its own column."** Every candidate shows 65%, because the job description
> asks for two things this survey never collected. Sorting on a score is only safe when the
> denominator sorts with it.

> **"We built the resume slot in order to refuse it."** It is the best-looking placement in
> Ashby and we will not use it — that is the candidate's own document.

## Lead with the constraint

Open with this, before the mockups. It reframes the whole session from "here is a demo"
to "here is what we learned about the platform."

**1 · The delivery is locked.**
> "The data flow works. Webhooks verify, the merge logic re-syncs, retries do not
> duplicate. But documentation review turned up a product constraint that changes our UI
> strategy, and I want to lead with it."

**2 · Show the unverified screen.** The pipeline, with the amber chip visible.
> "I built this assuming our custom fields could be a sortable column on the pipeline
> board. Ashby's documentation points against it. Custom-field columns are documented for
> Projects. The Candidate Pipeline page never mentions columns at all."

**3 · Name the competitive reality.**
> "The only `add column` option documented on Application Review is Ashby's own **AI job
> criteria met percentage** — and you can sort by it. They reserve that column for their
> own product, and `application.listCriteriaEvaluations` is read-only. No partner write
> path. That is our number one question for their partner team."

**4 · Then change the filter dropdown.** `Sam Role Fit ≥ 65%` — the list narrows to three.
> "This part is documented and it works: filtering by a custom field value. A hiring
> manager can save that as a search. So our scores make candidates **findable**, just not
> **ranked**."

**5 · Pivot to the note.** Open the Feed tab.
> "Which is why the note matters more than the fields. Ashby renders embedded tables
> natively — this is the anchors, the quoted evidence and the coverage gaps, in the feed,
> read without a click. And their AI reads **only resumes and application-form answers**.
> It has never heard the candidate speak. This table is built from five voice interviews,
> and there is no column anywhere in Ashby that competes with it."

**The line to land:** their AI ranks résumés; Sam explains people. The column is theirs.
The feed is ours.

## Four moves to have in your pocket

**A · Run it on someone else.** Do this unprompted — it answers the only real question
about a scoring demo.

```bash
npm run trigger -- --row 11        # Craig DeMary · 76% · complete
```
Then open `/canvas/craig_demary`. Different candidate, different Snapshot, no code change.

**B · Ashby retries a delivery.** Run it twice — the first call establishes the delivery,
the second is the one that gets refused.

```bash
npm run trigger -- --row 6 --replay     # complete
npm run trigger -- --row 6 --replay     # "duplicate":true — no work done
```

The `webhookActionId` persists across Ashby's own retries, so it is the idempotency key.

**C · Someone forges a webhook.**

```bash
curl -i -X POST http://localhost:3000/webhooks/applicationSubmit \
  -H 'content-type: application/json' \
  -H 'ashby-signature: sha256=deadbeef' -d '{"a":1}'
```
→ `401`, and the payload is never parsed.

**D · The attachment endpoint goes down.** The best move if anyone asks about failure.

```bash
# terminal 1: ctrl-C, then
ASHBY_FAIL=/candidate.uploadFile npm run ashby
# terminal 3:
npm run trigger -- --row 16
```
→ `partial`. The note still ships, **and drops the reference** — it never advertises a file
nobody can open.

**E · An application for a job we have no rubric for.** The answer to "how does it know
which role?"

```bash
npm run trigger -- --row 20 --job other
```
→ `HTTP 422 · no_rubric_for_job`. Terminal 2 says:

```
declined to score  No rubric is registered for job "Platform Engineer" (e72961ae…).
                   Sam will not score an application against another job's requirements.
```

> "The webhook carries the job id, so Sam never guesses. If we have no rubric for that job
> it refuses — a score against the wrong job's rubric looks exactly like a real one."

---

## If someone asks

**"Can we see the actual Snapshot?"**
`ashby-simulator/output/sam_snapshot_aditya_alapati.pdf` — open beside
`data/Sam_Resume_Snapshot_Design.pdf`.

**"What about the other 40 candidates?"**
`http://localhost:3000/pool.csv` — all 41 scored and ranked.

**"Why only three surfaces?"**
Ten surfaces were looked at: three built, one refused, six investigated and not built.
The three do three different jobs — triage, read, go deep — and all three land today.
Section 07 of the canvas lists the other six with the reason each one is out. The one worth
pressing on is `candidate.addProject`: Projects are the only surface where custom-field
columns are confirmed, which is exactly what the pipeline column cannot confirm.

**"How does it know which role to score against?"**
`data.application.job.id` on the webhook. Sam looks it up in a registry keyed by Ashby job
id and scores against that job's rubric. Unregistered job → 422, refuses. There's a test
asserting Sam and Ashby derive the same job id independently — if they ever drift, nothing
scores rather than everything mis-scoring.

**"How do we know the endpoints are right?"**
`shared/ashby-contract.js`. Six things in the original plan were wrong. The dangerous one:
`candidate.uploadResume` writes the *resume slot*, so we use `candidate.uploadFile`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ECONNREFUSED` on trigger | Terminal 2 isn't up. Start `npm run sam` first. |
| `Ashby ... failed (ECONNREFUSED)` | Terminal 1 isn't up, or you started `sam` without `ashby`. |
| Canvas 404 | Wrong slug. It's `aditya_alapati` with underscores. `npm run trigger` prints the right URL. |
| Port in use | `pkill -f mock_ashby_api; pkill -f sam-integration/server` |
| Want a clean slate | `rm -rf ashby-simulator/output/*` |

---

## Hand-back

```bash
npm run package     # sam-ashby-integration-YYYYMMDD.zip
```

Plus the two published pages — the canvas (build record screens) and the build record
itself — and the nine questions in `scripts/questions.js`, four of them high-risk.
