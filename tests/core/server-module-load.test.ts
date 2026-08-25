import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { packBundle, type BundleFile } from '@editmamei/delivery/bundle.ts';
import { sha256Hex } from '@editmamei/delivery/crypto.ts';
import { moduleSigMessage } from '@editmamei/delivery/signing.ts';
import {
  readInstalledModule,
  loadVerifiedModule,
  moduleArtifactPath,
  PRO_SKU,
} from '@editmamei/delivery/store.ts';
import type { DeliveryFetch } from '@editmamei/delivery/client.ts';
import { fakeDelivery, fakeDeliveryConfig as cfg, jsonRes } from '../fixtures/fake-delivery.ts';
import { VERSION } from '@editmamei/version.ts';

/**
 * Self-healing Pro module load + hardening (v0.22.1). A downloaded module built
 * against an OLDER host contract, or a corrupt on-disk install, must NEVER crash
 * the server — the whole process (CE included) used to die when
 * `assertToolsClassified` threw. These tests pin the skip-reason model, the two
 * degrade-to-Community nets (ABI gate + snapshot/restore rollback), the corrupt
 * detection, and the honest, reason-driven background self-heal — plus the
 * forward-compat per-tool degrade (a module NEWER than the host loses only its
 * unrecognized tools, not the whole module).
 *
 * Scaffolding mirrors ce-loads-pro-module.test.ts: a COMMUNITY-edition host, a
 * temp ~/.editmamei with a granted license + a genuinely-signed encrypted module
 * artifact. One ephemeral signer for the on-disk fixtures; its public half is
 * pinned via the signing.ts mock so the boot re-verification accepts them.
 */

const fx = vi.hoisted(() => ({ home: '', pub: '' }));

vi.mock('@editmamei/edition.ts', () => ({ EDITION: 'community' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fx.home };
});
vi.mock('@editmamei/delivery/signing.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@editmamei/delivery/signing.ts')>();
  return {
    ...actual,
    get MODULE_SIGNING_PUBLIC_KEYS() {
      return fx.pub ? [fx.pub] : [];
    },
  };
});

import { EditmameiServer, classifyModuleOutcome } from '@editmamei/core/server.ts';

/**
 * Fixture module version for every test EXCEPT the forward-compat cases below.
 * Kept <= the host's `VERSION` (src/version.ts) so these fixtures exercise the
 * pre-existing whole-module rollback path (a backward or equal-version
 * incompatibility) rather than the newer forward per-tool degrade.
 */
const MOD_VERSION = '0.9.9';
/** Fixture module version strictly newer than the host — the forward-compat cases. */
const FORWARD_MOD_VERSION = '99.0.0';

// One signer for every ON-DISK fixture module → fx.pub stays constant so the boot
// re-verification (mocked MODULE_SIGNING_PUBLIC_KEYS) accepts them. The re-provision
// path verifies against the fake delivery's own key (passed to loadVerifiedModule).
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

/** A downloaded module registering the given tool name(s). */
function handlersRegistering(names: string[]): string {
  const tools = names
    .map(
      (n) =>
        `{ tool: { name: '${n}', description: 'fixture', inputSchema: { type: 'object', properties: {} } }, ` +
        `handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }`
    )
    .join(',');
  return [
    'export default {',
    "  manifest: { id: 'pro', name: 'Pro (fixture)', abi: 1 },",
    '  register(host) {',
    `    host.registerTools([${tools}]);`,
    '  },',
    '};',
    '',
  ].join('\n');
}

const homes: string[] = [];
const dirOf = (home: string): string => join(home, '.editmamei');

/**
 * Build a fresh temp ~/.editmamei home with a granted license + a signed,
 * encrypted module at `abi`/`version` whose handlers register `names`. Returns
 * the home; sets fx.home so the next `new EditmameiServer()` resolves against it.
 * `version` defaults to MOD_VERSION (<= host VERSION); the forward-compat tests
 * pass FORWARD_MOD_VERSION (or the host's own VERSION, for the equal-version
 * fail-safe case) explicitly.
 */
