/**
 * Asking about a change to what telemetry covers, through MCP elicitation: a request that goes
 * from this server to the client's own interface and back, without passing through the model.
 *
 * The rules, for every client alike:
 *   - A question goes to anyone whose answer is older than its current version. A new install
 *     already holds a current answer, so it is never asked.
 *   - Not answering never turns anything on.
 *   - It never blocks. The caller doesn't wait on it, and a client that never replies only costs
 *     one pending request until the timeout.
 *   - Tool results never ask, and an answer relayed by the model doesn't count.
 *
 * A client can still answer without showing a person, and this server can't tell. That is why
 * what the setting unlocks stays narrow.
 */

import { SdkErrorCode, type ElicitResult } from '@modelcontextprotocol/server';
import { Logger } from '../utils/logger.js';
import { FEATURES_QUESTION } from './consent-questions.js';
import {
  loadSettings,
  saveSettings,
  setFeatureDetails,
  type LoadSettingsOptions,
  type Settings,
} from './settings.js';

const logger = new Logger('Consent');

/** Long enough for a person to come back to the window, short enough not to linger. */
const PROMPT_TIMEOUT_MS = 5 * 60_000;
/** A prompt closed or left unanswered is shown this many times in all. */
export const MAX_DISMISSALS = 3;

export type PromptOutcome = 'accepted' | 'declined' | 'dismissed' | 'timed_out' | 'failed';

export interface ConsentDeps {
  /** This process's settings. Updated in place, so an answer applies straight away. */
  settings: Settings;
  /** The settings file couldn't be read: nothing is known, so nothing is asked or saved. */
  degraded: boolean;
  /** Whether telemetry can send at all. An inert build has no reason to ask. */
  telemetryActive: boolean;
  /** Whether the client declared that it can show a form. */
  supportsForm: boolean;
  elicit: (
    params: {
      message: string;
      requestedSchema: {
        type: 'object';
        properties: { share: { type: 'boolean'; title: string; default: boolean } };
        required: string[];
      };
    },
    options: { timeout: number }
  ) => Promise<ElicitResult>;
  report: (info: {
    question: string;
    questionVersion: number;
    result: PromptOutcome | 'unsupported' | 'install_default';
    via: 'elicitation' | 'install' | 'cli' | 'desktop';
  }) => boolean | Promise<boolean>;
  storage?: LoadSettingsOptions;
  now?: () => Date;
}

/** Client capabilities mean a form unless only `url` is declared. An empty object means a form. */
export function clientSupportsForm(elicitation: unknown): boolean {
  if (typeof elicitation !== 'object' || elicitation === null) return false;
  const caps = elicitation as { form?: unknown; url?: unknown };
  return caps.form != null || caps.url == null;
}

/** Whether this question is due. A hand-set value with no record counts as a choice. */
export function shouldAsk(settings: Settings): boolean {
  if (!settings.telemetry.usage) return false;
  // An off Claude Desktop toggle wins over any answer, so there is nothing to ask.
  if (settings.desktop_toggles?.features === false) return false;
  const record = settings.consent?.features;
  if (record) {
    if (record.version >= FEATURES_QUESTION.version) return false;
  } else if (settings.telemetry.features !== undefined) {
    return false;
  }
  const dismissals = settings.consent_dismissals?.features;
  return !(
    dismissals &&
    dismissals.version === FEATURES_QUESTION.version &&
    dismissals.count >= MAX_DISMISSALS
  );
}

/**
 * Run once per session, after the handshake. Reports any choice not yet sent, then asks if the
 * question is due. Resolves when that's settled. Never rejects, and no caller should wait on it.
 */
