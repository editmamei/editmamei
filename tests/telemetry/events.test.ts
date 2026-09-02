import { describe, it, expect } from 'vitest';
import {
  buildUsageEvent,
  buildSessionSummary,
  buildSessionStart,
  buildClientConnected,
  buildModuleStatus,
  buildDiagnosticEvent,
  dayBucket,
  isContentSafe,
  looksLikeAbsolutePath,
  normalizeErrorClass,
  PS_VERSION_UNKNOWN,
  MAX_RESULT_BYTES,
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

  it('omits node_major/arch/os_major when the caller passes none', () => {
    const e = buildSessionStart(dims('2026'), NOW);
    expect('node_major' in e).toBe(false);
    expect('arch' in e).toBe(false);
    expect('os_major' in e).toBe(false);
  });

  it('includes node_major/arch/os_major when the caller supplies them', () => {
    const e = buildSessionStart(dims('2026'), NOW, {
      node_major: 22,
      arch: 'x64',
      os_major: 11,
    });
    expect(e.node_major).toBe(22);
    expect(e.arch).toBe('x64');
    expect(e.os_major).toBe(11);
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

  it('omits result_bytes when the caller does not pass it', () => {
    const e = buildUsageEvent(
      dims('2026'),
      { tool: 'ps_ping', success: true, duration_ms: 5, error_class: null },
      NOW
    );
    expect('result_bytes' in e).toBe(false);
  });

  it('carries result_bytes verbatim below the clamp', () => {
    const e = buildUsageEvent(
      dims('2026'),
      {
        tool: 'ps_get_preview',
        success: true,
        duration_ms: 5,
        error_class: null,
        result_bytes: 4096,
      },
      NOW
    );
    expect(e.result_bytes).toBe(4096);
  });

  it('clamps result_bytes to MAX_RESULT_BYTES', () => {
    const e = buildUsageEvent(
      dims('2026'),
      {
        tool: 'ps_get_preview',
        success: true,
        duration_ms: 5,
        error_class: null,
        result_bytes: MAX_RESULT_BYTES + 1_000_000,
      },
      NOW
    );
    expect(e.result_bytes).toBe(MAX_RESULT_BYTES);
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

  // The delete-layer snippet refuses to delete a group and says so in a fixed
  // phrase. That phrase is hoisted near the top of ERROR_CLASS_TABLE on
  // purpose: the message embeds a user-chosen GROUP NAME, and the table is
  // order-sensitive, so at wrong_layer_kind's natural position a group called
  // "Validation" or "must be dodged" would hand the row to schema_validation
  // or invalid_argument instead. These cases are the pin for that ordering.
  it('classifies the group-is-not-a-layer refusal regardless of the group name', () => {
    const refusal = (name: string) =>
      `Error deleting layer: Cannot delete "${name}": that name is a group, not an art layer (layer kind mismatch). Use ps_group(op=delete) to delete a group and its contents.`;
    for (const name of [
      'Old Curves',
      'Validation', // would otherwise hit schema_validation
      'must be dodged', // would otherwise hit invalid_argument
      'Background Layer', // would otherwise hit background_layer
      'locked layers', // would otherwise hit layer_locked
      'layer not found', // would otherwise hit layer_not_found
    ]) {
      expect(classifyError(refusal(name))).toBe('wrong_layer_kind');
    }
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
      '2026-06-14'
    );
    expect(e.type).toBe('session_summary');
    expect(e.tool_call_count).toBe(47);
    expect(e.distinct_tools).toBe(11);
    expect(e.any_failures).toBe(true);
  });

  it('stamps ts_bucket from the passed bucket, not "now" (session-start attribution)', () => {
    const e = buildSessionSummary(
      dims('2026'),
      { tool_call_count: 1, distinct_tools: 1, any_failures: false },
      '2026-06-13'
    );
    expect(e.ts_bucket).toBe('2026-06-13');
  });

  it('omits every new counter when the caller passes none of them', () => {
    const e = buildSessionSummary(
      dims('2026'),
      { tool_call_count: 1, distinct_tools: 1, any_failures: false },
      '2026-06-13'
    );
    for (const key of [
      'duration_s',
      'retry_count',
      'ended_after_failure',
      'edits_ok',
      'kept_work',
      'behind_latest',
      'dropped_events',
      'module_update',
      'templates_saved',
      'action_sets',
    ]) {
      expect(key in e).toBe(false);
    }
  });

  it('includes each new field when the caller supplies it', () => {
    const e = buildSessionSummary(
      dims('2026'),
      {
        tool_call_count: 10,
        distinct_tools: 3,
        any_failures: true,
        duration_s: 120,
        retry_count: 2,
        ended_after_failure: true,
        edits_ok: 5,
        kept_work: 1,
        behind_latest: true,
        dropped_events: 4,
        module_update: 'updated',
        templates_saved: 6,
        action_sets: 2,
      },
      '2026-06-13'
    );
    expect(e.duration_s).toBe(120);
    expect(e.retry_count).toBe(2);
    expect(e.ended_after_failure).toBe(true);
    expect(e.edits_ok).toBe(5);
    expect(e.kept_work).toBe(1);
    expect(e.behind_latest).toBe(true);
    expect(e.dropped_events).toBe(4);
    expect(e.module_update).toBe('updated');
    expect(e.templates_saved).toBe(6);
    expect(e.action_sets).toBe(2);
  });
});

describe('buildClientConnected', () => {
  it('maps a known client name + version, and every capability flag', () => {
    const e = buildClientConnected(
      dims('2026'),
      {
        clientName: 'claude-code',
        clientVersion: '2.1.170',
        capSampling: true,
        capElicitation: false,
        capRoots: true,
      },
      NOW
    );
    expect(e).toEqual({
      v: 2,
      type: 'client_connected',
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-06-14',
      editmamei_version: '0.15.0',
      edition: 'community',
      platform: 'win32',
      client: 'claude_code',
      client_major: 2,
      cap_sampling: true,
      cap_elicitation: false,
      cap_roots: true,
    });
    expect(isContentSafe(e)).toBe(true);
  });

  it('sends client_major as null (not omitted) when the version is unparseable', () => {
    const e = buildClientConnected(
      dims('2026'),
      {
        clientName: 'some-client',
        clientVersion: undefined,
        capSampling: false,
        capElicitation: false,
        capRoots: false,
      },
      NOW
    );
    expect('client_major' in e).toBe(true);
    expect(e.client_major).toBeNull();
  });

  it('maps an unrecognized client name to other', () => {
    const e = buildClientConnected(
      dims('2026'),
      {
        clientName: 'some-custom-mcp-client',
        clientVersion: '1.0.0',
        capSampling: false,
        capElicitation: false,
        capRoots: false,
      },
      NOW
    );
    expect(e.client).toBe('other');
  });

  it('has no ps_version dimension (unlike usage/session_start/diagnostic)', () => {
    const e = buildClientConnected(
      dims('2026'),
      {
        clientName: 'claude-ai',
        clientVersion: '0.1.0',
        capSampling: false,
        capElicitation: false,
        capRoots: false,
      },
      NOW
    );
    expect('ps_version' in e).toBe(false);
  });
});

describe('buildDiagnosticEvent', () => {
  it('omits edition and includes optional fields only when present', () => {
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

  it('omits doc_depth/doc_mode/ps_locale when the caller passes none', () => {
    const e = buildDiagnosticEvent(
      dims('2026'),
      { tool: 'ps_apply_adjustment', error_class: 'other', error_message: 'msg' },
      NOW
    );
    expect('doc_depth' in e).toBe(false);
    expect('doc_mode' in e).toBe(false);
    expect('ps_locale' in e).toBe(false);
  });

  it('includes doc_depth/doc_mode/ps_locale when the caller supplies them', () => {
    const e = buildDiagnosticEvent(
      dims('2026'),
      {
        tool: 'ps_apply_adjustment',
        error_class: 'other',
        error_message: 'msg',
        doc_depth: 16,
        doc_mode: 'cmyk',
        ps_locale: 'en_US',
      },
      NOW
    );
    expect(e.doc_depth).toBe(16);
    expect(e.doc_mode).toBe('cmyk');
    expect(e.ps_locale).toBe('en_US');
  });

  it('silently omits a ps_locale that does not match the server token shape', () => {
    const e = buildDiagnosticEvent(
      dims('2026'),
      {
        tool: 'ps_apply_adjustment',
        error_class: 'other',
        error_message: 'msg',
        ps_locale: 'not-a-locale',
      },
      NOW
    );
    expect('ps_locale' in e).toBe(false);
  });

  it('accepts a 3-letter language subtag locale', () => {
    const e = buildDiagnosticEvent(
      dims('2026'),
      {
        tool: 'ps_apply_adjustment',
        error_class: 'other',
        error_message: 'msg',
        ps_locale: 'fil_PH',
      },
      NOW
    );
    expect(e.ps_locale).toBe('fil_PH');
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
