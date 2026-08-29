import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditmameiServer } from '@editmamei/core/server.ts';
import { TOOL_TIERS, isToolAllowedInEdition, tierOf } from '@editmamei/core/tool-tiers.ts';
import { TOOL_GROUPS } from '@editmamei/core/tool-groups.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

// Every `new EditmameiServer()` below builds its own SessionLog with no `dir`
// override — redirect it to a per-test temp dir so this file's constructions
// never write real NDJSON into the user's ~/.editmamei/sessions/.
useSessionLogSandbox();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
// Pro tool sources aren't part of every checkout of this repo (Pro ships as
// a separate module loaded at runtime). Without it, loadModules() never
// registers the Pro-tier entries, so TOOL_TIERS' Pro entries would all read
// as orphans — gate the orphan check behind Pro actually being loadable.
const PRO_SOURCES_PRESENT = existsSync(join(REPO_ROOT, 'src', 'modules', 'pro', 'index.ts'));
const proIt = PRO_SOURCES_PRESENT ? it : it.skip;

/**
 * Tier entries that are deliberately NOT registered by any current factory,
 * and are therefore exempt from the orphan check below.
 *
 * These four names are retired warp variants. The classification tables have
 * to outlive the tools by one release: the module that registers them is
 * downloaded, and a newly fetched one only takes effect on the NEXT boot, so
 * a host on this version can be paired with a previously-installed module
 * that still registers all four. `tierOf`/`groupOf` throw on an unknown name
 * and `assertToolsClassified()` runs them over the whole registered surface
 * at startup, so dropping the rows early turns that pairing into a fatal boot
 * failure rather than a missing tool.
 *
 * This list, the `tool-tiers.ts` rows, and their `tool-groups.ts`
 * counterparts are deleted together, once no supported module registers
 * these names. The allowance is an explicit name list on purpose — any OTHER
 * orphan still fails.
 */
const TRANSITION_ORPHANS = new Set([
  'ps_warp_layer_mesh',
  'ps_warp_layer_along',
  'ps_warp_layer_region',
  'ps_warp_layer_to',
]);

/**
 * Pins the contract between the live tool surface and the tier-classification
 * table. The classification is the single source of truth for which tools
 * end up in each build bundle — drift here would silently leak tools into
 * the wrong edition.
 */
describe('TOOL_TIERS classification table', () => {
  it('classifies every registered tool', async () => {
    const server = new EditmameiServer() as unknown as {
      toolRegistry: { list(): Array<{ name: string }> };
      loadModules(): Promise<void>;
    };
    // Pro is a downloaded module loaded via dynamic import; pull it in so the
    // assertion covers the FULL live surface (CE built-in + Pro), not just CE.
    await server.loadModules();
    const registered = server.toolRegistry.list().map((t) => t.name);
    const missing = registered.filter((name) => !(name in TOOL_TIERS));
    expect(missing, `Registered tools missing a tier-tiers entry: ${missing.join(', ')}`).toEqual(
      []
    );
  });

  proIt(
    'has no orphan entries (every entry corresponds to a real tool factory output)',
    async () => {
      // Enumerate the full universe of tools (regardless of edition) by
      // temporarily marking every entry community so the tier gate lets all
      // of them through registration. Restore the table in finally so the
      // other tests see the canonical classification.
      const saved = { ...TOOL_TIERS };
      try {
        for (const name of Object.keys(TOOL_TIERS)) {
          TOOL_TIERS[name] = 'community';
        }
        const server = new EditmameiServer() as unknown as {
          toolRegistry: { list(): Array<{ name: string }> };
          loadModules(): Promise<void>;
        };
        // Pro tools come from the downloaded module (dynamic import); load it so
        // the orphan check sees the full registered surface.
        await server.loadModules();
        const registered = new Set(server.toolRegistry.list().map((t) => t.name));
        const orphans = Object.keys(saved).filter(
          (name) => !registered.has(name) && !TRANSITION_ORPHANS.has(name)
        );
        expect(orphans, `Orphan TOOL_TIERS entries: ${orphans.join(', ')}`).toEqual([]);
      } finally {
        for (const name of Object.keys(TOOL_TIERS)) delete TOOL_TIERS[name];
        Object.assign(TOOL_TIERS, saved);
      }
    }
  );

  // The allowance must not outlive the rows it covers. A name left in the set
  // after its tier row is gone is a permanent, invisible hole in the orphan
  // check — this runs in every checkout, including ones that skip the check
  // above. Also pins the `tool-groups.ts` counterpart: `groupOf()` throws at
  // boot on an unknown name exactly like `tierOf()` does, so a tier row kept
  // without its group row would be just as fatal a boot failure.
  it('every transition-orphan allowance still names a live TOOL_TIERS and TOOL_GROUPS entry', () => {
    for (const name of TRANSITION_ORPHANS) {
      expect(
        Object.keys(TOOL_TIERS),
        `${name} is allowed as a transition orphan but has no tier row`
      ).toContain(name);
      expect(
        Object.keys(TOOL_GROUPS),
        `${name} is allowed as a transition orphan but has no group row`
      ).toContain(name);
    }
  });

  it('classifies every entry as a valid Tier value', () => {
    for (const [name, tier] of Object.entries(TOOL_TIERS)) {
      expect(['community', 'pro', 'none', 'dev'], `${name} has invalid tier ${tier}`).toContain(
        tier
      );
    }
  });

  it('tierOf throws for unknown tool names', () => {
    expect(() => tierOf('photoshop_definitely_not_a_real_tool')).toThrow(
      /no entry in src\/core\/tool-tiers\.ts/
    );
  });

  it('tierOf returns the matching tier for known tools', () => {
    expect(tierOf('ps_ping')).toBe('community');
  });

  // Promotion out of 'dev' is a user decision backed by live evidence, so a
  // silent revert is a real regression rather than a formatting slip. Pinned
  // per tool because the generic checks above pass at any tier.
  it('keeps the user-authorized promotions at community tier', () => {
    expect(tierOf('ps_document')).toBe('community');
    expect(tierOf('ps_replace_sky')).toBe('community');
  });

  // Parked deliberately: it needs aiming precision no tier can supply yet, and
  // it folds into ps_select as mode=focus_area whenever it does promote.
  it('keeps ps_select_focus_area at dev tier', () => {
    expect(tierOf('ps_select_focus_area')).toBe('dev');
  });
});

