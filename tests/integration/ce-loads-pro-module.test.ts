import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { packBundle, type BundleFile } from '@editmamei/delivery/bundle.ts';
import { sha256Hex } from '@editmamei/delivery/crypto.ts';
import { moduleSigMessage } from '@editmamei/delivery/signing.ts';

/**
 * The "free CE → buy → unlock" path, end-to-end at the host level: a
 * COMMUNITY-edition host with a valid license + an installed downloaded module
 * loads that module and registers its Pro tools.
 *
 * Pins two things the slice-3 → CE-loads-modules change established:
 *  - `server.resolveProModule()`'s install-dir branch (entitled + installed →
 *    load from `~/.editmamei/modules/pro/<v>/`), previously only validated e2e.
 *  - the removal of the old `EDITION === 'community'` early-return in
 *    `loadModules` — a downloaded module is gated by ENTITLEMENT, not the host's
 *    build edition.
 */

// Hoisted holder so the os + signing mocks read values set in beforeAll.
const fx = vi.hoisted(() => ({ home: '', pub: '' }));

// The free CE build.
vi.mock('@editmamei/edition.ts', () => ({ EDITION: 'community' }));
// Redirect ~/.editmamei to our temp home (license + installed module live there).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fx.home };
});
// The real PROD signing key's private half isn't available to tests, so we sign
// the fixture artifact with an ephemeral key and pin its public half here — this
// is what lets the boot-time re-verification (audit H1) accept the fixture. The
// getter reads fx.pub lazily, after beforeAll mints the key. Everything else in
// signing.ts (verifyModuleSignature, moduleSigMessage) stays real.
vi.mock('@editmamei/delivery/signing.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@editmamei/delivery/signing.ts')>();
  return {
    ...actual,
    get MODULE_SIGNING_PUBLIC_KEYS() {
      return fx.pub ? [fx.pub] : [];
    },
  };
});

import { EditmameiServer } from '@editmamei/core/server.ts';

const MOD_VERSION = '9.9.9';

// The downloaded module: a minimal EditmameiModule that registers one tool. Its
// name (ps_list_actions) is a classified 'pro' tool NOT provided by the CE module,
// so assertToolsClassified passes and there's no duplicate-registration clash. (The
// v0.22 re-tier moved ps_select_subject to community, so the CE module registers it
// now — using that name here would collide.) No goCoreSnippets → the kernel uses the
// community client (no Pro binary spawn needed for registration).
const HANDLERS_SRC = [
  'export default {',
  "  manifest: { id: 'pro', name: 'Pro (fixture)', abi: 1 },",
  '  register(host) {',
  '    host.registerTools([{',
  "      tool: { name: 'ps_list_actions', description: 'fixture',",
  "        inputSchema: { type: 'object', properties: {} } },",
  "      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),",
  '    }]);',
  '  },',
  '};',
  '',
].join('\n');

beforeAll(() => {
  fx.home = mkdtempSync(join(tmpdir(), 'em-ce-pro-'));
  const dir = join(fx.home, '.editmamei');
  const modDir = join(dir, 'modules', 'pro', MOD_VERSION);
  mkdirSync(modDir, { recursive: true });

  // A granted, non-expiring license validated just now → within the 30-day grace.
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

  // A genuinely signed, encrypted module artifact — boot-time re-verification
  // (audit H1) decrypts + signature-checks it before loading, so an unsigned/fake
  // pointer (the pre-H1 fixture) is now correctly refused. Sign with an ephemeral
  // key whose public half is pinned via the signing.ts mock above.
  const contentKey = randomBytes(32).toString('base64');
  const files: BundleFile[] = [
    { name: 'pro-handlers.mjs', data: Buffer.from(HANDLERS_SRC) },
    {
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify({ sku: 'pro', version: MOD_VERSION, abi: 1 })),
    },
  ];
  const blob = packBundle(files, contentKey);
  const sha256 = sha256Hex(blob);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  fx.pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sig = edSign(null, moduleSigMessage('pro', MOD_VERSION, sha256), privateKey).toString(
    'base64'
  );

  // The retained artifact + a complete-install marker (manifest.json). The
  // unpacked pro-handlers.mjs is regenerated from the verified artifact at load.
  writeFileSync(join(modDir, 'artifact.enc'), Buffer.from(blob), { mode: 0o600 });
  writeFileSync(
    join(modDir, 'manifest.json'),
    JSON.stringify({ sku: 'pro', version: MOD_VERSION, abi: 1 })
  );
  writeFileSync(
    join(dir, 'modules', 'pro', 'installed.json'),
    JSON.stringify({
      sku: 'pro',
      version: MOD_VERSION,
      abi: 1,
      sha256,
      alg: 'AES-256-GCM',
      content_key: contentKey,
      sig,
      installed_at: new Date().toISOString(),
    })
  );
});

afterAll(() => {
  if (fx.home) rmSync(fx.home, { recursive: true, force: true });
});

describe('CE host loads an entitled downloaded module', () => {
  it('community edition + valid license + installed module → Pro tool registers', async () => {
    const server = new EditmameiServer() as unknown as {
      toolRegistry: { list(): Array<{ name: string }> };
      loadModules(): Promise<void>;
    };
    await server.loadModules();
    const names = server.toolRegistry.list().map((t) => t.name);
    expect(names).toContain('ps_list_actions');
  });
});
