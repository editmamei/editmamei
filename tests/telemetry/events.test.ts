import { describe, it, expect } from 'vitest';
import {
  buildUsageEvent,
  buildSessionSummary,
  buildSessionStart,
  buildModuleStatus,
  buildDiagnosticEvent,
  dayBucket,
  isContentSafe,
  looksLikeAbsolutePath,
  normalizeErrorClass,
  PS_VERSION_UNKNOWN,
  type TelemetryDimensions,
} from '@editmamei/telemetry/events.ts';
import { ERROR_CLASS_TABLE, classifyError } from '@editmamei/utils/session-log.ts';

/** The server's error_class token shape (telemetry-server USAGE_FIELDS / DIAGNOSTIC_FIELDS). */
const SERVER_TOKEN = /^[a-z0-9_]{1,48}$/;

function dims(
  psVersion: string | null,
  overrides: Partial<TelemetryDimensions> = {}
): TelemetryDimensions {
  return {
    install_id: 'a'.repeat(32),
    editmamei_version: '0.15.0',
    edition: 'community',
    platform: 'win32',
    channel: 'npm',
    getPsVersion: () => psVersion,
    ...overrides,
  };
}

const NOW = new Date('2026-06-14T19:30:00.000Z');

describe('dayBucket', () => {
  it('is day-granular (no time component)', () => {
    expect(dayBucket(NOW)).toBe('2026-06-14');
  });
});

describe('buildSessionStart', () => {
  it('produces a content-free boot ping: shared dimensions + channel, no counts, no free text', () => {
    const e = buildSessionStart(dims('2026', { channel: 'mcpb' }), NOW);
    expect(e).toEqual({
      v: 2,
      type: 'session_start',
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-06-14',
      editmamei_version: '0.15.0',
      edition: 'community',
      platform: 'win32',
      ps_version: '2026',
      channel: 'mcpb',
    });
    expect(isContentSafe(e)).toBe(true);
  });

  it('carries the install channel from the dims (npm default here)', () => {
    expect(buildSessionStart(dims('2026'), NOW).channel).toBe('npm');
  });

  it('uses the unknown placeholder before a ping resolves the PS version', () => {
    expect(buildSessionStart(dims(null), NOW).ps_version).toBe(PS_VERSION_UNKNOWN);
  });
});

describe('buildModuleStatus', () => {
  it('produces a content-free module_status event: enum outcome + module version/abi', () => {
    const e = buildModuleStatus(
      dims('2026', { edition: 'pro' }),
      { module: 'pro', outcome: 'loaded', module_version: '0.22.1', abi: 3 },
      NOW
    );
    expect(e).toEqual({
      v: 2,
      type: 'module_status',
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-06-14',
      editmamei_version: '0.15.0',
      edition: 'pro',
      platform: 'win32',
      module: 'pro',
      outcome: 'loaded',
      module_version: '0.22.1',
      abi: 3,
    });
    expect(isContentSafe(e)).toBe(true);
  });

  it('allows null version/abi (absent/corrupt module) without tripping the content guard', () => {
    const e = buildModuleStatus(
      dims('2026', { edition: 'pro' }),
      { module: 'pro', outcome: 'absent', module_version: null, abi: null },
      NOW
    );
    expect(e.module_version).toBeNull();
    expect(e.abi).toBeNull();
    expect(isContentSafe(e)).toBe(true);
  });
});

describe('buildUsageEvent', () => {
  it('produces a content-free usage event mirroring the server schema', () => {
    const e = buildUsageEvent(
      dims('2026'),
      {
        tool: 'ps_add_adjustment_layer',
        success: true,
        duration_ms: 612,
        error_class: null,
      },
      NOW
    );
    expect(e).toEqual({
      v: 2,
      type: 'usage',
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-06-14',
      editmamei_version: '0.15.0',
      edition: 'community',
      platform: 'win32',
      ps_version: '2026',
      tool: 'ps_add_adjustment_layer',
      success: true,
      error_class: null,
      duration_ms: 612,
    });
  });

  it('falls back to the "unknown" placeholder before ps_version is known', () => {
    const e = buildUsageEvent(
      dims(null),
      { tool: 'ps_ping', success: true, duration_ms: 5, error_class: null },
      NOW
    );
    expect(e.ps_version).toBe(PS_VERSION_UNKNOWN);
  });
});

