/**
 * Pins the Cursor plugin manifest (.cursor-plugin/ at the repository root) and
 * skills.sh.json, the file `npx skills add editmamei/editmamei` reads.
 *
 * Both point into plugin/, so the Claude plugin, the Cursor plugin and the
 * skills CLI share one skill and one icon. The Cursor marketplace refuses
 * manifest paths that are absolute or climb out with `..`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.cursor-plugin', 'plugin.json'), 'utf8'));

function safeRelative(p: string): boolean {
  return !isAbsolute(p) && !p.split(/[\\/]/).includes('..');
}

describe('Cursor plugin manifest', () => {
  it('names the plugin in lowercase kebab-case and carries the package license', () => {
    expect(manifest.name).toBe('editmamei');
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.description).toBeTruthy();
    expect(manifest.author?.name).toBeTruthy();
  });

  it('uses relative paths that exist', () => {
    for (const key of ['logo', 'skills', 'mcpServers'] as const) {
      const p = manifest[key] as string;
      expect(safeRelative(p), `${key}: ${p}`).toBe(true);
      expect(existsSync(join(REPO_ROOT, p)), `${key}: ${p}`).toBe(true);
    }
  });

  it('starts the published server with npx, unpinned so each restart picks up the latest release', () => {
    const mcp = JSON.parse(readFileSync(join(REPO_ROOT, manifest.mcpServers), 'utf8'));
    expect(mcp).toEqual({
      mcpServers: { editmamei: { command: 'npx', args: ['-y', pkg.name] } },
    });
  });
});

describe('skills.sh.json', () => {
  it('points at folders that each hold skills named after their folder', () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'skills.sh.json'), 'utf8'));
    expect(config.paths.length).toBeGreaterThan(0);
    for (const p of config.paths as string[]) {
      // The CLI ignores entries that don't start with ./ or that leave the repository.
      expect(p.startsWith('./')).toBe(true);
      expect(safeRelative(p)).toBe(true);
      const dir = join(REPO_ROOT, p);
      const skills = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory());
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        const body = readFileSync(join(dir, s, 'SKILL.md'), 'utf8');
        expect(body).toMatch(new RegExp(`^---\\r?\\nname: ${s}\\r?\\ndescription: \\S`));
      }
    }
  });
});
