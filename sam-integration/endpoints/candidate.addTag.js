/**
 * The tag that makes a graded candidate findable.
 *
 * WHY THIS EXISTS. Sam's four custom fields are visible on the Summary tab and useless for
 * discovery: verified against a live org, Ashby's list endpoints ignore every custom-field
 * filter we could construct — an impossible `customFieldFilters` returns every row, and so
 * does a parameter that does not exist. There is no way to ask "who has Sam graded".
 *
 * A tag is the one marker Ashby treats as a first-class search facet, and it shows as a chip
 * in the record header rather than three scrolls down the Summary tab. It answers a question
 * the custom fields cannot.
 *
 * WHY IT SAYS NOTHING ABOUT THE SCORE. "Sam: Strong" was considered and refused, and the
 * reasoning still holds: a band is a coverage-denominated judgement, and a chip has no room
 * for the denominator. "Strong at 40% coverage" and "Strong at 90% coverage" would wear the
 * same chip, and the chip is the version a reviewer sees first. So the tag carries the one
 * thing that is unambiguously true — that Sam has looked — and every number stays on the
 * surfaces that can qualify it.
 *
 * Tag application is idempotent: verified on a live record, adding the same tag three times
 * leaves exactly one. So this needs no `verify` and is safe on every re-delivery.
 */
import { ENDPOINTS } from '../../shared/ashby-contract.js';
import { post } from './client.js';
import { raiseAlert, ALERT, SEVERITY } from '../delivery/alerts.js';

/**
 * Neutral by design — and deliberately eye-catching.
 *
 * The star is not decoration. A tag chip sits in a row with every other tag a recruiter's
 * team has ever applied ("Very Senior", "Keep warm", "Engineering Event 9/12"), and a plain
 * text one disappears into that row. This org's own projects are named ☕️ Close network and
 * ❄️ Cold outreach, so a leading glyph is the convention here rather than a novelty.
 *
 * The WORDS still say nothing about the score. "Sam: Strong" was considered and refused: a
 * chip has no room for the coverage denominator, so Strong-at-40% and Strong-at-90% would
 * wear the same one. The star makes it findable; it does not make a claim.
 */
export const SAM_TAG = '⭐ Sam Graded';

/**
 * The band, as a tag — so the score is findable with NO setup by the client.
 *
 * Sam's numbers live in custom fields, and Ashby will not filter a list on a custom field:
 * verified, every list endpoint accepts a custom-field filter, ignores it, and still reports
 * success. The one surface that gives a ranked, sortable view is a Project with columns
 * added — and adding those columns is manual work we do not want to ask a client to do.
 *
 * A tag needs no configuration at all. It is a chip in the record header and a facet in
 * candidate search the moment it is applied, so "show me everyone Sam rated Strong" is a
 * filter a recruiter already knows how to use.
 *
 * WHY A BAND IS NOW SAFE TO PUT ON A CHIP. "Sam: Strong" was refused earlier, and the
 * reasoning was sound at the time: our band was coverage-denominated, and a chip has no
 * room for the denominator, so Strong-at-40%-coverage and Strong-at-90% would wear the same
 * one. That band is gone. This is SAM'S OWN verdict — its `match.strength`, already
 * accounting for its own cap rules — so the tag surfaces a judgement Sam has made rather
 * than compressing one of ours.
 *
 * Exactly one band tag is ever on a candidate: applying a new one removes the others, so a
 * re-score that moves someone from Strong to Partial does not leave both behind.
 */
export const BAND_TAGS = {
  Strong: '⭐ Sam · Strong',
  Solid: '⭐ Sam · Solid',
  Partial: '⭐ Sam · Partial',
  'Not a match': '⭐ Sam · Not a match',
};

/**
 * The prefix every band tag shares — and the thing stale-tag removal matches on.
 *
 * Matching removal against the VALUES of the map above was the obvious version and it leaks:
 * a band retired from the map stops being recognised as stale, so it is never taken off, and
 * the candidate keeps a tag for a verdict that no longer exists alongside their current one.
 * The prefix keeps working for bands this map has not heard of, in either direction.
 */
export const BAND_PREFIX = '⭐ Sam · ';

/** The band word, out of a band line that may carry provenance ("Strong · résumé only"). */
export const bandTagFor = (band) => {
  const head = String(band ?? '').split('·')[0].trim();
  const key = Object.keys(BAND_TAGS).find((k) => k.toLowerCase() === head.toLowerCase());
  return key ? BAND_TAGS[key] : null;
};

