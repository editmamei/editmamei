import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';
import { OVERVIEW_MARKDOWN } from '@editmamei/tools/overview-tools.ts';
import { HYDRATED_OVERLAY } from '../helpers/overlay-tree.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Walks a directory and returns every regular file path under it.
 * Used to enumerate all SKILL.md / companion docs inside skills/.
 */
function listFilesRecursive(start: string): string[] {
  if (!existsSync(start)) return [];
  const stat = statSync(start);
  if (stat.isFile()) return [start];
  if (!stat.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(start)) {
    out.push(...listFilesRecursive(join(start, entry)));
  }
  return out;
}

/**
 * Tool-name leak detection has to use word-boundary matching, not raw
 * substring matching. Tool names are built by suffixing a shared stem, so a
 * gated name is regularly a strict prefix of a shippable one — plain
 * `content.includes(gatedName)` then false-positives on a document that only
 * ever mentions the longer, shippable sibling. This helper escapes regex
 * metacharacters and matches only when the next character is NOT an
 * identifier char (letter / digit / underscore).
 */
function containsToolName(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped + '(?![A-Za-z0-9_])');
  return re.test(content);
}

/**
 * Positive control (confirmed MEDIUM finding, folded into the 2026-08-28
 * strengthening pass): every leak assertion in this file lives or dies on
 * `containsToolName`, and nothing previously proved it can actually catch a
 * leak. These pin its true-positive behavior (including the word-boundary
 * edge cases the header comment above describes) and its true-negative
 * behavior (a near-miss prefix must NOT match).
 */
describe('containsToolName (positive control)', () => {
  it('matches a bare mid-sentence mention', () => {
    expect(
      containsToolName('Use ps_resolve_placement to ground the anchor.', 'ps_resolve_placement')
    ).toBe(true);
  });

  it('matches a backticked mention', () => {
    expect(
      containsToolName('See `ps_resolve_placement` for details.', 'ps_resolve_placement')
    ).toBe(true);
  });

  it('matches a possessive mention', () => {
    expect(
      containsToolName("ps_resolve_placement's output feeds the gate.", 'ps_resolve_placement')
    ).toBe(true);
  });

  it('matches at end of sentence with trailing punctuation', () => {
    expect(
      containsToolName('Concur first with ps_resolve_placement.', 'ps_resolve_placement')
    ).toBe(true);
  });

  it('does NOT match when the name is a strict prefix of a longer identifier (word-boundary negative)', () => {
    // ps_path is a real community-tier tool name; ps_pathfinder is not a
    // real tool anywhere in this codebase — it exists here purely to prove
    // the matcher doesn't false-positive on a longer sibling identifier,
    // the exact failure mode the header comment above describes.
    expect(containsToolName('This behaves like ps_pathfinder.', 'ps_path')).toBe(false);
  });

  it('does NOT match an unrelated community-tier mention when scanning for a different blocked name', () => {
    expect(
      containsToolName('Use ps_select for common selection tasks.', 'ps_resolve_placement')
    ).toBe(false);
  });
});

/**
 * Prevents accidentally tipping unverified work-in-progress tools to
 * end-users via the public README.
 *
 * The public README.md ships in the CE / Pro npm packages and is what
 * users see on npmjs.com + GitHub. Any tool name appearing there is a
 * public commitment that the tool exists and works. Tier 'dev' means
 * "written but not yet live-verified" and tier 'none' means "kept in
 * source but not shipping" — neither should be advertised externally
 * until promoted to 'community' / 'pro'.
 *
 * This test fails the build when a 'dev' or 'none'-tier tool name
 * appears in the public README. The fix is either:
 *   (a) promote the tool to 'community' / 'pro' (after live verification)
 *       — then the mention is legitimate and the test passes; OR
 *   (b) strip the mention from the README until promotion happens.
 *
 * The same guard pattern should exist in editmamei-web (the marketing
 * site). The cross-repo invariant is "no marketing surface mentions a
 * tool that is still 'dev' / 'none' in Editmamei's tool-tiers.ts."
 */
