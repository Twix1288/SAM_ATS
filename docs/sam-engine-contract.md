# What the Snapshot needs back from the engine

The split: **the engine owns judgement, the Snapshot owns presentation.** Every number,
state, reason and quote arrives already decided. Nothing on this side re-derives a score,
re-words a finding, or invents a value the engine did not send.

This is not a wish list. `sam-integration/ingest/enginePayload.js` builds the real Snapshot
view model from a payload plus Ashby and **nothing else**, `docs/sam-engine-payload.example.json`
is a working example generated from a real scored candidate, and seven tests render a full
PDF from it. If a section cannot be filled from this contract, the build fails rather than
shipping a document with a hole in it.

---

## The payload

```jsonc
{
  "schemaVersion": "1.0",
  "scoreId": "sam_score_<stable>",     // idempotency key — see "one Snapshot per person"
  "scoredAt": "2026-08-25T12:00:00Z",

  "engine":  { "version", "rubricId", "rubricVersion", "rubricSource" },
  "subject": { "ashbyCandidateId", "ashbyApplicationId", "ashbyJobId" },

  "inputs": {
    "read": ["resume"],                // LITERAL list of what was opened → printed verbatim
    "resume": { "fileHandleId", "filename" },
    "jobDescription": { "storedAt", "version" },
    "answeredCount": 0,
    "audio": []                        // must be empty unless `read` names an interview source
  },

  "scores": {
    "roleFit": 0.65,                   // 0..1, already coverage-denominated
    "coverage": 0.65,                  // 0..1, share of the rubric actually observable
    "band": "Moderate",
    "capability": 9, "capabilityRaw": 8.6,
    "capabilitySignals": { "met": [], "missing": [] }
  },

  "anchors": [{
    "id": "A4",
    "label": "$5M+ annualized invoice volume",
    "detail": "…the rubric line…",
    "weight": 0.25,
    "state": "MET | PARTIAL | NOT_MET | NOT_COLLECTED",
    "reason": "the sentence the reviewer reads",
    "evidence": [{ "quote": "…", "source": "resume:page 1", "locator": null }]
  }],

  "narrative": {
    "netRead": "…",                    // the summary judgement, prose
    "recommendedNextStep": "…",
    "caveats": [],
    "gapsToInvestigate": null          // null = derive from anchors
  },

  "profile": {
    "careerHistory": { "roles": [{ "title", "company", "start", "end" }], "source", "note" },
    "additionalSkills": [],
    "experienceMatch": null,           // null = derive from anchor A1
    "responsibilityMatch": null,       // null = derive from anchor A3
    "roleLevelFit": null               // null = print "Not determined" rather than guess
  }
}
```

## The five rules

1. **Optional means `null`, never missing.** A key that is present and null prints an honest
   "Not determined". A key that is absent is a bug we cannot tell apart from a real absence.

2. **Every quote carries its source.** `source` is where it came from — `resume:page 1`,
   `interview:Q3`. A quote the reader cannot check is worse than no quote, so a missing
   `source` is a hard failure.

3. **Scores arrive computed.** We never re-derive `roleFit` from weights. One source of
   truth, and if the formula changes the Snapshot follows automatically.

4. **`inputs.read` is literal, not descriptive.** It becomes the provenance line on the
   document verbatim. If the engine read only a résumé, it says `["resume"]` — and then
   `inputs.audio` **must** be empty. A payload claiming résumé-only while shipping recordings
   is refused, because it would invite a reviewer to listen to evidence the score never used.

5. **Career-history rows must be clean.** Résumé parsers routinely swap the fields —
   `{title: "Apollo Tyres", company: "Sales Intern"}`. We drop obviously broken rows
   defensively, but a garbled job title on a person's record is the most visible way this
   document can look careless.

## What the engine does *not* send

`evidencedBy` and `signals` — how the engine decided — are rubric inputs, not results. The
Snapshot renders the conclusion and the evidence, never the working. A test asserts they
never reach the renderer.

