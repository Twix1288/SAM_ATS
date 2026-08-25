# Sam ↔ Ashby integration — Build 1 mockup

A working mockup of the Ashby integration, built to decide whether an Ashby account is
worth paying for before the partner request lands. Two halves, kept separate so the
stand-in can be pulled out and replaced with the real Ashby.

```
ashby-simulator/    HALF 1 · Ashby's servers AND its product UI    :3001
sam-integration/    HALF 2 · the integration under evaluation     :3000
shared/             the contract both halves compile against
scripts/            the Step 03 canvas — Ashby's screens rebuilt
data/               source artifacts (survey, job description, Snapshot design)
```

> **Presenting this? Run `npm run preflight` first**, then see [DEMO.md](DEMO.md) for the
> walkthrough script. Preflight verifies the whole demo end to end in about a minute.

## Run it

Three terminals.

```bash
npm install

npm run ashby                        # terminal 1 — Ashby
npm run sam                          # terminal 2 — Sam
npm run trigger -- --row 6           # terminal 3 — an application arrives
```

Then open the walkthrough:

| | |
|---|---|
| `http://localhost:3001` | **the interactive Ashby record** — click through it |
| `http://localhost:3000/canvas/aditya_alapati` | the side-by-side comparison of all three surfaces |
| `http://localhost:3000/dossier/aditya_alapati` | the hosted page the note links to |
| `http://localhost:3000/pool.csv` | all 41 candidates scored |

Other things worth running live:

```bash
npm run trigger -- --row 11          # a different candidate, no code change
npm run trigger -- --row 6 --replay  # twice: the second is deduplicated
npm test                             # 66 tests
npm run package                      # zip for hand-back
```

## Which role a candidate is scored against

`applicationSubmit` carries `data.application.job.id`, so Sam never guesses. Rubrics are
registered against an Ashby job id in `sam-integration/services/rubrics.js`, and an
application for an unregistered job is **refused with 422** rather than scored against
whichever rubric happens to be loaded — a score against the wrong job's requirements looks
exactly like a real one.

```bash
npm run trigger -- --row 6                 # Sales Account Executive → scored
npm run trigger -- --row 20 --job other    # Platform Engineer       → 422, declined
```

## The boundary that matters

Ashby is the system of record, not Sam.

```
ashby-simulator/        holds candidates, applications, files, notes, custom field values
  store.js                seeded with what Ashby knows at apply-time — identity + their resume
  ui.js                   Ashby's product UI, reading that store through Ashby's own endpoints
  mock_ashby_api.js       the write endpoints Sam calls, and the read endpoints the UI calls

sam-integration/        scores the candidate and calls Ashby's API. Owns no UI.
```

The UI calls `candidate.list`, `application.list`, `candidate.info`, `candidate.listNotes`,
`job.info`, `interviewStage.list` and `customField.list` — the same POST/Basic contract any
integration uses. It imports nothing from Sam, and there is a test that fails if it ever does.

**So a score can only appear on screen if a real write call actually landed it.** Before you
run the integration the Sam columns are empty and the feed says so; afterwards the values are
there because they are genuinely in Ashby. That is also why the demo is worth watching: the
page updates on its own, from Ashby, three seconds after the delivery completes.

## How a person gets from applying to having our result on their record

1. **`applicationSubmit`** fires. Envelope is `{ webhookActionId, action, data }`, signed
   `Ashby-Signature: sha256=<hex>` over the **raw** body — so the server runs on
   `node:http` rather than a body-parsing framework, because parsing then re-serialising
   changes the bytes and the HMAC can never match.
2. Signature verified, then `webhookActionId` checked against a seen-set. It persists
   across Ashby's retries, which makes it the idempotency key.
3. The candidate is scored against a rubric compiled from the job description. The whole
   pool is scored at boot, because "Top N% of pool" is only honest if everyone is ranked.
4. The Snapshot is rendered once, then delivered through the two shipping surfaces.

## What Sam writes into Ashby

Three surfaces, because a recruiter does three different things. All three land today —
no partner approval, no customer-side configuration.

**Two display versions**, separated by who does the rendering:

| | Version | Endpoint | Rendered by | Carries |
|---|---|---|---|---|
| **A** | Rich note in the feed | `candidate.createNote` | **Ashby**, in its house style | 67% |
| **B** | Snapshot as a document | `candidate.uploadFile` | **Sam**, exactly as designed | 90% |

