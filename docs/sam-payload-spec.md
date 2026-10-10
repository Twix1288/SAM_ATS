# What Sam must send, for any job

The engine owns judgement. This side owns presentation. Every number, state, reason and
quote arrives already decided; nothing here re-derives a score or invents a value.

This document is the field-by-field contract. It supersedes the payload table in
[sam-engine-contract.md](sam-engine-contract.md), which was written around one rubric
(Sales Account Executive) and one instrument (a voice questionnaire). Everything below was
derived from `sam-integration/ingest/enginePayload.js` and the renderers, not from the
older doc — where the two disagree, this one is right.

Budgets and rendering claims were measured against Helvetica at the sizes the renderer
actually uses: 612×792pt page, 46pt margins, 520pt usable width.

---

## 1. Hard-required

Absent, null, or the wrong type ⇒ `ContractError`, and **no Snapshot is produced at all**.

| Field | Type | Feeds |
|---|---|---|
| `schemaVersion` | non-empty string | version gate only |
| `scoreId` | non-empty string | idempotency key for the delivery ledger |
| `subject.ashbyCandidateId` | non-empty string | note + file target |
| `subject.ashbyJobId` | non-empty string | ledger key `(candidateId, jobId)` |
| `scores.roleFit` | number 0–1 | PDF header %, Ashby field, note headline |
| `scores.coverage` | number 0–1 | PDF `N% COVERAGE`, Ashby field — **and gates publication at 0.5** |
| `scores.capability` | number 0–10 | PDF, Ashby field, note |
| `anchors` | array, ≥ 1 | every anchor-derived section |
| `anchors[].id` | non-empty string | see §3 — `A1`/`A3` are magic |
| `anchors[].label` | non-empty string | anchors, coverage gaps, gaps-to-investigate, evidence |
| `anchors[].state` | `MET`\|`PARTIAL`\|`NOT_MET`\|`NOT_COLLECTED` | state chip, colour, all counts |
| `anchors[].reason` | non-empty string | printed under the anchor, and in two other sections |
| `anchors[].weight` | number | orders gaps-to-investigate |
| `anchors[].evidence[].quote` | non-empty string | evidence section |
| `anchors[].evidence[].source` | non-empty string | **hard failure if missing** — see §4 |
| `inputs.read` | array, ≥ 1 | the provenance line, verbatim |
| `narrative.netRead` | non-empty string | Net read, note body, dossier |
| `narrative.recommendedNextStep` | non-empty string | first line of the PDF and the note |

One cross-field rule is enforced: if `inputs.audio` is non-empty, at least one entry in
`inputs.read` must match `/voice|interview|recording|response/i`. A payload claiming
résumé-only while shipping recordings is refused, because it would invite a reviewer to
play evidence the score never used.

## 2. Optional means `null` — and complete

A whole section may be `null`. A section that arrives **half-filled** is a different thing,
and it used to kill the delivery: the payload passed validation and then threw inside
pdf-lib, so the candidate got no Snapshot rather than a Snapshot missing one line.

The renderer now fills the array keys defensively, but send them complete:

```jsonc
"profile": {
  "experienceMatch":     null | { "band": "…", "line": "…" },
  "responsibilityMatch": null | { "band": "…", "line": "…" },
  "roleLevelFit":        null | { "band": "…", "line": "…", "suggestions": ["…"] }
},
"scores": {
  "capabilitySignals":   null | { "met": ["…"], "missing": ["…"] }
}
```

Send `[]` for an empty `suggestions` / `met` / `missing`, never omit the key.

`band` should be one of `Strong` · `Partial` · `Not shown` · `Not asked` ·
`Not determined` · `Not assessed`. Any other string renders, but in neutral grey — the
page's colour language silently stops working.

## 3. The three fit rows are role-specific — send them

`experienceMatch`, `responsibilityMatch` and `roleLevelFit` are three of the five rows
above the fold.

When they are `null`, this side tries to derive the first two from the anchor whose id is
**literally `A1`** and **literally `A3`**. There is no semantic lookup — the id string is
the only key. That works for exactly one rubric.

> **For any other job, send all three as complete objects.** Sending `null` on a rubric
> with ids like `ANCH_OUTBOUND` leaves both rows reading *"Not determined — the engine did
> not send this row."*

(They previously read *"The inputs did not evidence this"*, which was a false statement
whenever the anchors below showed MET. That wording is fixed; the requirement stands.)

`roleLevelFit.suggestions` renders as bullets and is **the only place the engine can give
the reviewer more than one action.** 1–3 entries, ≤ 90 chars each. It is the highest-value
under-used field in the document.

## 4. Evidence: `source` is a locator a human can navigate to