Identity comes from **Ashby**, not the engine: name, email, LinkedIn, location, file handles,
job title. The engine sends ids; we resolve them.

---

## When the real engine lands

The demo in this repo scores locally, at `sam-integration/server.js`. That is scaffolding, not
architecture — grading stays on Sam's side, and this half starts at the scored payload.

It is kept that way on purpose so the walkthrough runs with no dependency on an engine that
does not exist yet. Five things change when it does, and none of them is a redesign:

| Today, for the demo | In production |
|---|---|
| `scorePool(pool)` at boot, from the survey file | POST the candidate to Sam's endpoint, receive a contract payload |
| `buildSnapshot(score, response)` | `snapshotFromEnginePayload(payload, ashby)` — already written and tested |
| Rubrics in a hardcoded registry | Pull each job description once when the job is added, store it |
| `POST /webhooks/applicationSubmit` drives delivery | `sweepJob()` on a timer drives delivery — already written and tested |
| Scored from résumé + voice answers | Résumé only, since the job description is already stored |

The two that already exist as tested code — the engine adapter and the sweep — are the ones
that would otherwise be the hard part. What is left is wiring and a job-description store.

## The two things we plan around — built, not described

### One Snapshot per person, per job

`delivery/ledger.js` is keyed on **`(candidateId, jobId)`**, not on the candidate. One person
applying to two roles gets a Snapshot for each, scored against each job's own rubric; keying
on the person alone would leave whichever job swept second with nothing.

The check runs **before** the engine is called, because scoring is the expensive half.

In production this is a table with a unique index on `(candidate_id, job_id)` — the index is
what makes a double-delivery impossible under a concurrent sweep rather than merely unlikely.

### The scheduled sweep

`delivery/sweep.js`. Per job: ask Ashby for applications created since the cursor, skip
anyone the ledger already has, hand the rest to the engine, write the Snapshot.

Three behaviours worth knowing, each with a test:

- **The cursor advances only to an application we actually saw**, never to wall-clock time.
  A sweep starting at 10:00 that advanced to "now" would step over an application created at
  10:00:30 while it was still running, permanently.
- **The cursor never advances past a failure.** A candidate whose scoring failed keeps no
  ledger entry, so the next sweep is their retry — but only if the cursor has not already
  excluded them from the query. Getting this wrong means they are never scored and nothing
  anywhere says so.
- **One candidate failing does not end the pass.** The next person in the list is unrelated.

The cursor is an optimisation; the ledger is the guarantee. If the cursor is lost to a
restart, the sweep sees everyone again and the ledger still prevents a second Snapshot —
there is a test for exactly that.

Both the engine and the Ashby read are injected, so neither guarantee needs a network to test.

### What we still need from you on this

- **`candidateMerge` no longer arrives as an event.** A sweep has no webhook. Either we keep
  a webhook subscription alongside the sweep, or we reconcile when a ledger entry points at
  an id that has stopped resolving. Worth a decision.
- **Re-scoring.** The rubric is expanding, so a candidate scored under v1 will one day be
  behind. `rubricVersion` is in the payload, so we *can* detect it — the question is whether
  a new version means re-issuing the Snapshot, and whether that replaces or appends.

## What Ashby actually exposes — verified against their reference

| What you asked about | Status |
|---|---|
| Résumé PDF | **Yes** — `candidate.info` → `resumeFileHandle` → `file.info` for a URL |
| Other attachments | **Yes** — `fileHandles` |
| Identity | **Yes** — name, emails, phones, `socialLinks` (LinkedIn), tags, source, `profileUrl` |
| Application context | **Yes** — `application.info`: job, status, stage, `customFields`, `appliedViaJobPostingId`, `submittedFormInstanceId` |
| **What Ashby parses from the résumé** | **No.** `candidate.info` returns contact/identity fields and a file handle only — no work history, employers, titles, education or skills. **We parse the résumé ourselves.** |
| **Custom application-form answers** | **No documented read path.** `application.info` has no answers field. `applicationForm.submit` only *writes*. `submittedFormInstanceId` is returned but nothing documented reads it back. |
| Consent question | **Probably** — `surveySubmission.list` covers *Candidate Data Consent* as a survey category and returns field definitions plus `submittedValues`. The exact `surveyType` string needs confirming. |