function buildHome({
  names,
  abi,
  version = MOD_VERSION,
}: {
  names: string[];
  abi: number;
  version?: string;
}): string {
  const home = mkdtempSync(join(tmpdir(), 'em-selfheal-'));
  homes.push(home);
  const dir = dirOf(home);
  const modDir = join(dir, 'modules', 'pro', version);
  mkdirSync(modDir, { recursive: true });

  writeFileSync(
    join(dir, 'license.json'),
    JSON.stringify({
      key: 'TEST-KEY',
      organization_id: 'org_test',
      status: 'granted',
      expires_at: null,
      activation_id: 'act_test',
      device_hash: 'dev_test',
      display_key: '****-TEST',
      last_validated_at: new Date().toISOString(),
    })
  );

  const contentKey = randomBytes(32).toString('base64');
  const files: BundleFile[] = [
    { name: 'pro-handlers.mjs', data: Buffer.from(handlersRegistering(names)) },
    {
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify({ sku: 'pro', version, abi })),
    },
  ];
  const blob = packBundle(files, contentKey);
  const sha256 = sha256Hex(blob);
  const sig = edSign(null, moduleSigMessage('pro', version, sha256), privateKey).toString('base64');

  writeFileSync(join(modDir, 'artifact.enc'), Buffer.from(blob), { mode: 0o600 });
  writeFileSync(join(modDir, 'manifest.json'), JSON.stringify({ sku: 'pro', version, abi }));
  writeFileSync(
    join(dir, 'modules', 'pro', 'installed.json'),
    JSON.stringify({
      sku: 'pro',
      version,
      abi,
      sha256,
      alg: 'AES-256-GCM',
      content_key: contentKey,
      sig,
      installed_at: new Date().toISOString(),
    })
  );
  fx.home = home;
  return home;
}

beforeAll(() => {
  fx.pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
});

afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

type SelfHealDelivery = {
  config?: unknown;
  fetchImpl?: DeliveryFetch;
  signingKeys?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
};
type ServerProbe = {
  toolRegistry: { list(): Array<{ name: string }>; get(name: string): unknown; count(): number };
  loadModules(): Promise<void>;
  moduleSkipReason: 'corrupt' | 'incompatible' | null;
  reprovisionIfModuleSkipped(delivery: SelfHealDelivery): Promise<void>;
  ensureEntitledModuleFresh(delivery: SelfHealDelivery): Promise<void>;
};

const names = (s: ServerProbe): string[] => s.toolRegistry.list().map((t) => t.name);

describe('EditmameiServer.loadModules — degrade-to-CE nets', () => {
  it('does NOT throw and rolls back when a module registers an unclassifiable tool', async () => {
    buildHome({ names: ['photoshop_list_actions'], abi: 1 });
    const server = new EditmameiServer() as unknown as ServerProbe;

    await expect(server.loadModules()).resolves.toBeUndefined();

    expect(names(server)).not.toContain('photoshop_list_actions'); // rolled back
    expect(names(server)).toContain('ps_ping'); // CE surface survived
    expect(server.moduleSkipReason).toBe('incompatible');
  });

  it('skips a module whose abi is below HOST_MIN_ABI, before importing it', async () => {
    // abi 0 < HOST_MIN_ABI (1); a VALID pro name proves the skip is pre-import.
    buildHome({ names: ['ps_list_actions'], abi: 0 });
    const server = new EditmameiServer() as unknown as ServerProbe;

    await expect(server.loadModules()).resolves.toBeUndefined();

    expect(names(server)).not.toContain('ps_list_actions');
    expect(names(server)).toContain('ps_ping');
    expect(server.moduleSkipReason).toBe('incompatible');
  });

  it('leaves the reason null + registers the tool for a compatible module (control)', async () => {
    buildHome({ names: ['ps_list_actions'], abi: 1 });
    const server = new EditmameiServer() as unknown as ServerProbe;

    await server.loadModules();

    expect(names(server)).toContain('ps_list_actions');
    expect(server.moduleSkipReason).toBeNull();
  });

  it('rollback RESTORES an overwritten CE tool by identity, not just by name', async () => {
    // A v0.21-era module can register a name that has since become a CE tool. The
    // registry overwrites on collision, so a name-only rollback would leave the
    // MODULE handler live under the CE name. Snapshot/restore puts the exact CE
    // definition back. ps_ping is a host-ambient classified tool always present.
    buildHome({ names: ['ps_ping', 'photoshop_unclassifiable'], abi: 1 });
    const server = new EditmameiServer() as unknown as ServerProbe;
    const cePing = server.toolRegistry.get('ps_ping');
    expect(cePing).toBeDefined();

    await server.loadModules();

    expect(names(server)).not.toContain('photoshop_unclassifiable');
    // Identity-equal to the pre-load CE definition — the module's overwrite was undone.
    expect(server.toolRegistry.get('ps_ping')).toBe(cePing);
    expect(server.moduleSkipReason).toBe('incompatible');
  });
});

