import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';
import { OVERVIEW_MARKDOWN } from '@editmamei/tools/overview-tools.ts';

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
 * substring matching. Several Pro tools have community-tier siblings
 * whose names contain them as prefixes — e.g. `photoshop_move_layer`
 * (Pro) is a substring of `ps_move_layer_to_group` (community).
 * Plain `content.includes(proName)` false-positives on the community
 * sibling. This helper escapes regex metacharacters and matches only
 * when the next character is NOT an identifier char (letter / digit /
 * underscore).
 */
function containsToolName(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped + '(?![A-Za-z0-9_])');
  return re.test(content);
}

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
 */
const HYDRATED_OVERLAY = existsSync(join(REPO_ROOT, 'src', 'modules', 'pro', 'index.ts'));

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
 * CE tool surface — runtime leak guard (added 2026-06-09 in v0.7.2).
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
 * This block enumerates every CE-tier factory's tool descriptions and
 * asserts no description names a non-community-tier tool. Captures any
 * future tier-name leak in any CE tool description.
 */
import { createDocumentTools } from '@editmamei/tools/document-tools.ts';
import { createLayerTools } from '@editmamei/tools/layer-tools.ts';
import { createGroupTools } from '@editmamei/tools/group-tools.ts';
import { createImageTools } from '@editmamei/tools/image-tools.ts';
import { createImagePlacementTools } from '@editmamei/tools/image-placement-tools.ts';
import { createLayerPropertiesTools } from '@editmamei/tools/layer-properties-tools.ts';
import { createFilterTools } from '@editmamei/tools/filter-tools.ts';
import { createAdjustmentTools } from '@editmamei/tools/adjustment-tools.ts';
import { createTextTools } from '@editmamei/tools/text-tools.ts';
import { createSelectionTools } from '@editmamei/tools/selection-tools.ts';
import { createHistoryTools } from '@editmamei/tools/history-tools.ts';
import { createLayerOrderingTools } from '@editmamei/tools/layer-ordering-tools.ts';
import { createPreviewTools } from '@editmamei/tools/preview-tools.ts';
import { createInspectTools } from '@editmamei/tools/inspect-tools.ts';
import { createOverviewTools } from '@editmamei/tools/overview-tools.ts';
import { createBrushTools } from '@editmamei/tools/brush-tools.ts';
import { createLayerTransformTools } from '@editmamei/tools/layer-transform-tools.ts';
import { createRetouchTools } from '@editmamei/tools/retouch-tools.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { isToolAllowedInEdition } from '@editmamei/core/tool-tiers.ts';

describe('CE tool surface leak guard', () => {
  const conn = makeConnection().asConnection();
  const sc = makeSnippetClient();
  // Enumerate every factory whose tools could land in CE. Pro-only
  // factories (selection-tools-pro, preview-tools-pro, action-tools-pro,
  // template-tools-pro) are excluded — their content is stripped at build
  // time for the CE bundle and never reaches CE users. As of the 2026-06-16
  // The layer-transform + retouch surfaces are community-tier
  // (included below) and the whole template surface is Pro (excluded).
  const ceCandidates = [
    ...createDocumentTools(conn, sc),
    ...createLayerTools(conn, sc),
    ...createGroupTools(conn, sc),
    ...createImageTools(conn, sc),
    ...createImagePlacementTools(conn, sc),
    ...createLayerPropertiesTools(conn, sc),
    ...createLayerTransformTools(conn, sc),
    ...createFilterTools(conn, sc),
    ...createAdjustmentTools(conn, sc),
    ...createTextTools(conn, sc),
    ...createSelectionTools(conn, sc),
    ...createHistoryTools(conn, sc),
    ...createLayerOrderingTools(conn, sc),
    ...createPreviewTools(conn, sc),
    ...createInspectTools(conn, sc),
    ...createOverviewTools(conn, sc),
    ...createRetouchTools(conn, sc),
    ...createBrushTools(conn, sc),
  ];
  // Apply the CE-edition tier filter as defense in depth — community
  // factories should already register only community tools, but if a
  // dev-tier tool shipped without being moved out, the filter catches
  // it before scanning.
  const ceTools = ceCandidates.filter((def) => isToolAllowedInEdition(def.tool.name, 'community'));

  // 'community' classified ambient tools (like ps_ping registered
  // directly in server.ts) live in the server source. Read the ping
  // description string the same way we read README content above.
  const serverSrc = readFileSync(join(REPO_ROOT, 'src', 'core', 'server.ts'), 'utf8');
  // Extract the ping description string between description: ... and the
  // following comma. Stops at the first `,` outside of escaped quotes.
  const pingDescriptionMatch = serverSrc.match(
    /name:\s*'ps_ping'[\s\S]*?description:\s*((?:'[^']*'|"(?:\\.|[^"\\])*")(?:\s*\+\s*(?:'[^']*'|"(?:\\.|[^"\\])*"))*)/
  );
  const pingDescription = pingDescriptionMatch
    ? // Evaluate the JS-literal-or-concat into a plain string.
      pingDescriptionMatch[1]
        .split(/\s*\+\s*/)
        .map((s) => s.replace(/^['"]|['"]$/g, ''))
        .join('')
    : '';
  // Sanity-check the match — if extraction breaks, the test silently
  // passes; fail loudly instead.
  if (!pingDescription) {
    throw new Error(
      'CE leak guard: could not extract ps_ping description from server.ts. ' +
        'Update the extraction regex to match the current source.'
    );
  }
  // Treat ping like any other CE-visible tool definition for scanning.
  const scanTargets: { name: string; description: string }[] = [
    { name: 'ps_ping', description: pingDescription },
    ...ceTools.map((def) => ({
      name: def.tool.name,
      description: def.tool.description ?? '',
    })),
  ];

  const nonCommunityNames = Object.entries(TOOL_TIERS)
    .filter(([, tier]) => tier !== 'community')
    .map(([name]) => name);

  it('no CE-visible tool description names a non-community-tier tool', () => {
    const leaks: string[] = [];
    for (const t of scanTargets) {
      for (const name of nonCommunityNames) {
        if (containsToolName(t.description, name)) {
          leaks.push(`${t.name} description → ${name}`);
        }
      }
    }
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

  it('CE scan covers at least 40 tools (sanity check the enumeration)', () => {
    // If a factory import path breaks, scanTargets shrinks silently —
    // pin a floor so a broken scan can't silently let leaks through.
    expect(
      scanTargets.length,
      'CE leak guard scan target count dropped below 40 — check factory imports'
    ).toBeGreaterThanOrEqual(40);
  });
});
