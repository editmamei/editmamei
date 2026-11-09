import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEATURE_TOKEN_PATTERN,
  optionValues,
  toFeatureToken,
} from '@editmamei/telemetry/feature-details.ts';
import { TelemetryClient } from '@editmamei/telemetry/client.ts';
import { appendOutboxSync, readOutbox } from '@editmamei/telemetry/outbox.ts';
import type { TelemetryEvent } from '@editmamei/telemetry/events.ts';
import type { Settings } from '@editmamei/core/settings.ts';

const SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['gaussian_blur', 'median'] },
    blend_mode: { type: 'string', enum: ['normal', 'soft light'] },
    bits: { type: 'number', enum: [8, 16] },
    layer_name: { type: 'string' },
    file_path: { type: 'string' },
  },
};

describe('optionValues', () => {
  it('records a value the schema lists', () => {
    expect(optionValues('ps_filter', SCHEMA, { type: 'median' })).toEqual([
      { kind: 'option', tool: 'ps_filter', name: 'type', value: 'median' },
    ]);
  });

  it('normalizes a listed value to the server token shape', () => {
    expect(optionValues('ps_filter', SCHEMA, { blend_mode: 'soft light' })).toEqual([
      { kind: 'option', tool: 'ps_filter', name: 'blend_mode', value: 'soft_light' },
    ]);
  });

  it('never records a value the schema does not list', () => {
    const args = {
      type: 'Smith Wedding',
      layer_name: 'Happy Birthday',
      file_path: 'C:/Users/someone/wedding.psd',
      bits: 16,
      not_in_schema: 'gaussian_blur',
    };
    expect(optionValues('ps_filter', SCHEMA, args)).toEqual([]);
  });

  it.each([undefined, null, {}, { properties: null }, { properties: 'x' }])(
    'tolerates a schema shaped like %j',
    (schema) => {
      expect(optionValues('ps_filter', schema, { type: 'median' })).toEqual([]);
    }
  );

  it('tolerates a malformed property', () => {
    const schema = { properties: { type: null, op: { enum: 'median' } } };
    expect(optionValues('ps_filter', schema, { type: 'median', op: 'median' })).toEqual([]);
  });
});

describe('toFeatureToken', () => {
  it.each([
    ['soft light', 'soft_light'],
    ['hue/saturation', 'hue_saturation'],
    ['$.evalFile', '$.evalFile'],
    ['#Pxl', '#Pxl'],
  ])('maps %s to %s', (raw, token) => {
    expect(toFeatureToken(raw)).toBe(token);
  });

  it('caps the length, and returns null for what the server would refuse', () => {
    expect(toFeatureToken('a'.repeat(100))).toHaveLength(64);
    expect(toFeatureToken('')).toBeNull();
    expect(toFeatureToken('.png')).toBeNull();
    expect(toFeatureToken('Smith Wedding.PSD')).toBeNull();
  });

  it('keeps a value out of the event when it would not fit', () => {
    const schema = { properties: { format: { enum: ['.png'] } } };
    expect(optionValues('ps_export', schema, { format: '.png' })).toEqual([]);
  });

  it('matches the telemetry server shape', () => {
    expect(FEATURE_TOKEN_PATTERN.test('gaussian_blur')).toBe(true);
    expect(FEATURE_TOKEN_PATTERN.test('photo.jpeg')).toBe(false);
  });
});

