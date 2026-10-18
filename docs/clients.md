# AI clients

Editmamei is a local MCP stdio server. Any client that can launch a local command and run MCP tools can in principle connect to it. This page lists the clients we document, what has been tested, and the settings each one needs.

The launch command is the same everywhere:

```
npx -y editmamei
```

It needs Node.js 22 or later (see [installation.md](installation.md)), except for the Claude Desktop extension, which bundles its own runtime. Browser-only clients (claude.ai and ChatGPT on the web) accept only remote connectors, so they can't launch a local server.

## Status

| Client | Status | Config |
|---|---|---|
| [Claude Desktop](#claude-desktop) | Tested | `.mcpb` extension or JSON |
| [Claude Code](#claude-code) | Tested | CLI command |
| [Cursor](#cursor) | The tool cap may apply (see the tool limit note); set `EDITMAMEI_EDITOR=photoshop` to reduce the tool count | JSON or deeplink |
| [VS Code (Copilot agent mode)](#vs-code-copilot-agent-mode) | Not yet tested | JSON, CLI or install link |
| [Visual Studio](#visual-studio) | Not yet tested | JSON |
| [Codex](#codex) | Not yet tested | TOML or CLI command |
| [Windsurf / Devin Desktop](#windsurf--devin-desktop) | Not yet tested | JSON |
| [Warp](#warp) | Not yet tested | JSON |
| [Zed](#zed) | Not yet tested | JSON |
| [Gemini CLI](#gemini-cli) | Not yet tested | JSON or CLI command |
| [Google Antigravity](#google-antigravity) | Not yet tested | JSON |
| [Cline](#cline) | Not yet tested | JSON |
| [Goose](#goose) | Not yet tested | YAML or deeplink |
| [opencode](#opencode) | Not yet tested | JSON |
| [Kiro](#kiro) | Not yet tested | JSON |
| [JetBrains AI Assistant](#jetbrains-ai-assistant) | Not yet tested | Settings UI |
| [Trae](#trae) | Not yet tested | Settings UI |

"Tested" means the client is part of our regular checks. "Not yet tested" means the configuration below comes from the vendor's documentation and has not been run end to end with Editmamei. It may work, and it may hit one of the known limits in the next section. Status lines will carry a client version and a date once a client has been tested.

Not supported: LM Studio (the model does not receive images that tools return, so Editmamei's preview loop can't work) and Raycast (MCP is limited to its paid plan and isn't covered here).

## Known limits across clients

**Tool count.** Editmamei registers up to 62 tools for Photoshop in Community, 83 with Pro. When GIMP 3.2 is detected, its tools register too, which brings the totals to 91 and 112. Some clients cap the number of tools:

- Cursor: commonly reported as 40. This figure is not in Cursor's documentation.
- Windsurf / Devin Desktop: 100 ([docs](https://docs.devin.ai/desktop/cascade/mcp)).
- VS Code: 128 per request, shared with built-in tools.

If your client truncates the list, set `EDITMAMEI_EDITOR=photoshop` in the server's `env` block to register only the Photoshop tools (or `gimp` for only the GIMP tools). See [gimp.md](gimp.md#pinning-the-editor). Most clients also let you switch off individual tools.

**Timeouts.** Some operations take longer than a minute, such as AI selection and large scene reads. Codex defaults to 300 seconds per tool call ([openai/codex#28234](https://github.com/openai/codex/pull/28234)) and Cline's default is reported as 60 seconds. Raise those limits where the client section below says so.

**Images and structured results.** Editmamei returns preview images alongside structured results. Two clients have open upstream issues around structured results. VS Code still passes tool-result images to the model, but replaces the text content when structured content is present ([microsoft/vscode#290063](https://github.com/microsoft/vscode/issues/290063)). Codex can drop the rest of a tool result when a structured result is present ([openai/codex#10334](https://github.com/openai/codex/issues/10334)), so the model may not see previews there. Until this is tested, treat Codex as possibly limited.

## Claude Desktop

Install the `.mcpb` extension (see [installation.md](installation.md#one-click-install-claude-desktop)), or run `editmamei install`. To edit by hand, add Editmamei under `mcpServers` in `claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

Restart Claude Desktop.

## Claude Code

```bash
claude mcp add --scope user editmamei -- npx -y editmamei
```

On Windows, if the server fails to start, use `-- cmd /c npx -y editmamei` ([Claude Code docs](https://code.claude.com/docs/en/mcp)).

## Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

Cursor's install-link format is documented at [cursor.com/docs/context/mcp/install-links](https://cursor.com/docs/context/mcp/install-links). This link adds Editmamei (paste it into a browser address bar):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=editmamei&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImVkaXRtYW1laSJdfQ==
```

If tools are missing, you may be over Cursor's tool limit. Set `EDITMAMEI_EDITOR=photoshop` and switch off tools you don't use. Config reference: [cursor.com/docs/context/mcp](https://cursor.com/docs/context/mcp).

## VS Code (Copilot agent mode)

Run **MCP: Open User Configuration** from the Command Palette, or create `.vscode/mcp.json` in a workspace. VS Code uses a top-level `servers` key:

```json
{
  "servers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

From a terminal:

```bash
code --add-mcp "{\"name\":\"editmamei\",\"command\":\"npx\",\"args\":[\"-y\",\"editmamei\"]}"
```

VS Code also accepts install links of the form `vscode:mcp/install?<URL-encoded JSON>`:

```
vscode:mcp/install?%7B%22name%22%3A%22editmamei%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22editmamei%22%5D%7D
```

Use agent mode and make sure the Editmamei tools are enabled in the tool picker. Known limits: the 128-tool budget and issue #290063 above. Docs: [code.visualstudio.com/docs/copilot/customization/mcp-servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

## Visual Studio

Windows only. Visual Studio 2026, or 2022 version 17.14 or later. Create `%USERPROFILE%\.mcp.json` (all solutions) or `<solution>\.mcp.json`:

```json
{
  "servers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

Tools are disabled by default. Open the tool picker in Copilot agent mode and enable the Editmamei tools. Docs: [learn.microsoft.com/visualstudio/ide/mcp-servers](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers). It shares VS Code's Copilot engine, so the VS Code limits above may apply.

## Codex

Shared by the CLI, IDE extension and desktop app: `~/.codex/config.toml`.

```toml
[mcp_servers.editmamei]
command = "npx"
args = ["-y", "editmamei"]
tool_timeout_sec = 600
```

Or `codex mcp add editmamei -- npx -y editmamei`, then add the `tool_timeout_sec` line by hand. The default is 300 seconds ([openai/codex#28234](https://github.com/openai/codex/pull/28234)). Known limit: issue #10334 above.

## Windsurf / Devin Desktop

Edit `mcp_config.json`:

- Windows: `%APPDATA%\devin\mcp_config.json`
- macOS and Linux: `~/.config/devin/mcp_config.json`

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

Docs: [docs.devin.ai/desktop/cascade/mcp](https://docs.devin.ai/desktop/cascade/mcp). The product was renamed from Windsurf and Cognition's other pages may still name an older path, so check the file location in your install. The 100-tool limit applies: use `EDITMAMEI_EDITOR=photoshop` if you are over it.

## Warp

Add a server under **Settings > Agents > MCP servers**, or edit `~/.warp/.mcp.json` (global) or `.warp/.mcp.json` (project):

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

Docs: [docs.warp.dev/agent-platform/capabilities/mcp](https://docs.warp.dev/agent-platform/capabilities/mcp/). Check that your Warp plan includes MCP.

## Zed

Add to your Zed `settings.json` (**zed: open settings file**):

```json
{
  "context_servers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"], "env": {} }
  }
}
```

Docs: [zed.dev/docs/ai/mcp](https://zed.dev/docs/ai/mcp).

## Gemini CLI

```bash
gemini mcp add editmamei npx -y editmamei
```

Or edit `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

The default request timeout is 10 minutes. Docs: [geminicli.com/docs/tools/mcp-server](https://geminicli.com/docs/tools/mcp-server/).

## Google Antigravity

Edit `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json` (workspace):

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

Docs: [antigravity.google/docs/mcp](https://antigravity.google/docs/mcp).

## Cline

In the Cline panel, open the MCP settings and edit the settings JSON (the Cline CLI reads `~/.cline/mcp.json`):

```json
{
  "mcpServers": {
    "editmamei": {
      "command": "npx",
      "args": ["-y", "editmamei"],
      "autoApprove": []
    }
  }
}
```

Raise the per-server request timeout from its 60-second default in the same panel. Docs: [docs.cline.bot/mcp/configuring-mcp-servers](https://docs.cline.bot/mcp/configuring-mcp-servers).

## Goose

Add an extension in the desktop app, run `goose configure`, or edit `config.yaml` (macOS and Linux: `~/.config/goose/config.yaml`; Windows: `%APPDATA%\goose\config.yaml`):

```yaml
extensions:
  editmamei:
    name: Editmamei
    cmd: npx
    args: [-y, editmamei]
    enabled: true
    type: stdio
    timeout: 300
```

A deeplink for the same entry: `goose://extension?cmd=npx&arg=-y&arg=editmamei&timeout=300&id=editmamei&name=Editmamei`. Docs: [goose-docs.ai](https://goose-docs.ai/docs/getting-started/using-extensions/).

## opencode

Add to `opencode.json` (for example `~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "editmamei": {
      "type": "local",
      "command": ["npx", "-y", "editmamei"],
      "enabled": true
    }
  }
}
```

The documented default `timeout` is 5000 ms, which a cold `npx` start can exceed. Set a larger value if the server fails to connect. Docs: [opencode.ai/docs/mcp-servers](https://opencode.ai/docs/mcp-servers/).

## Kiro

Edit `~/.kiro/settings/mcp.json` (global) or `.kiro/settings/mcp.json` (workspace). Changes apply on save.

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

Docs: [kiro.dev/docs/mcp/configuration](https://kiro.dev/docs/mcp/configuration/).

## JetBrains AI Assistant

Open **Settings | Tools | AI Assistant | Model Context Protocol (MCP)**, click **Add**, and paste:

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
  }
}
```

Docs: [jetbrains.com/help/ai-assistant/mcp.html](https://www.jetbrains.com/help/ai-assistant/mcp.html).

## Trae

Open **Settings > MCP > Add > Add Manually** and paste the same `mcpServers` entry as above. Docs: [docs.trae.ai/ide/add-mcp-servers](https://docs.trae.ai/ide/add-mcp-servers).

## Check it works

After registering Editmamei and restarting the client, open Photoshop and ask:

> "Is Photoshop connected? What version?"

You should see your Photoshop version. If not, see [troubleshooting.md](troubleshooting.md).