describe('public README leak guard', () => {
  // The npm tarball ships this repo's own README.md — it IS the public
  // README, and the single file this guard scans. (The pre-split export
  // pipeline seeded a second copy onto the public tree; that pipeline is
  // retired, and its seed path retired with it.)
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');

  it("no 'dev'-tier tool name appears in README.md", () => {
    const devTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'dev')
      .map(([name]) => name);
    const leaks = devTools.filter((name) => containsToolName(readme, name));
    expect(
      leaks,
      `'dev'-tier tools found in public README.md: ${leaks.join(', ')}. ` +
        `Either promote them to 'community' / 'pro' (with verification) ` +
        `or strip them from the README until promotion. Mentioning ` +
        `unverified tools tips features that may never ship working.`
    ).toEqual([]);
  });

  it("no 'none'-tier tool name appears in README.md", () => {
    const noneTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'none')
      .map(([name]) => name);
    const leaks = noneTools.filter((name) => containsToolName(readme, name));
    expect(
      leaks,
      `'none'-tier tools found in public README.md: ${leaks.join(', ')}. ` +
        `'none'-tier tools are excluded from every shipped bundle — ` +
        `documenting them in the README advertises functionality that ` +
        `users cannot actually invoke. Strip the README mention, or ` +
        `promote the tool back to 'community' / 'pro' after the underlying ` +
        `issue is resolved.`
    ).toEqual([]);
  });
});

/**
 * The Editmamei skill bundle (skills/editmamei/SKILL.md + companions)
 * ships in the npm tarball and is uploaded by end users to claude.ai.
 * Same invariant as the README: no 'dev' / 'none'-tier tool names allowed.
 * Otherwise the skill tells Claude to invoke tools the user can't actually
 * reach in their CE / Pro build.
 */
describe('skills/ leak guard', () => {
  const skillsDir = join(REPO_ROOT, 'skills');
  const skillFiles = listFilesRecursive(skillsDir).filter((p) => /\.(md|txt)$/i.test(p));

  it('finds at least one skill file (so the test is actually scanning something)', () => {
    expect(
      skillFiles.length,
      'No skill markdown files found under skills/. Either skills/ was deleted or the leak guard would silently pass on an empty scan.'
    ).toBeGreaterThan(0);
  });

  it("no 'dev'-tier tool name appears in any skill file", () => {
    const devTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'dev')
      .map(([name]) => name);
    const leaks: string[] = [];
    for (const file of skillFiles) {
      const content = readFileSync(file, 'utf8');
      for (const name of devTools) {
        if (containsToolName(content, name)) leaks.push(`${file}: ${name}`);
      }
    }
    expect(
      leaks,
      `'dev'-tier tool names found in skills/: ${leaks.join('; ')}. ` +
        `The skill bundle is uploaded by users to claude.ai — referencing a ` +
        `'dev'-tier tool tells Claude to invoke something the user can't ` +
        `actually reach in their CE / Pro build. Either promote the tool or ` +
        `strip the mention.`
    ).toEqual([]);
  });

  it("no 'none'-tier tool name appears in any skill file", () => {
    const noneTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'none')
      .map(([name]) => name);
    const leaks: string[] = [];
    for (const file of skillFiles) {
      const content = readFileSync(file, 'utf8');
      for (const name of noneTools) {
        if (containsToolName(content, name)) leaks.push(`${file}: ${name}`);
      }
    }
    expect(leaks, `'none'-tier tool names found in skills/: ${leaks.join('; ')}.`).toEqual([]);
  });

  // The skill ships once to claude.ai per user. It is therefore visible
  // to both CE and Pro users from the same source file. The invariant
  // adopted 2026-06-08: the skill body MUST NOT name Pro-tier tools or
  // mark anything with "(Pro)" / "Pro-tier" / "Community Edition" /
  // "CE build". CE users seeing Pro tool names in the workflow guidance
  // makes the product feel limited; Pro users discover their Pro tools
  // via tools/list (with full descriptions) without needing prose
  // enumeration. The discovery chain (ping → overview → tools/list)
  // is the canonical path; everything else is workflow narration.
  it("no 'pro'-tier tool name appears in any skill file", () => {
    const proTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'pro')
      .map(([name]) => name);
    const leaks: string[] = [];
    for (const file of skillFiles) {
      const content = readFileSync(file, 'utf8');
      for (const name of proTools) {
        if (containsToolName(content, name)) leaks.push(`${file}: ${name}`);
      }
    }
    expect(
      leaks,
      `'pro'-tier tool names found in skills/: ${leaks.join('; ')}. ` +
        `The skill ships to claude.ai for BOTH CE and Pro users — naming a ` +
        `Pro-only tool tells CE users about features they can't reach. ` +
        `Strip the mention; Pro users discover their Pro tools via tools/list.`
    ).toEqual([]);
  });

  it('no tier markers like "(Pro)" / "Pro-tier" / "Community Edition" appear in any skill file', () => {
    const forbiddenMarkers = [
      '(Pro)',
      'Pro-tier',
      'Pro tier',
      'Community Edition',
      'CE build',
      'CE-only',
      'Pro-only',
    ];
    const leaks: string[] = [];
    for (const file of skillFiles) {
      const content = readFileSync(file, 'utf8');
      for (const marker of forbiddenMarkers) {
        if (content.includes(marker)) leaks.push(`${file}: "${marker}"`);
      }
    }
    expect(
      leaks,
      `Tier markers found in skills/: ${leaks.join('; ')}. ` +
        `The skill must be tier-agnostic — it describes the workflow ` +
        `available in this session; tools/list reveals inventory.`
    ).toEqual([]);
  });

  it('the skill names the discovery primitives so the LLM has a repeatable discovery path', () => {
    // Positive assertion: a session-by-session discovery directive is
    // load-bearing. If a refactor strips it, this test fires before the
    // LLM gets vague workflow guidance with no entry point.
    const fullContent = skillFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(
      fullContent,
      'skill body must reference ps_ping (the liveness check + first call)'
    ).toContain('ps_ping');
    expect(
      fullContent,
      'skill body must reference ps_overview (the workflow brief; second call)'
    ).toContain('ps_overview');
    expect(
      fullContent,
      'skill body must reference tools/list (the authoritative inventory)'
    ).toContain('tools/list');
  });
});