describe('EditmameiServer.loadModules — forward-compat per-tool degrade', () => {
  // The mirror-image case: a downloaded module NEWER than this host (the delivery
  // manifest auto-updated ahead of a host restart onto the matching release) ships
  // a tool this host's tool-tiers.ts/tool-groups.ts don't know yet. Only that ONE
  // tool should be dropped — the rest of the module, and the rest of Pro, must
  // keep working.

  it('keeps a classifiable tool and drops only the unknown one from a FORWARD module', async () => {
    buildHome({
      names: ['ps_list_actions', 'ps_future_tool_never_heard_of'],
      abi: 1,
      version: FORWARD_MOD_VERSION,
    });
    const server = new EditmameiServer() as unknown as ServerProbe;

    await expect(server.loadModules()).resolves.toBeUndefined();

    expect(names(server)).not.toContain('ps_future_tool_never_heard_of');
    expect(names(server)).toContain('ps_list_actions'); // the rest of the module loaded
    expect(names(server)).toContain('ps_ping'); // CE surface intact
    expect(server.moduleSkipReason).toBeNull(); // the module IS loaded — no re-provision
  });

  it('drops every tool and contributes nothing when a FORWARD module registers only unknown tools', async () => {
    buildHome({
      names: ['ps_future_tool_never_heard_of', 'ps_another_future_tool'],
      abi: 1,
      version: FORWARD_MOD_VERSION,
    });
    const server = new EditmameiServer() as unknown as ServerProbe;

    await expect(server.loadModules()).resolves.toBeUndefined();

    expect(names(server)).not.toContain('ps_future_tool_never_heard_of');
    expect(names(server)).not.toContain('ps_another_future_tool');
    expect(names(server)).toContain('ps_ping'); // CE surface intact
    expect(server.moduleSkipReason).toBeNull();
  });

  it('falls through to the full rollback for an EQUAL-version module with an unknown tool', async () => {
    // The fail-safe: same-version build inconsistency is NOT a case a re-provision
    // can fix (the manifest already matches), so it stays on the old whole-module
    // rollback rather than silently limping along on a partial module.
    buildHome({
      names: ['ps_future_tool_never_heard_of'],
      abi: 1,
      version: VERSION, // equal to the host — not strictly newer, so no degrade
    });
    const server = new EditmameiServer() as unknown as ServerProbe;

    await expect(server.loadModules()).resolves.toBeUndefined();

    expect(names(server)).not.toContain('ps_future_tool_never_heard_of');
    expect(names(server)).toContain('ps_ping');
    expect(server.moduleSkipReason).toBe('incompatible');
  });
});