describe('TelemetryClient feature details', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function settings(telemetry: Partial<Settings['telemetry']> = {}): Settings {
    return {
      telemetry: { usage: true, diagnostics: false, install_id: 'a'.repeat(32), ...telemetry },
      privacy: { send_previews_to_llm: true },
      automation: { allow_execute_script: true },
      ps_path: null,
      update_check: true,
      editor: 'auto',
      gimp_path: null,
    };
  }

  function makeClient(s: Settings, opts: { fail?: boolean; maxBatchSize?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'editmamei-features-'));
    dirs.push(dir);
    const sent: TelemetryEvent[] = [];
    const client = new TelemetryClient({
      settings: s,
      getPsVersion: () => '27.0',
      active: true,
      outboxDir: dir,
      ...(opts.maxBatchSize ? { maxBatchSize: opts.maxBatchSize } : {}),
      now: () => new Date('2026-11-20T10:00:00Z'),
      transport: async (_url, body) => {
        if (opts.fail) throw new Error('down');
        sent.push(...(JSON.parse(body) as { events: TelemetryEvent[] }).events);
      },
    });
    return { client, sent, dir };
  }

  const blur = () => optionValues('ps_filter', SCHEMA, { type: 'gaussian_blur' });

  it('rolls repeats into one event with no install id or device details', async () => {
    const { client, sent } = makeClient(settings({ features: true }));
    client.recordFeatures(blur);
    client.recordFeatures(blur);
    await client.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      v: 2,
      type: 'feature_usage',
      ts_bucket: '2026-11-20',
      editmamei_version: expect.any(String),
      kind: 'option',
      tool: 'ps_filter',
      name: 'type',
      value: 'gaussian_blur',
      count: 2,
    });
  });

  it('splits a count over the server ceiling', async () => {
    const { client, sent } = makeClient(settings({ features: true }));
    for (let i = 0; i < 1_500; i++) client.recordFeatures(blur);
    await client.flush();
    expect(sent.map((e) => (e as { count: number }).count)).toEqual([1_000, 500]);
  });

  it.each([
    ['not asked', {}],
    ['declined', { features: false }],
    ['usage stats off', { features: true, usage: false }],
  ])('records nothing when %s', async (_label, telemetry) => {
    const { client, sent } = makeClient(settings(telemetry));
    let read = false;
    client.recordFeatures(() => {
      read = true;
      return blur();
    });
    await client.flush();
    expect(read).toBe(false);
    expect(sent).toEqual([]);
  });

  it('never throws into the caller', () => {
    const { client } = makeClient(settings({ features: true }));
    expect(() =>
      client.recordFeatures(() => {
        throw new Error('bad schema');
      })
    ).not.toThrow();
  });

  it('drops pending counts if consent is withdrawn before the flush', async () => {
    const s = settings({ features: true });
    const { client, sent } = makeClient(s);
    client.recordFeatures(blur);
    s.telemetry.features = false;
    await client.flush();
    expect(sent).toEqual([]);
  });

  it('never starts a send while draining at shutdown, so a full batch is not lost at exit', async () => {
    const { client, sent, dir } = makeClient(settings({ features: true }), { maxBatchSize: 2 });
    client.recordCall({ tool: 'ps_filter', success: true, duration_ms: 1, error_class: null });
    client.recordFeatures(() => [
      { kind: 'option', tool: 'ps_filter', name: 'type', value: 'median' },
      { kind: 'option', tool: 'ps_filter', name: 'blend_mode', value: 'normal' },
    ]);
    await client.shutdown();
    expect(sent).toEqual([]);
    const stored = readOutbox({ dir });
    expect(stored.filter((e) => e.type === 'feature_usage')).toHaveLength(2);
    expect(stored.some((e) => e.type === 'usage')).toBe(true);
  });

  it('writes pending counts to the outbox at shutdown', async () => {
    const { client, dir } = makeClient(settings({ features: true }));
    client.recordFeatures(blur);
    await client.shutdown();
    const stored = readOutbox({ dir });
    expect(stored.some((e) => e.type === 'feature_usage')).toBe(true);
  });

  it('does not send a stored feature event after consent is withdrawn', async () => {
    const { client, sent, dir } = makeClient(settings({ features: false }));
    const feature = {
      v: 2,
      type: 'feature_usage',
      ts_bucket: '2026-11-19',
      editmamei_version: '1.9.3',
      kind: 'option',
      tool: 'ps_filter',
      name: 'type',
      value: 'median',
      count: 1,
    } as const;
    const usage = {
      v: 2,
      type: 'usage',
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-11-19',
      editmamei_version: '1.9.3',
      edition: 'community',
      platform: 'win32',
      ps_version: '27.0',
      tool: 'ps_ping',
      success: true,
      error_class: null,
      duration_ms: 5,
    } as const;
    appendOutboxSync([feature, usage], { dir });
    await client.flushOutboxOnStartup();
    expect(sent.map((e) => e.type)).toEqual(['usage']);
  });

  it('sends a stored feature event while consent stands', async () => {
    const { client, sent, dir } = makeClient(settings({ features: true }));
    appendOutboxSync(
      [
        {
          v: 2,
          type: 'feature_usage',
          ts_bucket: '2026-11-19',
          editmamei_version: '1.9.3',
          kind: 'option',
          tool: 'ps_filter',
          name: 'type',
          count: 1,
        },
      ],
      { dir }
    );
    await client.flushOutboxOnStartup();
    expect(sent.map((e) => e.type)).toEqual(['feature_usage']);
  });

  describe('recordConsentResult', () => {
    const info = {
      clientName: 'claude-code',
      question: 'features',
      questionVersion: 1,
      result: 'declined',
      via: 'elicitation',
    } as const;

    it('records a no, even with Feature details off', async () => {
      const { client, sent } = makeClient(settings({ features: false }));
      await client.recordConsentResult(info);
      expect(sent[0]).toMatchObject({
        type: 'consent_result',
        install_id: 'a'.repeat(32),
        client: 'claude_code',
        question: 'features',
        question_version: 1,
        result: 'declined',
        via: 'elicitation',
      });
    });

    it('goes out straight away, or to the outbox if the send fails', async () => {
      const live = makeClient(settings());
      await expect(live.client.recordConsentResult(info)).resolves.toBe(true);
      expect(live.sent).toHaveLength(1);

      const down = makeClient(settings(), { fail: true });
      await expect(down.client.recordConsentResult(info)).resolves.toBe(true);
      expect(readOutbox({ dir: down.dir }).map((e) => e.type)).toEqual(['consent_result']);
    });

    it('sends nothing with usage stats off', async () => {
      const { client, sent } = makeClient(settings({ usage: false }));
      await expect(client.recordConsentResult(info)).resolves.toBe(false);
      expect(sent).toEqual([]);
    });
  });
});
