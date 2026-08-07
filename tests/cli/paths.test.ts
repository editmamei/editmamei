import { describe, it, expect, afterEach } from 'vitest';
import { getClaudeDesktopConfigPath } from '@editmamei/cli/paths.ts';

/**
 * `getClaudeDesktopConfigPath()` is pure (homedir lookup + path joins) so
 * the cross-platform branches can be exercised here without faking fs.
 * Each test passes the platform string explicitly rather than mutating
 * `process.platform`.
 */
describe('getClaudeDesktopConfigPath', () => {
  const originalAppData = process.env.APPDATA;

  afterEach(() => {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  });

  it('points at Library/Application Support on macOS', () => {
    const p = getClaudeDesktopConfigPath('darwin');
    expect(p).toMatch(
      /Library[/\\]Application Support[/\\]Claude[/\\]claude_desktop_config\.json$/
    );
  });

  it('points at %APPDATA%\\Claude on Windows when APPDATA is set', () => {
    process.env.APPDATA = 'C:\\Users\\TestUser\\AppData\\Roaming';
    const p = getClaudeDesktopConfigPath('win32');
    expect(p).toContain('AppData');
    expect(p).toContain('Roaming');
    expect(p).toContain('Claude');
    expect(p.endsWith('claude_desktop_config.json')).toBe(true);
  });

  it('falls back under homedir on Windows when APPDATA is unset', () => {
    delete process.env.APPDATA;
    const p = getClaudeDesktopConfigPath('win32');
    expect(p).toContain('AppData');
    expect(p).toContain('Roaming');
    expect(p.endsWith('claude_desktop_config.json')).toBe(true);
  });

  it('points at ~/.config/Claude on Linux', () => {
    const p = getClaudeDesktopConfigPath('linux');
    expect(p).toMatch(/\.config[/\\]Claude[/\\]claude_desktop_config\.json$/);
  });

  it('throws for unsupported platforms', () => {
    expect(() => getClaudeDesktopConfigPath('freebsd')).toThrow(/Unsupported platform/);
  });
});
