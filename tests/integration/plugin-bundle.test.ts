/**
 * Pins the Claude plugin bundle in plugin/ to the package it launches and to the
 * rules Anthropic's plugin directory checks on every version.
 *
 * The bundle starts the server with `npx -y editmamei@<version>`. The directory
 * requires that pin to be exact, so it has to move with package.json at every
 * release; a stale pin would keep plugin users on an old server. The README is
 * the listing's description and must disclose every host the server contacts,
 * so the hosts are read from the same constants the code uses.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';
import { resolveEndpoint } from '@editmamei/telemetry/transport.ts';
import { resolveDeliveryConfig } from '@editmamei/delivery/config.ts';
import { resolvePolarConfig } from '@editmamei/license/config.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugin');

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(
  readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8')
);
const mcp = JSON.parse(readFileSync(join(PLUGIN_DIR, '.mcp.json'), 'utf8'));
const readme = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const pluginFiles = listFiles(PLUGIN_DIR).map((p) => relative(PLUGIN_DIR, p).replace(/\\/g, '/'));

describe('plugin manifest', () => {
  it('keeps the permanent plugin name', () => {
    // The directory and every install refer to the plugin by this name; it can never change.
    expect(manifest.name).toBe('editmamei');
  });

  it('versions with the npm package', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('carries the package license', () => {
    expect(manifest.license).toBe(pkg.license);
  });

  it('sets the fields the directory warns about, and its icon exists', () => {
    expect(manifest.description).toBeTruthy();
    expect(manifest.author?.name).toBeTruthy();
    expect(existsSync(join(PLUGIN_DIR, manifest.icon))).toBe(true);
  });
});

describe('plugin MCP server', () => {
  it('launches exactly the released package version', () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(['editmamei']);
    expect(mcp.mcpServers.editmamei).toEqual({
      command: 'npx',
      args: ['-y', `${pkg.name}@${pkg.version}`],
    });
  });
});

describe('plugin folder hygiene', () => {
  it('has no top-level bin/, which stops claude.ai and Cowork from installing it', () => {
    expect(existsSync(join(PLUGIN_DIR, 'bin'))).toBe(false);
  });

  it('has no package manifest, lockfile, or registry config', () => {
    // A lockfile triggers an install at plugin install time; a registry config
    // next to an npx launcher blocks submission.
    const banned =
      /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|\.npmrc|bunfig\.toml|uv\.toml)$/;
    expect(pluginFiles.filter((f) => banned.test(f))).toEqual([]);
  });

  it('has no OS metadata files', () => {
    const banned = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)$/;
    expect(pluginFiles.filter((f) => banned.test(f))).toEqual([]);
  });

  it('stays within the file limits that avoid a reviewer hold', () => {
    const images = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
    const textual = new Set(['.md', '.json']);
    expect(pluginFiles.length).toBeLessThanOrEqual(512);
    for (const f of pluginFiles) {
      const ext = extname(f).toLowerCase();
      expect(images.has(ext) || textual.has(ext), `unexpected file type: ${f}`).toBe(true);
      if (!images.has(ext)) {
        expect(statSync(join(PLUGIN_DIR, f)).size, `${f} is over 256 KiB`).toBeLessThan(256 * 1024);
      }
    }
  });

  it('names each skill folder after its frontmatter name', () => {
    const skillsDir = join(PLUGIN_DIR, 'skills');
    for (const dir of readdirSync(skillsDir)) {
      const body = readFileSync(join(skillsDir, dir, 'SKILL.md'), 'utf8');
      expect(body).toMatch(new RegExp(`^---\\r?\\nname: ${dir}\\r?\\n`));
    }
  });
});

describe('plugin README', () => {
  it('meets the 40-word minimum outside code blocks', () => {
    const prose = readme.replace(/```[\s\S]*?```/g, '');
    expect(prose.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
  });

  it('discloses every host the server contacts', () => {
    const updateSource = readFileSync(join(REPO_ROOT, 'src', 'update', 'check.ts'), 'utf8');
    expect(updateSource).toContain('https://registry.npmjs.org/');
    const hosts = [
      new URL(resolveEndpoint({})).host,
      new URL(resolveDeliveryConfig(undefined).baseUrl).host,
      new URL(resolvePolarConfig('production').baseUrl).host,
      'registry.npmjs.org',
    ];
    for (const host of hosts) expect(readme, `README does not mention ${host}`).toContain(host);
  });

  it("names no 'dev' or 'none'-tier tool", () => {
    const hidden = Object.entries(TOOL_TIERS)
      .filter(([, tier]) => tier === 'dev' || tier === 'none')
      .map(([name]) => name);
    const leaks = hidden.filter((name) => new RegExp(`${name}(?![A-Za-z0-9_])`).test(readme));
    expect(leaks).toEqual([]);
  });
});
