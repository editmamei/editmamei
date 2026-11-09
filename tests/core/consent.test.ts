import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';
import {
  MAX_DISMISSALS,
  clientSupportsForm,
  runConsentPrompt,
  shouldAsk,
  type ConsentDeps,
} from '@editmamei/core/consent.ts';
import { FEATURES_QUESTION } from '@editmamei/core/consent-questions.ts';
import { TelemetryClient } from '@editmamei/telemetry/client.ts';
import {
  applyDesktopToggles,
  featureDetailsEnabled,
  loadSettings,
  settingsPath,
} from '@editmamei/core/settings.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'editmamei-consent-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An install from before this setting existed. */
async function existingInstall(extra: Record<string, unknown> = {}) {
  await writeFile(
    settingsPath({ dir }),
    JSON.stringify({ telemetry: { usage: true, install_id: 'x'.repeat(32) }, ...extra })
  );
  return loadSettings({ dir }).settings;
}

function deps(over: Partial<ConsentDeps> & Pick<ConsentDeps, 'settings'>) {
  const report = vi.fn(async () => true);
  const elicit = vi.fn(async () => ({ action: 'cancel' as const }));
  return {
    report,
    elicit,
    all: {
      degraded: false,
      telemetryActive: true,
      supportsForm: true,
      elicit,
      report,
      storage: { dir },
      now: () => new Date('2026-11-20T10:00:00Z'),
      ...over,
    } as ConsentDeps,
  };
}

describe('clientSupportsForm', () => {
  it.each([
    [{}, true],
    [{ form: {} }, true],
    [{ form: {}, url: {} }, true],
    [{ url: {} }, false],
    [undefined, false],
    [null, false],
  ])('%j reads as %s', (caps, expected) => {
    expect(clientSupportsForm(caps)).toBe(expected);
  });
});

describe('who is asked', () => {
  it('asks an existing install, once, with a fixed short message and a default of no', async () => {
    const settings = await existingInstall();
    const { all, elicit } = deps({ settings });
    await runConsentPrompt(all);
    expect(elicit).toHaveBeenCalledTimes(1);
    const [params] = elicit.mock.calls[0] as unknown as [
      {
        message: string;
        requestedSchema: { properties: { share: { type: string; default: boolean } } };
      },
    ];
    expect(params.message).toBe(FEATURES_QUESTION.message);
    expect(params.message.length).toBeLessThan(150);
    expect(params.message).not.toMatch(/https?:/);
    expect(params.requestedSchema.properties.share).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('never asks a new install, and tells the server why it is on', async () => {
    const { settings, created } = loadSettings({ dir });
    expect(created).toBe(true);
    const { all, elicit, report } = deps({ settings });
    await runConsentPrompt(all);
    expect(elicit).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({
      question: 'features',
      questionVersion: FEATURES_QUESTION.version,
      result: 'install_default',
      via: 'install',
    });
    expect(featureDetailsEnabled(settings)).toBe(true);
  });

  it('asks a new install again when the question version rises', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: true, install_id: 'x'.repeat(32) },
      consent: {
        features: {
          version: FEATURES_QUESTION.version - 1,
          answer: 'install_default',
          via: 'install',
          date: '2026-01-01',
          reported: true,
        },
      },
    });
    expect(shouldAsk(settings)).toBe(true);
    expect(featureDetailsEnabled(settings)).toBe(false);
  });

  it('does not ask while the Claude Desktop toggle is off', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: false, install_id: 'x'.repeat(32) },
      desktop_toggles: { features: false },
      consent: {
        features: {
          version: FEATURES_QUESTION.version - 1,
          answer: 'declined',
          via: 'desktop',
          date: '2026-01-01',
          reported: true,
        },
      },
    });
    expect(shouldAsk(settings)).toBe(false);
  });

  it('asks again when a stored record is malformed', async () => {
    const settings = await existingInstall({
      consent: { features: { version: 'one', answer: 'accepted', via: 'cli', date: 'today' } },
    });
    expect(settings).not.toHaveProperty('consent');
    expect(shouldAsk(settings)).toBe(true);
  });

  it('does not ask anyone with usage stats off, and sends nothing for them', async () => {
    const settings = await existingInstall({
      telemetry: { usage: false, install_id: 'x'.repeat(32) },
    });
    const { all, elicit, report } = deps({ settings });
    await runConsentPrompt(all);
    expect(elicit).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('does not ask when the setting was already chosen by hand', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: false, install_id: 'x'.repeat(32) },
    });
    const { all, elicit } = deps({ settings });
    await runConsentPrompt(all);
    expect(elicit).not.toHaveBeenCalled();
  });

  it.each([
    ['the file could not be read', { degraded: true }],
    ['telemetry is inert', { telemetryActive: false }],
  ])('does nothing when %s', async (_label, over) => {
    const settings = await existingInstall();
    const { all, elicit, report } = deps({ settings, ...over });
    await runConsentPrompt(all);
    expect(elicit).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
});

