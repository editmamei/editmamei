# Editmamei

Edit photos in desktop Adobe Photoshop or GIMP by describing what you want. Editmamei is an MCP server that runs on your computer, next to your editor, and gives Claude tools to open documents, build adjustment layers, make selections and masks, apply filters, retouch, and export. A bundled skill teaches Claude a non-destructive workflow: assess the photo, plan the edit, apply it one step at a time, then check the result with a preview and histogram before calling it done.

By default your original layer is never overwritten. Tonal and color changes land as adjustment layers, partial edits are masked, and layers are grouped in the order a retoucher would hand off, so you can keep editing the file by hand afterwards.

## What this plugin contains

- **The Editmamei MCP server**, started with `npx -y editmamei@<version>`. The version is pinned to an exact release of the [`editmamei` npm package](https://www.npmjs.com/package/editmamei), whose source is in this repository.
- **The `editmamei` skill**, which tells Claude how to use those tools: when to look before editing, which layer goes where, and how to verify a change.

## Where it works

The server is a local program, so it needs a computer with your editor installed.

| App | What you get |
|---|---|
| Claude Code | Server and skill |
| Cowork, in a session running on your computer | Server and skill |
| Chat on claude.ai, the desktop app, or mobile | Skill only. Chat does not start local servers, so the skill will explain how to install the server for Claude Desktop instead |

## Requirements

- [Node.js](https://nodejs.org) 22 or newer, so `npx` can start the server
- Windows 10/11 or macOS 13+
- Adobe Photoshop 2026 (v27.x), or GIMP 3.2+ for the GIMP tools (GIMP also works on Linux)

## Use it

Install the plugin, open a photo in Photoshop (or point Claude at a file), and ask for the result you want:

- "Warm up this portrait and lift the shadows a little, but keep the sky as it is."
- "Remove the background behind the product and put it on white."
- "Straighten the horizon and remove the sign on the left wall."

Claude checks the connection first, looks at the image, proposes a plan for open-ended requests, and shows you the preview after each step. Precise jobs such as placement and masking come back to you for a yes before they count as done.

## What it runs, sends, and fetches

**Runs on your computer**

- Node.js runs the `editmamei` package, which npm downloads on first start.
- Photoshop is controlled through the operating system's scripting bridge: `cscript` (COM) on Windows and `osascript` on macOS. If Photoshop is closed, Editmamei can start it.
- GIMP runs as a background `gimp-console` process when the GIMP tools are in use.
- Settings live in `~/.editmamei/settings.json`, and a local session log in `~/.editmamei/sessions/`. The log never leaves your machine.

**Network requests**

- **Usage telemetry, on by default** to `editmamei-telemetry-server.editmamei.workers.dev`, Editmamei's own endpoint: content-free events such as the tool name, success, duration, response size, versions, OS, and a random install ID. Never image content, file paths, or what you asked for. Turn it off by setting `telemetry.usage` to `false` in `~/.editmamei/settings.json`.
- **Diagnostics, off by default**: sanitized error detail sent to the same endpoint, only if you set `telemetry.diagnostics` to `true`.
- **Update check** to `registry.npmjs.org`: one request at startup asking for the latest version number, with no identifiers. Turn it off by setting `update_check` to `false`.
- **Pro license, only if you activate one**: the license key and a device identifier go to the licensing service (`api.polar.sh`) at activation and periodically to re-check the license. The license key is then presented to `editmamei-delivery.editmamei.workers.dev` to download the signed Pro module. A Community install makes none of these requests.
- **Previews to Claude**: when Claude needs to see an edit, the tool result carries a downscaled JPEG, the same as attaching a photo to the conversation. Set `privacy.send_previews_to_llm` to `false` to get text-only results.

Every telemetry field, the retention periods, and your rights over the data are listed in the [privacy documentation](https://github.com/editmamei/editmamei/blob/main/docs/privacy.md).

## Editions

The Community edition is free and is what this plugin installs. An optional Pro license adds more tools, including reusable edit templates, Camera Raw develop, named-object selection, batch editing, and a tool that runs a Photoshop script Claude writes, which you approve like any other tool call. See [Pro features](https://github.com/editmamei/editmamei/blob/main/docs/pro-features.md).

## Help

- [Getting started](https://github.com/editmamei/editmamei/blob/main/docs/getting-started.md) and [troubleshooting](https://github.com/editmamei/editmamei/blob/main/docs/troubleshooting.md)
- Bugs and questions: [GitHub issues](https://github.com/editmamei/editmamei/issues)
- Security reports: [SECURITY.md](https://github.com/editmamei/editmamei/blob/main/SECURITY.md)

## License

[FSL-1.1-MIT](https://github.com/editmamei/editmamei/blob/main/LICENSE.md). Each release converts to MIT two years after it is published.