`source` is printed verbatim next to the quote. Format for any job:

| Source kind | `source` |
|---|---|
| Résumé | `résumé · p.2` |
| Résumé, no reliable page | `résumé` |
| Interview / voice answer | `interview · Q3` |
| Take-home | `take-home · task 2` |
| Portfolio / work sample | `portfolio · case study 1` |
| Cover letter | `cover letter` |
| Public profile | `linkedin · headline` |

Lower-case, ` · ` separator, **≤ 28 characters**. It must name a place a human can go —
`resume_chunk_7f3a` passes validation and fails the point of the rule.

**Only `evidence[0]` of `MET` anchors reaches the PDF's evidence section.** Evidence on
PARTIAL / NOT_MET / NOT_COLLECTED anchors is carried and never rendered. Sending more than
one quote per anchor is not wasted — it reaches the dossier — but the first is the one that
gets read.

`evidence[].locator` is accepted and read by nothing. Send `null` or drop it.

## 5. `inputs`, for an instrument that is not a questionnaire

```jsonc
"inputs": {
  "read": ["résumé", "take-home submission"],  // literal, ordered, printed verbatim
  "audio": [],                                  // ONLY browser-playable recordings
  "answeredCount": null,                        // questionnaire-only; null otherwise
  "resume": null,                               // read by nothing — Ashby supplies the file
  "jobDescription": null                        // read by nothing
}
```

`inputs.read` becomes the header line `Scored from résumé + take-home submission`.

- Lower-case noun phrases, no counts, no trailing punctuation.
- **≤ 120 characters joined**, so at most three entries, or it collides with the score block.
- One entry **must** contain `resume` or `résumé` (case-insensitive) when a résumé was read
  — that regex is the only thing that sets `hasResume`. **`CV` does not match**, and the
  document will claim there is no résumé on file.

## 6. Anchor states mean different things per instrument

Shape is universal; meaning is not. The `reason` string is the only thing telling the
reviewer which sense applies.

- **`NOT_COLLECTED` — the inputs *could not* have shown it.** Excluded from the coverage
  denominator (`observable = total − notCollected`), so it lowers `coverage` **without
  counting against the candidate**.
- **`NOT_MET` — the inputs could have shown it and did not.** This is the state that costs
  the candidate.

On a résumé-only read, most anchors that would be `NOT_MET` after an interview are honestly
`NOT_COLLECTED` — a résumé does not evidence objection handling. **Getting this split wrong
is the fastest way to make a good candidate look weak.**

Note the rendered band for `NOT_COLLECTED` is "Not asked", which reads oddly for a
résumé-only job; the coverage-gap wording ("Not covered by the inputs") is the accurate one.

## 7. Career history — the drop rules

```jsonc
"careerHistory": {
  "roles": [{ "title": "…", "company": "…", "start": "2023-04", "end": "Present" }],
  "source": "candidate_resume.pdf",   // printed as "From <source>" — a filename
  "note": null                         // printed ONLY when roles is empty
}
```

Rows are filtered on arrival and **dropped silently**. A row survives only if `title` and
`company` are both present, `title` is longer than one character, and `company` does not
match `/\d{2}%|\brates\b/i`.

Fields are **not** re-ordered: a swapped `{title: "Apollo Tyres", company: "Sales Intern"}`
passes every filter and prints as-is. This is the most visible way the document can look
careless, so send them the right way round.

`title` renders unwrapped: hard ceiling ~98 characters, keep to **≤ 60**.

## 8. Budgets

**Unwrapped — exceeding these overprints neighbouring text. No ellipsis, no wrap.**

| Field | Hard ceiling | Recommended |
|---|---|---|
| `anchors[].label` | 98 chars | **≤ 55** — repeated in four places |
| `careerHistory.roles[].title` | 98 | ≤ 60 |
| evidence `source` | — | ≤ 28 |
| `inputs.read` joined | 122 | ≤ 70, max 3 entries |

**Wrapped — budget is page count and readability, not breakage.**

| Field | Budget |
|---|---|
| `narrative.recommendedNextStep` | **≤ 200** (2 lines) — first thing on the page |
| `anchors[].reason` | **≤ 240** (2 lines); past ~320 a 6-anchor Snapshot grows to 3 pages |
| `evidence[].quote` | **120–200** — quote a whole sentence, not a truncated fragment |
| `narrative.netRead` | **400–700** (3–6 lines) |
| `narrative.caveats[]` | ≤ 140 each, ≤ 3 entries |

**Anchor count:** 5–8 renders well. Below 4 the page looks thin; past 10 it spills to a
third page and the note becomes a wall.