The middle two are the ones that change the plan. **The engine's input is the résumé and the
stored job description — and essentially nothing else structured.** If the consent question or
any screening questions live on the application form rather than in a Questionnaire survey,
we currently have no way to read them back.

---

## Unverified against real Ashby

One assumption in this build has never touched `api.ashbyhq.com`, and it is the one that can
put wrong data in front of a hiring manager.

**Clearing a custom field is undocumented.** Ashby's per-type table covers Boolean, Date,
String, LongText, ValueSelect, MultiValueSelect, Number, Currency, NumberRange,
CompensationRange, Url and UUID — what to send to *set* each one. Nothing anywhere says how
to *unset* one. Not null, not an empty string, not an empty array.

We send `null`, because that is what every other JSON API means by unset. That is a guess.

`test/live-ashby.test.js` is written to settle it against a real org and is **skipped without
a key**:

```bash
ASHBY_API_KEY=<key> ASHBY_LIVE_APPLICATION_ID=<uuid> npm run test:live
```

It tries `null`, `""` and `0` in turn, reports what each one actually does, and fails with
the working mechanism named if `null` is not it. It restores the field's original value
afterwards — point it at a sandbox, never a live requisition.

Until that runs, three things contain the guess:

1. `CLEAR` is one constant in `customField.setValue.js`.
2. If Ashby refuses the clear, the non-null values are written on their own, so a refused
   clear cannot also lose the coverage number that explains a withheld score.
3. A **critical alert** fires — see below. Verified end to end with
   `ASHBY_REJECT_NULL_CLEAR=1`, which makes the simulator refuse a null the way real Ashby
   might.

## When a clear fails, who finds out

Every other failed write leaves the record as it was and the next sweep retries. A failed
clear leaves a withdrawn score visible in a filterable column. That cannot depend on someone
reading an HTTP response, because a scheduled sweep has no reader.

Before this, it did. The pipeline caught the error, recorded a failed stage and returned
`partial` in a response body. There was no alerting anywhere in the codebase.

`sam-integration/delivery/alerts.js` is the seam. It does the two things that work with no
account and no dependency — a structured `SAM-ALERT` line on **stderr** for a log aggregator
to match, and an append to a **file** so an alert outlives the process — and exposes
`onAlert()` for production to wire to whatever actually pages someone. Raising an alert never
throws; an alerting path that can fail the delivery it reports on is worse than none.

The alert carries `attemptedClearValue`, so if it ever fires in production that is the line
that tells us `null` was the wrong guess.

## Open questions

1. **How thin a read still publishes a number.** Grading is yours; what we put in Ashby's
   sortable field is ours. Today we withhold the Role Fit number below 50% coverage, because
   a coverage-denominated score is only comparable between candidates at similar coverage and
   a filterable integer cannot carry that caveat. `MIN_SCOREABLE_COVERAGE` is one constant —
   tell us if that line is in the wrong place once you see real sweep coverage.
2. **Where does consent live** — application form (unreadable) or Questionnaire survey
   (readable via `surveySubmission.list`)? Worth deciding before the form is configured.
3. **Re-scoring on rubric change** — the rubric is expanding. When v2 ships, does a candidate
   scored under v1 get a second Snapshot? `rubricVersion` is in the payload so we *can*
   detect it; the product decision is whether to re-issue, and whether that replaces or
   appends to the record.
4. **Who owns `netRead`** — the engine sends prose today. If the Snapshot's layout should
   constrain its length, that constraint belongs in the contract as a character budget.
5. **Rank** — currently omitted entirely when there is no cohort, because "1 of 1, top 100%"
   is worse than saying nothing. Worth deciding whether the engine should maintain a per-job
   distribution and return a percentile instead.
