/**
 * The license advisory: one short passage saying why Pro is not working and what
 * to do about it, or nothing at all.
 *
 * Two call sites share this — the `ps_ping` response and the explain-only stubs
 * that stand in for the Pro tools while a license is not unlocking. Both want the
 * same words, so the words live once, here. It is deliberately not a framework:
 * one function and a short switch on the reason, no registry of advisory kinds.
 *
 * Four rules shape the wording, and all four are load-bearing:
 *
 *   - **It says nothing unless there is something to say.** Someone who never
 *     bought Pro, and someone whose Pro is working, both get `null`. The result
 *     text is read by a model on every ping, so an advisory that is usually
 *     present is a standing token charge on people with no problem — and one the
 *     model learns to skip.
 *   - **It is about the reader's license, never about our machinery.** No vendor
 *     names, no request limits, no HTTP statuses, no delivery internals. Someone
 *     whose Pro is dark needs to know what to do, and none of that helps; it is
 *     also a public surface, and internals published there stay published.
 *   - **It carries a reason AND a fix**, in plain sentences a model can relay to a
 *     photographer as-is. An advisory the reader cannot act on is noise with extra
 *     steps.
 *   - **The cause it names is the cause it actually is.** The text branches on
 *     `EntitlementReason`, because the causes do not generalise: `refreshIfStale`
 *     returns before attempting a check at all when the status is revoked or
 *     disabled, or the end date has passed, so a check that could not finish is
 *     never why those are dark, and no amount of restarting moves them. A fix that
 *     cannot work sends the reader round a loop with no end in it. The branches
 *     mirror the per-reason table in `docs/troubleshooting.md`; keep the two in
 *     step.
 */

import {
  readLicense,
  readCheckState,
  type LicenseRecord,
  type LicenseStoreOptions,
} from './store.js';
import {
  evaluateEntitlement,
  GRACE_MS,
  REFRESH_AFTER_MS,
  type Entitlement,
} from './entitlement.js';

export interface LicenseAdvisoryOptions extends LicenseStoreOptions {
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Set when a background Pro-module update failed this session. */
  moduleUpdateFailed?: boolean;
}

/**
 * Where to send someone whose license came back while the session was already
 * running. The tools cannot appear mid-session (a loaded module is never
 * hot-swapped), so the honest answer is "restart", not the advisory below.
 */
export const PRO_RESTART_TO_LOAD =
  'Your Pro license is active again, but this session started without it. ' +
  'Restart your MCP client to load the Pro tools.';

/**
 * Calendar day in ISO form — locale-free, and unambiguous when a model relays it.
 * `null` for anything `Date` cannot represent: `last_validated_at` is only checked
 * for being a string when the record is read, so a junk or extreme value reaches
 * here, and `toISOString` THROWS on an out-of-range date rather than returning
 * "Invalid Date". This is called on the ping path, where a throw would take out a
 * response that otherwise succeeded, so the date is dropped instead.
 */
