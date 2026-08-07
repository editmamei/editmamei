import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { buildSkillZip } from '../../scripts/build-skill-zip.ts';

describe('buildSkillZip', () => {
  it('produces a non-empty zip with editmamei/SKILL.md at the root', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'skill-zip-test-'));
    const destPath = join(tempDir, 'editmamei-skill.zip');
    try {
      const result = buildSkillZip({ destPath, silent: true });
      expect(result.destPath).toBe(destPath);
      expect(existsSync(destPath)).toBe(true);

      const stat = statSync(destPath);
      // Sanity check — SKILL.md alone should be >2KB. An empty zip
      // would be sub-100 bytes.
      expect(stat.size).toBeGreaterThan(1000);

      const zip = new AdmZip(destPath);
      const entries = zip.getEntries().map((e) => e.entryName);
      // Anthropic's Skills upload expects the skill folder at the zip
      // root: unzipping should produce ./editmamei/SKILL.md, not
      // ./SKILL.md. Verify the prefix.
      expect(entries.some((name) => name === 'editmamei/SKILL.md')).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
