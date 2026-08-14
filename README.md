# Editmamei

**Unlock Photoshop with natural-language photo editing.** AI orchestration, not generation.

> Independent project, not affiliated with or endorsed by Adobe Inc.

[![npm version](https://img.shields.io/npm/v/editmamei.svg)](https://www.npmjs.com/package/editmamei)
[![CI](https://github.com/editmamei/editmamei/actions/workflows/ci.yml/badge.svg)](https://github.com/editmamei/editmamei/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](LICENSE.md)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-lightgrey.svg)](docs/installation.md)

Editmamei is a Model Context Protocol (MCP) server that drives the Adobe Photoshop you already have. You describe the edit in plain words, your AI assistant plans the steps, and your own copy of Photoshop carries them out with its standard adjustment layers, masks, selections, and filters. The AI directs and Photoshop edits. No generative model touches your pixels, and no image is uploaded to perform an edit.

It serves photographers and retouchers who want to edit by conversation just as much as developers wiring Photoshop into an AI pipeline. To learn more or get started, visit **[editmamei.com](https://editmamei.com)**.

**[editmamei.com](https://editmamei.com)** · [Docs](docs/getting-started.md) · [Report a bug](https://github.com/editmamei/editmamei/issues)

## How it works

Editmamei is a pure MCP **stdio** server written in Node. Your AI client launches it as a subprocess and calls its tools over stdio. Each tool builds a small Photoshop script and runs it in your local Photoshop over the platform's native automation channel:

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

Photoshop does the pixel work with its own engine. Editmamei is the conductor, not a renderer.

## Install

```bash
npm install -g editmamei
editmamei install   # registers with Claude Desktop, Cursor, Claude Code
editmamei status    # confirms install state + Photoshop detection
```

Then restart your AI client and ask it: _"Is Photoshop connected?"_

Prefer not to use a terminal? Claude Desktop users can install the one-click [`.mcpb` extension](https://github.com/editmamei/editmamei/releases/latest/download/editmamei.mcpb) directly (no system Node required, Claude Desktop ships its own runtime). Full walkthrough in the [install guide](docs/installation.md).

**Requirements:** Adobe Photoshop 2026 (v27.x), Windows 10/11 or macOS 12+, Node.js 22+ (for the npm path), and an MCP-compatible AI client (Claude Desktop, Cursor, Claude Code).

## A session, end to end

The discovery chain is `ps_ping` (liveness), then `ps_overview` (the working method and capability map), then `tools/list` (the full schema-typed inventory). After that you just talk to your assistant:

> _"Open my vacation photo."_
> _"Make the sky more dramatic but keep the foreground natural."_
> _"Sharpen the eyes, soften the skin, leave everything else alone."_
> _"Isolate the subject onto its own layer with a clean mask."_
> _"Export a 2048px web JPEG."_

Your assistant composes those into tool calls, checks the result with previews and measurements, and iterates.

## Design principles

These are the choices that shape the surface, and the reason an AI assistant can drive it reliably rather than hopefully.

- **Structured results, not prose.** Every tool declares an `outputSchema` and returns a typed JSON payload. Any tool that changes what is active reports the current document and layer back, so the model keeps an accurate picture of Photoshop's state between calls instead of re-deriving it.
- **Guidance lives in the surface.** `ps_overview` returns the working method (assess, plan, enact, check, iterate) and `ps_list_capabilities` returns a live map of what exists. The model orients itself from the server rather than from guesswork or a stale prompt.
- **Measure, don't eyeball.** A dedicated set of verification tools (histogram, region compare, layer-bounds diff, selection preview) lets the model check its own work numerically instead of trusting a thumbnail.
- **On-device perception.** Local computer vision (ONNX) detects faces, objects, and scene regions and returns real document coordinates. The image stays on your machine for this step and is never sent to a cloud vision model.
- **Non-destructive by default.** Adjustments are adjustment layers, and destructive pixel operations run on an auto-created duplicate. An edit is reversible by construction.
- **Verified against real Photoshop.** Every tool is built on Photoshop's own native scripting functions and verified in live Photoshop sessions before it ships. A new tool stays disabled until it has passed live verification, so the shipped surface is the verified surface.
- **Built for modern Photoshop.** Editmamei targets Photoshop 2026 (v27.x) so it can rely on current, stable scripting descriptors rather than carrying a decade of drifted behavior.

## Tool surface

**82 tools across 16 capability groups** (59 Community, 23 Pro). Every tool is namespaced `ps_*` and discoverable at runtime via `tools/list`. Community tools ship in both editions; Pro tools unlock with a license.

| Group | Edition | Tools |
| --- | --- | --- |
| **Core** | Community | `ping` · `overview` · `list_capabilities` · `undo` · `redo` · `report_problem` |
| **Inspect** | Community | `inspect` · `get_preview` |
| **Verify** | Community | `get_histogram` · `compare_regions` · `get_layer_bounds_diff` · `get_selection_preview` |
| **Document & canvas** | Community | `create_document` · `open_document` · `close_document` · `save_psd` · `export` · `place_image` · `resize_image` · `crop_document` · `convert_image_mode` · `transform_canvas` · `guides` |
| **Selection** | Community | `select` · `modify_selection` · `selection_channel` |
| **Adjustments** | Community | `add_adjustment_layer` · `apply_adjustment` |
| **Filters** | Community | `filter` |
| **Retouch** | Community | `retouch` |
| **Layers** | Community | `create_layer` · `delete_layer` · `fill_layer` · `add_fill_layer` · `select_layer` · `move_layer_to_position` · `duplicate_layer` · `copy_to_new_layer` · `convert_to_smart_object` · `rasterize_layer` · `set_layer` · `merge` · `bake_layer` · `add_layer_style` · `transform_layer` · `shape` · `group` |
| **Masks & paths** | Community | `layer_mask` · `clipping_mask` · `path` · `vector_mask` · `apply_image` · `calculations` |
| **Type** | Community | `text` |
| **Perception** | Community | `detect` · `read_scene` · `select_by_reference` |
| **AI selection** | Community | `select_subject` · `select_sky` |
| **AI selection** | Pro | `select_subject_instance` · `select_object` |
| **Filters** | Pro | `apply_camera_raw` |
| **Layers (warp)** | Pro | `warp_layer` · `warp_layer_mesh` · `warp_layer_along` · `warp_layer_region` · `warp_layer_to` |
| **Perception** | Pro | `edit_object` · `add_text_to_object` · `resolve_placement` |
| **Face mesh** | Pro | `detect_landmarks` · `select_face_feature` |
| **Templates** | Pro | `template_create_evidence` · `template_save` · `template_list` · `template_apply` · `template_verify` · `template_recall` · `template_delete` |
| **Automation** | Pro | `list_actions` · `play_action` · `execute_script` |

## Editions

- **Community** is free and covers the everyday editing surface: documents, layers, selections (including AI Select Subject and Select Sky), non-destructive adjustments, filters, masks, type, retouching, on-device perception, and the inspect/verify primitives.
- **Pro** adds Camera Raw develop, the grounded precision tools (warp, named-object masks, precision placement), subject-instance targeting, face-mesh perception, the reproducible-template system, and Photoshop Actions plus the scripting escape hatch.

The split is detailed in [pro-features.md](docs/pro-features.md). Pricing is at [editmamei.com](https://editmamei.com).

This repository holds the Community source. Pro is a separately licensed module and its source is not published here; Community never imports it, so this tree builds and runs on its own.

## Build from source

```bash
git clone https://github.com/editmamei/editmamei.git
cd editmamei
npm install
npm run build
npm test
```

You need Node.js 22+ and a Go toolchain (the build compiles the `editmamei-core` binary that generates Photoshop scripts). The build warns instead of failing when Go is missing, so you can still run the test suite; set `EDITMAMEI_CORE_BIN` to a prebuilt binary if you would rather not install Go.

The test suite runs without Photoshop. It verifies the ExtendScript Editmamei generates, never that Photoshop accepted it, so live verification against a real Photoshop is a separate step.

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which covers the CLA, the branch and pull-request flow, and what to include in a bug report.

## Configuration

Settings live in `~/.editmamei/settings.json`, managed by the `editmamei config` CLI:

```bash
editmamei config list
editmamei config set telemetry.usage false      # turn off anonymous usage telemetry
editmamei config set ps_path "/path/to/Photoshop"
```

`PHOTOSHOP_PATH` (env var) overrides Photoshop auto-detection for a single run.

## Privacy

Editmamei runs on your computer and edits in your own Photoshop. No image content, document data, or file paths are sent to Editmamei's servers. It reports anonymous, content-free usage telemetry (on by default, turn it off with `editmamei config set telemetry.usage false`). When your AI assistant needs to see a result, Editmamei sends it a downscaled preview, the same as dropping a photo into a chat with that assistant. Every field is documented in [privacy.md](docs/privacy.md).

The source in this repository is the same code published to npm, so none of the above has to be taken on trust.

## Docs and support

- **Features and pricing:** [editmamei.com](https://editmamei.com)
- **Install:** [docs/installation.md](docs/installation.md)
- **Getting started:** [docs/getting-started.md](docs/getting-started.md)
- **FAQ:** [docs/faq.md](docs/faq.md)
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
