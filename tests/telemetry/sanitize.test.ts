import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeMessage,
  sanitizeSnippet,
  sanitizeStderrTail,
  MAX_SNIPPET_LEN,
  MAX_STDERR_TAIL_LEN,
} from '@editmamei/telemetry/sanitize.ts';
import { looksLikeAbsolutePath } from '@editmamei/telemetry/events.ts';

describe('sanitizeMessage', () => {
  it('collapses an absolute Windows path to its basename', () => {
    const out = sanitizeMessage('failed reading C:\\Work\\Client\\secret.psd while opening');
    expect(out).not.toContain('\\');
    expect(out).not.toContain('C:');
    expect(out).toContain('secret.psd');
  });

  it('collapses an absolute POSIX path to its basename', () => {
    const out = sanitizeMessage('open /Users/amber/Pictures/raw/shoot.psd failed');
    expect(out).toContain('shoot.psd');
    expect(out).not.toContain('/Users/amber');
  });

  it('redacts the running home directory', () => {
    const inside = join(homedir(), 'Desktop', 'a.psd');
    const out = sanitizeMessage(`could not write ${inside}`);
    expect(out).not.toContain(homedir());
  });

  it('leaves content-free text (and "I/O") untouched in substance', () => {
    const out = sanitizeMessage('I/O error: command not currently available');
    expect(out).toContain('command not currently available');
  });

  it('preserves non-path slash punctuation ("I/O", "read/write") unchanged', () => {
    // Single-segment, non-anchored slashes are word punctuation, not paths — the
    // single-segment-POSIX redaction must NOT fire on them (M7 over-redaction guard).
    expect(sanitizeMessage('I/O error')).toBe('I/O error');
    expect(sanitizeMessage('read/write conflict')).toBe('read/write conflict');
    expect(sanitizeMessage('and/or both fail')).toBe('and/or both fail');
  });

  it('redacts a single-segment absolute POSIX path (M7 — bare client codename)', () => {
    // `/ClientCodename` survived before the fix: basenamePaths only matched 2+ segments,
    // then the leading-`/` strip exposed the bare name. Now it collapses to a marker.
    const out = sanitizeMessage('could not open /ClientCodename for write');
    expect(out).not.toContain('ClientCodename');
    expect(looksLikeAbsolutePath(out)).toBe(false);
  });

  it('redacts a username under a Users/<name> parent not returned by homedir() (M low fallback)', () => {
    // DOS 8.3 / junction representations carry the username under a `Users/` parent the
    // literal homedir-prefix scan never sees. The generic fallback scrubs it.
    const out = sanitizeMessage('mount failed at C:\\Users\\ALICE~1');
    expect(out).not.toContain('ALICE~1');
    expect(looksLikeAbsolutePath(out)).toBe(false);
  });

  it('always yields a value the server path-guard accepts', () => {
    for (const m of [
      'C:\\Users\\me\\a.psd',
      '/etc/passwd contents',
      'mixed C:/x/y and /a/b/c paths',
      '\\\\server\\share\\file',
      'file:///Users/me/Pictures/raw.psd',
    ]) {
      expect(looksLikeAbsolutePath(sanitizeMessage(m))).toBe(false);
    }
  });

  it('basenames UNC paths so directory/client names do not survive', () => {
    const out = sanitizeMessage('write failed \\\\nas\\ClientAcme\\project42\\final.psd');
    expect(out).toContain('final.psd');
    expect(out).not.toContain('ClientAcme');
    expect(out).not.toContain('project42');
  });

  it('basenames file:// URLs', () => {
    const out = sanitizeMessage('load file:///Users/amber/Secret/Project/shot.psd failed');
    expect(out).toContain('shot.psd');
    expect(out).not.toContain('Secret');
    expect(out).not.toContain('Project');
  });

  it('truncates to the cap', () => {
    expect(sanitizeMessage('x'.repeat(5000)).length).toBeLessThanOrEqual(2000);
  });
});

describe('sanitizeSnippet', () => {
  it('clamps to the snippet cap', () => {
    expect(sanitizeSnippet('a'.repeat(500)).length).toBeLessThanOrEqual(MAX_SNIPPET_LEN);
  });
});

describe('sanitizeStderrTail', () => {
  it('clamps to the stderr cap and stays path-guard-safe', () => {
    const out = sanitizeStderrTail('C:\\logs\\x ' + 'y'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(MAX_STDERR_TAIL_LEN);
    expect(looksLikeAbsolutePath(out)).toBe(false);
  });
});
