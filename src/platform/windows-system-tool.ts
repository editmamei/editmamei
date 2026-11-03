import { win32 as pathWin32 } from 'node:path';

/**
 * The absolute path of a tool in Windows' own System32 folder (`cscript.exe`, `reg.exe`, …).
 *
 * Started by bare name, Windows looks in the current directory before PATH, and MCP clients
 * often start this server in a project folder. A `reg.bat` or `cscript.exe` in a cloned repo
 * would then run on the first Photoshop call instead of the real tool.
 */
export function windowsSystemTool(
  name: string,
  env: Record<string, string | undefined> = process.env
): string {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return pathWin32.join(root, 'System32', name);
}
