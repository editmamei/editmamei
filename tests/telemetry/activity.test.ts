import { describe, it, expect } from 'vitest';
import {
  READ_ONLY_TOOLS,
  KEPT_WORK_TOOLS,
  mapClientName,
  parseMajor,
  nodeMajor,
  archToken,
  osMajor,
} from '@editmamei/telemetry/activity.ts';

describe('READ_ONLY_TOOLS / KEPT_WORK_TOOLS', () => {
  it('is a fixed, disjoint pair of sets', () => {
    expect(READ_ONLY_TOOLS.has('ps_ping')).toBe(true);
    expect(READ_ONLY_TOOLS.has('ps_export')).toBe(false);
    expect(KEPT_WORK_TOOLS.has('ps_export')).toBe(true);
    expect(KEPT_WORK_TOOLS.has('ps_save_psd')).toBe(true);
    for (const tool of KEPT_WORK_TOOLS) expect(READ_ONLY_TOOLS.has(tool)).toBe(false);
  });

  it('does not classify an ordinary editing tool as either', () => {
    expect(READ_ONLY_TOOLS.has('ps_add_adjustment_layer')).toBe(false);
    expect(KEPT_WORK_TOOLS.has('ps_add_adjustment_layer')).toBe(false);
  });
});

describe('mapClientName', () => {
  it('maps the real Claude Desktop name ("claude-ai")', () => {
    expect(mapClientName('claude-ai')).toBe('claude_desktop');
  });

  it('maps the real Claude Code name ("claude-code")', () => {
    expect(mapClientName('claude-code')).toBe('claude_code');
  });

  it('recognizes claude-code variants ahead of the generic claude fallback', () => {
    expect(mapClientName('Claude-Code')).toBe('claude_code');
    expect(mapClientName('claude_code')).toBe('claude_code');
    expect(mapClientName('claudecode')).toBe('claude_code');
  });

  it('falls back generic claude names to claude_desktop', () => {
    expect(mapClientName('Claude Desktop')).toBe('claude_desktop');
    expect(mapClientName('CLAUDE')).toBe('claude_desktop');
  });

  it('recognizes cursor, windsurf, and vscode variants', () => {
    expect(mapClientName('Cursor')).toBe('cursor');
    expect(mapClientName('Windsurf')).toBe('windsurf');
    expect(mapClientName('vscode')).toBe('vscode');
    expect(mapClientName('Visual Studio Code')).toBe('vscode');
    expect(mapClientName('code-oss')).toBe('vscode');
  });

  it('falls back to other for an unrecognized or missing name', () => {
    expect(mapClientName('some-other-client')).toBe('other');
    expect(mapClientName(undefined)).toBe('other');
  });
});

describe('parseMajor', () => {
  it('reads the leading integer of a semver-ish string', () => {
    expect(parseMajor('2.1.170')).toBe(2);
    expect(parseMajor('27.8.0')).toBe(27);
    expect(parseMajor('10')).toBe(10);
  });

  it('returns null for undefined or unparseable input', () => {
    expect(parseMajor(undefined)).toBeNull();
    expect(parseMajor('unknown')).toBeNull();
    expect(parseMajor('')).toBeNull();
  });
});

describe('nodeMajor', () => {
  it('matches the leading integer of the real process.versions.node', () => {
    expect(nodeMajor()).toBe(parseMajor(process.versions.node));
  });
});

describe('archToken', () => {
  it('reflects the real process.arch bucket', () => {
    const token = archToken();
    expect(['x64', 'arm64', 'other']).toContain(token);
    if (process.arch === 'x64' || process.arch === 'arm64') {
      expect(token).toBe(process.arch);
    } else {
      expect(token).toBe('other');
    }
  });
});

describe('osMajor', () => {
  it('parses a Windows 10 release string', () => {
    expect(osMajor('win32', '10.0.19045')).toBe(10);
  });

  it('parses a Windows 11 release string by build number', () => {
    expect(osMajor('win32', '10.0.22631')).toBe(11);
    expect(osMajor('win32', '10.0.22000')).toBe(11); // boundary: exactly 22000
    expect(osMajor('win32', '10.0.21999')).toBe(10); // boundary: just under
  });

  it('parses a macOS release string (Darwin major - 9)', () => {
    expect(osMajor('darwin', '24.6.0')).toBe(15); // Sequoia
    expect(osMajor('darwin', '23.6.0')).toBe(14); // Sonoma
    expect(osMajor('darwin', '22.6.0')).toBe(13); // Ventura
  });

  it('parses a Linux kernel release string as its leading integer', () => {
    expect(osMajor('linux', '5.15.0-1053-aws')).toBe(5);
    expect(osMajor('linux', '6.8.0-generic')).toBe(6);
  });

  it('returns null for an unparseable release string', () => {
    expect(osMajor('win32', 'unknown')).toBeNull();
    expect(osMajor('darwin', '')).toBeNull();
    expect(osMajor('linux', 'not-a-version')).toBeNull();
  });
});
