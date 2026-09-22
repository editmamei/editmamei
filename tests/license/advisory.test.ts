/**
 * The license advisory.
 *
 * Three things are being pinned here, and the last two matter as much as the first.
 *
 * WHEN it speaks. Silence is the default and the common case: someone who never
 * bought Pro, and someone whose Pro is working, must get nothing at all, because
 * this text is read by a model on every ping and an advisory that is usually
 * present is both a standing charge on people with no problem and one the model
 * learns to skip past.
 *
 * WHAT it says. The words are a public, user-facing surface. They have to carry a
 * reason and a fix the reader can act on, and they must not leak the machinery
 * behind the license — no vendor names, no request limits, no HTTP statuses. The
 * wording test below is deliberately a hard assertion, not a lint: a future edit
 * that slips an internal into this string should fail, not warn.
 *
 * WHICH cause it names. One tail for every reason was the bug these tests exist to
 * stop coming back. A record the server has taken out of service, and one whose
 * end date has passed, are never re-checked at all — so a check that could not
 * finish cannot be why they are dark, restarting cannot cure them, and an offline
 * window counted from the last check-in promises time that is not there. Each
 * reason is asserted twice over: once for the words it must carry, and once for
 * the words it must not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { licenseAdvisory } from '@editmamei/license/advisory.ts';
import { writeLicense, updateCheckState, type LicenseRecord } from '@editmamei/license/store.ts';
import { GRACE_MS, REFRESH_AFTER_MS } from '@editmamei/license/entitlement.ts';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The two claims that are only true of a check that did not complete. Every
 * assertion against a status-based reason checks for their ABSENCE — they are the
 * exact words that sent a reader whose license was already settled into a restart
 * loop that could never end.
 */
const RESTART_LOOP_WORDS = ['restarting faster', 'quit the client fully'];
const GRACE_WINDOW_WORDS = ['grace window', 'last checked in'];
/**
 * The wait caveat. True only while a backoff marker is live, which a settled
 * verdict never has — telling someone whose subscription ended to sit tight for
 * a few hours costs them the restart that would actually have shown them the
 * renewal. Asserted absent alongside the two above for exactly that reason.
 */
const WAIT_CAVEAT_WORDS = ['a few hours', 'instead of restarting it again'];

function rec(over: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    key: 'ETTA-KEY',
    organization_id: 'org_test',
    status: 'granted',
    expires_at: null,
    activation_id: 'act_1',
    device_hash: 'dh',
    display_key: '****-AAAA',
    last_validated_at: new Date(NOW).toISOString(),
    ...over,
  };
}

function agedRec(ageMs: number, over: Partial<LicenseRecord> = {}): LicenseRecord {
  return rec({ last_validated_at: new Date(NOW - ageMs).toISOString(), ...over });
}

describe('licenseAdvisory — when it stays silent', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-advisory-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const now = () => NOW;

  it('says nothing for someone who never bought Pro', () => {
    expect(licenseAdvisory({ dir, now })).toBeNull();
  });

  it('says nothing for a healthy Pro user', () => {
    writeLicense(rec(), { dir });
    expect(licenseAdvisory({ dir, now })).toBeNull();
  });

  it('says nothing for a Pro user whose license is merely overdue for a check', () => {
    // Stale but nothing has actually failed — the next check is due, not broken.
    writeLicense(agedRec(REFRESH_AFTER_MS + DAY_MS), { dir });
    expect(licenseAdvisory({ dir, now })).toBeNull();
  });

  it('says nothing once a stale record is checking in again', () => {
    // A marker that has already lapsed is history, not a symptom: an attempt is
    // imminent, so there is nothing to advise about.
    writeLicense(agedRec(REFRESH_AFTER_MS + DAY_MS), { dir });
    updateCheckState({ validate_retry_after: NOW - 1 }, { dir });
    expect(licenseAdvisory({ dir, now })).toBeNull();
  });
});