describe('normalizeErrorClass — server-token safety', () => {
  it('passes already-conforming tokens through unchanged', () => {
    expect(normalizeErrorClass('am_descriptor_no_op')).toBe('am_descriptor_no_op');
  });
  it('forces non-conforming input into the token shape', () => {
    expect(normalizeErrorClass('Schema Validation!')).toMatch(SERVER_TOKEN);
    expect(normalizeErrorClass('x'.repeat(80))).toMatch(SERVER_TOKEN);
    expect(normalizeErrorClass('x'.repeat(80)).length).toBeLessThanOrEqual(48);
  });
  it('falls back to "other" when nothing survives', () => {
    expect(normalizeErrorClass('')).toBe('other');
  });

  it('every classifyError output is a valid server token (regression)', () => {
    const classes = [...ERROR_CLASS_TABLE.map((e) => e.errorClass), 'other'];
    for (const c of classes) expect(c).toMatch(SERVER_TOKEN);
    // And anything classifyError can actually return for a real error string.
    expect(classifyError('layer "Sky" not found')).toMatch(SERVER_TOKEN);
    expect(classifyError('totally novel error text')).toMatch(SERVER_TOKEN);
  });

  it('a built usage event carries a clamped error_class', () => {
    const e = buildUsageEvent(
      dims('2026'),
      { tool: 'photoshop_x', success: false, duration_ms: 1, error_class: 'Weird Class!!' },
      NOW
    );
    expect(e.error_class).toMatch(SERVER_TOKEN);
  });
});

describe('buildSessionSummary', () => {
  it('carries only aggregate counts, no per-call data', () => {
    const e = buildSessionSummary(
      dims('2026'),
      { tool_call_count: 47, distinct_tools: 11, any_failures: true },
      NOW
    );
    expect(e.type).toBe('session_summary');
    expect(e.tool_call_count).toBe(47);
    expect(e.distinct_tools).toBe(11);
    expect(e.any_failures).toBe(true);
  });
});

describe('buildDiagnosticEvent', () => {
  it('omits edition (per §4.3) and includes optional fields only when present', () => {
    const withOpt = buildDiagnosticEvent(
      dims('2026'),
      {
        tool: 'photoshop_apply_shadows_highlights',
        error_class: 'am_descriptor_no_op',
        error_message: 'sanitized message',
        snippet: 'applyShadowsHighlights',
      },
      NOW
    );
    expect('edition' in withOpt).toBe(false);
    expect(withOpt.snippet).toBe('applyShadowsHighlights');
    expect('stderr_tail' in withOpt).toBe(false);
  });
});

describe('looksLikeAbsolutePath / isContentSafe', () => {
  it('flags path-shaped strings', () => {
    expect(looksLikeAbsolutePath('C:\\Users\\me\\a.psd')).toBe(true);
    expect(looksLikeAbsolutePath('/home/me/a.psd')).toBe(true);
    expect(looksLikeAbsolutePath('a\\b')).toBe(true);
  });
  it('passes content-free values', () => {
    expect(looksLikeAbsolutePath('ps_crop_document')).toBe(false);
    expect(looksLikeAbsolutePath('I/O error')).toBe(false);
    // Single-segment slash punctuation must not read as a path (M6 over-redaction guard).
    expect(looksLikeAbsolutePath('read/write conflict')).toBe(false);
    expect(looksLikeAbsolutePath('and/or both fail')).toBe(false);
  });
  it('flags a mid-string multi-segment POSIX path (M6 — leading-/ already stripped)', () => {
    // sanitizeMessage strips the leading separator, so a residual absolute POSIX path is
    // mid-string by guard time. The leading-`/` clause misses it; the multi-segment clause
    // is the defense-in-depth backstop.
    expect(looksLikeAbsolutePath('failed to open /Users/alice/secret/photo.psd')).toBe(true);
    expect(looksLikeAbsolutePath('Users/alice/secret/photo.psd')).toBe(true);
  });
  it('isContentSafe rejects an event whose message still contains a path', () => {
    const dirty = buildDiagnosticEvent(
      dims('2026'),
      { tool: 'photoshop_x', error_class: 'other', error_message: 'C:\\Users\\me\\x.psd' },
      NOW
    );
    expect(isContentSafe(dirty)).toBe(false);
  });
  it('isContentSafe rejects an event with a mid-string POSIX path (M6 defense-in-depth)', () => {
    const dirty = buildDiagnosticEvent(
      dims('2026'),
      {
        tool: 'photoshop_x',
        error_class: 'other',
        error_message: 'failed to open /Users/alice/secret/photo.psd',
      },
      NOW
    );
    expect(isContentSafe(dirty)).toBe(false);
  });
  it('isContentSafe accepts a clean usage event', () => {
    const clean = buildUsageEvent(
      dims('2026'),
      { tool: 'ps_crop_document', success: true, duration_ms: 1, error_class: null },
      NOW
    );
    expect(isContentSafe(clean)).toBe(true);
  });
});
