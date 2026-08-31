/**
 * The one test that cannot be satisfied by our own stand-in.
 *
 * Everything else in this suite runs against a simulator we wrote, which means it proves the
 * two halves agree with each other and proves nothing about Ashby. For most of the contract
 * that is fine — the endpoint names, the envelopes and the auth are all documented, so
 * agreeing with the documentation is the same as agreeing with Ashby.
 *
 * Clearing a custom field is not documented. Ashby's per-type table says what to send to SET
 * each field type — Boolean, Date, String, LongText, ValueSelect, MultiValueSelect, Number,
 * Currency, NumberRange, CompensationRange, Url, UUID — and says nothing anywhere about
 * removing a value. Not null, not an empty string, not an empty array. We send null because
 * it is what every other JSON API means by "unset", and that is a guess.
 *
 * It matters more than the other guesses because of how it fails. Every other write that
 * does not land leaves the record as it was. A clear that does not land leaves a score we
 * have withdrawn sitting in a filterable column, and a hiring manager filtering on it gets a
 * candidate the current evidence does not support.
 *
 * So this test hits api.ashbyhq.com directly. It needs a real key and it is SKIPPED without
 * one, loudly, because a skipped test that looks like a pass is how an unverified assumption
 * gets mistaken for a verified one.
 *
 *   ASHBY_API_KEY=<key> ASHBY_LIVE_APPLICATION_ID=<uuid> npm run test:live
 *
 * It writes to a real application, so it restores what it found before it started. Point it
 * at a sandbox or a test candidate, never at a live requisition.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ASHBY_BASE_URL, ENDPOINTS, CUSTOM_FIELD_OBJECT } from '../shared/ashby-contract.js';

const KEY = process.env.ASHBY_API_KEY;
const APPLICATION_ID = process.env.ASHBY_LIVE_APPLICATION_ID;
const FIELD_TITLE = process.env.ASHBY_LIVE_FIELD_TITLE ?? 'Sam Role Fit';
const COVERAGE_TITLE = process.env.ASHBY_LIVE_COVERAGE_TITLE ?? 'Sam Evidence Coverage';

const live = Boolean(KEY && APPLICATION_ID);
const skip = live ? false
  : 'NOT VERIFIED against real Ashby — set ASHBY_API_KEY and ASHBY_LIVE_APPLICATION_ID. '
    + 'Until this runs, `null` clears a custom field is an assumption, not a fact.';

/** Ashby: Basic auth, API key as username, blank password. */
const call = async (endpoint, body) => {
  const res = await fetch(`${ASHBY_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep the raw body for the assertion */ }
  return { status: res.status, json, text };
};

const fieldIdFor = async (title) => {
  const { json } = await call(ENDPOINTS.listCustomFields, {});
  const field = (json?.results ?? []).find((f) => f.title === title);
  assert.ok(field, `No custom field titled "${title}" exists in this org — create it first.`);
  return field.id;
};

const readValue = async (title) => {
  const { json } = await call(ENDPOINTS.applicationInfo, { id: APPLICATION_ID });
  return (json?.results?.customFields ?? []).find((f) => f.title === title);
};

const setValues = (values) => call(ENDPOINTS.setCustomFields, {
  objectId: APPLICATION_ID,
  objectType: CUSTOM_FIELD_OBJECT.application,
  values,
});

describe('Clearing a custom field, against Ashby itself', { skip }, () => {
  let roleFitId;
  let coverageId;
  let original;

  before(async () => {
    roleFitId = await fieldIdFor(FIELD_TITLE);
    coverageId = await fieldIdFor(COVERAGE_TITLE);
    original = await readValue(FIELD_TITLE);
  });

  after(async () => {
    // Put back whatever was there. This runs against a real record.
    if (original?.value !== undefined && original?.value !== null) {
      await setValues([{ fieldId: roleFitId, fieldValue: original.value }]);
    }
  });

  test('a value can be set, so the rest of the test means something', async () => {
    const { status, json } = await setValues([{ fieldId: roleFitId, fieldValue: 72 }]);
    assert.equal(status, 200, `setValues failed: ${JSON.stringify(json)}`);
    assert.equal(json.success, true);
    assert.equal((await readValue(FIELD_TITLE))?.value, 72);
  });

  test('WHAT ACTUALLY CLEARS A FIELD — null, empty string, or neither', async () => {
    await setValues([{ fieldId: roleFitId, fieldValue: 72 }]);

    // Recorded rather than asserted: the point is to learn the answer, and a failing
    // assertion would hide the response shape we came here to read.
    const attempts = [];
    for (const [label, value] of [['null', null], ['empty string', ''], ['zero', 0]]) {
      await setValues([{ fieldId: roleFitId, fieldValue: 72 }]);
      const { status, json, text } = await setValues([{ fieldId: roleFitId, fieldValue: value }]);
      const after = await readValue(FIELD_TITLE);
      attempts.push({
        sent: label,
        httpStatus: status,
        success: json?.success ?? null,
        errors: json?.errors ?? null,
        rawIfUnparseable: json ? null : text.slice(0, 200),
        fieldAfter: after === undefined ? 'ABSENT (cleared)' : JSON.stringify(after.value),
      });
    }

    console.log('\n  What Ashby actually does with each candidate clear value:');
    for (const a of attempts) {
      console.log(`    sent ${a.sent.padEnd(13)} → HTTP ${a.httpStatus} success=${a.success} `
        + `· field after: ${a.fieldAfter}`);
      if (a.errors) console.log(`      errors: ${JSON.stringify(a.errors)}`);
      if (a.rawIfUnparseable) console.log(`      raw: ${a.rawIfUnparseable}`);
    }

    const cleared = attempts.filter((a) => a.fieldAfter === 'ABSENT (cleared)');
    assert.ok(cleared.length > 0,
      'Nothing we tried cleared the field. The clear mechanism has to come from Ashby '
      + `support before this ships. Results: ${JSON.stringify(attempts, null, 2)}`);

    // The assumption the code is built on. If this fails, CLEAR in
    // sam-integration/endpoints/customField.setValue.js is the one line to change.
    assert.ok(cleared.some((a) => a.sent === 'null'),
      `null did NOT clear the field. What did: ${cleared.map((a) => a.sent).join(', ')}. `
      + 'Change CLEAR to that value.');
  });

  test('a rejected clear does not take the other fields down with it', async () => {
    // Only meaningful if Ashby refuses null. If it accepts null there is nothing to fall
    // back from, and the previous test has already recorded that.
    const probe = await setValues([{ fieldId: roleFitId, fieldValue: null }]);
    if (probe.json?.success === true) {
      console.log('  Ashby accepts null — the fallback path is unreachable here, by design.');
      return;
    }

    console.log(`  Ashby refuses null: HTTP ${probe.status} ${JSON.stringify(probe.json?.errors)}`);

    // The real response shape, asserted rather than assumed.
    assert.equal(probe.json?.success, false, 'a refusal must still use the documented envelope');
    assert.ok(Array.isArray(probe.json?.errors), 'errors must be an array of {message}');
    assert.ok(typeof probe.json.errors[0]?.message === 'string');

    // The fallback: the non-null values must still land on their own.
    const { status, json } = await setValues([{ fieldId: coverageId, fieldValue: 40 }]);
    assert.equal(status, 200, `the fallback write failed too: ${JSON.stringify(json)}`);
    assert.equal((await readValue(COVERAGE_TITLE))?.value, 40,
      'coverage is the number that explains a withheld score — it must survive a refused clear');
  });
});
