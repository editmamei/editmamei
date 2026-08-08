import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildPackageJson, type SourcePackageJson } from '../../scripts/lib/build-common.js';

// The official MCP registry proves npm-package ownership by reading `mcpName`
// from the PUBLISHED package.json and requiring it to equal the server name in
// server.json. Three things therefore have to stay in lockstep: package.json's
// mcpName, server.json's name/mcpName, and the field whitelist in
// buildPackageJson that decides what actually reaches npm.
//
// The whitelist is the easy one to miss — it drops any field it doesn't name,
// silently, and npm versions are immutable, so a miss costs a patch release to
// undo. 1.0.0 through 1.0.2 all shipped without mcpName for that reason and
// could not be listed.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as SourcePackageJson;
const serverJson = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));

describe('MCP registry identity sync', () => {
  it('package.json carries an mcpName in the registry namespace we authenticate as', () => {
    // GitHub-authenticated publishes may only claim io.github.<owner>/* names.
    expect(pkg.mcpName).toBe('io.github.editmamei/editmamei');
  });

  it('server.json name and mcpName match package.json mcpName', () => {
    expect(serverJson.name).toBe(pkg.mcpName);
    expect(serverJson.mcpName).toBe(pkg.mcpName);
  });

  it('server.json points at the npm package this repo publishes', () => {
    const npmPackage = serverJson.packages?.find(
      (p: { registryType?: string }) => p.registryType === 'npm'
    );
    expect(npmPackage).toBeDefined();
    expect(npmPackage.identifier).toBe(pkg.name);
  });

  it.each(['community', 'pro'] as const)(
    'the %s published manifest keeps mcpName through the field whitelist',
    (edition) => {
      const published = buildPackageJson(edition, '9.9.9', pkg);
      expect(published.mcpName).toBe(pkg.mcpName);
    }
  );
});
