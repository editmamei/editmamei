/*
 * Builds the two editor-named npm packages, @editmamei/photoshop-mcp and
 * @editmamei/gimp-mcp, into packages/wrappers/<name>/.
 *
 * Each is a launcher (wrappers/launcher.mjs) that starts the `editmamei`
 * server with EDITMAMEI_EDITOR set, plus a README and the license. The
 * package.json is generated here rather than committed: its version and its
 * exact `editmamei` dependency both come from the root package.json, so a
 * release needs no extra version bump and the pair can never drift.
 *
 * The release workflow runs this and publishes each package after the main
 * one. A wrapper must be republished on every release: npx re-checks the
 * wrapper's own version, not its dependency's, so a stale wrapper keeps its
 * users on the old server.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Wrapper {
  /** Folder under wrappers/ holding the README; also the package's unscoped name. */
  dir: string;
  editor: 'photoshop' | 'gimp';
  description: string;
  keywords: string[];
}

export const WRAPPERS: readonly Wrapper[] = [
  {
    dir: 'photoshop-mcp',
    editor: 'photoshop',
    description:
      'MCP server for AI photo editing in Adobe Photoshop: your AI app edits in layers and masks you can keep editing. Runs Editmamei with its Photoshop tools.',
    keywords: [
      'photoshop',
      'photoshop-mcp',
      'mcp',
      'mcp-server',
      'photo-editing',
      'ai',
      'editmamei',
    ],
  },
  {
    dir: 'gimp-mcp',
    editor: 'gimp',
    description:
      'MCP server for AI photo editing in GIMP: your AI app edits with live filters and layers you can keep editing. Runs Editmamei with its GIMP tools.',
    keywords: ['gimp', 'gimp-mcp', 'mcp', 'mcp-server', 'photo-editing', 'ai', 'editmamei'],
  },
];

export function packageName(w: Wrapper): string {
  return `@editmamei/${w.dir}`;
}

export function binName(w: Wrapper): string {
  return `editmamei-${w.dir}`;
}

export interface BuildWrappersOptions {
  outDir?: string;
  silent?: boolean;
}

export function launcherFor(editor: Wrapper['editor']): string {
  const source = readFileSync(join(REPO_ROOT, 'wrappers', 'launcher.mjs'), 'utf8');
  const marker = /^const EDITOR = '[a-z]+';$/m;
  if (!marker.test(source)) {
    throw new Error('wrappers/launcher.mjs: the `const EDITOR = ...;` line is missing or changed');
  }
  return source.replace(marker, `const EDITOR = '${editor}';`);
}

export function buildWrappers(opts: BuildWrappersOptions = {}): string[] {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license: string;
    engines?: { node?: string };
  };
  const outDir = opts.outDir ?? join(REPO_ROOT, 'packages', 'wrappers');
  const built: string[] = [];

  for (const w of WRAPPERS) {
    const dest = join(outDir, w.dir);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(dest, 'bin'), { recursive: true });

    const bin = `bin/${binName(w)}.mjs`;
    const pkg = {
      name: packageName(w),
      version: root.version,
      description: w.description,
      keywords: w.keywords,
      homepage: 'https://editmamei.com',
      repository: {
        type: 'git',
        url: 'git+https://github.com/editmamei/editmamei.git',
        directory: `wrappers/${w.dir}`,
      },
      bugs: { url: 'https://github.com/editmamei/editmamei/issues' },
      license: root.license,
      type: 'module',
      bin: { [binName(w)]: bin },
      files: ['bin', 'README.md', 'LICENSE.md'],
      engines: { node: root.engines?.node ?? '>=22.0.0' },
      dependencies: { [root.name]: root.version },
      publishConfig: { access: 'public', provenance: true },
    };

    writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    writeFileSync(join(dest, bin), launcherFor(w.editor), { mode: 0o755 });
    copyFileSync(join(REPO_ROOT, 'wrappers', w.dir, 'README.md'), join(dest, 'README.md'));
    copyFileSync(join(REPO_ROOT, 'LICENSE.md'), join(dest, 'LICENSE.md'));
    built.push(dest);
    if (!opts.silent) console.log(`built ${pkg.name}@${pkg.version} -> ${dest}`);
  }
  return built;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildWrappers();
}
