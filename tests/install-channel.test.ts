import { describe, it, expect } from 'vitest';
import { resolveInstallChannel } from '@editmamei/install-channel.ts';

describe('resolveInstallChannel', () => {
  it('reports dev for a dev build regardless of env or argv1 (committed EDITION default)', () => {
    // The test tree is EDITION='dev', so the default (no edition arg) short-circuits.
    expect(resolveInstallChannel({})).toBe('dev');
    expect(resolveInstallChannel({ EDITMAMEI_INSTALL_CHANNEL: 'mcpb' })).toBe('dev');
  });

  it('dev wins over every other signal (a working tree is never a distributed channel)', () => {
    expect(resolveInstallChannel({ EDITMAMEI_INSTALL_CHANNEL: 'mcpb' }, 'dev')).toBe('dev');
    expect(
      resolveInstallChannel(
        {},
        'dev',
        '/home/x/.npm/_npx/abc123/node_modules/editmamei/dist/index.js'
      )
    ).toBe('dev');
  });

  it('reports mcpb when the bundle env marker is set, regardless of argv1', () => {
    expect(
      resolveInstallChannel(
        { EDITMAMEI_INSTALL_CHANNEL: 'mcpb' },
        'community',
        '/some/random/path/index.js'
      )
    ).toBe('mcpb');
  });

  it('reports npx for an entry script under an _npx cache dir (POSIX and Windows)', () => {
    expect(
      resolveInstallChannel(
        {},
        'community',
        '/home/alice/.npm/_npx/1a2b3c/node_modules/editmamei/dist/index.js'
      )
    ).toBe('npx');
    expect(
      resolveInstallChannel(
        {},
        'community',
        'C:\\Users\\alice\\AppData\\Local\\npm-cache\\_npx\\1a2b3c\\node_modules\\editmamei\\dist\\index.js'
      )
    ).toBe('npx');
  });

  it('reports npm_global for a node_modules segment preceded by lib (POSIX global convention)', () => {
    expect(
      resolveInstallChannel({}, 'community', '/usr/local/lib/node_modules/editmamei/dist/index.js')
    ).toBe('npm_global');
  });

  it('reports npm_global for a node_modules segment preceded by npm (Windows AppData layout)', () => {
    expect(
      resolveInstallChannel(
        {},
        'community',
        'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\editmamei\\dist\\index.js'
      )
    ).toBe('npm_global');
  });

  it('reports npm_global for nvm/volta-style global layouts (a lib segment above node_modules)', () => {
    // nvm: node_modules sits under <node version>/lib/, same convention as any other
    // POSIX global npm prefix — no execPath inference needed, the lib segment alone decides.
    expect(
      resolveInstallChannel(
        {},
        'community',
        '/home/alice/.nvm/versions/node/v20.11.0/lib/node_modules/editmamei/dist/index.js'
      )
    ).toBe('npm_global');
    // volta: global packages land under its own "image" tree, same lib/node_modules shape.
    expect(
      resolveInstallChannel(
        {},
        'community',
        '/home/alice/.volta/tools/image/packages/editmamei/lib/node_modules/editmamei/dist/index.js'
      )
    ).toBe('npm_global');
  });

  it("reports npm_global when node_modules sits under the running node binary's own directory (no lib/npm segment)", () => {
    // The Windows official installer layout: node.exe and node_modules\ are SIBLINGS in the
    // same directory, with neither a `lib` nor an `npm` segment between them.
    expect(
      resolveInstallChannel(
        {},
        'community',
        'C:\\Program Files\\nodejs\\node_modules\\editmamei\\dist\\index.js',
        'C:\\Program Files\\nodejs\\node.exe'
      )
    ).toBe('npm_global');
  });

  it('reports npm_local for any OTHER node_modules segment (a project-local install)', () => {
    expect(
      resolveInstallChannel(
        {},
        'community',
        '/home/alice/my-project/node_modules/editmamei/dist/index.js',
        '/usr/bin/node' // not a sibling/ancestor of the node_modules segment above
      )
    ).toBe('npm_local');
    expect(
      resolveInstallChannel(
        {},
        'community',
        'C:\\projects\\my-app\\node_modules\\editmamei\\dist\\index.js',
        'C:\\Program Files\\nodejs\\node.exe'
      )
    ).toBe('npm_local');
  });

  it('reports source for an entry script outside any node_modules', () => {
    expect(resolveInstallChannel({}, 'community', '/home/alice/editmamei/dist/index.js')).toBe(
      'source'
    );
    expect(resolveInstallChannel({}, 'community', 'E:\\code\\editmamei\\dist\\index.js')).toBe(
      'source'
    );
  });

  it('reports source (never npm_global) for a directory whose name merely CONTAINS "node_modules" — segment matching, not substring', () => {
    // The old substring check (`.includes('node_modules')`) would have misclassified this as
    // npm_global; there is no `node_modules` PATH SEGMENT here at all, only a directory named
    // `node_modules_backup`.
    expect(
      resolveInstallChannel(
        {},
        'community',
        '/home/alice/projects/node_modules_backup/editmamei/dist/index.js'
      )
    ).toBe('source');
  });

  it('falls back to source when argv1 is empty (unavailable)', () => {
    // Passing `undefined` here would trigger the parameter default (the REAL
    // process.argv[1], the vitest worker's own path) rather than testing "no entry path" —
    // an empty string is the honest way to exercise that branch directly.
    expect(resolveInstallChannel({}, 'community', '')).toBe('source');
  });
});