describe('answers', () => {
  it.each([
    ['accept, ticked', { action: 'accept', content: { share: true } }, true, 'accepted'],
    ['accept, unticked', { action: 'accept', content: { share: false } }, false, 'declined'],
    ['accept, empty', { action: 'accept' }, false, 'declined'],
    ['decline', { action: 'decline' }, false, 'declined'],
  ] as const)('%s', async (_label, answer, on, result) => {
    const settings = await existingInstall();
    const { all, report } = deps({ settings, elicit: async () => answer });
    await runConsentPrompt(all);

    const onDisk = loadSettings({ dir }).settings;
    for (const s of [settings, onDisk]) {
      expect(s.telemetry.features).toBe(on);
      expect(s.telemetry.usage).toBe(true);
      expect(s.consent?.features).toMatchObject({
        version: FEATURES_QUESTION.version,
        answer: result,
        via: 'elicitation',
        date: '2026-11-20',
      });
    }
    expect(onDisk.consent?.features?.reported).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ result, via: 'elicitation' }));
    expect(featureDetailsEnabled(settings)).toBe(on);
  });

  it('never asks again after an answer', async () => {
    const settings = await existingInstall();
    await runConsentPrompt(
      deps({ settings, elicit: async () => ({ action: 'decline' as const }) }).all
    );
    const next = deps({ settings: loadSettings({ dir }).settings });
    await runConsentPrompt(next.all);
    expect(next.elicit).not.toHaveBeenCalled();
    expect(next.report).not.toHaveBeenCalled();
  });

  it('keeps a change made elsewhere while the prompt was open', async () => {
    const settings = await existingInstall();
    const { all } = deps({
      settings,
      elicit: async () => {
        const raw = {
          telemetry: { usage: true, diagnostics: true, install_id: 'x'.repeat(32) },
        };
        await writeFile(settingsPath({ dir }), JSON.stringify(raw));
        return { action: 'accept' as const, content: { share: true } };
      },
    });
    await runConsentPrompt(all);
    const onDisk = loadSettings({ dir }).settings;
    expect(onDisk.telemetry.diagnostics).toBe(true);
    expect(onDisk.telemetry.features).toBe(true);
  });
});

