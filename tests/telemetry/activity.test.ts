import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  READ_ONLY_TOOLS,
  KEPT_WORK_TOOLS,
  MUTATING_TOOLS,
  mapClientName,
  parseMajor,
  boundMajor,
  nodeMajor,
  archToken,
  osMajor,
} from '@editmamei/telemetry/activity.ts';
import { TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

describe('READ_ONLY_TOOLS / KEPT_WORK_TOOLS', () => {
  it('is a fixed, disjoint pair of sets', () => {
    expect(READ_ONLY_TOOLS.has('ps_ping')).toBe(true);
    expect(READ_ONLY_TOOLS.has('ps_export')).toBe(false);
    expect(KEPT_WORK_TOOLS.has('ps_export')).toBe(true);
    expect(KEPT_WORK_TOOLS.has('ps_save_psd')).toBe(true);
    for (const tool of KEPT_WORK_TOOLS) expect(READ_ONLY_TOOLS.has(tool)).toBe(false);
  });

  it('does not classify an ordinary editing tool as either', () => {
    expect(READ_ONLY_TOOLS.has('ps_add_adjustment_layer')).toBe(false);
    expect(KEPT_WORK_TOOLS.has('ps_add_adjustment_layer')).toBe(false);
  });

  it('classifies ps_document, ps_template_verify, and ps_resolve_placement as read-only', () => {
    // ps_document: only op=list/activate exist (a closed enum — see document-tools.ts's
    // DOCUMENT_OPS) and neither touches pixels. ps_template_verify and ps_resolve_placement
    // are pure reads/checks, never document mutations.
    for (const tool of ['ps_document', 'ps_template_verify', 'ps_resolve_placement']) {
      expect(READ_ONLY_TOOLS.has(tool)).toBe(true);
      expect(KEPT_WORK_TOOLS.has(tool)).toBe(false);
    }
  });

  it('classifies the template trio (save/delete/create_evidence) as read-only — they write template FILES, never the open document', () => {
    for (const tool of ['ps_template_save', 'ps_template_delete', 'ps_template_create_evidence']) {
      expect(READ_ONLY_TOOLS.has(tool)).toBe(true);
      expect(KEPT_WORK_TOOLS.has(tool)).toBe(false);
      expect(MUTATING_TOOLS.has(tool)).toBe(false);
    }
  });

  it('is exactly the original sixteen, six template/document additions, and two orchestration wrappers (24 total)', () => {
    // A size pin is deliberately brittle: it forces anyone adding an entry to
    // state why that tool does not count as an edit.
    expect(READ_ONLY_TOOLS.size).toBe(24);
  });
});

describe('MUTATING_TOOLS', () => {
  it('classifies every ps_select* variant, plus modify/save-load-channel and layer masks, as mutating (selection is document state)', () => {
    for (const tool of [
      'ps_select',
      'ps_select_subject',
      'ps_select_sky',
      'ps_select_subject_instance',
      'ps_select_object',
      'ps_select_by_reference',
      'ps_select_face_feature',
      'ps_select_layer',
      'ps_modify_selection',
      'ps_selection_channel',
      'ps_layer_mask',
    ]) {
      expect(MUTATING_TOOLS.has(tool)).toBe(true);
      expect(READ_ONLY_TOOLS.has(tool)).toBe(false);
    }
  });

  it('classifies guides and shapes as mutating', () => {
    expect(MUTATING_TOOLS.has('ps_guides')).toBe(true);
    expect(MUTATING_TOOLS.has('ps_shape')).toBe(true);
  });

  it('classifies ps_template_apply as mutating (the one template-* tool that touches the open document)', () => {
    expect(MUTATING_TOOLS.has('ps_template_apply')).toBe(true);
    expect(READ_ONLY_TOOLS.has('ps_template_apply')).toBe(false);
  });
});

// Exhaustiveness guard. Reads every tool name registered in tool-tiers.ts (the actual
// source of truth for what tools exist, all tiers) and asserts each falls into EXACTLY one of
// the three classification sets — so a newly added tool that nobody classified here fails
// this suite instead of silently defaulting to "edit" with no test noticing either way.
describe('classification exhaustiveness against tool-tiers.ts', () => {
  const allToolNames = Object.keys(TOOL_TIERS);

  it('every tool in TOOL_TIERS is classified in exactly one of READ_ONLY_TOOLS / KEPT_WORK_TOOLS / MUTATING_TOOLS', () => {
    const unclassified: string[] = [];
    const overlapping: string[] = [];
    for (const name of allToolNames) {
      const memberships = [
        READ_ONLY_TOOLS.has(name),
        KEPT_WORK_TOOLS.has(name),
        MUTATING_TOOLS.has(name),
      ].filter(Boolean).length;
      if (memberships === 0) unclassified.push(name);
      if (memberships > 1) overlapping.push(name);
    }
    expect(unclassified, `unclassified tool(s): ${unclassified.join(', ')}`).toEqual([]);
    expect(overlapping, `tool(s) in more than one set: ${overlapping.join(', ')}`).toEqual([]);
  });

  it('has no entries in the three sets for a tool name that no longer exists in TOOL_TIERS', () => {
    // The reverse direction — a stale classification entry for a removed tool wouldn't be
    // caught by the loop above (which only walks TOOL_TIERS forward), so check it explicitly.
    const known = new Set(allToolNames);
    const stale = [...READ_ONLY_TOOLS, ...KEPT_WORK_TOOLS, ...MUTATING_TOOLS].filter(
      (name) => !known.has(name)
    );
    expect(stale, `classified but not in tool-tiers.ts: ${stale.join(', ')}`).toEqual([]);
  });

  it('accounts for every registered tool with no gaps (sanity total)', () => {
    expect(READ_ONLY_TOOLS.size + KEPT_WORK_TOOLS.size + MUTATING_TOOLS.size).toBe(
      allToolNames.length
    );
  });
});

describe('classification mirror', () => {
  // The aggregation service classifies each arriving event's tool name against its own copy
  // of these two sets, and its rollups are only comparable to this client's counters while
  // both copies agree. Nothing across that boundary can be imported here, so the membership
  // is pinned literally: changing either set fails this test, and the fix is to update the
  // service in the same breath — not to re-bless the list. MUTATING_TOOLS is deliberately
  // not pinned; it is the fail-open default on both sides, so a new tool lands in it
  // automatically and the two stay in step without an edit.
  it('pins READ_ONLY_TOOLS membership (update the aggregation service when this fails)', () => {
    expect([...READ_ONLY_TOOLS].sort()).toEqual([
      'ps_batch',
      'ps_compare_regions',
      'ps_detect',
      'ps_detect_landmarks',
      'ps_document',
      'ps_get_histogram',
      'ps_get_layer_bounds_diff',
      'ps_get_preview',
      'ps_get_selection_preview',
      'ps_inspect',
      'ps_list_actions',
      'ps_list_capabilities',
      'ps_overview',
      'ps_ping',
      'ps_read_scene',
      'ps_report_problem',
      'ps_resolve_placement',
      'ps_sequence',
      'ps_template_create_evidence',
      'ps_template_delete',
      'ps_template_list',
      'ps_template_recall',
      'ps_template_save',
      'ps_template_verify',
    ]);
  });

  it('pins KEPT_WORK_TOOLS membership (update the aggregation service when this fails)', () => {
    expect([...KEPT_WORK_TOOLS].sort()).toEqual(['ps_export', 'ps_save_psd']);
  });
});

describe('mapClientName', () => {
  it('maps the real Claude Desktop name ("claude-ai")', () => {
    expect(mapClientName('claude-ai')).toBe('claude_desktop');
  });

  it('maps the real Claude Code name ("claude-code")', () => {
    expect(mapClientName('claude-code')).toBe('claude_code');
  });

  it('recognizes claude-code variants ahead of the generic claude fallback', () => {
    expect(mapClientName('Claude-Code')).toBe('claude_code');
    expect(mapClientName('claude_code')).toBe('claude_code');
    expect(mapClientName('claudecode')).toBe('claude_code');
  });

  it('falls back generic claude names to claude_desktop', () => {
    expect(mapClientName('Claude Desktop')).toBe('claude_desktop');
    expect(mapClientName('CLAUDE')).toBe('claude_desktop');
  });

  it('recognizes cursor, windsurf, and vscode variants', () => {
    expect(mapClientName('Cursor')).toBe('cursor');
    expect(mapClientName('Windsurf')).toBe('windsurf');
    expect(mapClientName('vscode')).toBe('vscode');
    expect(mapClientName('Visual Studio Code')).toBe('vscode');
    expect(mapClientName('code-oss')).toBe('vscode');
  });

  it('falls back to other for an unrecognized or missing name', () => {
    expect(mapClientName('some-other-client')).toBe('other');
    expect(mapClientName(undefined)).toBe('other');
  });
});

describe('parseMajor', () => {
  it('reads the leading integer of a semver-ish string', () => {
    expect(parseMajor('2.1.170')).toBe(2);
    expect(parseMajor('27.8.0')).toBe(27);
    expect(parseMajor('10')).toBe(10);
  });

  it('returns null for undefined or unparseable input', () => {
    expect(parseMajor(undefined)).toBeNull();
    expect(parseMajor('unknown')).toBeNull();
    expect(parseMajor('')).toBeNull();
  });
});

describe('boundMajor', () => {
  it('passes a value through unchanged when inside [0, max]', () => {
    expect(boundMajor(0, 999)).toBe(0);
    expect(boundMajor(22, 999)).toBe(22);
    expect(boundMajor(999, 999)).toBe(999);
  });

  it('returns null for a value outside [0, max] (the bound, exclusive)', () => {
    expect(boundMajor(1000, 999)).toBeNull();
    expect(boundMajor(-1, 999)).toBeNull();
    expect(boundMajor(10000, 9999)).toBeNull();
  });

  it('passes null through as null', () => {
    expect(boundMajor(null, 999)).toBeNull();
  });

  it('returns null for a non-finite input (NaN, Infinity)', () => {
    expect(boundMajor(NaN, 999)).toBeNull();
    expect(boundMajor(Infinity, 999)).toBeNull();
    expect(boundMajor(-Infinity, 999)).toBeNull();
  });
});

describe('nodeMajor', () => {
  it('matches the leading integer of the real process.versions.node', () => {
    expect(nodeMajor()).toBe(parseMajor(process.versions.node));
  });

  it('returns null (not a 0 default) when unparseable — source-level pin', () => {
    // process.versions.node is not writable at runtime (Node ignores the assignment
    // silently), so the null-return path can't be exercised by calling nodeMajor()
    // directly with a garbled input. Pin the fix at the source level instead: the old
    // `parseMajor(process.versions.node) ?? 0` default must not have come back.
    const src = readFileSync(join(REPO_ROOT, 'src', 'telemetry', 'activity.ts'), 'utf8');
    const fnMatch = src.match(/export function nodeMajor\(\)[^{]*\{([\s\S]*?)\n\}/);
    expect(fnMatch, 'nodeMajor() body not found').toBeTruthy();
    expect(fnMatch![1]).not.toMatch(/\?\?/);
  });
});

describe('archToken', () => {
  it('reflects the real process.arch bucket', () => {
    const token = archToken();
    expect(['x64', 'arm64', 'other']).toContain(token);
    if (process.arch === 'x64' || process.arch === 'arm64') {
      expect(token).toBe(process.arch);
    } else {
      expect(token).toBe('other');
    }
  });
});

describe('osMajor', () => {
  it('parses a Windows 10 release string', () => {
    expect(osMajor('win32', '10.0.19045')).toBe(10);
  });

  it('parses a Windows 11 release string by build number', () => {
    expect(osMajor('win32', '10.0.22631')).toBe(11);
    expect(osMajor('win32', '10.0.22000')).toBe(11); // boundary: exactly 22000
    expect(osMajor('win32', '10.0.21999')).toBe(10); // boundary: just under
  });

  it('parses a macOS release string through Darwin 24 as Darwin major - 9', () => {
    expect(osMajor('darwin', '24.6.0')).toBe(15); // Sequoia
    expect(osMajor('darwin', '23.6.0')).toBe(14); // Sonoma
    expect(osMajor('darwin', '22.6.0')).toBe(13); // Ventura
  });

  it('parses Darwin 25+ as Darwin major + 1 — Apple broke the -9 mapping at macOS 26', () => {
    expect(osMajor('darwin', '25.0.0')).toBe(26); // Tahoe
    expect(osMajor('darwin', '24.6.0')).toBe(15); // boundary: the OLD mapping still applies at 24
  });

  it('parses a Linux kernel release string as its leading integer', () => {
    expect(osMajor('linux', '5.15.0-1053-aws')).toBe(5);
    expect(osMajor('linux', '6.8.0-generic')).toBe(6);
  });

  it('returns null for an unparseable release string', () => {
    expect(osMajor('win32', 'unknown')).toBeNull();
    expect(osMajor('darwin', '')).toBeNull();
    expect(osMajor('linux', 'not-a-version')).toBeNull();
  });
});

describe('classification of the orchestration wrappers and raw develop', () => {
  // The exhaustiveness suite only proves each tool is in EXACTLY ONE set, so it
  // passes whichever set these land in. These pin the actual decision, because
  // both carry a live correctness argument against where they currently sit —
  // see the KNOWN BIAS comments in activity.ts.
  it('does not count an orchestration wrapper as an edit of its own', () => {
    // edits_ok counts any successful call OUTSIDE READ_ONLY_TOOLS. These
    // wrappers' steps dispatch through host.invokeTool into registry.execute,
    // whose `finally` fires onCall for nested dispatches too, so each inner
    // step is already counted. Counting the wrapper as well inflated edits_ok
    // by an amount that scaled with step count.
    for (const tool of ['ps_sequence', 'ps_batch']) {
      expect(READ_ONLY_TOOLS.has(tool)).toBe(true);
      expect(MUTATING_TOOLS.has(tool)).toBe(false);
      expect(KEPT_WORK_TOOLS.has(tool)).toBe(false);
    }
  });

  it('counts ps_develop_raw as mutating, including its read mode', () => {
    // Name-shaped classification cannot see mode='read', which develops
    // nothing. Documented in activity.ts rather than silently shipped.
    expect(MUTATING_TOOLS.has('ps_develop_raw')).toBe(true);
    expect(KEPT_WORK_TOOLS.has('ps_develop_raw')).toBe(false);
  });
});