/**
 * docs/ (getting-started.md, faq.md, installation.md, privacy.md,
 * pro-features.md, roadmap.md, and the docs/engineering/ subtree) ships
 * in the npm tarball and is read directly by users and by anyone
 * auditing the public repo on GitHub. Same invariant as the README: no
 * 'dev' / 'none'-tier tool name may appear in any docs markdown file.
 *
 * Only in this repo, though: in the commercial overlay (where this file
 * runs hydrated, detected the same way tool-tiers.test.ts gates its Pro
 * checks), docs/ is internal planning material that legitimately names
 * dev-tier tools and ships nowhere. The scan is gated to the tree whose
 * docs/ is the published surface; CI here enforces it on every change.
 *
 * Note the polarity, which is inverted from every other use of this
 * marker: elsewhere a true marker turns EXTRA Pro checks on (a wrong
 * answer costs coverage in a tree that has its own), here it turns a
 * published-surface guard off. That direction fails open, which is why
 * overlay-detection-guard.test.ts cross-checks the marker unconditionally.
 */
describe.skipIf(HYDRATED_OVERLAY)('docs/ leak guard', () => {
  const docsDir = join(REPO_ROOT, 'docs');
  const docFiles = listFilesRecursive(docsDir).filter((p) => /\.md$/i.test(p));

  it('finds at least one docs file (so the test is actually scanning something)', () => {
    expect(
      docFiles.length,
      'No markdown files found under docs/. Either docs/ was deleted or the leak guard would silently pass on an empty scan.'
    ).toBeGreaterThan(0);
  });

  it("no 'dev'-tier tool name appears in any docs file", () => {
    const devTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'dev')
      .map(([name]) => name);
    const leaks: string[] = [];
    for (const file of docFiles) {
      const content = readFileSync(file, 'utf8');
      for (const name of devTools) {
        if (containsToolName(content, name)) leaks.push(`${file}: ${name}`);
      }
    }
    expect(
      leaks,
      `'dev'-tier tool names found in docs/: ${leaks.join('; ')}. ` +
        `docs/ ships in the npm tarball and is read directly by users — ` +
        `mentioning a 'dev'-tier tool documents something the user can't ` +
        `actually invoke. Either promote the tool to 'community' / 'pro' ` +
        `(after live verification) or strip the mention until promotion.`
    ).toEqual([]);
  });

  it("no 'none'-tier tool name appears in any docs file", () => {
    const noneTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'none')
      .map(([name]) => name);
    const leaks: string[] = [];
    for (const file of docFiles) {
      const content = readFileSync(file, 'utf8');
      for (const name of noneTools) {
        if (containsToolName(content, name)) leaks.push(`${file}: ${name}`);
      }
    }
    expect(leaks, `'none'-tier tool names found in docs/: ${leaks.join('; ')}.`).toEqual([]);
  });
});

