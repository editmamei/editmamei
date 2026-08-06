import { describe, it, expect } from 'vitest';
import { resolveInstallChannel } from '@editmamei/install-channel.ts';

describe('resolveInstallChannel', () => {
  it('reports dev for a dev build regardless of env (committed EDITION default)', () => {
    // The test tree is EDITION='dev', so the default (no edition arg) short-circuits.
    expect(resolveInstallChannel({})).toBe('dev');
    expect(resolveInstallChannel({ EDITMAMEI_INSTALL_CHANNEL: 'mcpb' })).toBe('dev');
  });

  it('defaults a shipped build to npm when no channel env is set', () => {
    expect(resolveInstallChannel({}, 'community')).toBe('npm');
    expect(resolveInstallChannel({}, 'pro')).toBe('npm');
  });

  it('reports mcpb when the bundle env marker is set', () => {
    expect(resolveInstallChannel({ EDITMAMEI_INSTALL_CHANNEL: 'mcpb' }, 'community')).toBe('mcpb');
  });

  it('dev wins over the env marker (a working tree is never a distributed channel)', () => {
    expect(resolveInstallChannel({ EDITMAMEI_INSTALL_CHANNEL: 'mcpb' }, 'dev')).toBe('dev');
  });

  it('falls back to npm for an unrecognized marker value', () => {
    expect(resolveInstallChannel({ EDITMAMEI_INSTALL_CHANNEL: 'garbage' }, 'community')).toBe(
      'npm'
    );
  });
});
