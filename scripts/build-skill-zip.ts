/*
 * Bundles skills/editmamei/ into dist/skills/editmamei-skill.zip.
 *
 * The zip layout is what Anthropic's Skills feature expects on upload:
 * the zip's root contains the skill folder (not the folder's contents),
 * i.e. unzipping produces ./editmamei/SKILL.md rather than ./SKILL.md.
 *
 * Runs after tsc via the postbuild hook in package.json so every dev
 * build (npm run build) carries an up-to-date skill bundle that
 * matches the source. The CE / Pro build scripts call this helper
 * separately so the per-edition packages/<edition>/dist/skills/ mirror.
 *
 * The npm package's files array includes dist/, so the zip ships in
 * the published tarball at node_modules/editmamei/dist/skills/
 * editmamei-skill.zip. The editmamei install CLI copies it from there
 * to the user's Downloads folder for manual upload to claude.ai →
 * Settings > Customize > Skills.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export interface BuildSkillZipOptions {
  /**
   * Where to place the output zip. Defaults to
   * `<repoRoot>/dist/skills/editmamei-skill.zip`. CE/Pro builds
   * override to write into `packages/<edition>/dist/skills/`.
   */
  destPath?: string;
  /**
   * Suppress the success line. Tests use this; build hooks don't.
   */
  silent?: boolean;
}

export function buildSkillZip(opts: BuildSkillZipOptions = {}): { destPath: string } {
  const skillSourceDir = join(REPO_ROOT, 'skills', 'editmamei');

  // Sanity-check the source before zipping. Avoids producing an empty
  // bundle if someone deletes the SKILL.md by mistake.
  if (!existsSync(skillSourceDir)) {
    throw new Error(
      `buildSkillZip: skill source not found at ${skillSourceDir}. Expected SKILL.md and any companion files to live there.`
    );
  }
  const skillMd = join(skillSourceDir, 'SKILL.md');
  if (!existsSync(skillMd)) {
    throw new Error(`buildSkillZip: ${skillMd} missing. The zip needs a SKILL.md at minimum.`);
  }
  const stat = statSync(skillMd);
  if (stat.size === 0) {
    throw new Error(`buildSkillZip: ${skillMd} is empty. Refusing to produce an empty bundle.`);
  }

  const destPath = opts.destPath ?? join(REPO_ROOT, 'dist', 'skills', 'editmamei-skill.zip');
  mkdirSync(dirname(destPath), { recursive: true });

  const zip = new AdmZip();
  // Second arg is the in-zip prefix. PASSING 'editmamei' means unzipping
  // produces ./editmamei/SKILL.md (folder at zip root), which is what
  // Anthropic's Skills upload expects. Do NOT change the prefix without
  // updating the SKILL.md frontmatter `name` to match — they must agree.
  zip.addLocalFolder(skillSourceDir, 'editmamei');
  zip.writeZip(destPath);

  if (!opts.silent) {
    // eslint-disable-next-line no-console
    console.log(`Built skill bundle: ${destPath}`);
  }

  return { destPath };
}

// Run when invoked directly (postbuild hook), not when imported.
// Use pathToFileURL so the comparison works on Windows (file:///E:/...)
// as well as POSIX (file:///home/...) without manual path munging.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSkillZip();
}
