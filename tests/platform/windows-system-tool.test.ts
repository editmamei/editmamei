import { describe, expect, it } from 'vitest';
import { windowsSystemTool } from '@editmamei/platform/windows-system-tool.ts';

describe('windowsSystemTool', () => {
  it('resolves under SystemRoot, never a bare name the current directory could shadow', () => {
    expect(windowsSystemTool('reg.exe', { SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\reg.exe'
    );
    expect(windowsSystemTool('cscript.exe', { SystemRoot: 'D:\\WINNT' })).toBe(
      'D:\\WINNT\\System32\\cscript.exe'
    );
  });

  it('falls back to windir, then C:\\Windows', () => {
    expect(windowsSystemTool('tasklist.exe', { windir: 'E:\\Win' })).toBe(
      'E:\\Win\\System32\\tasklist.exe'
    );
    expect(windowsSystemTool('taskkill.exe', {})).toBe('C:\\Windows\\System32\\taskkill.exe');
  });
});