describe('EditmameiServer — corrupt on-disk module detection', () => {
  it('flags a corrupt artifact as "corrupt", keeps CE, and force-re-verifies on self-heal', async () => {
    buildHome({ names: ['ps_list_actions'], abi: 1 });
    // Flip a byte in the retained artifact so boot re-verification (sha256) fails.
    const artifact = moduleArtifactPath(PRO_SKU, MOD_VERSION, { dir: dirOf(fx.home) });
    const bytes = readFileSync(artifact);
    bytes[0] = bytes[0] ^ 0xff;
    writeFileSync(artifact, bytes);

    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();

    expect(names(server)).toContain('ps_ping'); // CE intact — no crash
    expect(names(server)).not.toContain('ps_list_actions'); // corrupt module didn't load
    expect(server.moduleSkipReason).toBe('corrupt');

    // Self-heal force-re-downloads the SAME version → the install re-verifies.
    const fake = fakeDelivery(MOD_VERSION);
    await server.reprovisionIfModuleSkipped({
      config: cfg,
      fetchImpl: fake.fetchImpl,
      signingKeys: [fake.pubB64],
      sleep: async () => {},
    });
    const dir = dirOf(fx.home);
    expect(readInstalledModule(PRO_SKU, { dir })?.version).toBe(MOD_VERSION);
    expect(loadVerifiedModule(PRO_SKU, { dir }, [fake.pubB64])).not.toBeNull();
  });

  it('treats a legacy pointer missing `abi` as corrupt and self-heals into a fresh pointer', async () => {
    buildHome({ names: ['ps_list_actions'], abi: 1 });
    const dir = dirOf(fx.home);
    // Rewrite installed.json WITHOUT the abi field → readInstalledModule's shape
    // check rejects it → loadVerifiedModule null → corrupt.
    const ptrPath = join(dir, 'modules', 'pro', 'installed.json');
    const ptr = JSON.parse(readFileSync(ptrPath, 'utf8')) as Record<string, unknown>;
    delete ptr.abi;
    writeFileSync(ptrPath, JSON.stringify(ptr));
    expect(readInstalledModule(PRO_SKU, { dir })).toBeNull();

    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();
    expect(server.moduleSkipReason).toBe('corrupt');

    const fake = fakeDelivery(MOD_VERSION);
    await server.reprovisionIfModuleSkipped({
      config: cfg,
      fetchImpl: fake.fetchImpl,
      signingKeys: [fake.pubB64],
      sleep: async () => {},
    });
    // Now a well-formed pointer (with abi) exists and re-verifies.
    expect(readInstalledModule(PRO_SKU, { dir })?.abi).toBe(1);
    expect(loadVerifiedModule(PRO_SKU, { dir }, [fake.pubB64])).not.toBeNull();
  });
});

describe('EditmameiServer — background self-heal policy', () => {
  it('re-fetches a NEWER module for an incompatible skip (no force)', async () => {
    buildHome({ names: ['photoshop_list_actions'], abi: 1 }); // wedge → incompatible
    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();
    expect(server.moduleSkipReason).toBe('incompatible');

    const fake = fakeDelivery('9.9.10'); // newer than the wedged 0.9.9
    await server.reprovisionIfModuleSkipped({
      config: cfg,
      fetchImpl: fake.fetchImpl,
      signingKeys: [fake.pubB64],
      sleep: async () => {},
    });
    expect(readInstalledModule(PRO_SKU, { dir: dirOf(fx.home) })?.version).toBe('9.9.10');
  });

  it('installs nothing + does NOT recommend repair when only the SAME (incompatible) version is served', async () => {
    buildHome({ names: ['photoshop_list_actions'], abi: 1 }); // wedge → incompatible
    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();

    const fake = fakeDelivery(MOD_VERSION); // SAME version — an incompatible skip won't force
    // Capture into an external array (mockRestore() would clear mock.calls).
    const lines: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        lines.push(String(chunk));
        return true;
      });
    try {
      await server.reprovisionIfModuleSkipped({
        config: cfg,
        fetchImpl: fake.fetchImpl,
        signingKeys: [fake.pubB64],
        sleep: async () => {},
      });
    } finally {
      stderr.mockRestore();
    }
    const logged = lines.join('');

    // Nothing installed (still the wedged version), reason unchanged…
    expect(readInstalledModule(PRO_SKU, { dir: dirOf(fx.home) })?.version).toBe(MOD_VERSION);
    expect(server.moduleSkipReason).toBe('incompatible');
    // …and the guidance is honest: never point at `repair` (it hits the same wall).
    expect(logged).not.toMatch(/repair/i);
    expect(logged).toMatch(/does not yet support this host/i);
  });
});

