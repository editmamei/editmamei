/**
 * The wiring that decides whether the GIMP backend is tested at all. The live suite is excluded
 * from `npm test`, so it runs only where gimp.yml runs it: a path filter that misses a GIMP file,
 * or a job that stops calling the script, would let a change merge with no live coverage and no
 * failing check. Read as text: the workflows are YAML and this suite has no YAML dependency.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import config from '../../vitest.config.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('the live GIMP suite is opt-in', () => {
  it('npm test excludes tests/gimp-live (this run did not name it)', () => {
    expect(config.test?.exclude).toContain('tests/gimp-live/**');
  });

  it('npm run test:gimp runs it', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:gimp']).toBe('vitest run tests/gimp-live');
  });
});

describe('gimp.yml runs the live suite on every pull request that touches the GIMP surface', () => {
  const workflow = read('.github/workflows/gimp.yml');
  const pathsBlock = workflow.match(/pull_request:\n\s+paths:\n((?:\s+- '[^']+'\n)+)/);

  it.each([
    'src/backends/**',
    'src/tools/gimp-*.ts',
    'src/modules/gimp/**',
    'src/core/server.ts',
    'src/core/tool-tiers.ts',
    'src/core/tool-groups.ts',
    'src/index.ts',
    'src/kernel/**',
    'src/cli/config.ts',
    'src/utils/validate.ts',
    'src/utils/temp.ts',
    'src/utils/tool-helpers.ts',
    'src/utils/operation-timeouts.ts',
    'src/utils/gimp-path.ts',
    'src/core/settings.ts',
    'scripts/copy-gimp-bridge.ts',
    'scripts/lib/build-common.ts',
    'package.json',
    'package-lock.json',
    'vitest.config.ts',
    'tests/gimp-live/**',
    'tests/fixtures/fake-gimp-session.ts',
    '.github/workflows/gimp.yml',
  ])('the path filter includes %s', (path) => {
    expect(pathsBlock, 'pull_request.paths block').not.toBeNull();
    expect(pathsBlock![1]).toContain(`- '${path}'`);
  });

  it('every job runs the full suite through npm run test:gimp', () => {
    for (const job of ['gimp-windows', 'gimp-macos', 'gimp-linux']) {
      expect(workflow, `${job} is defined`).toMatch(new RegExp(`\\n  ${job}:\\n`));
    }
    expect(workflow.match(/run: npm run test:gimp\n/g)).toHaveLength(3);
    expect(workflow).not.toMatch(/run: npx vitest run tests\/gimp-live\n/);
  });
});

describe('ci.yml never lets the bridge Python tests skip silently', () => {
  it('sets EDITMAMEI_REQUIRE_PYTHON on both the Windows and the macOS test step', () => {
    const ci = read('.github/workflows/ci.yml');
    const steps = [...ci.matchAll(/- name: test\n((?:\s{8,}.*\n)+?)\s+run: npm test\n/g)];
    expect(steps).toHaveLength(2);
    for (const [, body] of steps) {
      expect(body).toMatch(/EDITMAMEI_REQUIRE_PYTHON: '1'/);
    }
  });
});
