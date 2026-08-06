import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The public package description lives on four hand-maintained surfaces:
// package.json (npm source), the published CE/Pro strings in
// scripts/lib/build-common.ts, the .mcpb manifest in scripts/build-mcpb.ts
// (what Claude Desktop's Extensions card shows), and server.json (the MCP
// registry manifest). Per the derived-list invariant, a hand-maintained
// mirror needs a sync guard: every surface must lead with package.json's
// description so a copy change can't ship half-applied.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const desc: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).description;

describe('package description sync', () => {
  it('build-common.ts publishes the package.json description with edition suffixes', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'lib', 'build-common.ts'), 'utf8');
    expect(src).toContain(`'${desc} (Community Edition)'`);
    expect(src).toContain(`'${desc} (Pro Edition)'`);
  });

  it('the .mcpb manifest carries the package.json description', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'build-mcpb.ts'), 'utf8');
    expect(src).toContain(`description: '${desc}'`);
  });

  it('server.json leads with the package.json description', () => {
    const serverJson = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
    expect(serverJson.description.startsWith(desc)).toBe(true);
  });
});
