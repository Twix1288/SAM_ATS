# Sam × Ashby — demo video shot list

Everything below is live in the Ashby sandbox right now. Nothing is mocked, nothing needs
to be set up before recording.

**Runtime:** about 4 minutes. **Cast:** 7 graded candidates across 5 jobs, scoring 15%–94%.

---

## Before you hit record

- Open Ashby in the sandbox org, logged in as yourself (**not** the API key user — the Y/N
  reply in Scene 5 only works if the reply comes from a human account).
- Have a terminal open in the project, with the Scene 5 command ready to paste.
- Close any other Ashby tabs so the sidebar isn't cluttered.

---

## Scene 1 — The only thing a client sets up (20s)

**Click:** Jobs → **Director of Platform Engineering** → scroll to **Custom Fields**

**Show:** the `Sam Grading` toggle, set to **Yes**.

**Say:** "This is the entire client-side setup. One toggle per job. They tick it, and Sam
starts grading everyone who applies to that role. Nothing else to configure, no columns to
add, no new tool to log into."

---

## Scene 2 — What Sam writes back to the job (25s)

**Stay on the same page**, scroll to the Sam fields.

**Show:** `Sam Candidates Graded = 1` · `Sam Median Role Fit = 94` · `Sam Last Run`

**Then click:** Jobs → **Account Executive**

**Show:** `Candidates Graded = 3` · `Median Role Fit = 50` · and **`Sam Cohort Finding`** —
*"No applicant for this role shows multi-stakeholder deal navigation…"*

**Say:** "On a role with a few applicants, Sam also compares them against each other and
writes back one finding about the pool as a whole — not just the individuals."

---

## Scene 3 — The candidate record (60s) ⭐ *the main shot*

**Click:** Candidates → **Edwardo Lockman**

**Show, in this order:**

1. **The tags in the header** — `⭐ Sam Graded` and `⭐ Sam · Strong`
2. **The top note in the activity feed** — the scorecard. Let it sit on screen:
   - `Role fit █████████░ 94%`
   - `Capability ███████░░░ 7/10`
   - `Requirements ██████████ 6 of 6`
   - Experience **Strong** · Responsibility **Solid** · Level **Meets** · Overall **Strong**
   - **Next step.** "Strong enough to interview. Confirm the $6M+ infrastructure budget…"
   - **✓ STRENGTHS** — four, each with the evidence Sam found
   - **? ASK IN INTERVIEW** — three numbered questions, written to be read aloud

**Say:** "Everything a recruiter needs is in the note — they don't have to open anything.
The bars are there so you can scan a list of these without reading a word. And the questions
at the bottom are what Sam couldn't establish from the documents."

> **Worth opening Jamar Herzog (65%) straight after**, because his questions are the sharper
> case: all three are requirements *currently counted as not met*, each tagged underneath,
> and the first is marked **core requirement** — the one actually capping his score. On
> Edwardo, who meets 6 of 6, the questions are smaller details instead. Same system, ranked
> by what answering would change.

---

## Scene 4 — The Snapshot (30s)

**Click:** the Files tab (or the filename named at the bottom of the note)

**Show:** `sam_snapshot_edwardo_lockman_c6c5782d.pdf` — open it.

**Say:** "Sam renders this report. We attach it to the Ashby record with the candidate's own
résumé bound in behind it, so one document has both the grading and what it was graded on."

**Then click:** the **"Open on Sam →"** link at the bottom of the note.

**Say:** "And it links straight back to Sam."

---

## Scene 5 — The conversation (60s) ⭐ *the differentiator*

This is the part nobody else does. Film it in one take.

**On Edwardo's note**, the `? ASK IN INTERVIEW` list is three things Sam could not establish
from the documents. On a candidate like **Jamar Herzog** they are the requirements actually
holding his score down — each tagged *not met*, and the first also *core requirement*.

**Click Reply on the note and type:**

```
1Y 2N 3Y
```

**Say while typing:** "Sam asked three things it couldn't tell from the résumé. The recruiter
finds these out in the screen — and normally that answer goes in their head and never back
onto the record. Here they just answer in the feed, in the tool they already have open."