/**
 * The ps_overview tool's markdown body ships in dist/ as part of
 * both CE and Pro bundles (the tool is 'community' tier). It is
 * returned verbatim to the LLM when called. Same invariant as the
 * skill: must not name non-community tools or include tier markers,
 * because CE users will read it and think tools they don't have are
 * available.
 *
 * The overview is also the single anchor for the workflow-guidance
 * discovery chain — `tools/list` should be named explicitly so the
 * LLM always knows how to enumerate its actual inventory.
 */
describe('overview tool markdown leak guard', () => {
  it("no 'dev'-tier tool name appears in OVERVIEW_MARKDOWN", () => {
    const devTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'dev')
      .map(([name]) => name);
    const leaks = devTools.filter((name) => containsToolName(OVERVIEW_MARKDOWN, name));
    expect(
      leaks,
      `'dev'-tier tool names found in OVERVIEW_MARKDOWN: ${leaks.join(', ')}. ` +
        `Dev-tier tools are excluded from shipped CE + Pro bundles — ` +
        `mentioning them in the overview tells the LLM about tools the ` +
        `user can't actually invoke.`
    ).toEqual([]);
  });

  it("no 'none'-tier tool name appears in OVERVIEW_MARKDOWN", () => {
    const noneTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'none')
      .map(([name]) => name);
    const leaks = noneTools.filter((name) => containsToolName(OVERVIEW_MARKDOWN, name));
    expect(
      leaks,
      `'none'-tier tool names found in OVERVIEW_MARKDOWN: ${leaks.join(', ')}.`
    ).toEqual([]);
  });

  it("no 'pro'-tier tool name appears in OVERVIEW_MARKDOWN", () => {
    const proTools = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'pro')
      .map(([name]) => name);
    const leaks = proTools.filter((name) => containsToolName(OVERVIEW_MARKDOWN, name));
    expect(
      leaks,
      `'pro'-tier tool names found in OVERVIEW_MARKDOWN: ${leaks.join(', ')}. ` +
        `The overview ships in CE — naming Pro tools tells CE users about ` +
        `features they can't reach. Pro users discover their Pro tools via ` +
        `tools/list (with full descriptions) without overview prose.`
    ).toEqual([]);
  });

  it('no tier markers like "(Pro)" / "Pro-tier" appear in OVERVIEW_MARKDOWN', () => {
    const forbiddenMarkers = [
      '(Pro)',
      'Pro-tier',
      'Pro tier',
      'Community Edition',
      'CE build',
      'CE-only',
      'Pro-only',
    ];
    const leaks = forbiddenMarkers.filter((m) => OVERVIEW_MARKDOWN.includes(m));
    expect(
      leaks,
      `Tier markers in OVERVIEW_MARKDOWN: ${leaks.join(', ')}. ` +
        `Overview is workflow guidance; tools/list is inventory. ` +
        `Tier annotations belong in neither.`
    ).toEqual([]);
  });

  it('OVERVIEW_MARKDOWN names the discovery primitives (ping + tools/list)', () => {
    expect(
      OVERVIEW_MARKDOWN,
      'overview must reference ps_ping (the liveness check that anchors the discovery chain)'
    ).toContain('ps_ping');
    expect(
      OVERVIEW_MARKDOWN,
      'overview must reference tools/list (the authoritative inventory) so the LLM knows where to enumerate available tools'
    ).toContain('tools/list');
  });
});

/**
 * CE tool surface — runtime leak guard (added 2026-06-09 in v0.7.2;
 * strengthened 2026-08-28).
 *
 * The 2026-06-09 Mac CE session surfaced a real leak: `ps_ping`'s
 * description contained "ps_list_actions / play_action are worth
 * exploring" — both Pro-tier — which the LLM read out of `tools/list`,
 * dutifully searched for, and reported as missing. Same pattern in
 * `ps_template_list`'s empty-state message ("Create one with
 * ps_template_create_evidence + ps_template_save", both
 * Pro) and `photoshop_invert_selection`'s description ("`ps_select_subject`
 * (Pro) → invert"). None were caught by the existing README / skill /
 * overview scans because tool-description text wasn't being scanned.
 *
 * This block enumerates every CE-tier factory's tool descriptions AND every
 * `description` string nested in each tool's `inputSchema` / `outputSchema` /
 * `annotations.title` (all ship in the same tools/list payload an LLM
 * reads), and asserts none names a non-community-tier tool. A 2026-08-28
 * audit found this block had gone stale in two ways: the factory list below
 * was a hand copy of `ce/index.ts`'s `ceFactories` that drifted to 18
 * entries against the module's real 28 (+ the separately-registered scene
 * factory) — 11 factories' tool descriptions were never scanned — and the
 * scan only ever looked at `tool.description`, never `inputSchema` property
 * descriptions, so a leak like `PLACEMENT_SCHEMA` naming
 * `ps_resolve_placement` (pro) in its own property descriptions reached CE
 * users' tools/list undetected. The factory list is now derived from
 * `ceFactories` itself instead of hand-copied, and the scan recurses into
 * `inputSchema`. A follow-up 2026-08-28 QA pass on that fix found the new
 * scan path itself untested and its floor check weaker than the one it
 * replaced; extended the walk to `outputSchema` + `annotations.title`, added
 * `collectDescriptions` unit coverage plus an end-to-end synthetic-leak
 * control, and replaced the size-based floor with a name-set completeness
 * check (see below).
 */