describe('EditmameiServer.ensureEntitledModuleFresh — healthy-path auto-update', () => {
  // The fix for the .mcpb auto-update gap: once a module is installed, no boot path
  // re-checked the manifest, so a newer published module was never pulled (the stale
  // module still loaded — never skipped → the self-heal never fired). This task runs
  // provisionModules on the HEALTHY path (moduleSkipReason === null) for an entitled
  // user, mutually exclusive with the self-heal.

  it('pulls a NEWER published module when the installed one loaded fine (Bug A)', async () => {
    buildHome({ names: ['ps_list_actions'], abi: 1 }); // compatible → loads, reason null
    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();
    expect(server.moduleSkipReason).toBeNull();

    const fake = fakeDelivery('9.9.10'); // newer than the installed 0.9.9
    await server.ensureEntitledModuleFresh({
      config: cfg,
      fetchImpl: fake.fetchImpl,
      signingKeys: [fake.pubB64],
      sleep: async () => {},
    });
    // Upgraded on disk; the new version loads on the NEXT restart (no hot-swap).
    expect(readInstalledModule(PRO_SKU, { dir: dirOf(fx.home) })?.version).toBe('9.9.10');
  });

  it('is a cheap no-op when already latest — fetches the manifest but NOT the artifact', async () => {
    buildHome({ names: ['ps_list_actions'], abi: 1 });
    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();

    const urls: string[] = [];
    const fake = fakeDelivery(MOD_VERSION); // same version served
    await server.ensureEntitledModuleFresh({
      config: cfg,
      fetchImpl: async (url, init) => {
        urls.push(url);
        return fake.fetchImpl(url, init);
      },
      signingKeys: [fake.pubB64],
      sleep: async () => {},
    });
    expect(readInstalledModule(PRO_SKU, { dir: dirOf(fx.home) })?.version).toBe(MOD_VERSION);
    // Proof it SKIPPED rather than re-downloaded: the manifest was consulted, but the
    // artifact + content-key endpoints were never hit (a re-download would touch both).
    expect(urls.some((u) => u.endsWith('/v1/modules/manifest'))).toBe(true);
    expect(urls.some((u) => u.includes(`/v1/modules/pro/${MOD_VERSION}`))).toBe(false);
    expect(urls.some((u) => u.endsWith('/v1/modules/pro/key'))).toBe(false);
  });

  it('provisions the module when entitled but NONE is installed (first-unlock / npm safety net, Bug B)', async () => {
    buildHome({ names: ['ps_list_actions'], abi: 1 });
    const dir = dirOf(fx.home);
    // Remove the installed module entirely → entitled, nothing on disk, reason stays null
    // (no pointer = not 'corrupt'). This is the .mcpb slow-first-install fallback + the npm
    // path where boot never provisions a missing module.
    rmSync(join(dir, 'modules', 'pro'), { recursive: true, force: true });
    expect(readInstalledModule(PRO_SKU, { dir })).toBeNull();

    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();
    expect(server.moduleSkipReason).toBeNull();

    const fake = fakeDelivery(MOD_VERSION);
    await server.ensureEntitledModuleFresh({
      config: cfg,
      fetchImpl: fake.fetchImpl,
      signingKeys: [fake.pubB64],
      sleep: async () => {},
    });
    expect(readInstalledModule(PRO_SKU, { dir })?.version).toBe(MOD_VERSION);
  });

  it('stays on the installed module without crashing when provisioning errors', async () => {
    buildHome({ names: ['ps_list_actions'], abi: 1 });
    const dir = dirOf(fx.home);
    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();

    // Delivery 500s every request → provisionModules collects an error and installs
    // nothing; the freshness poll must swallow it and leave the working install intact.
    await expect(
      server.ensureEntitledModuleFresh({
        config: cfg,
        fetchImpl: async () => jsonRes(500, { error: 'server' }),
        signingKeys: [],
        sleep: async () => {},
      })
    ).resolves.toBeUndefined();
    expect(readInstalledModule(PRO_SKU, { dir })?.version).toBe(MOD_VERSION);
  });

  it('does NOT run on the skipped path — mutually exclusive with the self-heal', async () => {
    buildHome({ names: ['photoshop_list_actions'], abi: 1 }); // wedge → incompatible
    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();
    expect(server.moduleSkipReason).toBe('incompatible');

    // Serve a NEWER version that WOULD install if the method ran — proves the early
    // return on moduleSkipReason !== null (the self-heal owns this boot instead).
    let calls = 0;
    const fake = fakeDelivery('9.9.10');
    await server.ensureEntitledModuleFresh({
      config: cfg,
      fetchImpl: async (url, init) => {
        calls++;
        return fake.fetchImpl(url, init);
      },
      signingKeys: [fake.pubB64],
      sleep: async () => {},
    });
    expect(calls).toBe(0); // never touched the delivery service
    expect(readInstalledModule(PRO_SKU, { dir: dirOf(fx.home) })?.version).toBe(MOD_VERSION);
  });

  it('does NOT provision when the device is no longer entitled (no cached license)', async () => {
    buildHome({ names: ['ps_list_actions'], abi: 1 });
    const dir = dirOf(fx.home);
    const server = new EditmameiServer() as unknown as ServerProbe;
    await server.loadModules();
    // Remove the license AFTER load so isProEntitled() reads false at call time.
    rmSync(join(dir, 'license.json'));

    let calls = 0;
    const fake = fakeDelivery('9.9.10'); // a newer version is available…
    await server.ensureEntitledModuleFresh({
      config: cfg,
      fetchImpl: async (url, init) => {
        calls++;
        return fake.fetchImpl(url, init);
      },
      signingKeys: [fake.pubB64],
      sleep: async () => {},
    });
    expect(calls).toBe(0); // …but an unentitled device pulls nothing
    expect(readInstalledModule(PRO_SKU, { dir })?.version).toBe(MOD_VERSION);
  });
});

