# Installation

Editmamei is an MCP server that drives your locally installed Adobe Photoshop. It installs two ways: a one-click `.mcpb` extension for Claude Desktop (no terminal, no Node), or the `editmamei` npm package for Claude Code, Cursor, and any other MCP client. Both deliver the same tools. On the npm path, the `editmamei install` subcommand detects your MCP clients and writes each one's config in a single pass; manual configuration is documented below as a fallback.

---

## Requirements: Photoshop 2026, Node 20+, Windows or macOS

- **Adobe Photoshop 2026 (internal version 27.x).** The only version Editmamei has been verified against. Earlier majors may work but are unverified; see [faq.md](faq.md#which-photoshop-versions-are-supported) for the rationale.
- **Operating system:** Windows 10/11 or macOS 12+.
- **Node.js 20 or later** ([nodejs.org](https://nodejs.org/)), for the npm install path only. The `.mcpb` extension doesn't need it; Claude Desktop bundles its own runtime.
- An **MCP-compatible client**, at least one of:
  - [Claude Desktop](https://claude.ai/download)
  - [Cursor](https://cursor.com/)
  - [Claude Code](https://claude.ai/code)

---

## One-click install (Claude Desktop)

The fastest path if you use Claude Desktop. No terminal, and nothing else to install: Claude Desktop ships its own Node runtime.

1. Download the latest [`editmamei.mcpb`](https://github.com/editmamei/editmamei/releases/latest/download/editmamei.mcpb).
2. In Claude Desktop, open **Settings → Extensions**.
3. Install the downloaded `editmamei.mcpb`.
4. Restart Claude Desktop.

The telemetry switches and your Pro license key (if you have one) live in the extension's own settings under Settings → Extensions → Editmamei, so there's no config file to edit. Then skip ahead to [Photoshop preferences](#photoshop-preferences) and [Verify](#verify).

---

## Install from npm (Claude Code, Cursor, any MCP client)

For clients that already have Node. Confirm your Node.js version:

```bash
node --version
```

If you see `v20.x` or higher, install the CLI globally:

```bash
npm install -g editmamei
```

---

## Register with your MCP client(s)

```bash
editmamei install
```

`editmamei install` runs against every supported client in one pass and prints a per-client result line. The clients today are:

| Client | Detection | Config touched |
|---|---|---|
| **Claude Desktop** | always written (canonical client) | `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| **Cursor** | written if `~/.cursor/` exists or `cursor` is on your PATH | `~/.cursor/mcp.json` |
| **Claude Code** | written if the `claude` binary is on your PATH | uses `claude mcp add --scope user editmamei -- npx -y editmamei` under the hood |

For each detected client, the command:

1. Reads the existing config (refuses to overwrite if the JSON is malformed; fix that first).
2. Backs up the existing file to `<config>.bak` only if no `.bak` is already there. The pre-install state is more valuable than any of our own first-run output, so a second install never clobbers the original backup.
3. Adds an `editmamei` entry to `mcpServers`, or no-ops if the entry already matches. Any env vars you've hand-added to the `editmamei` entry (e.g. `LOG_LEVEL`) are preserved; install only overrides the keys it explicitly sets.

If a client isn't detected, that line is reported as "skipped" and doesn't abort the run.

The command also drops the Editmamei skill bundle (`editmamei-skill.zip`) into your Downloads folder and prints instructions for uploading it to claude.ai (Settings → Customize → Skills). The bundle is only for driving Editmamei from claude.ai; if you don't use claude.ai, ignore the file or pass `--skip-skill`.

Restart your AI client(s) after this completes. Config changes only take effect on a fresh boot.

### Options

- `--dev`: register the locally-built binary at the path you're invoking from instead of `npx -y editmamei`. Used for testing local changes.
- `--photoshop-path <path>`: bake an absolute path to your Photoshop binary into the MCP server entry as the `PHOTOSHOP_PATH` env var, across every detected client. Use when Photoshop is installed somewhere the auto-detector can't find (custom drive letter, side-by-side installs, beta tracks, etc.). Example:

  ```bash
  editmamei install --photoshop-path "D:\\Adobe\\Photoshop 2026\\Photoshop.exe"
  ```

  Equivalent to hand-editing `env: { "PHOTOSHOP_PATH": "..." }` into the `editmamei` entry of every config the install touches.

- `--skip-skill`: don't copy the claude.ai skill bundle to Downloads. For headless or CI installs where the upload step doesn't apply.

### Check your install state

```bash
editmamei status
```

Reports, per client, whether Editmamei is registered and what command would launch it. Run this when troubleshooting.

---

## Manual configuration

If `editmamei install` couldn't reach one of your clients (for example, because the `claude` binary isn't on your PATH, or you're using a different MCP-compatible client), register Editmamei by hand.

### Claude Desktop

Edit `claude_desktop_config.json`:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "editmamei": {
      "command": "npx",
      "args": ["-y", "editmamei", "serve"]
    }
  }
}
```

### Cursor

Edit `~/.cursor/mcp.json` (create if it doesn't exist):

```json
{
  "mcpServers": {
    "editmamei": {
      "command": "npx",
      "args": ["-y", "editmamei", "serve"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add --scope user editmamei -- npx -y editmamei
```

`--scope user` registers Editmamei for your whole account; without it the registration is scoped to the current project directory and silently disappears when Claude Code runs elsewhere.

---

## Photoshop preferences

Open Photoshop and confirm:

1. **Edit → Preferences → Scripting and Actions** (Windows) or **Photoshop → Settings → Scripting and Actions** (macOS): scripting is enabled
2. Have at least one document open (or be ready to ask the AI to create one)

The AI talks to whatever instance of Photoshop is currently running, so Photoshop must be open before you start a session.

### Optional: pin a specific Photoshop install

Editmamei auto-detects Photoshop. If you have multiple versions installed and want to pin a specific one, set the `PHOTOSHOP_PATH` env var in your MCP client config:

```json
{
  "mcpServers": {
    "editmamei": {
      "command": "npx",
      "args": ["-y", "editmamei", "serve"],
      "env": {
        "PHOTOSHOP_PATH": "C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe"
      }
    }
  }
}
```

---

## Verify

Restart your MCP client. Editmamei tools should appear in the available-tools list (in Claude Desktop, that's the slider icon at the bottom of the chat input).

Test with the ping:

> "Is Photoshop connected? What version?"

You should see your Photoshop version returned. If not, see [getting-started.md](getting-started.md) for troubleshooting.

---

## Upgrade

**npm install:**

```bash
npm install -g editmamei@latest
```

Restart your MCP client to pick up the new version.

**Claude Desktop (`.mcpb`):** download the latest [`editmamei.mcpb`](https://github.com/editmamei/editmamei/releases/latest/download/editmamei.mcpb) and reinstall it under **Settings → Extensions**, then restart Claude Desktop.

Either way, your existing templates and session logs at `~/.editmamei/` are preserved across upgrades.

---

## Uninstall

```bash
editmamei uninstall
npm uninstall -g editmamei
```

The `uninstall` subcommand removes Editmamei from your MCP client configs. The `npm uninstall` removes the package itself. Your per-user data at `~/.editmamei/` (templates, session logs) is left in place; delete it manually if you don't want it.

---

## Pro

Pro is a downloaded **module**, not a separate install. Keep your Community setup as-is; when you activate a license, Editmamei fetches the signed Pro module and loads it alongside Community after a restart. Buy at [editmamei.com/pricing](https://editmamei.com/pricing), then activate with your license key: with an npm install, run `editmamei activate YOUR-KEY` and restart your client; with the Claude Desktop extension, paste your key into **Settings → Extensions → Editmamei → Pro license key** and restart. The license re-validates roughly daily in the background; if a subscription lapses there's a seven-day grace window, then Editmamei keeps running as Community rather than locking you out. Full steps at [editmamei.com/activate](https://editmamei.com/activate). See [pro-features.md](pro-features.md) for what Pro adds and [roadmap.md](roadmap.md) for what's planned next.
