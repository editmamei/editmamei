# Editmamei

**Give your AI assistant a real photo editor.**

Editmamei is an MCP (Model Context Protocol) server that lets AI apps edit your photos in desktop Adobe Photoshop. Ask for the edit in your own words, and your assistant carries it out with Photoshop's real adjustment layers, masks, selections, and filters. It edits the photo you have instead of generating a new one, and you end up with a layered file you can keep working on yourself. GIMP is supported too.

> Independent project, not affiliated with or endorsed by Adobe Inc.

[![npm version](https://img.shields.io/npm/v/editmamei.svg)](https://www.npmjs.com/package/editmamei)
[![CI](https://github.com/editmamei/editmamei/actions/workflows/ci.yml/badge.svg)](https://github.com/editmamei/editmamei/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](LICENSE.md)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-lightgrey.svg)](docs/installation.md)

**[Install](#install)** · [Website](https://editmamei.com) · [Docs](docs/getting-started.md) · [Editmamei Connect](#editmamei-connect) · [Report a bug](https://github.com/editmamei/editmamei/issues)

<p align="center">
  <a href="https://editmamei.com"><img src="https://raw.githubusercontent.com/editmamei/editmamei/dev/docs/media/batch-flip.webp" width="540" alt="Seventy-three travel photos graded in Photoshop from one sentence: the prompt, the grading calls three photos at a time, and the finished set."></a>
  <br>
  <sub>A real run: 73 travel photos, one sentence, graded in Photoshop.</sub>
</p>

## What you can ask

Once it's connected, talk to your assistant the way you'd brief a retoucher:

- _"Open my vacation photo."_
- _"Make the sky more dramatic but keep the foreground natural."_
- _"Sharpen the eyes, soften the skin, leave everything else alone."_
- _"Isolate the subject onto its own layer with a clean mask."_
- _"Export a 2048px web JPEG."_

Your assistant turns those into tool calls, checks the result with previews and measurements, and iterates.

## Install

### Claude Desktop (no terminal)

1. Download [`editmamei.mcpb`](https://github.com/editmamei/editmamei/releases/latest/download/editmamei.mcpb).
2. In Claude Desktop, go to **Settings → Desktop app → Manage** (next to Extensions) **→ Advanced settings → Install Extension…** and choose the downloaded file.
3. Restart Claude Desktop, then ask it: _"Is Photoshop connected?"_

You don't need Node.js for this route, because Claude Desktop ships its own runtime. The [install guide](docs/installation.md#one-click-install-claude-desktop) covers older versions of the app and updates.

### Claude Code, Cursor, and other MCP apps

```bash
npm install -g editmamei
editmamei install   # registers with Claude Desktop, Cursor, Claude Code
editmamei status    # confirms install state + Photoshop detection
```

Then restart your AI app and ask it: _"Is Photoshop connected?"_ For anything `editmamei install` doesn't detect, see [docs/clients.md](docs/clients.md).

### Requirements

- Adobe Photoshop 2026 (v27.x)
- Windows 10/11 or macOS 13+
- Node.js 22+ (for the npm route only)
- An AI app that can run a local MCP server. Editmamei ships no model of its own and runs on whichever app you connect, so every edit spends that app's tokens.

## Editmamei Connect

Want to edit from a browser or your phone, or don't have Photoshop or GIMP on this computer? [Editmamei Connect](https://editmamei.com/connect) is the hosted version. Add it to Claude, ChatGPT, or another AI app as a connector, send a photo, and get it back edited. There's nothing to install, and it's free to start.

Connect is a separate product, and its source isn't in this repository. It edits on Editmamei's server instead of on your computer, so your photo is uploaded, and uploads are deleted after 24 hours.

## How it works

Editmamei runs on your computer as an MCP **stdio** server written in Node. Your AI app launches it as a subprocess and calls its tools over stdio. Each tool builds a small Photoshop script and runs it in your local Photoshop over the platform's native automation channel:

```
AI client  ──stdio──▶  Editmamei (Node MCP server)
                              │  builds a Photoshop script per tool call
                              ▼
                    COM (Windows) / AppleScript (macOS)
                              │
                              ▼
                     Your local Adobe Photoshop
```

- **Windows** drives Photoshop through COM (the `Photoshop.Application` object).
- **macOS** drives it through AppleScript / OSA.
- Perception (face, object, and scene detection) runs **on-device** with local ONNX computer vision, so the model gets real document coordinates without your image leaving the machine.

Photoshop does the pixel work with its own engine, and edits land as adjustment layers, masks, and duplicates you can keep changing by hand.

**112 tools:** 83 for Photoshop (62 Community, 21 Pro) and 29 for GIMP (all Community). The full list is in [docs/tools.md](docs/tools.md).

### GIMP

Editmamei can also drive GIMP, headless, as a second editor alongside (or instead of) Photoshop. When GIMP 3.2 or newer is detected on your machine, a `gimp_*` tool set registers next to the `ps_*` one; use it when you ask for GIMP, or when Photoshop isn't available. There's no visible window: edits happen in a background `gimp-console` process, and you follow along through rendered previews in the conversation instead of watching a window change. GIMP doesn't yet cover heal/clone or AI subject and sky selection. Details, requirements (including Linux), and troubleshooting are in [docs/gimp.md](docs/gimp.md).

## Free and Pro

- **Community** is free and covers the everyday editing surface: documents, layers, selections (including AI Select Subject and Select Sky), non-destructive adjustments, filters, masks, type, retouching, on-device perception, and the inspect/verify primitives.
- **Pro** adds Camera Raw as a re-editable filter, raw files developed before they open, folder batch, the reproducible-template system, the grounded precision tools (warp, named-object masks, precision placement), subject-instance and face-mesh targeting, and Photoshop Actions plus the scripting escape hatch.

Pro is a Photoshop-only upgrade: it adds nothing to the GIMP tools.

The split is detailed in [pro-features.md](docs/pro-features.md). Pricing is at [editmamei.com/desktop/pricing](https://editmamei.com/desktop/pricing).

This repository holds the Community source. Pro is a separately licensed module and its source is not published here; Community never imports it, so this tree builds and runs on its own.

## Privacy

Editmamei runs on your computer and edits in desktop Photoshop. No image content, document data, or file paths are sent to Editmamei's servers. It reports content-free usage telemetry (on by default, turn it off with `editmamei config set telemetry.usage false`). When your AI assistant needs to see a result, Editmamei sends it a downscaled preview, the same as dropping a photo into a chat with that assistant. Every field is documented in [privacy.md](docs/privacy.md), including [your rights, and the legal basis](docs/privacy.md#your-rights-and-the-legal-basis).

The source in this repository is the same code published to npm, so none of the above has to be taken on trust.

## For developers

The discovery chain is `ps_ping` (liveness), then `ps_overview` (the working method and capability map), then `tools/list` (the full schema-typed inventory).

### Design principles

These are the choices that shape the surface, and the reason an AI assistant can drive it reliably rather than hopefully.

- **Structured results, not prose.** Every tool declares an `outputSchema` and returns a typed JSON payload. Any tool that changes what is active reports the current document and layer back, so the model keeps an accurate picture of Photoshop's state between calls instead of re-deriving it.
- **Guidance lives in the surface.** `ps_overview` returns the working method (assess, plan, enact, check, iterate) and `ps_list_capabilities` returns a live map of what exists. The model orients itself from the server rather than from guesswork or a stale prompt.
- **Measure, don't eyeball.** A dedicated set of verification tools (histogram, region compare, layer-bounds diff, selection preview) lets the model check its own work numerically instead of trusting a thumbnail.
- **On-device perception.** Local computer vision (ONNX) detects faces, objects, and scene regions and returns real document coordinates. The image stays on your machine for this step and is never sent to a cloud vision model.
- **Non-destructive by default.** Adjustments are adjustment layers, and destructive pixel operations run on an auto-created duplicate. An edit is reversible by construction.
- **Verified against real Photoshop.** Every tool is built on Photoshop's own native scripting functions and verified in live Photoshop sessions before it ships. A new tool stays disabled until it has passed live verification, so the shipped surface is the verified surface.
- **Built for modern Photoshop.** Editmamei targets Photoshop 2026 (v27.x) so it can rely on current, stable scripting descriptors rather than carrying a decade of drifted behavior.

### Configuration

Settings live in `~/.editmamei/settings.json`, managed by the `editmamei config` CLI:

```bash
editmamei config list
editmamei config set telemetry.usage false      # turn off usage telemetry
editmamei config set ps_path "/path/to/Photoshop"
```

`PHOTOSHOP_PATH` (env var) overrides Photoshop auto-detection for a single run.

### Build from source

```bash
git clone https://github.com/editmamei/editmamei.git
cd editmamei
npm install
npm run build
npm test
```

You need Node.js 22+ and Go 1.21+ (the build compiles the `editmamei-core` binary that generates Photoshop scripts; it needs Go 1.27, which Go fetches for you from 1.21 on). The build warns instead of failing when Go is missing, so you can still run the test suite; set `EDITMAMEI_CORE_BIN` to a prebuilt binary if you would rather not install Go.

The test suite runs without Photoshop. It verifies the ExtendScript Editmamei generates, never that Photoshop accepted it, so live verification against a real Photoshop is a separate step.

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which covers the CLA, the branch and pull-request flow, and what to include in a bug report.

## Docs and support

- **Features and pricing:** [editmamei.com](https://editmamei.com)
- **Install:** [docs/installation.md](docs/installation.md)
- **Getting started:** [docs/getting-started.md](docs/getting-started.md)
- **Tools:** [docs/tools.md](docs/tools.md)
- **FAQ:** [docs/faq.md](docs/faq.md)
- **AI clients:** [docs/clients.md](docs/clients.md)
- **Troubleshooting:** [docs/troubleshooting.md](docs/troubleshooting.md)
- **GIMP:** [docs/gimp.md](docs/gimp.md)
- **Pro features:** [docs/pro-features.md](docs/pro-features.md)
- **Roadmap:** [docs/roadmap.md](docs/roadmap.md)
- **Bugs and feature requests:** [the issue tracker](https://github.com/editmamei/editmamei/issues). If something's broken, ask your assistant to "report a problem" (or run `editmamei report`) to drop an anonymized diagnostic bundle in your Downloads folder, then attach it to the issue.
- **Security:** see [SECURITY.md](SECURITY.md) (don't file security issues publicly)

## License

Editmamei CE is [Fair Source](https://fair.io) software under the
[Functional Source License, v1.1, MIT Future License](LICENSE.md) (FSL-1.1-MIT).

You can read, run, modify, and redistribute the code for almost anything: commercial photo
editing, internal tools, education, research, security review. The one thing the license
holds back, for two years per release, is offering the code to others in a commercial
product or service that competes with Editmamei CE or Pro. If you redistribute the code,
keep the license and copyright notices with it. Two years after each version ships, that
version automatically becomes available under plain [MIT](LICENSE.md).

This section is a plain-English summary. The [LICENSE](LICENSE.md) file is the license;
where they differ, the LICENSE file controls.

Editmamei is not open source under the OSI definition, and we don't call it that. It is
source-available, with the full CE stack developed in the open.

Editmamei Pro is a separate, commercially licensed module; its source is not published.

Third-party dependencies keep their own licenses, listed in [NOTICES.md](NOTICES.md).
