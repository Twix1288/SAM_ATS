# What the Ashby integration needs from Sam

A brief for whoever builds the endpoint. Written as information, not as JSON — the exact
field names are in [sam-payload-spec.md](sam-payload-spec.md); this is what the fields have
to *contain* and why.

One call: we send a job and a person, Sam sends back a grading.

---

## First — do not send us these. We already have them.

Everything about a person's **identity** comes from Ashby, and Ashby is the system of record.
If Sam sends its own copy we will ignore it, and if the two ever disagree the record wins.

| We get from Ashby | So Sam should not send |
|---|---|
| Name, email, phone, LinkedIn, location | any of it |
| The résumé file itself | the résumé text back |
| Their other attachments | copies of them |
| Current title and employer | their contact details |
| Which job they applied to, and when | the job posting text back |

Sam gets the résumé and the job description **from us**, on the way in. What comes back
should be judgement only.

---

## What only Sam can tell us

### 1. How well they fit — two numbers that must travel together

**A fit score, 0–100.** How much of the job this person meets.

**A coverage figure, 0–100.** How much of the job Sam could actually *assess* from what it
was given. A résumé says nothing about how someone handles disagreement, so a rubric line
about collaboration is unassessable from a résumé — that lowers coverage.

These are inseparable and the second is the one people forget. *68% fit* means nothing on its
own: 68% of everything, or 68% of the third we could see? We refuse to publish the fit score
at all when coverage is under 50%, because a coverage-denominated number in a sortable column
is a lie by omission.

> Send the fit score **already denominated by coverage**. We never recompute it — one source
> of truth, and if the formula changes the document follows automatically.

**A capability figure, 0–10**, with the signals behind it: which working behaviours the
evidence showed ("ships end to end", "names the systems they run") and which it did not
("quantifies impact"). This is the *how they work* read, separate from *can they do the job*.

### 2. Requirement by requirement — the actual reasoning

For every line of the job that matters, we need:

- **The requirement, in the job's own words.** "2–5 years on a modern backend stack", not
  "experience".
- **One of four verdicts** — and the fourth is the whole product:
  - **Met** — the evidence shows it
  - **Partial** — described but not sized, or adjacent
  - **Not met** — we looked in what we had and it was not there
  - **Never asked** — *unassessable from what Sam was given.* Not the candidate's fault, and
    excluded from the coverage denominator so it lowers confidence without counting against
    them.
- **One sentence of reasoning a human would actually say.** "Names the work but no
  before/after figure, so the size of the improvement is unknown" — not "insufficient
  evidence for criterion 3".
- **How much this requirement matters**, as a weight, so the document can order them.

The difference between *not met* and *never asked* is the reason this exists. Every ATS can
say "no match". Only an instrument that knows what it asked can say "we never asked".

### 3. Evidence — a quote, and where it came from

For anything marked **met**, we need the candidate's own words and a locator precise enough
for a reviewer to go and check: `résumé · page 1`, `interview · Q3`.

A quote with no source is worse than no quote. It looks like proof and cannot be verified,
and the first time a hiring manager fails to find it the whole document loses credibility.
We reject a payload where evidence has no source rather than render it.

### 4. The read — prose, for a human in a hurry

**A short paragraph.** What Sam actually concluded, in the voice a good recruiter would use
to a colleague. This is the first thing on the note and the thing most people will read
instead of everything else. Two to four sentences.

**One recommended next step**, specific enough to act on. "Screen. Ask for a sized example of
a reliability fix, and one schema they designed." Not "proceed to interview".

**Any caveats**, plainly. "Scored from a résumé alone; nothing here reflects how they work in
conversation."

### 5. Their shape against this role — three one-line verdicts

Three quick reads that sit above the fold:

- **Experience** — do they have the depth the role asks for?
- **Responsibility** — have they owned what this job owns?
- **Level** — are they at the right altitude, or a stretch either way?

Each is a band (Strong / Partial / Light / Not determined) plus one sentence. Plus, for the
level read, **one or two things worth asking** in a screen — the only place Sam gets to hand
over more than one action.

### 6. Career history — clean rows

Title, company, start, end. The single most visible way this document can look careless is a
swapped field: `{title: "Apollo Tyres", company: "Sales Intern"}` renders as a job title of
Apollo Tyres on a real person's record. We drop obviously-broken rows defensively, but they
should not arrive broken.

Also useful, not required: the other skills the résumé mentions that no requirement covered.

### 7. What it read — literally

A plain list of what Sam actually opened: `["résumé"]`, or
`["résumé", "interview"]`. This prints on the document verbatim as the provenance line and
fills a field in Ashby.

It must be **literal, not aspirational**. If Sam read only a résumé it says résumé, and then
it must not also send interview recordings — a document claiming a résumé-only read while
shipping audio invites a reviewer to weigh evidence the score never used.

### 8. The link back to Sam

**A full `https://` URL to this grading on Sam's own site.**

This goes on every page of the PDF and in the note. It is how a hiring manager gets from a
document in Ashby to the live record — the recordings, the full evidence, anything the
Snapshot could not fit.