function isoDay(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * The advisory for this machine right now, or `null` when there is nothing worth
 * saying. Reads the cached record and the check-state sidecar; makes no network
 * call and never throws.
 *
 * Speaks up in exactly three cases, all of which mean a license holder is being
 * short-changed: Pro is not unlocking at all; the license is overdue for a check
 * and the last attempt did not get through; or a Pro module update failed. Every
 * other state is silence.
 */
export function licenseAdvisory(opts: LicenseAdvisoryOptions = {}): string | null {
  const now = (opts.now ?? Date.now)();
  const rec = readLicense(opts);
  // No record = no Pro was ever bought here. Nothing to advise, nothing to add.
  if (!rec) return null;

  const entitlement = evaluateEntitlement(rec, now);
  const last = Date.parse(rec.last_validated_at);
  const stale = !Number.isFinite(last) || now - last > REFRESH_AFTER_MS;
  // A live backoff marker is the record of a check that did not get through. Once
  // it lapses the next attempt is imminent, so it stops counting as a symptom.
  const retryAfter = readCheckState(opts).validate_retry_after;
  const checksFailing = retryAfter !== undefined && retryAfter > now;

  if (entitlement.entitled && !(stale && checksFailing) && opts.moduleUpdateFailed !== true) {
    return null;
  }
  return advisoryText(rec, entitlement, now);
}

/** The opening line whenever the Pro tools are not there at all. */
const NOT_UNLOCKING = 'Pro is not unlocking.';

/**
 * The cause and the fix for the one shape they actually describe: a client that
 * starts, does not stay up long enough for a check to finish, and starts again.
 * Shared by the two branches that are about a check not completing, and by no
 * others.
 */
const RESTART_LOOP_CAUSE_AND_FIX =
  'Most likely cause: this client is restarting faster than the license check can finish. ' +
  'Fix: quit the client fully, wait a minute, then start it once and leave it running.';

/**
 * A check that has just failed is not tried again immediately, so the clean start
 * above does not always show its result at the next one. Saying so is the
 * difference between a reader who leaves it alone and one who restarts on a loop
 * waiting for a change that was never going to arrive that fast. Deliberately
 * vague about how long and why — the interval is ours, not theirs.
 */
const GIVE_IT_TIME =
  'Pro may take a few hours to come back rather than returning at the next start, so leave ' +
  'the client alone instead of restarting it again.';

/** Where to go when the fix above did not take. */
const SUPPORT_TAIL =
  'If that does not bring Pro back, run `editmamei license` in a terminal and send the output ' +
  'to support@editmamei.com.';

/**
 * "Last checked in on X, and the window runs to Y" — or nothing at all.
 *
 * Both dates or neither. Half of this sentence is worse than none of it: the
 * reason only reads as a reason when the reader can see the window it names.
 * Only the two check-related branches call it: a record the server has taken out
 * of service, or one whose end date has passed, has no offline window left to
 * name, and printing one there would promise time that is not there.
 */
function checkInWindow(rec: LicenseRecord, now: number, entitled: boolean): string {
  const last = Date.parse(rec.last_validated_at);
  const graceEndsAt = last + GRACE_MS;
  const lastDay = isoDay(last);
  const graceDay = isoDay(graceEndsAt);
  if (lastDay === null || graceDay === null) return '';
  return entitled
    ? ` Your license last checked in on ${lastDay}, and Pro locks on ` +
        `${graceDay} if it cannot check in before then.`
    : ` Your license last checked in on ${lastDay} and the offline grace window ` +
        `${graceEndsAt <= now ? 'closed' : 'closes'} on ${graceDay}.`;
}

/**
 * The end date of a license that has one and has passed it. `expires_at` is
 * non-null and parseable for that reason to be reached at all; the dateless form
 * is the same out-of-range guard every other date here carries.
 */
function endedSentence(rec: LicenseRecord): string {
  const day = rec.expires_at === null ? null : isoDay(Date.parse(rec.expires_at));
  return day === null
    ? 'This license has an end date that has passed, and restarting will not extend it.'
    : `This license ended on ${day}, and restarting will not extend it.`;
}

/** The words themselves — one branch per reason the reader can be in. */
function advisoryText(rec: LicenseRecord, entitlement: Entitlement, now: number): string {
  // Entitled and still speaking: Pro works, its background checks do not. The
  // restart-loop cause is the right one here, because a check that cannot finish
  // is the whole of what is wrong.
  if (entitlement.entitled) {
    return (
      'Pro is unlocked, but its background license and update checks are not completing.' +
      `${checkInWindow(rec, now, true)} ${RESTART_LOOP_CAUSE_AND_FIX} ` +
      `${GIVE_IT_TIME} ${SUPPORT_TAIL}`
    );
  }

  // No `default`: adding a reason to the union should be a compile error here,
  // not a silent fall into whichever cause happens to be written last.
  switch (entitlement.reason) {
    case 'revoked':
    case 'disabled':
      return (
        `${NOT_UNLOCKING} This license is no longer active, so restarting will not bring it ` +
        'back. Fix: check your subscription status. If it should still be running, run ' +
        '`editmamei license` in a terminal and send the output to support@editmamei.com.'
      );
    case 'expired':
      return (
        `${NOT_UNLOCKING} ${endedSentence(rec)} Fix: renew it, then run ` +
        '`editmamei activate YOUR-KEY` in a terminal. If the renewal has already gone ' +
        'through, run `editmamei license` and send that output to support@editmamei.com.'
      );
    // `grace-expired` is what these words were written for. `granted` cannot be
    // un-entitled and `no-license` never reaches here (a null record returned
    // above), but a check that did not land is what the words describe, so they
    // are the least wrong thing either could be handed.
    case 'grace-expired':
    case 'granted':
    case 'no-license':
      return (
        `${NOT_UNLOCKING}${checkInWindow(rec, now, false)} ${RESTART_LOOP_CAUSE_AND_FIX} ` +
        `${GIVE_IT_TIME} ${SUPPORT_TAIL}`
      );
  }
}