describe('classifyModuleOutcome — module_status taxonomy (telemetry §11)', () => {
  it('loaded: a resolved module with no skip flag', () => {
    expect(classifyModuleOutcome({ proModuleLoaded: true, skipReason: null, entitled: true })).toBe(
      'loaded'
    );
  });

  it('skipped_corrupt / skipped_incompatible map straight from the skip reason', () => {
    // A resolved module can still carry a skip flag (ABI gate / rollback set it while
    // proModule stays non-null) — the skip reason wins over "loaded".
    expect(
      classifyModuleOutcome({ proModuleLoaded: false, skipReason: 'corrupt', entitled: true })
    ).toBe('skipped_corrupt');
    expect(
      classifyModuleOutcome({ proModuleLoaded: true, skipReason: 'incompatible', entitled: true })
    ).toBe('skipped_incompatible');
  });

  it('absent: entitled, nothing loaded, no skip flag (awaiting first provision)', () => {
    expect(
      classifyModuleOutcome({ proModuleLoaded: false, skipReason: null, entitled: true })
    ).toBe('absent');
  });

  it('lapsed: a license record exists but is no longer entitled', () => {
    expect(
      classifyModuleOutcome({ proModuleLoaded: false, skipReason: null, entitled: false })
    ).toBe('lapsed');
  });
});