/**
 * A verdict we have no tag for, as opposed to the absence of a verdict.
 *
 * The difference decides whether silence is correct. "Not determined" and "Insufficient
 * evidence" are OUR words for "Sam did not reach a verdict", and a candidate with no verdict
 * should carry no band tag — that is the design, and it is right.
 *
 * A band Sam DID return and we simply do not recognise is the opposite case, and it is how
 * this failed live: Sam began returning SOLID, which was not among the three bands it
 * documented, so `bandTagFor` returned null and an 83% candidate landed with no band tag at
 * all. Nothing failed, nothing was logged, and the record looked finished. The next band Sam
 * adds should be noisy on the first candidate rather than discovered in an audit.
 */
const NON_VERDICTS = ['not determined', 'insufficient evidence', ''];
export const isUnrecognisedVerdict = (band) => {
  const head = String(band ?? '').split('·')[0].trim().toLowerCase();
  return !NON_VERDICTS.includes(head) && !bandTagFor(band);
};

/** Resolved once per process — the id is stable and the list is small. */
let cachedTagId = null;

/**
 * Finds the tag, creating it if the org does not have it yet.
 *
 * `candidateTag.create` needs a higher permission than tagging does, so a key scoped to
 * candidate writes alone will fail here — which is why the caller treats a missing tag as a
 * skipped surface rather than a failed delivery.
 */
export async function resolveSamTagId({ create = true } = {}) {
  if (cachedTagId) return cachedTagId;

  const tags = (await post(ENDPOINTS.listCandidateTags, {})) ?? [];
  const found = tags.find((t) => t.title === SAM_TAG && !t.isArchived);
  if (found) { cachedTagId = found.id; return cachedTagId; }

  if (!create) return null;
  const made = await post(ENDPOINTS.createCandidateTag, { title: SAM_TAG });
  cachedTagId = made?.id ?? null;
  return cachedTagId;
}

/**
 * Marks a candidate as graded by Sam.
 *
 * Never throws. This is the one surface whose absence costs the reader nothing they cannot
 * get elsewhere — the note, the Snapshot and the fields all still landed — so a tagging
 * failure must not fail a delivery that otherwise succeeded.
 *
 * @returns {Promise<{ok: boolean, tag: string, detail?: string}>}
 */
export async function tagAsGraded({ candidateId }) {
  try {
    const tagId = await resolveSamTagId();
    if (!tagId) return { ok: false, tag: SAM_TAG, detail: 'the tag does not exist and could not be created' };

    await post(ENDPOINTS.addCandidateTag, { candidateId, tagId });
    return { ok: true, tag: SAM_TAG };
  } catch (err) {
    return { ok: false, tag: SAM_TAG, detail: err.message };
  }
}

/**
 * Puts the right band tag on, and takes any other band tag off.
 *
 * Never throws — this is a findability aid, and losing it must not fail a delivery that
 * otherwise landed.
 */
export async function tagBand({ candidateId, band }) {
  const wanted = bandTagFor(band);
  if (!wanted) {
    if (isUnrecognisedVerdict(band)) {
      raiseAlert({
        code: ALERT.unknownBand,
        severity: SEVERITY.warning,
        message: `Sam returned the band "${band}", which has no tag. The candidate is graded `
          + 'but will not appear under any band filter. Add it to BAND_TAGS.',
        context: { candidateId, band },
      });
    }
    return { ok: false, skipped: true, detail: `no tag for band "${band}"` };
  }

  try {
    const tags = (await post(ENDPOINTS.listCandidateTags, {})) ?? [];
    const byTitle = new Map(tags.filter((t) => !t.isArchived).map((t) => [t.title, t.id]));

    let wantedId = byTitle.get(wanted);
    if (!wantedId) wantedId = (await post(ENDPOINTS.createCandidateTag, { title: wanted }))?.id;
    if (!wantedId) return { ok: false, skipped: false, detail: 'could not create the band tag' };

    await post(ENDPOINTS.addCandidateTag, { candidateId, tagId: wantedId });

    // Remove any OTHER band tag. Without this a re-score leaves "Strong" and "Partial" on
    // the same person, and a recruiter filtering on either one gets them.
    const candidate = await post(ENDPOINTS.candidateInfo, { id: candidateId });
    const stale = (candidate?.tags ?? [])
      .filter((t) => String(t.title ?? '').startsWith(BAND_PREFIX) && t.title !== wanted);
    for (const t of stale) {
      await post(ENDPOINTS.removeCandidateTag, { candidateId, tagId: t.id }).catch(() => {});
    }

    return { ok: true, tag: wanted, removed: stale.map((t) => t.title) };
  } catch (err) {
    return { ok: false, skipped: false, detail: err.message };
  }
}

/** Only for tests. */
export const resetTagCache = () => { cachedTagId = null; };
