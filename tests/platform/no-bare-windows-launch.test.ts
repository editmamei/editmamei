import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

const WINDOWS_TOOLS =
  'cscript|wscript|reg|tasklist|taskkill|where|cmd|powershell|pwsh|wmic|icacls|sc|net|netsh';
const LAUNCH =
  '(?:exec|execAsync|execSync|execFile|execFileAsync|execFileSync|spawn|spawnSync|runChildWithTimeout)';

/** A Windows tool started by name: the current directory could shadow it (windows-system-tool.ts). */
const BARE_NAME = new RegExp(
  `\\b${LAUNCH}\\(\\s*[\`'"]"?(?:${WINDOWS_TOOLS})(?:\\.exe)?(?![\\w-])`,
  'i'
);
/** A system tool run through a shell command line, which adds a cmd.exe layer it doesn't need. */
const THROUGH_A_SHELL = /\b(?:exec|execAsync|execSync)\(\s*`[^`]*windowsSystemTool/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('Windows tool launches', () => {
  it('catches both shapes it is here to stop', () => {
    expect(BARE_NAME.test("execAsync('tasklist /FI x')")).toBe(true);
    expect(BARE_NAME.test('spawn("cscript.exe", [path])')).toBe(true);
    expect(BARE_NAME.test('await execFileAsync(`reg`, [])')).toBe(true);
    expect(THROUGH_A_SHELL.test('execAsync(`"${windowsSystemTool(\'reg.exe\')}" query`)')).toBe(
      true
    );
    expect(BARE_NAME.test("spawn(windowsSystemTool('cscript.exe'), [path])")).toBe(false);
    expect(BARE_NAME.test("spawn('open', ['-a', path])")).toBe(false);
    expect(BARE_NAME.test("runChildWithTimeout('cscript.exe', [path])")).toBe(true);
    expect(BARE_NAME.test("execFileAsync('registry-tool', [])")).toBe(false);
    expect(BARE_NAME.test("execFileAsync('reg-tool', [])")).toBe(false);
  });

  it('never starts one by bare name or through a shell, anywhere in src', () => {
    const found = sourceFiles(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return BARE_NAME.test(text) || THROUGH_A_SHELL.test(text);
    });
    expect(found).toEqual([]);
  });
});
