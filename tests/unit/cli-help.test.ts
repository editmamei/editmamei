import { describe, expect, it } from 'vitest';
import { printHelp } from '../../src/cli/help.js';

/** printHelp takes an injectable writer, so the output is assertable without
 *  touching stdout. */
function helpText(): string {
  let out = '';
  printHelp((s) => {
    out += s;
  });
  return out;
}

describe('CLI help', () => {
  it('lists where to find docs, issues, and release notes', () => {
    const text = helpText();
    expect(text).toContain('https://editmamei.com/docs');
    expect(text).toContain('https://github.com/editmamei/editmamei/issues');
    expect(text).toContain('https://editmamei.com/blog?src=cli');
  });

  it('ends the release-notes line on the URL, with no trailing punctuation', () => {
    // Terminals linkify, and several swallow a trailing period into the href.
    // The same rule governs the update notice in src/core/server.ts.
    const line = helpText()
      .split('\n')
      .find((l) => l.includes('src=cli'));
    expect(line).toBeDefined();
    expect(line!.trimEnd().endsWith('https://editmamei.com/blog?src=cli')).toBe(true);
  });
});