export async function runConsentPrompt(deps: ConsentDeps): Promise<void> {
  try {
    if (deps.degraded || !deps.telemetryActive) return;
    await reportUnsentAnswer(deps);
    if (!shouldAsk(deps.settings)) return;
    if (!deps.supportsForm) {
      await reportOutcome(deps, 'unsupported');
      return;
    }
    const outcome = await ask(deps);
    if (outcome === 'accepted' || outcome === 'declined') {
      storeAnswer(deps, outcome === 'accepted');
      await reportUnsentAnswer(deps);
      return;
    }
    if (outcome === 'dismissed' || outcome === 'timed_out') storeDismissal(deps);
    await reportOutcome(deps, outcome);
  } catch (err) {
    logger.debug(`consent prompt skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ask(deps: ConsentDeps): Promise<PromptOutcome> {
  try {
    const answer = await deps.elicit(
      {
        message: FEATURES_QUESTION.message,
        requestedSchema: {
          type: 'object',
          properties: {
            share: { type: 'boolean', title: 'Share feature names', default: false },
          },
          required: ['share'],
        },
      },
      { timeout: PROMPT_TIMEOUT_MS }
    );
    if (answer.action === 'accept') return answer.content?.share === true ? 'accepted' : 'declined';
    return answer.action === 'decline' ? 'declined' : 'dismissed';
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === SdkErrorCode.RequestTimeout
      ? 'timed_out'
      : 'failed';
  }
}

async function reportOutcome(
  deps: ConsentDeps,
  result: PromptOutcome | 'unsupported'
): Promise<void> {
  await deps.report({
    question: FEATURES_QUESTION.id,
    questionVersion: FEATURES_QUESTION.version,
    result,
    via: 'elicitation',
  });
}

/**
 * Save against a fresh read of the file, so a change made elsewhere while the prompt was open
 * survives, and mirror it onto this process. `mutate` runs on both.
 */
function update(deps: ConsentDeps, mutate: (settings: Settings) => void): void {
  mutate(deps.settings);
  const { settings: onDisk, degraded } = loadSettings(deps.storage);
  if (degraded) return;
  mutate(onDisk);
  saveSettings(onDisk, deps.storage);
}

function storeAnswer(deps: ConsentDeps, share: boolean): void {
  update(deps, (settings) => setFeatureDetails(settings, share, 'elicitation', deps.now?.()));
}

function storeDismissal(deps: ConsentDeps): void {
  update(deps, (settings) => {
    const current = settings.consent_dismissals?.features;
    const count = current?.version === FEATURES_QUESTION.version ? current.count : 0;
    settings.consent_dismissals = {
      features: { version: FEATURES_QUESTION.version, count: count + 1 },
    };
  });
}

/**
 * Send a stored answer the server hasn't seen. Choices made through the CLI or in Claude Desktop
 * happen where no telemetry runs, so this is the one path every answer leaves by. Waits while
 * usage stats are off, because a person who opted out sends nothing. Marked as sent only once it
 * is delivered or in the outbox, so a process killed first sends it again next session.
 */
/** The server's ceiling for `question_version` (telemetry-server src/routes/telemetry.ts). */
const MAX_QUESTION_VERSION = 1000;

async function reportUnsentAnswer(deps: ConsentDeps): Promise<void> {
  const record = deps.settings.consent?.features;
  if (!record || record.reported || !deps.settings.telemetry.usage) return;
  // The server takes question versions 1 to 1000 and refuses the whole batch otherwise, so a
  // hand-edited record outside them is never sent: it would sit in the outbox and hold up every
  // later batch. It still reads as an answer to that version (an older one is asked again).
  if (record.version < 1 || record.version > MAX_QUESTION_VERSION) return;
  const settled = await deps.report({
    question: FEATURES_QUESTION.id,
    questionVersion: record.version,
    result: record.answer,
    via: record.via,
  });
  if (!settled) return;
  update(deps, (settings) => {
    const stored = settings.consent?.features;
    // A different answer saved meanwhile hasn't been sent, so it stays unmarked.
    if (
      stored?.version === record.version &&
      stored.answer === record.answer &&
      stored.via === record.via
    ) {
      settings.consent = { ...settings.consent, features: { ...stored, reported: true } };
    }
  });
}
