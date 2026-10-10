#!/usr/bin/env node
/**
 * Reads the answers people left in Ashby, on demand.
 *
 *   ASHBY_LIVE=1 npm run followup              # show what was said, write nothing
 *   ASHBY_LIVE=1 npm run followup -- --post    # record it on the candidate
 *
 * The same collection runs inside every `npm run sam` pass, so this is for looking — when
 * you want to see what came back without waiting for the next scheduled run, or to check
 * what a reply will be read as before anything is written.
 */
import { readFileSync } from 'node:fs';
import { collectReplies, replyCandidatesFrom, REPLY } from '../sam-integration/delivery/collectReplies.js';

const B = '\x1b[1m'; const G = '\x1b[32m'; const D = '\x1b[90m';
const Y = '\x1b[33m'; const C = '\x1b[36m'; const O = '\x1b[0m';

const POST = process.argv.includes('--post');
const LEDGER = process.env.SAM_LEDGER ?? '.sam/ledger.jsonl';

console.log(`\n${B}Sam · replies${O}  ${POST ? `${G}recording answers${O}` : `${D}reading only, nothing is written${O}`}\n`);

const summary = await collectReplies({
  rows: replyCandidatesFrom(readFileSync(LEDGER, 'utf8')),
  write: POST,
  onResult: (r) => {
    const label = r.name.padEnd(20);
    if (r.outcome === REPLY.notAsked) return console.log(`  ${D}${label}nothing asked yet${O}`);
    if (r.outcome === REPLY.waiting) return console.log(`  ${D}${label}waiting on a reply${O}`);
    if (r.outcome === REPLY.alreadyRecorded) return console.log(`  ${D}${label}already recorded${O}`);
    if (r.outcome === REPLY.unparseable) {
      return console.log(`  ${Y}${label}a reply, but nothing in it answers a question that was asked${O}`);
    }

    const who = [r.reply.by?.firstName, r.reply.by?.lastName].filter(Boolean).join(' ') || 'a reviewer';
    console.log(`  ${G}${label}${O}${who} answered ${r.resolved.length} of ${r.asked}`);
    for (const a of r.resolved) console.log(`      ${a.confirmed ? '✅' : '❌'} ${a.label}`);

    if (r.outcome === REPLY.recorded) {
      console.log(`      ${C}recorded on the record${O}`
        + `${r.field?.ok ? ` ${D}· Sam Confirmed = ${r.field.value.slice(0, 60)}${O}` : ''}`
        + `${r.stillOpen?.length ? ` ${D}· ${r.stillOpen.length} still open${O}` : ''}`);
    }
    return undefined;
  },
});

console.log(`\n  ${D}${POST ? `${summary.recorded} answer(s) recorded` : 'read-only — re-run with --post to record'}`
  + `${summary.waiting ? `, ${summary.waiting} waiting on a reply` : ''}${O}\n`);