import { ceFactories } from '@editmamei/modules/ce/index.ts';
import { createSceneTools } from '@editmamei/tools/scene-tools.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { isToolAllowedInEdition, toolsInTier } from '@editmamei/core/tool-tiers.ts';

const SCHEMA_WALK_MAX_DEPTH = 50;

/**
 * Recursively collects every string value keyed `description` anywhere in a
 * JSON-Schema tree — properties, nested objects, array `items`, oneOf/anyOf
 * branches, all of it. `inputSchema` / `outputSchema` ship in the same
 * tools/list payload the LLM reads, so a tool-name leak buried in a nested
 * property description is exactly as live as one in `tool.description`
 * itself.
 *
 * `ancestors` tracks the CURRENT recursion path (added on entry, removed on
 * exit via backtracking), not every node ever visited — that distinction
 * matters because a schema can legitimately reuse the same object reference
 * from two different branches (a diamond, not a cycle; e.g. two sibling
 * properties pointing at a shared sub-schema constant), and a global
 * seen-forever set would misreport that as cyclic. A node that is its own
 * ancestor, though, IS a real cycle — no JSON Schema in this codebase should
 * ever be shaped that way, so throwing a clear error beats either silently
 * truncating the scan (a security-relevant silent failure, given what this
 * guard exists to catch) or crashing with an opaque `RangeError: Maximum
 * call stack size exceeded`. The depth cap is the same fail-legibly
 * philosophy applied as a backstop against runaway (not necessarily cyclic)
 * nesting.
 */
function collectDescriptions(
  node: unknown,
  out: string[] = [],
  ancestors: Set<object> = new Set(),
  depth = 0
): string[] {
  if (depth > SCHEMA_WALK_MAX_DEPTH) {
    throw new Error(
      `collectDescriptions: exceeded max walk depth (${SCHEMA_WALK_MAX_DEPTH}) — the schema is ` +
        `either implausibly deep or cyclic. Investigate rather than raising the cap.`
    );
  }
  if (node !== null && typeof node === 'object') {
    if (ancestors.has(node)) {
      throw new Error(
        'collectDescriptions: cyclic schema detected (a node reachable from itself). No real ' +
          'JSON Schema in this codebase should be cyclic — check for an accidental self reference.'
      );
    }
    ancestors.add(node);
    try {
      if (Array.isArray(node)) {
        for (const item of node) collectDescriptions(item, out, ancestors, depth + 1);
      } else {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === 'description' && typeof value === 'string') {
            out.push(value);
          } else {
            collectDescriptions(value, out, ancestors, depth + 1);
          }
        }
      }
    } finally {
      ancestors.delete(node);
    }
  }
  return out;
}

/** One string the LLM can read via tools/list, plus a label identifying
 *  where it came from (for leak-message diagnostics). */
interface ScanTarget {
  name: string;
  description: string;
}

/**
 * Builds every scan target for one MCP tool definition: its own top-level
 * `description`, plus one target per `description` string recursively found
 * in `inputSchema`, `outputSchema`, and `annotations.title` — all four ship
 * in the same tools/list payload the LLM reads. Shared by the real CE scan
 * below and by the synthetic end-to-end tests, so a test exercising this
 * function is exercising the actual pipeline, not a parallel reimplementation
 * of it.
 */
function scanTargetsForTool(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: { title?: string };
}): ScanTarget[] {
  const targets: ScanTarget[] = [{ name: tool.name, description: tool.description ?? '' }];
  for (const description of collectDescriptions(tool.inputSchema)) {
    targets.push({ name: `${tool.name} (inputSchema)`, description });
  }
  for (const description of collectDescriptions(tool.outputSchema)) {
    targets.push({ name: `${tool.name} (outputSchema)`, description });
  }
  if (tool.annotations?.title) {
    targets.push({ name: `${tool.name} (annotations.title)`, description: tool.annotations.title });
  }
  return targets;
}