describe('isToolAllowedInEdition (the registration gate)', () => {
  it('Pro builds accept every community + pro tool (skips dev + none)', () => {
    for (const [name, tier] of Object.entries(TOOL_TIERS)) {
      if (tier === 'none' || tier === 'dev') continue;
      expect(isToolAllowedInEdition(name, 'pro')).toBe(true);
    }
  });

  it('Community builds accept community-tier tools', () => {
    expect(isToolAllowedInEdition('ps_ping', 'community')).toBe(true);
  });

  it('Community builds reject pro-tier tools', () => {
    const original = TOOL_TIERS.ps_ping;
    try {
      TOOL_TIERS.ps_ping = 'pro';
      expect(isToolAllowedInEdition('ps_ping', 'community')).toBe(false);
      expect(isToolAllowedInEdition('ps_ping', 'pro')).toBe(true);
      expect(isToolAllowedInEdition('ps_ping', 'dev')).toBe(true);
    } finally {
      TOOL_TIERS.ps_ping = original;
    }
  });

  it("'none'-tier tools are excluded from EVERY edition (community + pro + dev)", () => {
    // 'none' is the "keep in source, never expose" tier — known-broken
    // tools, deprecation-window tools, etc. Excluded even from dev.
    const original = TOOL_TIERS.ps_ping;
    try {
      TOOL_TIERS.ps_ping = 'none';
      expect(isToolAllowedInEdition('ps_ping', 'community')).toBe(false);
      expect(isToolAllowedInEdition('ps_ping', 'pro')).toBe(false);
      expect(isToolAllowedInEdition('ps_ping', 'dev')).toBe(false);
    } finally {
      TOOL_TIERS.ps_ping = original;
    }
  });

  it("'dev'-tier tools are visible ONLY in the dev edition; excluded from CE + Pro builds", () => {
    // 'dev' is the default landing zone for new tools — visible in local
    // dev runs (where EDITION='dev', the committed default) so the dev
    // can verify them, but invisible in shipped CE/Pro bundles until
    // promoted. This is the "untested tool can't accidentally ship"
    // guarantee.
    const original = TOOL_TIERS.ps_ping;
    try {
      TOOL_TIERS.ps_ping = 'dev';
      expect(isToolAllowedInEdition('ps_ping', 'dev')).toBe(true);
      expect(isToolAllowedInEdition('ps_ping', 'community')).toBe(false);
      expect(isToolAllowedInEdition('ps_ping', 'pro')).toBe(false);
    } finally {
      TOOL_TIERS.ps_ping = original;
    }
  });

  it("'dev' edition (local dev runs) sees community + pro + dev tools", () => {
    // Verifies the contrapositive of the above: a 'dev' edition exposes
    // the full surface so the developer can exercise every classified
    // tool regardless of its eventual ship-tier.
    const originals = { ...TOOL_TIERS };
    try {
      TOOL_TIERS.ps_ping = 'community';
      expect(isToolAllowedInEdition('ps_ping', 'dev')).toBe(true);
      TOOL_TIERS.ps_ping = 'pro';
      expect(isToolAllowedInEdition('ps_ping', 'dev')).toBe(true);
      TOOL_TIERS.ps_ping = 'dev';
      expect(isToolAllowedInEdition('ps_ping', 'dev')).toBe(true);
      TOOL_TIERS.ps_ping = 'none';
      expect(isToolAllowedInEdition('ps_ping', 'dev')).toBe(false);
    } finally {
      Object.assign(TOOL_TIERS, originals);
    }
  });

  it('unclassified tools pass through (caught later by the startup assertion)', () => {
    expect(isToolAllowedInEdition('not_in_table', 'community')).toBe(true);
    expect(isToolAllowedInEdition('not_in_table', 'pro')).toBe(true);
    expect(isToolAllowedInEdition('not_in_table', 'dev')).toBe(true);
  });
});