**Then run in the terminal** (cut to screen, or run it off camera and cut back):

```bash
ASHBY_LIVE=1 npm run followup -- --post
```

*(That's the whole command — the key is read from `.env`. Run it once without `--post` first
if you want to see what it found before it writes anything.)*

**Cut back to Ashby and refresh.** Two things have changed:

1. **A new note:**

> **Sam · updated from Rishit Agnihotri**
> ✅ Multi-stakeholder deal navigation — confirmed
> ❌ Pipeline management and forecast accuracy — still not evidenced
> ✅ HR and talent acquisition buyer context — confirmed
>
> 2 of 3 confirmed, recorded against Jamar Herzog's grading.
>
> **Still open** — Budget ownership at Carlson Civil
>
> *Sam's score is unchanged — it grades from the documents it was given, and this was not in
> them. What you confirmed is on the record and goes to Sam with the next grading.*

2. **A new field on the Summary tab** — `Sam Confirmed`, carrying the confirmations with who
   said them and when, so the next person to open the record sees it without scrolling.

**Say:** "Sam records it against the grading and names who said it — nothing on a hiring
record says 'confirmed' without saying who confirmed it. And it's explicit that the score
hasn't moved, because Sam grades from documents and this wasn't in them."

**Worth adding if they ask about scale:** answer two of three, and the next pass asks the
*next* open items rather than the same three again — so a candidate with eight open questions
gets worked through instead of nagged.

## Scene 6 — Finding the right people (30s)

**Click:** Candidates → filter by tag **`⭐ Sam · Strong`**

**Show:** Edwardo Lockman (94%) and Efren Schowalter (90%)

**Switch the filter to `⭐ Sam · Not a match`**

**Show:** Jim Halpert (50%) and Creed Fraudster (15%)

**Say:** "Ashby won't let you filter or sort on a custom field — we checked, every list
endpoint accepts the filter and ignores it. Tags are a native filter, so the score is
findable with zero setup on the client's side."

---

## Scene 7 — Proof it actually discriminates (20s)

**Click:** **Creed Fraudster**

**Show:** the header tags and the **top note only** — `Role fit ██░░░░░░░░ 15%`, 0 of 6
requirements, Not a match.

**Say:** "Same pipeline, same job. A résumé that doesn't hold up scores 15 and says so. The
grading isn't flattering everybody."

> ⚠️ **Do not open Creed's Files tab and do not scroll his activity feed.** He and Jim
> Halpert still carry development-era test files and probe notes from when we were working
> out the note rendering. Ashby has no API to delete a file or a note, so they can't be
> removed. Their newest note and their tags are correct — just don't scroll.

---

## The five records that are clean top to bottom

Use any of these freely — every surface on them is current:

| Candidate | Fit | Band | Job |
|---|---|---|---|
| Edwardo Lockman | 94% | ⭐ Sam · Strong | Director of Platform Engineering |
| Efren Schowalter | 90% | ⭐ Sam · Strong | Recruiter |
| Aylin King | 83% | ⭐ Sam · Solid | Backend Engineer |
| Vivianne Bogan | 74% | ⭐ Sam · Partial | Frontend Engineer |
| Jamar Herzog | 65% | ⭐ Sam · Partial | Account Executive |

---

## Numbers you can quote

- **7 candidates** graded live across **5 jobs**, scoring **15% to 94%**
- **212 automated tests**, plus **3 checks that run against the real Ashby API**
- **4 surfaces** written per candidate: custom fields, the Snapshot PDF, the scorecard note,
  and the tags — plus `Sam Confirmed` once a human answers
- **1 toggle** is the entire client-side setup

---

## Don't show

- **Creed Fraudster's and Jim Halpert's** Files tab or older notes — development artifacts,
  not deletable via Ashby's API
- **Guadalupe Koss, Leopold Runte, Ollie Anderson, Alejandra Smith** — graded in September
  against an older format, on jobs that aren't enrolled now. They carry no Sam tag, so they
  won't appear in any filter you use above.
- The `.env` file or the terminal scrollback from a run with keys in it