/**
 * Finds every (target, blockedName) pair where `blockedName` appears,
 * word-boundary matched, in `target.description`. Shared by the real CE
 * scan and the synthetic end-to-end tests for the same reason as
 * `scanTargetsForTool` above.
 */
function findToolNameLeaks(targets: ScanTarget[], blockedNames: string[]): string[] {
  const leaks: string[] = [];
  for (const t of targets) {
    for (const name of blockedNames) {
      if (containsToolName(t.description, name)) {
        leaks.push(`${t.name} description → ${name}`);
      }
    }
  }
  return leaks;
}

/**
 * Confirmed HIGH finding (2026-08-28 QA pass): the schema-walk scan path
 * itself — `collectDescriptions` and its wiring into scan targets — had no
 * tests. The positive controls above only ever exercised `containsToolName`,
 * which was already covered before this pass; nothing proved the WALKER
 * finds nested descriptions, or that a leak buried in one actually surfaces
 * as a leak entry through the real pipeline.
 */
describe('collectDescriptions (schema walker)', () => {
  it('collects every description string from a nested schema — properties, array items, oneOf/anyOf branches', () => {
    const schema = {
      type: 'object',
      description: 'top-level',
      properties: {
        a: { type: 'string', description: 'plain property' },
        b: {
          type: 'array',
          description: 'array property',
          items: {
            type: 'object',
            description: 'array item',
            properties: {
              c: { type: 'string', description: 'nested inside an item' },
            },
          },
        },
        d: {
          oneOf: [
            { type: 'string', description: 'oneOf branch 1' },
            { type: 'number', description: 'oneOf branch 2' },
          ],
        },
        e: {
          anyOf: [{ type: 'string', description: 'anyOf branch' }],
        },
        // A property with no description at all must not blow up the walk
        // or contribute a spurious entry.
        f: { type: 'boolean' },
      },
    };
    expect(collectDescriptions(schema).sort()).toEqual(
      [
        'top-level',
        'plain property',
        'array property',
        'array item',
        'nested inside an item',
        'oneOf branch 1',
        'oneOf branch 2',
        'anyOf branch',
      ].sort()
    );
  });

  it('does NOT misreport a diamond (the same sub-schema object reused from two sibling branches) as cyclic', () => {
    const shared = { type: 'object', description: 'shared sub-schema' };
    const schema = {
      type: 'object',
      properties: {
        start: shared,
        end: shared,
      },
    };
    expect(collectDescriptions(schema)).toEqual(['shared sub-schema', 'shared sub-schema']);
  });

  it('throws a legible error on a genuinely cyclic schema instead of a RangeError', () => {
    const cyclic: Record<string, unknown> = { type: 'object', description: 'root' };
    cyclic.properties = { self: cyclic };
    expect(() => collectDescriptions(cyclic)).toThrow(/cyclic schema detected/);
  });
});

/**
 * End-to-end negative control (the other half of the same HIGH finding): a
 * synthetic tool whose `inputSchema` embeds a blocked name in a NESTED
 * property description must actually produce a leak entry when run through
 * `scanTargetsForTool` + `findToolNameLeaks` — the exact two functions the
 * real CE scan below calls. This proves the pipeline, not just the matcher
 * `containsToolName` already covers above.
 */