A is read without a click; B keeps every pixel behind one. The note names the document, so
they are one path rather than two competing ones.

B ships as a single file: the Snapshot, then every document the candidate supplied, each
behind its own divider page. Ashby's Files list has no ordering and no way to say *read this
one first*, so separate documents would leave the reviewer to relate them for themselves.

The divider distinguishes what Sam **read** from what the candidate merely **submitted**.
The engine scores from the resume and the interview answers, so a cover letter it never
opened sits behind a page that says so — otherwise the document implies evidence the score
was never drawn from. One candidate in this pool attached one, which is how the distinction
earned its place.

35 of the 41 resumes are PDFs and merge page-for-page; the 6 Word documents are typeset from
their text. Formats that cannot be bound in at all are listed in the result rather than
dropped in silence, and the bound-in pages are capped so an unbounded upload cannot produce
an unbounded attachment.

**Plus a data layer**, which is not a display:

| | Write | Endpoint | The job it does |
|---|---|---|---|
| — | Scores in Ashby's fields | `customField.setValues` | Makes a graded candidate **searchable and filterable** |

> **Known assumption.** The mockup shows Sam's scores as sortable pipeline columns.
> Filtering by a custom field is documented; custom-field *columns* are documented for
> Projects only, and the sole documented column on Application Review is Ashby's own AI
> criteria percentage. See [docs/ashby-capabilities.md](docs/ashby-capabilities.md).

```
01  Verify and deduplicate
02  Resolve candidate and job
03  Score against the compiled rubric
04  Render the Snapshot                   → snapshot.pdf
05  Write scores into Ashby's fields      → DELIVERABLE 1 · dashboard scores
06  Append the Snapshot to their files    → DELIVERABLE 2 · attachment
07  Write the note that points at it      → DELIVERABLE 3 · rich note
08  Confirm all three landed              → delivery receipt
```

**The order matters.** Scores go first, so the candidate is sortable the moment anything
lands. The note goes last because it names the attachment — write it first and it links
to a document that does not exist yet.

**Partial delivery is handled, not hidden.** If one surface fails the others still go, the
note drops the attachment reference rather than advertising a file nobody can open, and the
run reports `partial` instead of claiming success:

```bash
ASHBY_FAIL=/candidate.uploadFile npm run ashby   # then trigger as usual
```

### The one surface we refuse

`candidate.uploadResume` writes the **resume slot** — the document the candidate uploaded
themselves. `candidate.uploadFile` gives the same PDF in the same viewer without risking it.

## Ashby contract

Read from [developers.ashbyhq.com](https://developers.ashbyhq.com), not assumed. Six
things in the original plan were wrong:

| Assumed | Verified |
|---|---|
| `candidateNote.create` | `candidate.createNote` |
| `application.created` webhook | `applicationSubmit` |
| `POST /api/candidate.uploadResume` | no `/api` prefix |
| notes are plain text only | notes accept `{ type: 'text/html', value }` |
| one `customField.setValue` per field | `customField.setValues` — concurrent single writes have a documented race |
| the Snapshot goes in the resume slot | `candidate.uploadFile`, so the candidate's own resume is never displaced |

Auth is Basic with the API key as username and an empty password. Files use the two-step
flow: `file.createFileUploadHandle` with `fileUploadContext: 'CandidateFiles'`, PUT the
bytes to the presigned URL, then attach the handle.

## Known gaps

- **PDF text extraction reads 23 of 36 resumes.** Built on `node:zlib` because the brief
  forbids new dependencies. Subset-embedded CID fonts without a usable ToUnicode map
  produce glyph codes rather than characters; those are detected and dropped rather than
  returned as convincing-looking garbage. Career history renders when it parses and is
  omitted when it does not.
- **Scoring is deterministic and lexicon-based.** It will miss paraphrase a model would
  catch. Low confidence is surfaced rather than smoothed over, and the evidence-span
  interface takes a model later without touching any renderer.
- **Every pixel measurement in the mockup is an estimate.** Ashby publishes no
  dimensions. Region names, the tab list, the action bar and the location of custom
  fields are confirmed from their knowledge base; the sizes are not. All of it is in the
  questions list.

## Hand-back

- `npm run canvas` → the build record screens
- `scripts/questions.js` → 11 questions for Ashby, ordered by blast radius
- `npm run package` → zipped repo, excluding `node_modules`, caches and generated output
