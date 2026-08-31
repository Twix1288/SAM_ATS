/**
 * Where a failure goes when nobody is watching the response.
 *
 * Every other failure in this integration is recoverable by doing nothing: a write that did
 * not land leaves the record as it was, and the next sweep tries again. One is not. If we
 * publish a score, re-score the candidate on thinner evidence, and then fail to clear the
 * old number, Ashby keeps showing a stale Role Fit in a filterable column with nothing
 * marking it as old. A hiring manager filters on it and gets a candidate the current
 * evidence does not support.
 *
 * That failure has to reach a person. Until this change it did not: the pipeline caught the
 * error, recorded a failed stage, and returned `partial` in an HTTP response body — which is
 * fine for a webhook a human triggered and useless for a scheduled sweep whose response goes
 * nowhere.
 *
 * This is deliberately not an integration with a paging vendor. It is the seam one plugs
 * into, doing the two things that work everywhere with no account and no dependency:
 *
 *   1. a single structured line on **stderr**, prefixed so any log aggregator can match it
 *   2. an append to a **file**, so an alert outlives the process that raised it
 *
 * Production wires `onAlert` to whatever actually pages someone. The contract is that
 * raising an alert NEVER throws — an alerting path that can fail the delivery it is
 * reporting on is worse than no alerting at all.
 */
import { appendFileSync } from 'node:fs';

export const SEVERITY = {
  /** Wrong data is visible to a user right now. Someone has to look. */
  critical: 'critical',
  /** Something did not land, but nothing incorrect is on the record. */
  warning: 'warning',
};

export const ALERT = {
  /** A score we withdrew is still showing in Ashby because the clear was refused. */
  staleScoreVisible: 'stale_score_visible',
  /** A deliverable did not land. The record is incomplete, not wrong. */
  deliveryIncomplete: 'delivery_incomplete',
};

const STREAM_PREFIX = 'SAM-ALERT';
const FILE = process.env.SAM_ALERT_LOG ?? '.alerts.jsonl';

/** In-process history, so a server can surface recent alerts without reading the file. */
const history = [];
const MAX_HISTORY = 200;

/** Replaced in production with whatever pages a human. */
let sink = null;

/** @param {(alert: object) => void} fn */
export function onAlert(fn) { sink = fn; }

/**
 * Raises an alert. Never throws, whatever the sink or the filesystem does.
 *
 * @param {object} args
 * @param {string} args.code      one of ALERT
 * @param {string} args.severity  one of SEVERITY
 * @param {string} args.message   what a human needs to know, in one sentence
 * @param {object} [args.context] ids and values worth having when someone investigates
 */
export function raiseAlert({ code, severity, message, context = {} }) {
  const alert = { at: new Date().toISOString(), code, severity, message, context };

  history.push(alert);
  if (history.length > MAX_HISTORY) history.shift();

  // stderr first: it is the one channel that survives a missing disk, a read-only container
  // and a misconfigured sink, and it is where an aggregator is already looking.
  try {
    process.stderr.write(`${STREAM_PREFIX} ${JSON.stringify(alert)}\n`);
  } catch { /* a broken stderr must not take the delivery with it */ }

  try {
    appendFileSync(FILE, `${JSON.stringify(alert)}\n`);
  } catch { /* read-only or full disk — the stderr line is still out */ }

  try {
    sink?.(alert);
  } catch { /* a paging vendor being down is not a reason to fail a delivery */ }

  return alert;
}

/** Recent alerts, newest last. */
export const listAlerts = () => [...history];

/** Only for tests. */
export const resetAlerts = () => { history.length = 0; };