describe('CE schema-leak scan pipeline (end-to-end synthetic control)', () => {
  it('a blocked name buried in a nested inputSchema property description surfaces as a leak', () => {
    const fakeTool = {
      name: 'ps_fake_synthetic_tool',
      description: 'A synthetic community tool for the end-to-end pipeline test.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'object',
            description: 'Same vocabulary as ps_resolve_placement.',
          },
        },
      },
    };
    const targets = scanTargetsForTool(fakeTool);
    const leaks = findToolNameLeaks(targets, ['ps_resolve_placement']);
    expect(leaks).toEqual([
      'ps_fake_synthetic_tool (inputSchema) description → ps_resolve_placement',
    ]);
  });

  it('a blocked name buried in a nested outputSchema property description surfaces as a leak', () => {
    const fakeTool = {
      name: 'ps_fake_synthetic_tool',
      description: 'A synthetic community tool for the end-to-end pipeline test.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            description: 'Resolved the same way ps_apply_brush_stroke would.',
          },
        },
      },
    };
    const targets = scanTargetsForTool(fakeTool);
    const leaks = findToolNameLeaks(targets, ['ps_apply_brush_stroke']);
    expect(leaks).toEqual([
      'ps_fake_synthetic_tool (outputSchema) description → ps_apply_brush_stroke',
    ]);
  });

  it('a blocked name in annotations.title surfaces as a leak', () => {
    const fakeTool = {
      name: 'ps_fake_synthetic_tool',
      description: 'A synthetic community tool for the end-to-end pipeline test.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'Like ps_resolve_placement, but synthetic' },
    };
    const targets = scanTargetsForTool(fakeTool);
    const leaks = findToolNameLeaks(targets, ['ps_resolve_placement']);
    expect(leaks).toEqual([
      'ps_fake_synthetic_tool (annotations.title) description → ps_resolve_placement',
    ]);
  });

  it('a clean synthetic tool (no blocked names anywhere) produces no leaks', () => {
    const fakeTool = {
      name: 'ps_fake_synthetic_tool',
      description: 'Uses ps_select, a real community-tier name, which must not be flagged.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'A plain, tier-agnostic description.' },
        },
      },
    };
    const targets = scanTargetsForTool(fakeTool);
    const leaks = findToolNameLeaks(targets, ['ps_resolve_placement', 'ps_apply_brush_stroke']);
    expect(leaks).toEqual([]);
  });
});

