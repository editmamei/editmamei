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
      resolveInstallChannel({}, 'dev', '/home/x/.npm/_npx/abc123/node_modules/editmamei/dist/index.js')
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

  it('reports npm_global for an entry script under an ordinary node_modules (not _npx)', () => {
    expect(
      resolveInstallChannel(
        {},
        'community',
        '/usr/local/lib/node_modules/editmamei/dist/index.js'
      )
    ).toBe('npm_global');
    expect(
      resolveInstallChannel(
        {},
        'community',
        'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\editmamei\\dist\\index.js'
      )
    ).toBe('npm_global');
  });

  it('reports source for an entry script outside any node_modules', () => {
    expect(resolveInstallChannel({}, 'community', '/home/alice/editmamei/dist/index.js')).toBe(
      'source'
    );
    expect(
      resolveInstallChannel({}, 'community', 'E:\\code\\editmamei\\dist\\index.js')
    ).toBe('source');
  });

  it('falls back to source when argv1 is empty (unavailable)', () => {
    // Passing `undefined` here would trigger the parameter default (the REAL
    // process.argv[1], the vitest worker's own path) rather than testing "no entry path" —
    // an empty string is the honest way to exercise that branch directly.
    expect(resolveInstallChannel({}, 'community', '')).toBe('source');
  });
});