## 9. Send these — the Snapshot is materially better with them

All five render today and all five are null/empty in the current example payload, which is
why the demo has dead rows above the fold.

1. **`experienceMatch` / `responsibilityMatch`** — mandatory for any non-A1/A3 rubric (§3).
2. **`roleLevelFit`** including `suggestions[]` — the only multi-action surface.
3. **`capabilitySignals`** — 3–6 met signals. Role-independent, cheap, renders in all three
   surfaces. Null prints the stub `How they work: .`
4. **`narrative.caveats[]`** — send whenever coverage is below ~0.7. An unexplained low
   number is what makes a reviewer distrust the whole document.
5. **`profile.additionalSkills[]`** — a `·`-joined line in the PDF, chips in the dossier.

## 10. Stored, not shown

Do not spend engineering making these good; nothing renders them.

`scores.capabilityRaw` · `engine.rubricSource` · `anchors[].detail` ·
`evidence[].locator` · `inputs.answeredCount` (engine path) · `inputs.resume` ·
`inputs.jobDescription` · `scoredAt` · `engine.version` · `engine.rubricId`

Keep **`engine.rubricVersion`** — it is the only way to detect a candidate scored under a
superseded rubric.

## 11. Identity comes from Ashby, never the engine

Verified against `candidate.info` on a live org (2026-09-10):

| Snapshot field | Ashby path | Notes |
|---|---|---|
| name | `name` | |
| email | `primaryEmailAddress.value` | |
| LinkedIn | `socialLinks[].url` where `type === 'LinkedIn'` | enum confirmed |
| location | `location.locationSummary` | present on ~70% of candidates |
| résumé | `resumeFileHandle` `{id, name, handle}` | |
| attachments | `fileHandles[]` | |
| job title | `job.title` | **`job.company` is null on every real Ashby job** |

Ashby also returns `position`, `company` and `school` (current employer/title/school). The
Snapshot does not use them today — they are the obvious cross-check against the engine's
`careerHistory`.

**Send ids; we resolve them.** A payload carrying a name or an email is ignored.

---

## Minimum viable payload — résumé-only job, no interview instrument

The shape for the likely first real customer.

```jsonc
{
  "schemaVersion": "1.0",
  "scoreId": "sam_score_<candidate>_<job>_<rubricVersion>",
  "scoredAt": "2026-09-10T08:00:00.000Z",
  "engine": { "version": "sam-engine@1.0.0", "rubricId": "ops-manager",
              "rubricVersion": "1", "rubricSource": null },
  "subject": { "ashbyCandidateId": "…", "ashbyApplicationId": "…", "ashbyJobId": "…" },

  "inputs": { "read": ["résumé"], "audio": [], "answeredCount": null,
              "resume": null, "jobDescription": null },

  "scores": {
    "roleFit": 0.71, "coverage": 0.58, "band": "Moderate — résumé evidence only",
    "capability": 7, "capabilityRaw": null,
    "capabilitySignals": {
      "met": ["Owns a number", "Names the systems they run", "States outcomes, not activity"],
      "missing": ["Quantifies results"]
    }
  },

  "anchors": [
    {
      "id": "OPS_SCALE", "label": "Ran operations at 50+ headcount", "weight": 0.3,
      "state": "MET",
      "reason": "Names a 70-person site and the shift structure they owned.",
      "evidence": [{ "quote": "…whole sentence…", "source": "résumé · p.1", "locator": null }]
    }
    // 5–8 total, one evidence entry on each MET anchor
  ],

  "narrative": {
    "netRead": "…400–700 chars…",
    "recommendedNextStep": "…≤200 chars…",
    "caveats": ["Scored from a résumé alone; nothing here reflects how they work in conversation."],
    "gapsToInvestigate": null           // null = derived from anchors by weight
  },

  "profile": {
    "careerHistory": { "roles": [ /* … */ ], "source": "<filename>.pdf", "note": null },
    "additionalSkills": ["…"],
    "experienceMatch":     { "band": "Strong",  "line": "…" },   // required: ids are not A1/A3
    "responsibilityMatch": { "band": "Partial", "line": "…" },   // required: ids are not A1/A3
    "roleLevelFit":        { "band": "Strong",  "line": "…", "suggestions": ["…"] }
  }
}
```

## The coverage floor

Below **50% coverage** (`MIN_SCOREABLE_COVERAGE`) the Role Fit number is withheld
everywhere — the PDF header shows `—`, the Ashby field is cleared, and the note says
"Not scored". Coverage still publishes, because it is what explains the absence.

A coverage-denominated score is only comparable between candidates at similar coverage. The
document can carry that caveat; a filterable integer in an ATS cannot.
