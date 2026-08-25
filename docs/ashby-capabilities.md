# What Ashby actually lets an integration do

Researched from Ashby's own knowledge base and API reference. Split by what is
**documented**, what is **not documented**, and what the documentation contradicts.

The distinction matters because a self-consistent mockup cannot catch an assumption —
both halves agree with each other and every test passes.

---

## Custom fields — the important one

Sam's dashboard story depends entirely on what a custom field value can *do* once written.

| Capability | Status | Source |
|---|---|---|
| Render on the candidate's **Summary tab** | **Confirmed** | "candidate custom fields appear on the summary tab of the candidate profile" |
| **Filter** candidates by custom field value | **Confirmed** | Candidate Search advanced filters: "filtering by a value added to a custom field on the candidate's profile" |
| Usable "in searches and reports" | **Confirmed** | Custom Fields KB |
| Shown as **columns when viewing Projects** | **Confirmed** | "you can show these custom fields as additional columns when viewing projects or filter by custom fields as needed" |
| Shown as a **column in the candidate pipeline** | **NOT DOCUMENTED** | The Candidate Pipeline KB never mentions columns at all |
| Shown as a **column in Application Review** | **Evidence against** | The only documented `add column` options are Ashby's own AI evaluation columns |
| **Sort** records by custom field value | **NOT DOCUMENTED** | Only sorting *options within* a multiple-choice field is described |

**Conclusion.** A custom field written by Sam is reliably **visible** (Summary tab),
**findable** (search filters) and **reportable**. It is *not* documented as a sortable
pipeline column. Projects are the only surface where custom-field columns are confirmed.

### Supported field types

Yes/no · Short answer · Date · Multiple choice · Checkboxes · Number · Currency ·
Long unformatted answer · URL · Employee dropdown · Number range (jobs & openings only) ·
Compensation range (openings only). Archive-reason fields are Plus/Enterprise.

Attachable to: **Candidate, Application, Job, Opening, Project, Employee** (the API's
`customField.setValues` accepts only Application, Candidate, Job, Opening).

---

## The overlap worth knowing about

Ashby ships **AI-Assisted Application Review**, and it already does the thing Sam's
dashboard story claimed:

> "select **add column** on the application review page and choose **AI job criteria met
> percentage**… **sort by this column** to move the best fit candidates (highest
> percentage) to the top of your review queue"

A per-criterion AI evaluation with outcome and reasoning, surfaced as a sortable
percentage column. That is structurally Sam's anchor model, native, and occupying exactly
the screen real estate Sam wanted. `application.listCriteriaEvaluations` is read-only —
no documented partner write path into it.

**But it reads different inputs.** Ashby's AI evaluates *"resume criteria that the AI looks
for within a candidate's resume as well as whether the candidate answered specific
application form questions."* Confirmed: resumes and form answers only — no interviews, no
audio, no behavioural signal. It returns meets / does not meet / **undecided**, with
reasoning.

That is structurally close to Sam's MET / NOT_MET / PARTIAL — with one gap. Ashby has no
equivalent of **NOT_COLLECTED**, because it can only read documents that already exist. The
distinction between *"asked and could not evidence it"* and *"never asked"* requires an
instrument, and Sam has one.

So the overlap is real on the surface and shallow underneath: same shape of output, very
different inputs. Raise it with the partner team as positioning, not as a threat.

---

## Writing to a candidate

| Endpoint | Lands | Confirmed |
|---|---|---|
| `customField.setValues` | Summary tab; batch, atomic | Yes |
| `customField.setValue` | Same; documented race when fired concurrently | Yes |
| `candidate.createNote` | Activity feed; `text/plain` or `text/html`, **tables render** | Yes |
| `candidate.uploadFile` | Files/Attachments tab, alongside the resume | Yes |
| `candidate.uploadResume` | **Forcefully replaces** the primary resume in the viewer | Yes |
| `candidate.addTag` | Tag chips in the header; a search facet | Yes |
| `candidate.addProject` | Adds to a talent pool — **where custom-field columns work** | Yes |
| `applicationFeedback.submit` | Feedback tab, beside human scorecards | Yes |
| `assessment.addCompletedToCandidate` | Native assessment card | Partner-gated |
| `application.changeStage` | Moves/archives; needs `archiveReasonId` | Yes |

## Reading

`candidate.list` · `candidate.info` · `candidate.search` · `application.list` ·
`application.info` · `candidate.listNotes` · `file.info` · `job.info` · `job.list` ·
`interviewStage.list` · `customField.list` · `application.listHistory` ·
`application.listCriteriaEvaluations` · `notetakerTranscript.info`

## Files

Three steps, always: `file.createFileUploadHandle` (context must be `CandidateResume`,
`CandidateFiles` or `ApplicationForm`) → **presigned S3 POST** with the returned `fields`
→ attach the handle. The signature is bound to the declared content type and length.

## Webhooks

`applicationSubmit` · `applicationUpdate` · `candidateMerge` · `candidateStageChange` ·
`candidateHire` · `candidateDelete` · `interviewScheduleCreate` / `Update` ·
`takeHomeAssignmentSubmitted` · `jobPostingDelete`

HMAC-SHA256 over the **raw body**, `Ashby-Signature: sha256=<hex>`. `webhookActionId`
persists across retries. Ashby stamps an `Ashby-Webhook` user agent — never trust it for
auth.

## Auth

Basic, API key as username, blank password. **401** when no key is present; **403 with
`missing_endpoint_permission`** when the key lacks scope. Confidential jobs and private
custom fields are excluded by default and need explicit grants.

## Limits

Reporting: **15 generations/minute, 3 concurrent**. General polling can return **429**.
Write-endpoint idempotency is **not documented** — do not rely on an idempotency key.

---

## Still unknown

- Whether custom fields can ever be a **pipeline column**, and whether records can be
  **sorted** by one. Everything about triage-by-Sam-score depends on this.
- Whether a **partner write path** into AI criteria evaluations exists or is planned.
- Whether a merge carries third-party custom fields, files and notes to the survivor.
- The exact `file.createFileUploadHandle` parameter schema — not published.
- Whether write endpoints honour an idempotency key on retry.