describe('no answer', () => {
  it('stays off on dismissal, and stops asking after the limit', async () => {
    let settings = await existingInstall();
    for (let i = 0; i < MAX_DISMISSALS; i++) {
      const { all, elicit, report } = deps({ settings });
      await runConsentPrompt(all);
      expect(elicit).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ result: 'dismissed' }));
      settings = loadSettings({ dir }).settings;
      expect(settings.telemetry).not.toHaveProperty('features');
      expect(featureDetailsEnabled(settings)).toBe(false);
    }
    const { all, elicit } = deps({ settings });
    await runConsentPrompt(all);
    expect(elicit).not.toHaveBeenCalled();
  });

  it('reports a client that cannot show a form, without counting it as a dismissal', async () => {
    const settings = await existingInstall();
    const { all, elicit, report } = deps({ settings, supportsForm: false });
    await runConsentPrompt(all);
    expect(elicit).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ result: 'unsupported' }));
    expect(loadSettings({ dir }).settings).not.toHaveProperty('consent_dismissals');
    expect(featureDetailsEnabled(settings)).toBe(false);
  });

  it('stays off after an error, and does not count it', async () => {
    const settings = await existingInstall();
    const { all, report } = deps({
      settings,
      elicit: async () => {
        throw new Error('method not found');
      },
    });
    await expect(runConsentPrompt(all)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ result: 'failed' }));
    expect(settings.telemetry).not.toHaveProperty('features');
    expect(loadSettings({ dir }).settings).not.toHaveProperty('consent_dismissals');
  });

  it('stays off after a timeout, and stops asking after the limit', async () => {
    let settings = await existingInstall();
    const elicit = vi.fn(async () => {
      throw new SdkError(SdkErrorCode.RequestTimeout, 'slow');
    });
    for (let i = 0; i < MAX_DISMISSALS; i++) {
      const { all, report } = deps({ settings, elicit });
      await runConsentPrompt(all);
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ result: 'timed_out' }));
      settings = loadSettings({ dir }).settings;
      expect(featureDetailsEnabled(settings)).toBe(false);
    }
    expect(elicit).toHaveBeenCalledTimes(MAX_DISMISSALS);
    expect(shouldAsk(settings)).toBe(false);
  });

  it('does not make the caller wait on a client that never replies', async () => {
    const settings = await existingInstall();
    const { all } = deps({ settings, elicit: () => new Promise(() => undefined) });
    let settled = false;
    void runConsentPrompt(all).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(featureDetailsEnabled(settings)).toBe(false);
  });

  it('asks for a bounded time', async () => {
    const settings = await existingInstall();
    const { all, elicit } = deps({ settings });
    await runConsentPrompt(all);
    const [, options] = elicit.mock.calls[0] as unknown as [unknown, { timeout: number }];
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(10 * 60_000);
  });

  it('never rejects, even if reporting throws', async () => {
    const settings = await existingInstall();
    const { all } = deps({
      settings,
      supportsForm: false,
      report: () => {
        throw new Error('boom');
      },
    });
    await expect(runConsentPrompt(all)).resolves.toBeUndefined();
  });
});

describe('marking an answer as reported', () => {
  const record = {
    version: FEATURES_QUESTION.version,
    answer: 'declined',
    via: 'cli',
    date: '2026-11-19',
  };

  it('waits for the send to settle', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: false, install_id: 'x'.repeat(32) },
      consent: { features: record },
    });
    let finishSend: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => (finishSend = resolve));
    const run = runConsentPrompt(deps({ settings, report: () => pending.then(() => true) }).all);
    await new Promise((r) => setTimeout(r, 10));
    expect(loadSettings({ dir }).settings.consent?.features?.reported).toBeUndefined();
    finishSend();
    await run;
    expect(loadSettings({ dir }).settings.consent?.features?.reported).toBe(true);
  });

  it('stays unmarked when the send could not be delivered or stored', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: false, install_id: 'x'.repeat(32) },
      consent: { features: record },
    });
    await runConsentPrompt(deps({ settings, report: () => false }).all);
    expect(loadSettings({ dir }).settings.consent?.features?.reported).toBeUndefined();
  });

  it('holds the mark until the real client has sent, even with a nearly full queue', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: false, install_id: 'x'.repeat(32) },
      consent: { features: record },
    });
    let finishSend: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => (finishSend = resolve));
    const client = new TelemetryClient({
      settings,
      getPsVersion: () => null,
      active: true,
      outboxDir: dir,
      maxBatchSize: 2,
      transport: () => pending,
    });
    client.recordCall({ tool: 'ps_ping', success: true, duration_ms: 1, error_class: null });
    const run = runConsentPrompt(
      deps({
        settings,
        report: (info) => client.recordConsentResult({ clientName: 'cursor', ...info }),
      }).all
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(loadSettings({ dir }).settings.consent?.features?.reported).toBeUndefined();
    finishSend();
    await run;
    expect(loadSettings({ dir }).settings.consent?.features?.reported).toBe(true);
  });

  it('leaves unmarked a different answer saved while the send was running', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: false, install_id: 'x'.repeat(32) },
      consent: { features: record },
    });
    await runConsentPrompt(
      deps({
        settings,
        report: async () => {
          await writeFile(
            settingsPath({ dir }),
            JSON.stringify({
              telemetry: { usage: true, features: true, install_id: 'x'.repeat(32) },
              consent: { features: { ...record, answer: 'accepted' } },
            })
          );
          return true;
        },
      }).all
    );
    const stored = loadSettings({ dir }).settings.consent?.features;
    expect(stored?.answer).toBe('accepted');
    expect(stored?.reported).toBeUndefined();
  });
});

