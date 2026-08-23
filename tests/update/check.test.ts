import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isNewer,
  updateMessage,
  resolveUpdateCheckUrl,
  shouldCheckForUpdate,
  checkForUpdate,
  parseFixesByVersion,
  fixedToolsSince,
  httpFetchLatest,
  type LatestManifest,
} from '@editmamei/update/check.ts';

/** A manifest double with no release metadata — the pre-1.2.0 publish shape. */
const bare = (version: string): LatestManifest => ({ version, fixesByVersion: {} });

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
  it('defaults to the npm registry latest-version manifest endpoint', () => {
    // The version-manifest endpoint (not dist-tags): the `latest` tag resolves
    // server-side and the one response carries version + release metadata, so
    // the privacy doc's "one request, to the public npm registry" stays true.
    expect(resolveUpdateCheckUrl({})).toContain('registry.npmjs.org');
    expect(resolveUpdateCheckUrl({})).toContain('editmamei/latest');
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
      fetchLatest: async () => bare('0.99.0'),
    });
    expect(info).not.toBeNull();
    expect(info!.current).toBe('0.18.0');
    expect(info!.latest).toBe('0.99.0');
    expect(validChannels).toContain(info!.channel);
    expect(info!.how_to_update.length).toBeGreaterThan(0);
    expect(info!.fixed_tools).toEqual([]);
  });

  it('returns null when already up to date', async () => {
    const info = await checkForUpdate({
      env: {},
      current: '0.18.0',
      fetchLatest: async () => bare('0.18.0'),
    });
    expect(info).toBeNull();
  });

  it('returns null when the running version is ahead of npm', async () => {
    const info = await checkForUpdate({
      env: {},
      current: '0.19.0',
      fetchLatest: async () => bare('0.18.0'),
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
      fetchLatest: async () => bare('not-a-version'),
    });
    expect(info).toBeNull();
  });

  it('flattens the fixes map over (current, latest] into fixed_tools', async () => {
    const info = await checkForUpdate({
      env: {},
      current: '1.0.3',
      fetchLatest: async () => ({
        version: '1.2.0',
        fixesByVersion: {
          '1.0.1': ['ps_already_installed'], // at/below current — excluded
          '1.1.0': ['ps_create_clipping_mask'],
          '1.2.0': ['ps_delete_layer', 'ps_create_clipping_mask'], // dedup across versions
          '9.9.9': ['ps_not_published_yet'], // above latest — excluded
        },
      }),
    });
    expect(info!.fixed_tools).toEqual(['ps_create_clipping_mask', 'ps_delete_layer']);
  });
});

// The endpoint + field swap (dist-tags `latest` string → version-manifest
// `version` + `editmamei.fixesByVersion`) is the highest-consequence seam in
// this module: a field-name mistake here ships the feature dead against an
// immutable published version. Drive the REAL fetch wrapper with stubbed
// responses, not just checkForUpdate with an injected double.
describe('httpFetchLatest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (body: unknown, ok = true) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok, json: async () => body }))
    );
  };

  it('parses a realistic npm version manifest into { version, fixesByVersion }', async () => {
    stubFetch({
      name: 'editmamei',
      version: '1.2.0',
      description: 'Photoshop MCP server (Community Edition)',
      editmamei: { fixesByVersion: { '1.2.0': ['ps_delete_layer'] } },
      dependencies: {},
    });
    const manifest = await httpFetchLatest()('https://x/editmamei/latest', 1000);
    expect(manifest).toEqual({
      version: '1.2.0',
      fixesByVersion: { '1.2.0': ['ps_delete_layer'] },
    });
  });

  it('degrades a manifest without the editmamei key to an empty fixes map', async () => {
    stubFetch({ name: 'editmamei', version: '1.1.0' });
    const manifest = await httpFetchLatest()('https://x/editmamei/latest', 1000);
    expect(manifest).toEqual({ version: '1.1.0', fixesByVersion: {} });
  });

  it('returns null when the manifest has no version string', async () => {
    stubFetch({ name: 'editmamei', editmamei: { fixesByVersion: {} } });
    expect(await httpFetchLatest()('https://x/editmamei/latest', 1000)).toBeNull();
  });

  it('returns null on a non-2xx response', async () => {
    stubFetch({ version: '1.2.0' }, false);
    expect(await httpFetchLatest()('https://x/editmamei/latest', 1000)).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    expect(await httpFetchLatest()('https://x/editmamei/latest', 1000)).toBeNull();
  });
});

describe('parseFixesByVersion', () => {
  it('keeps only well-formed entries', () => {
    expect(
      parseFixesByVersion({
        '1.2.0': ['ps_a', 'ps_b'],
        '1.2': ['ps_dropped_bad_semver'],
        'not-a-version': ['ps_dropped'],
        '1.3.0': 'not-an-array',
        '1.4.0': ['ps_kept', 42, null, ''],
        '1.5.0': [],
      })
    ).toEqual({
      '1.2.0': ['ps_a', 'ps_b'],
      '1.4.0': ['ps_kept'],
    });
  });

  it('degrades every non-object shape to an empty map', () => {
    expect(parseFixesByVersion(undefined)).toEqual({});
    expect(parseFixesByVersion(null)).toEqual({});
    expect(parseFixesByVersion('1.2.0')).toEqual({});
    expect(parseFixesByVersion(['1.2.0'])).toEqual({});
    expect(parseFixesByVersion(42)).toEqual({});
  });

  it('caps versions, tools per version, and tool-name length (remote input)', () => {
    const huge: Record<string, string[]> = {};
    for (let i = 0; i < 40; i++) huge[`1.${i}.0`] = ['ps_a'];
    expect(Object.keys(parseFixesByVersion(huge))).toHaveLength(16);

    const manyTools = parseFixesByVersion({
      '1.0.0': Array.from({ length: 40 }, (_, i) => `ps_tool_${i}`),
    });
    expect(manyTools['1.0.0']).toHaveLength(16);

    expect(parseFixesByVersion({ '1.0.0': ['x'.repeat(65), 'ps_kept'] })).toEqual({
      '1.0.0': ['ps_kept'],
    });
  });
});

describe('fixedToolsSince', () => {
  it('orders the union oldest-version-first and deduplicates', () => {
    expect(
      fixedToolsSince({ '1.2.0': ['ps_b', 'ps_a'], '1.1.0': ['ps_a', 'ps_c'] }, '1.0.3', '1.2.0')
    ).toEqual(['ps_a', 'ps_c', 'ps_b']);
  });

  it('includes latest itself and excludes current itself', () => {
    expect(fixedToolsSince({ '1.0.3': ['ps_old'], '1.2.0': ['ps_new'] }, '1.0.3', '1.2.0')).toEqual(
      ['ps_new']
    );
  });

  it('is empty for an empty or fully-out-of-window map', () => {
    expect(fixedToolsSince({}, '1.0.3', '1.2.0')).toEqual([]);
    expect(fixedToolsSince({ '1.0.0': ['ps_a'] }, '1.0.3', '1.2.0')).toEqual([]);
  });
});
