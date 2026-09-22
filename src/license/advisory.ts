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
 *     step. Not everything the words need is a reason, though: whether a check
 *     is currently being held off cuts across the branches, so it travels beside
 *     the reason as a fact rather than being baked into one of them.
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
  let iso: string;
  try {
    iso = new Date(ms).toISOString();
  } catch {
    return null;
  }
  // In range but not a calendar year the reader knows: an expanded-year date
  // formats as `+275760-09-13T…`, and the first ten characters of that are
  // `+275760-09`, which is not a day at all. Only the ordinary four-digit form
  // slices to one, so anything else is dropped like an unparseable date.
  return /^\d{4}-/.test(iso) ? iso.slice(0, 10) : null;
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
  return advisoryText(rec, entitlement, now, {
    checksFailing,
    checksNotCompleting: stale && checksFailing,
  });
}

/**
 * What the words need to know beyond the reason, because the same reason is
 * reached from states that want different sentences.
 */
interface AdvisoryFacts {
  /**
   * A backoff marker is live RIGHT NOW: a check failed and the next one is
   * deliberately deferred. This is the only thing that makes the wait caveat
   * true, and it cuts across the branches rather than belonging to one of them.
   */
  checksFailing: boolean;
  /** Overdue for a check AND the last attempt did not get through. */
  checksNotCompleting: boolean;
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
 *
 * TRUE OF A STATE, NOT OF A BRANCH. It holds exactly while a backoff marker is
 * live, which is what defers the next attempt; without one the very next start
 * checks in, and telling that reader to wait hours and not restart delays the
 * recovery they were one restart away from. So it is gated on `checksFailing`
 * wherever it appears, never attached to a branch.
 */
const GIVE_IT_TIME =
  'Pro may take a few hours to come back rather than returning at the next start, so leave ' +
  'the client alone instead of restarting it again.';

/** `GIVE_IT_TIME`, space and all, only while it is true. */
function waitCaveat(facts: AdvisoryFacts): string {
  return facts.checksFailing ? ` ${GIVE_IT_TIME}` : '';
}

/**
 * The Pro tools are resolved once, at start. Every branch that hands the reader a
 * cure has to say this, because the cure on its own leaves Pro exactly as absent
 * as it was and the reader with no reason to think it worked.
 */
const RESTART_TO_LOAD = 'restart your MCP client, because the Pro tools only load when it starts';

/**
 * Pro is fine; an update to its module is not. Named separately because the
 * restart-loop cause above is flatly untrue here — the license checked in
 * moments ago — and naming a cause that is not the cause is the whole defect
 * these branches exist to remove.
 */
const MODULE_UPDATE_FAILED =
  'Pro is unlocked, but an update to its module did not finish. The version already ' +
  'installed keeps working and the update is tried again on its own, so there is nothing to ' +
  'do now. If the Pro tools do stop working, run `editmamei repair` in a terminal and then ' +
  'restart your MCP client.';

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
    ? 'This license has an end date that has passed, and restarting on its own will not extend it.'
    : `This license ended on ${day}, and restarting on its own will not extend it.`;
}

/**
 * A record denied while its offline window is still OPEN. The window runs from
 * the last check-in, so age cannot be what denied it; the backward-clock guard
 * is the only other way out of `evaluateEntitlement`, and its cure is neither a
 * restart nor a renewal. Worth detecting on its own because the grace wording
 * contradicts itself here — it tells the reader Pro is dark and that a week of
 * window is left, and the restart it advises can never work, since the recorded
 * mark the clock is behind does not move back.
 */
function clockIsBehind(rec: LicenseRecord, now: number): boolean {
  const last = Date.parse(rec.last_validated_at);
  return Number.isFinite(last) && last + GRACE_MS >= now;
}

/**
 * What that reader is actually looking at, and the only thing that fixes it.
 * Deactivate-then-activate, not activate alone: on a device that already holds a
 * record for the key, activate only refreshes it, and a refresh keeps the stored
 * high-water mark because that mark never moves backwards. Deactivate clears the
 * record so the next activate seeds a fresh one. Both need the network, since an
 * offline deactivate clears locally but leaves the device slot held on the server.
 */
const CLOCK_BEHIND =
  `${NOT_UNLOCKING} This machine's clock is set earlier than a date Editmamei has already ` +
  'recorded here, usually because it was once set ahead, so the license stored on it cannot be ' +
  'read as current. Fix: correct the system clock, ' +
  'then, while connected to the internet, run `editmamei deactivate` followed by ' +
  `\`editmamei activate YOUR-KEY\` in a terminal and ${RESTART_TO_LOAD}. Running activate on ` +
  `its own is not enough here, because it keeps the stored record. ${SUPPORT_TAIL}`;

/** The words themselves — one branch per reason the reader can be in. */
function advisoryText(
  rec: LicenseRecord,
  entitlement: Entitlement,
  now: number,
  facts: AdvisoryFacts
): string {
  if (entitlement.entitled) {
    // Entitled and still speaking, for one of two reasons. A module update that
    // failed is not a check that could not finish: the license checked in
    // seconds ago, so the restart-loop cause below would name something that
    // demonstrably did not happen.
    if (!facts.checksNotCompleting) return MODULE_UPDATE_FAILED;
    // Pro works, its background checks do not. The restart-loop cause is the
    // right one here, because a check that cannot finish is the whole of what is
    // wrong.
    return (
      'Pro is unlocked, but its background license and update checks are not completing.' +
      `${checkInWindow(rec, now, true)} ${RESTART_LOOP_CAUSE_AND_FIX}` +
      `${waitCaveat(facts)} ${SUPPORT_TAIL}`
    );
  }

  // No `default`: adding a reason to the union should be a compile error here,
  // not a silent fall into whichever cause happens to be written last.
  switch (entitlement.reason) {
    case 'revoked':
    case 'disabled':
      return (
        `${NOT_UNLOCKING} This license is no longer active, and restarting on its own will not ` +
        'bring it back. Fix: check your subscription status. Once it is running again, run ' +
        '`editmamei license` in a terminal to re-check the license and update this machine, ' +
        `then ${RESTART_TO_LOAD}. If it should be running already, send that output to ` +
        'support@editmamei.com.'
      );
    case 'expired':
      return (
        `${NOT_UNLOCKING} ${endedSentence(rec)} Fix: renew it, then run ` +
        `\`editmamei activate YOUR-KEY\` in a terminal and ${RESTART_TO_LOAD}. If the renewal ` +
        'has already gone through, run `editmamei license` instead to re-check the license and ' +
        'update this machine, then restart the client; if Pro is still missing, send that ' +
        'output to support@editmamei.com.'
      );
    // `grace-expired` is what these words were written for. `granted` cannot be
    // un-entitled and `no-license` never reaches here (a null record returned
    // above), but a check that did not land is what the words describe, so they
    // are the least wrong thing either could be handed.
    case 'grace-expired':
    case 'granted':
    case 'no-license':
      if (clockIsBehind(rec, now)) return CLOCK_BEHIND;
      return (
        `${NOT_UNLOCKING}${checkInWindow(rec, now, false)} ${RESTART_LOOP_CAUSE_AND_FIX}` +
        `${waitCaveat(facts)} ${SUPPORT_TAIL}`
      );
  }
}