describe('answers given elsewhere', () => {
  it('reports a CLI or Desktop choice at the next session, once', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: false, install_id: 'x'.repeat(32) },
      consent: {
        features: {
          version: FEATURES_QUESTION.version,
          answer: 'declined',
          via: 'cli',
          date: '2026-11-19',
        },
      },
    });
    const first = deps({ settings });
    await runConsentPrompt(first.all);
    expect(first.report).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'declined', via: 'cli' })
    );
    const second = deps({ settings: loadSettings({ dir }).settings });
    await runConsentPrompt(second.all);
    expect(second.report).not.toHaveBeenCalled();
  });

  it('holds a choice back while usage stats are off', async () => {
    const settings = await existingInstall({
      telemetry: { usage: false, features: false, install_id: 'x'.repeat(32) },
      consent: {
        features: {
          version: FEATURES_QUESTION.version,
          answer: 'declined',
          via: 'cli',
          date: '2026-11-19',
        },
      },
    });
    const { all, report } = deps({ settings });
    await runConsentPrompt(all);
    expect(report).not.toHaveBeenCalled();
    expect(loadSettings({ dir }).settings.consent?.features?.reported).toBeUndefined();
  });
});

describe('Claude Desktop toggle', () => {
  const desktop = (features: string) => ({
    EDITMAMEI_TELEMETRY_USAGE: 'true',
    EDITMAMEI_TELEMETRY_DIAGNOSTICS: 'false',
    EDITMAMEI_UPDATE_CHECK: 'true',
    EDITMAMEI_TELEMETRY_FEATURES: features,
  });

  it('does not turn on an unanswered install when first seen on', async () => {
    const settings = await existingInstall();
    const out = applyDesktopToggles(settings, desktop('true'), { dir });
    expect(out.telemetry).not.toHaveProperty('features');
    expect(featureDetailsEnabled(out)).toBe(false);
    expect(loadSettings({ dir }).settings.telemetry).not.toHaveProperty('features');
    expect(shouldAsk(out)).toBe(true);
  });

  it('keeps a new install on when first seen on', () => {
    const { settings } = loadSettings({ dir });
    expect(featureDetailsEnabled(applyDesktopToggles(settings, desktop('true'), { dir }))).toBe(
      true
    );
  });

  it('records an off at first sight as a choice', async () => {
    const settings = await existingInstall();
    const out = applyDesktopToggles(settings, desktop('false'), { dir });
    expect(out.telemetry.features).toBe(false);
    expect(loadSettings({ dir }).settings.consent?.features).toMatchObject({
      answer: 'declined',
      via: 'desktop',
    });
    expect(shouldAsk(out)).toBe(false);
  });

  it('keeps an answer through an unchanged toggle', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: false, install_id: 'x'.repeat(32) },
      desktop_toggles: { features: true },
      consent: {
        features: {
          version: FEATURES_QUESTION.version,
          answer: 'declined',
          via: 'elicitation',
          date: '2026-11-19',
        },
      },
    });
    const out = applyDesktopToggles(settings, desktop('true'), { dir });
    expect(out.telemetry.features).toBe(false);
    expect(loadSettings({ dir }).settings.consent?.features?.via).toBe('elicitation');
  });

  it('counts moving the toggle as a choice, both ways', async () => {
    await existingInstall({ desktop_toggles: { features: true } });
    const off = applyDesktopToggles(loadSettings({ dir }).settings, desktop('false'), { dir });
    expect(off.telemetry.features).toBe(false);
    const on = applyDesktopToggles(loadSettings({ dir }).settings, desktop('true'), { dir });
    expect(on.telemetry.features).toBe(true);
    expect(loadSettings({ dir }).settings.consent?.features).toMatchObject({
      answer: 'accepted',
      via: 'desktop',
    });
  });

  it('lets an off toggle win for this launch without rewriting the stored answer', async () => {
    const settings = await existingInstall({
      telemetry: { usage: true, features: true, install_id: 'x'.repeat(32) },
      desktop_toggles: { features: false },
    });
    const out = applyDesktopToggles(settings, desktop('false'), { dir });
    expect(featureDetailsEnabled(out)).toBe(false);
    expect(loadSettings({ dir }).settings.telemetry.features).toBe(true);
  });
});
