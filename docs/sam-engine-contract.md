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

## Three things that change because it is a sweep

### 1. Résumé-only reads report NOT_COLLECTED — decided, and it needs a guard

**Decision: a résumé cannot ask, so an anchor it cannot evidence is `NOT_COLLECTED`, not
`NOT_MET`.** That is right per anchor — the candidate is not penalised for a question nobody
put to them — and `NOT_COLLECTED` drops out of the denominator as designed.

In aggregate it is dangerous, and the danger is not theoretical. A sweep where one anchor of
six is observable and met produces:

```
Role Fit 100%   at 25% coverage
```

The 100 is what lands in Ashby's sortable, filterable field. The 25 does not go with it. A
reviewer filtering `Sam Role Fit ≥ 65` gets a one-anchor read at the top of their list, and
nothing on that screen says why.

So the score is gated on coverage:

| | Below 50% coverage | At or above |
|---|---|---|
| Band | `Insufficient evidence` | normal band |
| PDF headline | `—` | the percentage |
| Ashby Role Fit field | **not written** | written |
| Note headline | "Not scored — only N% of the rubric was observable" | normal |
| Coverage field | **always written** | always written |

Coverage is always written because it is the number that explains the empty one.

`MIN_SCOREABLE_COVERAGE` is one constant in `enginePayload.js` and every surface reads it.
Raise it if the résumé sweep turns out thinner than expected. The reasoning is that a
coverage-denominated score is only comparable between candidates at similar coverage — a
document can carry that caveat, a filterable integer cannot.

**What this means for the engine:** send `coverage` honestly and do not compensate. If a
résumé sweep genuinely only evidences a quarter of the rubric, say so and let the gate do its
job. The failure mode we are protecting against is a confident number, not a low one.

### 2. No webhook means no delivery id

The mockup keys idempotency on `webhookActionId`, which Ashby guarantees stable across its
own retries. A sweep has no such id, so **`scoreId` becomes the idempotency key** — it must
be stable for the same (candidate, job, rubric version).

Also needed: **a cursor per job** (last-swept timestamp) and a **ledger keyed on
`(ashbyCandidateId, ashbyJobId)`** — not on candidate alone, since one person can apply to
two jobs and should get a Snapshot for each.

And `candidateMerge` no longer arrives as an event. A sweep will silently re-score a merged
candidate or lose the old one. Either subscribe to that webhook anyway, or reconcile on
ledger misses.

### 3. Pool rank cannot be computed one candidate at a time

The Snapshot prints *"2 of 41 · top 5%"*. That needs the cohort. In a trickle, the first
person swept is "1 of 1", which is worse than printing nothing.

Options: the engine maintains a per-job score distribution and returns a percentile; or we
compute rank at render time from Ashby's own custom-field values; or we **drop rank** until
a job has enough scored candidates to make it meaningful. Cheapest honest answer is the
third — suppress it under a threshold.

---

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

## Open questions

1. ~~NOT_COLLECTED under résumé-only~~ — **decided**: résumé-only reads report
   `NOT_COLLECTED`, and the score is gated below 50% coverage. See above.
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
