import { describe, it, expect } from 'vitest';
import {
  isNewer,
  updateMessage,
  resolveUpdateCheckUrl,
  shouldCheckForUpdate,
  checkForUpdate,
} from '@editmamei/update/check.ts';

describe('isNewer', () => {
  it('is true when latest is a higher patch / minor / major', () => {
    expect(isNewer('0.18.1', '0.18.0')).toBe(true);
    expect(isNewer('0.19.0', '0.18.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
  });
  it('is false when equal or lower', () => {
    expect(isNewer('0.18.0', '0.18.0')).toBe(false);
    expect(isNewer('0.17.9', '0.18.0')).toBe(false);
  });
  it('is false (never throws) for malformed versions', () => {
    expect(isNewer('1.2', '1.2.0')).toBe(false);
    expect(isNewer('latest', '0.18.0')).toBe(false);
    expect(isNewer('0.18.0', 'nope')).toBe(false);
  });
});

describe('updateMessage', () => {
  it('gives channel-specific remediation', () => {
    expect(updateMessage('npm', '0.19.0')).toContain('npm install -g editmamei@latest');
    const mcpb = updateMessage('mcpb', '0.19.0');
    // Stable, versionless asset filename (release.yml uploads editmamei.mcpb); the
    // version appears as (v0.19.0) for the user, never baked into the filename.
    expect(mcpb).toContain('editmamei.mcpb');
    expect(mcpb).not.toContain('editmamei-0.19.0.mcpb');
    expect(mcpb).toContain('(v0.19.0)');
    // The download pointer must be a URL we own and can redirect. This string
    // ships baked into every copy and can never be changed for installs already
    // out there, so naming a specific host here would make that host permanent.
    // Pinning the property, not just the value: no direct link to a code host.
    expect(mcpb).toContain('editmamei.com/download');
    expect(mcpb).not.toContain('github.com');
    expect(updateMessage('dev', '0.19.0').toLowerCase()).toContain('dev build');
  });
});

describe('resolveUpdateCheckUrl', () => {
  it('defaults to the npm registry dist-tags endpoint', () => {
    expect(resolveUpdateCheckUrl({})).toContain('registry.npmjs.org');
    expect(resolveUpdateCheckUrl({})).toContain('editmamei/dist-tags');
  });
  it('honors the env override', () => {
    expect(resolveUpdateCheckUrl({ EDITMAMEI_UPDATE_CHECK_URL: 'https://x/y' })).toBe(
      'https://x/y'
    );
  });
});

describe('shouldCheckForUpdate', () => {
  it('runs only when enabled and not under a test runner', () => {
    expect(shouldCheckForUpdate(true, {})).toBe(true);
    expect(shouldCheckForUpdate(false, {})).toBe(false);
    expect(shouldCheckForUpdate(true, { VITEST: '1' })).toBe(false);
    expect(shouldCheckForUpdate(true, { NODE_ENV: 'test' })).toBe(false);
  });
});

describe('checkForUpdate', () => {
  const validChannels = ['npm', 'mcpb', 'dev'];

  it('returns UpdateInfo when a newer version is published', async () => {
    const info = await checkForUpdate({
      env: {},
      current: '0.18.0',
      fetchLatest: async () => '0.99.0',
    });
    expect(info).not.toBeNull();
    expect(info!.current).toBe('0.18.0');
    expect(info!.latest).toBe('0.99.0');
    expect(validChannels).toContain(info!.channel);
    expect(info!.how_to_update.length).toBeGreaterThan(0);
  });

  it('returns null when already up to date', async () => {
    const info = await checkForUpdate({
      env: {},
      current: '0.18.0',
      fetchLatest: async () => '0.18.0',
    });
    expect(info).toBeNull();
  });

  it('returns null when the running version is ahead of npm', async () => {
    const info = await checkForUpdate({
      env: {},
      current: '0.19.0',
      fetchLatest: async () => '0.18.0',
    });
    expect(info).toBeNull();
  });

  it('is fail-silent when the fetch returns null (offline / non-2xx)', async () => {
    const info = await checkForUpdate({
      env: {},
      current: '0.18.0',
      fetchLatest: async () => null,
    });
    expect(info).toBeNull();
  });

  it('is fail-silent when the fetch throws', async () => {
    const info = await checkForUpdate({
      env: {},
      current: '0.18.0',
      fetchLatest: async () => {
        throw new Error('network down');
      },
    });
    expect(info).toBeNull();
  });

  it('returns null for a malformed latest value', async () => {
    const info = await checkForUpdate({
      env: {},
      current: '0.18.0',
      fetchLatest: async () => 'not-a-version',
    });
    expect(info).toBeNull();
  });
});