describe('licenseAdvisory — when it speaks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-advisory-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const now = () => NOW;

  it('speaks when Pro is not unlocking at all', () => {
    writeLicense(agedRec(GRACE_MS + DAY_MS), { dir });
    const text = licenseAdvisory({ dir, now });
    expect(text).toContain('Pro is not unlocking');
  });

  it('speaks when the license is overdue AND the last check did not get through', () => {
    writeLicense(agedRec(REFRESH_AFTER_MS + DAY_MS), { dir });
    updateCheckState({ validate_retry_after: NOW + 60_000 }, { dir });
    const text = licenseAdvisory({ dir, now });
    expect(text).toContain('not completing');
  });

  it('speaks when a Pro module update failed, even on an otherwise healthy license', () => {
    writeLicense(rec(), { dir });
    expect(licenseAdvisory({ dir, now })).toBeNull();
    expect(licenseAdvisory({ dir, now, moduleUpdateFailed: true })).not.toBeNull();
  });

  it('carries both the dates and the fix, and reads as past tense once grace has closed', () => {
    writeLicense(agedRec(GRACE_MS + DAY_MS), { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';

    // Reason: when it last checked in, and when the offline window ran out.
    expect(text).toContain('2026-09-14'); // 8 days before NOW
    expect(text).toContain('closed on 2026-09-21'); // that date + the 7-day window
    // Fix: something to do, then somewhere to go if it does not work.
    expect(text).toContain('quit the client fully');
    expect(text).toContain('editmamei license');
    expect(text).toContain('support@editmamei.com');
  });

  it('does not promise the clean start will show its result at the next one, while a check is being held off', () => {
    // A check that has just failed is not retried immediately, and the past-grace
    // recovery attempt is skipped for as long as that holds. Someone who takes
    // "wait a minute, then start it once" literally can restart into exactly the
    // same silence, so the advisory has to say that up front.
    writeLicense(agedRec(GRACE_MS + DAY_MS), { dir });
    updateCheckState({ validate_retry_after: NOW + 60_000 }, { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';
    for (const phrase of WAIT_CAVEAT_WORDS) expect(text).toContain(phrase);
  });

  it('keeps quiet about the wait when nothing is holding the next check off', () => {
    // The lapsed-grace reason is reached constantly with no marker at all: a
    // machine that was simply offline, or one whose marker has since run out.
    // The next start checks in straight away there, so "leave it alone for a few
    // hours" is not a caveat, it is a delay imposed on the one action that would
    // have brought Pro back.
    writeLicense(agedRec(GRACE_MS + DAY_MS), { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';
    expect(text).toContain('quit the client fully');
    for (const phrase of WAIT_CAVEAT_WORDS) expect(text).not.toContain(phrase);
  });

  it('reads as future tense while the license is still inside its grace window', () => {
    writeLicense(agedRec(REFRESH_AFTER_MS + DAY_MS), { dir });
    updateCheckState({ validate_retry_after: NOW + 60_000 }, { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';
    expect(text).toContain('Pro locks on');
    expect(text).not.toContain('closed on');
  });

  it('warns the entitled reader that the wait is long, since this branch only speaks when one is live', () => {
    // This branch is reached only when `checksFailing` is true, which means a
    // backoff marker exists RIGHT NOW — so "quit and restart" without the wait
    // caveat is least accurate here, not most. Pinned so the caveat cannot be
    // dropped from this branch while surviving on the grace-expired one.
    writeLicense(agedRec(REFRESH_AFTER_MS + DAY_MS), { dir });
    updateCheckState({ validate_retry_after: NOW + 60_000 }, { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';
    expect(text).toContain('a few hours');
    expect(text).toContain('instead of restarting it again');
  });

  it('names the update, not a restart loop, when the checks are fine and the module update is not', () => {
    // The record checked in seconds ago, so "this client is restarting faster
    // than the license check can finish" is not merely unhelpful here, it
    // describes something that demonstrably did not happen. Nothing is dark
    // either: the installed module carries on.
    writeLicense(rec(), { dir });
    const text = licenseAdvisory({ dir, now, moduleUpdateFailed: true }) ?? '';
    expect(text).toContain('Pro is unlocked');
    expect(text).toContain('did not finish');
    expect(text).toContain('keeps working');
    expect(text).toContain('tried again on its own');
    for (const phrase of [...RESTART_LOOP_WORDS, ...WAIT_CAVEAT_WORDS]) {
      expect(text).not.toContain(phrase);
    }
  });

  it('gives the entitled reader the dates, the fix and somewhere to go', () => {
    // Nothing else pins what this branch says. It is the one the wait caveat is
    // most load-bearing on, since it is reached only while a marker is live.
    writeLicense(agedRec(REFRESH_AFTER_MS + DAY_MS), { dir });
    updateCheckState({ validate_retry_after: NOW + 60_000 }, { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';

    expect(text).toContain('Pro is unlocked');
    expect(text).toContain('not completing');
    expect(text).toContain('last checked in on 2026-09-20'); // 2 days before NOW
    expect(text).toContain('Pro locks on 2026-09-27'); // that date + the 7-day window
    expect(text).toContain('quit the client fully');
    expect(text).toContain('editmamei license');
    expect(text).toContain('support@editmamei.com');
  });

  it('never throws on a date the calendar cannot represent', () => {
    // The record's timestamp is only checked for being a string when it is read,
    // so an extreme value reaches the formatter — where `toISOString` THROWS
    // rather than returning "Invalid Date". This runs on the ping path, so a
    // throw would take out a response that otherwise succeeded.
    // A failed module update is what makes it speak at all; the timestamp sits at
    // the far end of representable time, where the window would end past it.
    writeLicense(rec({ last_validated_at: '+275760-09-13T00:00:00.000Z' }), { dir });
    let text: string | null = null;
    expect(() => {
      text = licenseAdvisory({ dir, now, moduleUpdateFailed: true });
    }).not.toThrow();
    expect(text).not.toBeNull();
    expect(text ?? '').not.toContain('Invalid Date');
  });

  it('drops a day the calendar cannot spell rather than printing half of one', () => {
    // An expanded-year timestamp is inside what `Date` can represent, so nothing
    // throws — but its ISO form reads `-271821-04-20T…`, and the first ten
    // characters of that are a year and a month, not a day.
    writeLicense(rec({ last_validated_at: '-271821-04-20T00:00:00.000Z' }), { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';
    expect(text).toContain('Pro is not unlocking');
    expect(text).not.toContain('-271821');
    expect(text).not.toContain('last checked in');
    expect(text).toContain('quit the client fully');
  });

  it('omits the dates rather than printing a bad one when the timestamp is unreadable', () => {
    writeLicense(rec({ last_validated_at: 'not-a-date' }), { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';
    expect(text).toContain('Pro is not unlocking');
    expect(text).not.toContain('Invalid Date');
    expect(text).not.toContain('NaN');
    expect(text).toContain('quit the client fully');
  });
});

/**
 * The reason-specific half. `revoked`, `disabled` and `expired` are settled
 * verdicts: nothing on the boot path re-checks them, so the restart-loop cause is
 * not merely unhelpful there, it is impossible, and the offline window counted
 * from the last check-in states time the reader does not have. Each of these must
 * name what is actually wrong and where to go with it.
 */
describe('licenseAdvisory — the cause it names is the cause it is', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-advisory-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const now = () => NOW;

  it('sends a revoked license to its subscription status, not round the restart loop', () => {
    writeLicense(rec({ status: 'revoked' }), { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';

    expect(text).toContain('Pro is not unlocking');
    expect(text).toContain('no longer active');
    expect(text).toContain('restarting on its own will not bring it back');
    expect(text).toContain('subscription status');
    expect(text).toContain('support@editmamei.com');
    for (const phrase of [...RESTART_LOOP_WORDS, ...GRACE_WINDOW_WORDS, ...WAIT_CAVEAT_WORDS]) {
      expect(text).not.toContain(phrase);
    }
  });

  it('says the same for a disabled license', () => {
    writeLicense(rec({ status: 'disabled' }), { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';

    expect(text).toContain('no longer active');
    expect(text).toContain('subscription status');
    for (const phrase of [...RESTART_LOOP_WORDS, ...GRACE_WINDOW_WORDS, ...WAIT_CAVEAT_WORDS]) {
      expect(text).not.toContain(phrase);
    }
  });

  it('gives an ended license its own end date and the way to renew it', () => {
    // Its own date, not the offline window: the window is counted from the last
    // check-in, which for an ended license can sit days in the future and read as
    // though there were time left.
    writeLicense(rec({ expires_at: new Date(NOW - DAY_MS).toISOString() }), { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';

    expect(text).toContain('Pro is not unlocking');
    expect(text).toContain('ended on 2026-09-21');
    expect(text).toContain('editmamei activate');
    expect(text).toContain('support@editmamei.com');
    for (const phrase of [...RESTART_LOOP_WORDS, ...GRACE_WINDOW_WORDS, ...WAIT_CAVEAT_WORDS]) {
      expect(text).not.toContain(phrase);
    }
  });

  it('still names the end date on an ended license that stopped checking in long ago', () => {
    // The real shape of an ended license: nothing re-validates it, so its last
    // check-in recedes and it is comfortably past the offline window too. Only
    // the order the reasons are tested in keeps it out of the lapsed-grace
    // branch, and that order is what this pins — both dates are in the past, so
    // a mix-up would read as plausible while naming the wrong cure.
    writeLicense(
      agedRec(GRACE_MS + 30 * DAY_MS, { expires_at: new Date(NOW - 30 * DAY_MS).toISOString() }),
      { dir }
    );
    const text = licenseAdvisory({ dir, now }) ?? '';

    expect(text).toContain('ended on 2026-08-23');
    expect(text).toContain('editmamei activate');
    for (const phrase of [...RESTART_LOOP_WORDS, ...GRACE_WINDOW_WORDS, ...WAIT_CAVEAT_WORDS]) {
      expect(text).not.toContain(phrase);
    }
  });

  it('tells both cure branches that the tools only come back on a restart', () => {
    // Renewing, or reinstating a subscription, leaves Pro exactly as absent as
    // it was until the client starts again: a module is never loaded
    // mid-session. Without this the reader who did everything asked sees no
    // change and has already been told restarting is pointless.
    writeLicense(rec({ status: 'revoked' }), { dir });
    const revoked = licenseAdvisory({ dir, now }) ?? '';
    writeLicense(rec({ expires_at: new Date(NOW - DAY_MS).toISOString() }), { dir });
    const ended = licenseAdvisory({ dir, now }) ?? '';

    for (const text of [revoked, ended]) {
      expect(text).toContain('only load when it starts');
      // `editmamei license` re-checks the license and rewrites this machine's
      // copy, so it is the self-heal for a subscription that is running again,
      // not just something to paste into a support mail.
      expect(text).toContain('editmamei license');
      expect(text).toContain('re-check the license and update this machine');
    }
  });

  it('keeps the restart loop for the one reason it explains — a check that did not land', () => {
    writeLicense(agedRec(GRACE_MS + DAY_MS), { dir });
    const text = licenseAdvisory({ dir, now }) ?? '';
    for (const phrase of [...RESTART_LOOP_WORDS, ...GRACE_WINDOW_WORDS]) {
      expect(text).toContain(phrase);
    }
  });

  it('names the clock, not the window, when the clock is what denied the license', () => {
    // The backward-clock guard denies a record whose offline window is still
    // open, so the grace wording contradicts itself here: Pro is dark, and a
    // week of window is left. The restart it advises cannot work either — the
    // recorded mark the clock is behind never moves back, so every later check
    // lands on the same verdict.
    writeLicense(agedRec(DAY_MS, { high_water_mark: new Date(NOW + 30 * DAY_MS).toISOString() }), {
      dir,
    });
    const text = licenseAdvisory({ dir, now }) ?? '';

    expect(text).toContain('Pro is not unlocking');
    expect(text).toContain('clock is set earlier');
    expect(text).toContain('correct the system clock');
    expect(text).toContain('editmamei activate');
    // The self-contradiction itself: no window that "closes" on a date the
    // reader can still see coming.
    expect(text).not.toContain('closes on');
    for (const phrase of [...GRACE_WINDOW_WORDS, ...RESTART_LOOP_WORDS, ...WAIT_CAVEAT_WORDS]) {
      expect(text).not.toContain(phrase);
    }
  });

  it('never names the machinery behind the license', () => {
    // These words belong in the code and the logs, never in what a photographer
    // is handed. Checked over EVERY branch, since they word the opening line
    // differently and a leak could live in any of them.
    const forbidden = [
      'polar',
      'throttl',
      'rate limit',
      'retry-after',
      '429',
      '503',
      'http',
      'endpoint',
      'delivery',
      'worker',
      'api',
      'token',
    ];

    writeLicense(agedRec(GRACE_MS + DAY_MS), { dir });
    const lapsed = (licenseAdvisory({ dir, now }) ?? '').toLowerCase();
    writeLicense(rec({ status: 'revoked' }), { dir });
    const revoked = (licenseAdvisory({ dir, now }) ?? '').toLowerCase();
    writeLicense(rec({ expires_at: new Date(NOW - DAY_MS).toISOString() }), { dir });
    const ended = (licenseAdvisory({ dir, now }) ?? '').toLowerCase();
    writeLicense(agedRec(REFRESH_AFTER_MS + DAY_MS), { dir });
    updateCheckState({ validate_retry_after: NOW + 60_000 }, { dir });
    const failing = (licenseAdvisory({ dir, now }) ?? '').toLowerCase();
    writeLicense(rec(), { dir });
    updateCheckState({ validate_retry_after: null }, { dir });
    const moduleFailed = (
      licenseAdvisory({ dir, now, moduleUpdateFailed: true }) ?? ''
    ).toLowerCase();
    writeLicense(agedRec(DAY_MS, { high_water_mark: new Date(NOW + 30 * DAY_MS).toISOString() }), {
      dir,
    });
    const clockBehind = (licenseAdvisory({ dir, now }) ?? '').toLowerCase();

    const all = [lapsed, revoked, ended, failing, moduleFailed, clockBehind];
    for (const text of all) expect(text).not.toBe('');
    for (const word of forbidden) {
      for (const text of all) expect(text).not.toContain(word);
    }
  });
});