describe('CE tool surface leak guard', () => {
  const conn = makeConnection().asConnection();
  const sc = makeSnippetClient();

  // Derived straight from the module (src/modules/ce/index.ts) instead of a
  // hand-copied list — the earlier hand list drifted to 18 of the module's
  // real 28 factories, so 11 factories' worth of tool descriptions were
  // never scanned. Pro-only factories (selection-tools-pro, preview-tools-
  // pro, action-tools-pro, template-tools-pro) are still correctly excluded
  // because they're registered by the Pro module, not `ceFactories`.
  const ceCandidates = ceFactories.flatMap((f) => f(conn, sc));
  // createSceneTools is registered separately in ce/index.ts's register()
  // — it needs host.invokeTool (the cross-module broker), which the generic
  // (connection, snippetClient) factory shape the rest of ceFactories share
  // can't supply. Mirror that split here rather than folding it into
  // ceFactories. Pass the SAME broker shape ce/index.ts:129 actually passes
  // (a real function, not undefined) — none of scene-tools.ts's returned
  // tool descriptions branch on it today, but if a future edit ever makes a
  // description conditional on Pro-refine availability, this scan should see
  // the production text variant, not the CE-fallback one.
  const sceneInvokeTool = async () => ({ content: [{ type: 'text' as const, text: 'unused' }] });
  const sceneCandidates = createSceneTools(conn, sc, { invokeTool: sceneInvokeTool });

  it('scans every factory ce/index.ts itself registers (secondary regression guard; see the name-set completeness check below for the primary one)', () => {
    // ce/index.ts has 28 CE-tier factories today. This is a floor, not an
    // exact pin, so adding a factory there doesn't require touching this
    // test — but a collapse (e.g. a broken import silently yielding an
    // empty or truncated array) fails loudly instead of the old bug, where
    // a stale 18-factory hand list comfortably cleared the anti-vacuity
    // floor below and the drift was invisible.
    expect(ceFactories.length).toBeGreaterThanOrEqual(28);
  });

  // Apply the CE-edition tier filter as defense in depth — community
  // factories should already register only community tools, but if a
  // dev-tier tool shipped without being moved out, the filter catches
  // it before scanning.
  const ceTools = [...ceCandidates, ...sceneCandidates].filter((def) =>
    isToolAllowedInEdition(def.tool.name, 'community')
  );

  // 'community' classified ambient tools (registered directly in server.ts
  // rather than through a ceFactories entry) live in the server source, not
  // as importable ToolDefinition values — `EditmameiServer` builds them
  // inline inside its constructor. ps_ping and ps_list_capabilities are the
  // two: `toolsInTier('community')` names a third, ps_report_problem, but
  // that one IS wired through `createDiagnosticsTools` in ceFactories, so it
  // needs no special-casing here.
  const serverSrc = readFileSync(join(REPO_ROOT, 'src', 'core', 'server.ts'), 'utf8');
  const AMBIENT_TOOL_NAMES = ['ps_ping', 'ps_list_capabilities'] as const;
  /**
   * Extracts the raw source text of an ambient tool's registration block —
   * from its `name: 'ps_x'` through the next `handler:` — and returns it as
   * ONE scan target. Deliberately widened to the WHOLE block (description +
   * inputSchema + outputSchema + annotations, whatever the tool declares)
   * rather than picking `description` out with its own dedicated regex per
   * field: unlike a real `Tool` object built through a factory, there's
   * nothing here to hand to `scanTargetsForTool` — reading the literal
   * source is the only option, so reading all of it in one pass is both
   * simpler and can't develop the same kind of coverage gap the walker
   * itself was strengthened against (a field silently going unscanned).
   */
  function extractAmbientToolBlock(name: string): string {
    const match = serverSrc.match(new RegExp(`name:\\s*'${name}'[\\s\\S]*?\\n\\s*handler:`));
    // Sanity-check the match — if extraction breaks, the test would
    // silently pass on an empty scan; fail loudly instead.
    if (!match) {
      throw new Error(
        `CE leak guard: could not extract the '${name}' registration block from server.ts. ` +
          `Update the extraction regex to match the current source.`
      );
    }
    return match[0];
  }
  const ambientTargets: ScanTarget[] = AMBIENT_TOOL_NAMES.map((name) => ({
    name,
    description: extractAmbientToolBlock(name),
  }));
  const scanTargets: ScanTarget[] = [
    ...ambientTargets,
    ...ceTools.flatMap((def) => scanTargetsForTool(def.tool)),
  ];

  const nonCommunityNames = Object.entries(TOOL_TIERS)
    .filter(([, tier]) => tier !== 'community')
    .map(([name]) => name);

  it('no CE-visible tool description names a non-community-tier tool', () => {
    const leaks = findToolNameLeaks(scanTargets, nonCommunityNames);
    expect(
      leaks,
      `Pro / dev / none tier tool names referenced from CE tool descriptions:\n  ` +
        leaks.join('\n  ') +
        `\nCE users read these descriptions via tools/list — naming a tool ` +
        `they cannot reach makes the product feel incomplete and invites ` +
        `the LLM to search for tools that aren't there. Rephrase the ` +
        `description to be tier-agnostic ("if X is available in this build, ` +
        `it will appear in tools/list").`
    ).toEqual([]);
  });

  it('no CE-visible tool description includes tier markers like "(Pro)"', () => {
    const forbiddenMarkers = [
      '(Pro)',
      'Pro-tier',
      'Pro tier',
      'Community Edition',
      'CE build',
      'CE-only',
      'Pro-only',
    ];
    const leaks: string[] = [];
    for (const t of scanTargets) {
      for (const m of forbiddenMarkers) {
        if (t.description.includes(m)) leaks.push(`${t.name} description → "${m}"`);
      }
    }
    expect(
      leaks,
      `Tier markers found in CE tool descriptions:\n  ` +
        leaks.join('\n  ') +
        `\nDescriptions read by the LLM via tools/list should be tier-agnostic.`
    ).toEqual([]);
  });

  it('every community-tier tool name is actually reachable by the CE scan (name-set completeness)', () => {
    // Replaces the earlier "scanTargets.length >= N" anti-vacuity floor,
    // which the 2026-08-28 QA pass flagged as LOOSER than the magic-40 it
    // replaced: once the walker recurses into inputSchema, scanTargets
    // counts every nested description (hundreds), not one-per-tool — a
    // factory-wiring collapse to a couple of factories could still clear
    // any plausible size floor and stay green. A name-set difference is
    // immune to that: it asks the actual question ("did every community
    // tool get scanned at all"), not a proxy question about volume.
    //
    // The ambient tools are the allowed exception — community-tier but
    // registered directly in server.ts rather than via a ceFactories entry
    // — so they're added to the reachable set explicitly (they're already
    // scanned above, via `ambientTargets`; this just tells the completeness
    // check they don't need to come from `ceTools`).
    const reachableNames = new Set<string>([
      ...ceTools.map((def) => def.tool.name),
      ...AMBIENT_TOOL_NAMES,
    ]);
    const communityNames = toolsInTier('community');
    const missing = communityNames.filter((name) => !reachableNames.has(name));
    expect(
      missing,
      `community-tier tools missing from the CE leak-guard scan: ${missing.join(', ')} — ` +
        `check factory wiring in ce/index.ts / ceFactories.`
    ).toEqual([]);
  });
});
