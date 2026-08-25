/**
 * Help text printed by `editmamei --help` / `editmamei help`.
 *
 * Defaults to stdout (the user explicitly asked for help). When the router
 * prints help after an error — unknown subcommand, bad option — it passes
 * a stderr sink so the "Usage:" block lands on the error stream alongside
 * the error message.
 *
 * The empty-argv default (`editmamei` with no args) is what Claude Desktop
 * spawns — that path starts the MCP server, never enters this function.
 */

export function printHelp(write: (s: string) => void = (s) => process.stdout.write(s)): void {
  write(`editmamei — MCP server for Adobe Photoshop, driven by your AI assistant

Usage:
  editmamei                  Start the MCP server (default — what Claude Desktop spawns)
  editmamei install          Register Editmamei with Claude Desktop
  editmamei uninstall        Remove Editmamei from Claude Desktop's config
  editmamei status           Show where Editmamei is currently registered
  editmamei config           Get/set settings (telemetry, privacy) in ~/.editmamei/settings.json
  editmamei activate <key>   Activate a Pro license on this device
  editmamei deactivate       Free this device's seat (before moving Pro to another machine)
  editmamei repair           Re-download the Pro module if it wedged after a host update
                             (fixes it without deleting ~/.editmamei — keeps templates + license)
  editmamei license          Show the current license + whether Pro is unlocked
  editmamei report           Write an anonymized diagnostic bundle to Downloads for a bug report
  editmamei help, --help     Print this help

Install options:
  --dev                      Register the locally-built binary you're invoking right now
                             (uses absolute path to the current script), instead of
                             the published "npx -y editmamei" command. Use for local dev.

  --photoshop-path <path>    Bake an absolute path to your Photoshop binary into the MCP
                             server entry as the PHOTOSHOP_PATH env var. Use when Photoshop
                             isn't at its default install location. Applies to every client
                             that gets configured this run.

  --skip-skill               Skip copying the editmamei skill bundle to your Downloads folder.
                             By default, install drops editmamei-skill.zip in Downloads with
                             instructions for uploading it to claude.ai (Settings > Customize >
                             Skills). Pass this flag for headless / CI installs where the skill
                             upload step doesn't apply.

Config examples:
  editmamei config list                          Show all settings
  editmamei config set telemetry.usage false     Opt out of anonymous usage telemetry
  editmamei config set telemetry.diagnostics true Opt in to sanitized diagnostic detail

Report options:
  --note "<text>"            Attach a short description of the problem to the bundle

Examples:
  npm install -g editmamei && editmamei install
  editmamei install --photoshop-path "D:\\Adobe\\Photoshop 2025\\Photoshop.exe"
  node /path/to/Editmamei/dist/index.js install --dev

Per-user data and session logs live in ~/.editmamei/; uninstall preserves them.

Docs: https://editmamei.com/docs
Issues: https://github.com/editmamei/editmamei/issues
Updates by email: https://editmamei.com/?src=cli
`);
}