Sam must own this URL. We used to build it from the candidate's name, which breaks the moment
two people share one. Send a real link or send none: a 404 on a hiring manager's screen is a
public claim that there is more to see, and whoever clicks it concludes the document is stale.

### 9. Bookkeeping, so we can be safe

- **An id for this grading** — so a retry is recognisable as the same score, not a new one.
- **Which rubric version produced it** — job descriptions get edited, and we need to know
  whose score is now answering requirements that no longer exist.
- **The three Ashby ids we sent** — candidate, application, job — echoed back. We check the
  job id matches before writing anything. It is the difference between "we scored the right
  person against the right role" being a check and being a hope.

---

## One thing we would like to send back — a recruiter's answer

This is the only request in here that is not already built on our side.

Every grading comes back with requirements marked *not met* and a `what_to_confirm` list.
Those are now questions on the candidate's record in Ashby, numbered, and a recruiter answers
them in the activity feed — `1Y 2N` — because they find these things out in the screen. That
is live and working: the answer is recorded against the grading, attributed to the person who
gave it, and shown beside the score.

**What it cannot do is reach Sam.** `POST /api/v1/snapshots` takes `resume_pdf_base64` or
`resume_url` and nothing else, so a requirement a recruiter has confirmed stays *not met* in
every future grading. The candidate's score never improves on the strength of a fact a human
established.

What would close it, in whatever shape suits the engine:

```jsonc
"confirmations": [
  {
    "anchor": "Multi-stakeholder deal navigation",   // the requirement, in Sam's own words
    "confirmed": true,
    "note": "Ran six-person committee deals at Datadog, procurement and security both in",
    "by": "Dana Reed",                                // a named human, not a system
    "at": "2026-10-09T18:00:00Z"
  }
]
```

Three things we would want from how Sam treats it:

- **It is evidence, not an override.** Sam decides what a confirmation is worth. We are not
  asking for a way to set a score.
- **It is attributable.** If a confirmation moves an anchor, the grading should say who
  confirmed it, the same way it quotes a résumé line.
- **Unknown confirmations are ignored, not rejected.** If an anchor name no longer matches
  after a re-derive, drop it and grade without it rather than failing the request.

Until then the answers accumulate on the Ashby record and the grading does not see them,
which is a working product with a visible seam — a record that says "confirmed" beside a
score still counting the requirement as missing. We say so explicitly on the record rather
than leaving a reader to notice.

---

## What we send Sam

| | |
|---|---|
| **The job description** | Body text only. We strip the equal-opportunity boilerplate — 891 identical characters on every posting — because a rubric compiled from it grows requirements no candidate can evidence |
| **The job's facts** | Employment type, on-site or remote, location, team, compensation band. Things the prose does not state cleanly but a rubric should know |
| **A version hash of that description** | So Sam can cache a compiled rubric and we can both detect an edit |
| **The résumé** | The file itself. **Sam does the text extraction** — ours reads zero characters out of real Ashby PDFs |
| **Their other attachments** | Cover letters and so on, flagged as unscored unless Sam reads them |
| **The three Ashby ids** | Candidate, application, job |

---

## Two rules that will save an argument later

**Optional means `null`, never missing.** A field that is present and null prints an honest
"Not determined". A field that is absent is a bug we cannot tell apart from a real absence,
and we will reject the payload rather than guess which it was.

**Send conclusions, not working.** How Sam decided — the signals it matched, the intermediate
scores — is rubric input, not result. The Snapshot renders the judgement and the evidence,
never the arithmetic. Anything extra is ignored, and a document that shows its working reads
as a machine rather than a colleague.

---

## What one good answer looks like

Not a schema — the actual substance, for one real person:

> **Fit 68 at 72% coverage. Capability 7/10.**
>
> **Owns projects end to end** — *met*. Describes taking two services from design through to
> production and iterating afterwards. *"Owned the billing service from design through to
> production"* — résumé · p.1
>
> **Improves scalability as usage grows** — *partial*. Names the work but no before/after
> figure, so the size of the improvement is unknown.
>
> **Develops data models and storage** — *not met*. Nothing in the document read describes
> schema or storage design.
>
> **Works across product and design** — *never asked*. How someone works with other functions
> is not a thing a résumé can evidence. It needs a conversation.
>
> **The read:** A credible backend engineer on the evidence available. Ownership and stack are
> both clearly shown; the scale work is described but never sized, and nothing speaks to data
> modelling. The collaboration requirement — the one the posting leads with — cannot be read
> from a résumé at all, which is most of why coverage sits at 72%.
>
> **Next step:** Screen. Ask for a sized example of a reliability fix, and one schema they
> designed.
>
> **Read from:** résumé · **Full grading:** https://app.launchsam.com/grading/9f3c21a8

Every sentence there is doing a job. The reasoning is specific enough to disagree with, the
evidence is checkable, the gap is named rather than buried, and the one thing a résumé could
never show is marked as never asked instead of counted as a failure.
