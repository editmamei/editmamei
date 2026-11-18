import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRAPPERS, binName, buildWrappers, packageName } from '../../scripts/build-wrappers.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'editmamei-wrappers-'));
  buildWrappers({ outDir, silent: true });
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('wrapper packages', () => {
  for (const w of WRAPPERS) {
    describe(packageName(w), () => {
      it('versions with editmamei and depends on exactly that release', () => {
        // npx re-checks only the wrapper's own version, so a range here would let
        // an older cached server run under a newer wrapper, and vice versa.
        const pkg = JSON.parse(readFileSync(join(outDir, w.dir, 'package.json'), 'utf8'));
        expect(pkg.name).toBe(packageName(w));
        expect(pkg.version).toBe(rootPkg.version);
        expect(pkg.dependencies).toEqual({ editmamei: rootPkg.version });
        expect(pkg.license).toBe(rootPkg.license);
        expect(pkg.engines.node).toBe(rootPkg.engines.node);
        expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true });
        expect(pkg.repository.directory).toBe(`wrappers/${w.dir}`);
      });

      it('has exactly one bin, so `npx -y <package>` runs it', () => {
        const pkg = JSON.parse(readFileSync(join(outDir, w.dir, 'package.json'), 'utf8'));
        expect(Object.keys(pkg.bin)).toEqual([binName(w)]);
        for (const f of [pkg.bin[binName(w)], 'README.md', 'LICENSE.md']) {
          expect(existsSync(join(outDir, w.dir, f)), f).toBe(true);
        }
      });

      it(`pins the editor to ${w.editor}`, () => {
        const bin = readFileSync(join(outDir, w.dir, 'bin', `${binName(w)}.mjs`), 'utf8');
        expect(bin).toContain(`const EDITOR = '${w.editor}';`);
        expect(bin.startsWith('#!/usr/bin/env node\n')).toBe(true);
      });
    });
  }
});

describe('editmamei package shape the launcher relies on', () => {
  it('has no exports map and ships dist/index.js, so require.resolve finds the server by path', () => {
    // An exports map without "./dist/index.js" would make every wrapper fail to start.
    expect(rootPkg.exports).toBeUndefined();
    expect(rootPkg.main).toBe('dist/index.js');
    expect(rootPkg.files).toContain('dist');
  });
});

describe('launcher', () => {
  let project: string;

  beforeAll(() => {
    // A project laid out the way npx installs a wrapper: the wrapper and its
    // `editmamei` dependency side by side under node_modules. The fake server
    // echoes stdin to stdout (the MCP channel) and reports what it was given on
    // stderr, then exits with a code the launcher must pass through.
    project = mkdtempSync(join(tmpdir(), 'editmamei-launcher-'));
    const nm = join(project, 'node_modules');
    mkdirSync(join(nm, '@editmamei'), { recursive: true });
    cpSync(join(outDir, 'photoshop-mcp'), join(nm, '@editmamei', 'photoshop-mcp'), {
      recursive: true,
    });
    mkdirSync(join(nm, 'editmamei', 'dist'), { recursive: true });
    writeFileSync(
      join(nm, 'editmamei', 'package.json'),
      JSON.stringify({ name: 'editmamei', version: '0.0.0', type: 'module' })
    );
    writeFileSync(
      join(nm, 'editmamei', 'dist', 'index.js'),
      [
        "let input = '';",
        "process.stdin.on('data', (c) => (input += c));",
        "process.stdin.on('end', () => {",
        '  process.stdout.write(input);',
        '  process.stderr.write(JSON.stringify({ editor: process.env.EDITMAMEI_EDITOR, args: process.argv.slice(2) }));',
        '  process.exit(7);',
        '});',
      ].join('\n')
    );
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  function run(env: NodeJS.ProcessEnv) {
    const bin = join(
      project,
      'node_modules',
      '@editmamei',
      'photoshop-mcp',
      'bin',
      'editmamei-photoshop-mcp.mjs'
    );
    return spawnSync(process.execPath, [bin, '--flag'], {
      input: '{"jsonrpc":"2.0"}\n',
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
  }

  it('starts the server with the editor set, passing stdio, arguments and the exit code through', () => {
    const env = { ...process.env };
    delete env.EDITMAMEI_EDITOR;
    const r = run(env);
    expect(r.stdout).toBe('{"jsonrpc":"2.0"}\n');
    expect(JSON.parse(r.stderr)).toEqual({ editor: 'photoshop', args: ['--flag'] });
    expect(r.status).toBe(7);
  });

  it('leaves an EDITMAMEI_EDITOR the user set alone', () => {
    const r = run({ ...process.env, EDITMAMEI_EDITOR: 'auto' });
    expect(JSON.parse(r.stderr).editor).toBe('auto');
  });
});
