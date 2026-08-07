/**
 * Per-OS resolution of the Claude Desktop config file path.
 *
 * macOS:    ~/Library/Application Support/Claude/claude_desktop_config.json
 * Windows:  %APPDATA%\Claude\claude_desktop_config.json
 * Linux:    ~/.config/Claude/claude_desktop_config.json
 *
 * Linux isn't an officially supported Claude Desktop platform, but the
 * Electron app and its config follow the standard XDG / Linux convention
 * when run there — included so the helper isn't surprising.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cursor's MCP config lives at `~/.cursor/mcp.json` on all platforms. The
 * Cursor docs treat this as the user-level scope; per-workspace overrides
 * are project-scoped (`<project>/.cursor/mcp.json`) and we don't touch
 * those.
 */
export function getCursorMcpConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

export function getClaudeDesktopConfigPath(
  platform: typeof process.platform = process.platform
): string {
  switch (platform) {
    case 'darwin':
      return join(
        homedir(),
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json'
      );
    case 'win32': {
      // Prefer %APPDATA% — it's always set on a normal Windows session
      // and honors roaming profiles correctly. Fall back to USERPROFILE
      // (always present) before homedir() so heavily-stripped envs (CI
      // containers, freshly-created users) still get a sensible path.
      const appData =
        process.env.APPDATA ??
        (process.env.USERPROFILE
          ? join(process.env.USERPROFILE, 'AppData', 'Roaming')
          : join(homedir(), 'AppData', 'Roaming'));
      return join(appData, 'Claude', 'claude_desktop_config.json');
    }
    case 'linux':
      return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    default:
      throw new Error(
        `Unsupported platform: ${platform}. Claude Desktop ships on macOS and Windows; ` +
          `Linux works on a best-effort basis. Other platforms have no Claude Desktop install path.`
      );
  }
}
