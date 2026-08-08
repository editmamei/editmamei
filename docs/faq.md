# FAQ

Common questions about Editmamei, the MCP server that drives Adobe Photoshop from your AI assistant.

---

## What Editmamei is

### What is Editmamei?

Editmamei is a Model Context Protocol (MCP) server for Adobe Photoshop. It runs locally, your AI client (Claude Desktop, Claude Code, Cursor, or any MCP-compatible client) connects to it, and it drives the Photoshop installed on your machine. You describe the edit in plain language; the AI plans the steps; Photoshop carries them out with its own standard tools.

### Is Editmamei affiliated with Adobe?

No. Editmamei is an independent product. It is not affiliated with, endorsed by, or sponsored by Adobe Inc. "Adobe" and "Photoshop" are registered trademarks of Adobe Inc.

### Does Editmamei generate pixels with AI?

No. Editmamei is an *orchestration* layer, not a *generation* layer. The AI assistant plans the steps (which adjustments, which selections, in what order), and Photoshop carries them out using its own standard non-generative tools (adjustment layers, masks, selections, filters). Your pixels are only ever changed by Photoshop itself; no generative model touches them. "AI orchestration, not generation" is the short version.

### Is Editmamei open source?

The Community Edition source is published in this repository, under the [Functional Source License, v1.1, MIT Future License](../LICENSE.md) (FSL-1.1-MIT): you can read, run, modify, and redistribute it for almost anything, and each release converts to plain MIT two years after it ships. The one thing the license holds back during that window is offering the code to others in a commercial product or service that competes with Editmamei CE or Pro. That makes Editmamei *source-available* / *fair source*, not open source under the OSI definition, and we don't call it that. Editmamei Pro is a separate, commercially licensed module; its source is not published. Third-party open-source dependencies retain their original licenses; the full list is in [`NOTICES.md`](../NOTICES.md).

---

## Installation & compatibility

### Which MCP clients are supported?

Officially:

- [Claude Desktop](https://claude.ai/download) (Windows, macOS)
- [Cursor](https://cursor.com/)
- [Claude Code](https://claude.ai/code)

Any MCP-compatible client should work; Editmamei is a standard MCP stdio server. `editmamei install` detects your installed clients (Claude Desktop, Cursor, Claude Code) and writes each one's config in a single pass; for other clients, the [manual configuration steps](installation.md#manual-configuration) show what to put in your client's config.

### Which AI client should I use?

All three supported clients work with Editmamei. The right one for you depends on the kind of work you do.

**Claude Desktop** is the easiest to set up and the most familiar if you've used Claude on the web. It's a great fit for everyday edits: a single hero shot to grade, a portrait to retouch, a quick template to apply. Most one-off and short-session work runs comfortably here.

**Claude Code** is a terminal-based client. It takes more setup, but it has a much larger working memory for the conversation, which keeps it fast when a session runs long. Real-estate batches, wedding sets, multi-image template authoring, and any workflow that runs through dozens of edits in a row stay responsive on Code in ways Desktop currently cannot match. If you regularly notice the AI slowing down as you keep editing, switching to Code is the fix.

**Cursor** runs Editmamei the same way Claude Desktop does. Use it if it's already part of your workflow.

If you're not sure: start on Desktop. Move to Code the first time you feel a session getting slow. The [getting-started guide](getting-started.md#when-the-ai-starts-feeling-slow) covers why that happens, and [installation.md](installation.md#claude-code) covers the Code setup.

### Which Photoshop versions are supported?

**Photoshop 2026 (internal version 27.x).** That's the only Photoshop version Editmamei has been verified against; every ActionManager descriptor we emit was captured against PS 27.x on Windows and macOS.

Earlier versions (Photoshop 2025 / 2024 / 2023 / 2022) may work (the DOM-level APIs and most AM events are stable across recent majors), but they're unverified. Adobe is known to rotate event IDs between major versions, and a tool that string-match-tests fine in the source can still silent-no-op against a different PS major. The auto-detector still finds older installs so you can try, but failing tools on unsupported versions are a known unsupported-version risk, not a bug.

### Does Editmamei work on Linux?

No. Editmamei drives Photoshop through Windows COM automation or macOS AppleScript / OSA, both OS-specific. Photoshop itself is not supported on Linux.

### Does it need an internet connection?

Core editing doesn't. Editmamei never requires a network call to drive Photoshop. Its own network calls are few and content-free: anonymous usage telemetry (which tools ran, whether they succeeded, version/OS/Photoshop version), sent best-effort in the background and switchable off with `editmamei config set telemetry.usage false`; a boot-time update check (an anonymous version lookup against the npm registry, also switchable off in settings); and, on Pro, license validation plus the Pro-module download when you activate. None of these carry images, paths, or personal data. Every telemetry field is documented in [privacy.md](privacy.md).

Your AI assistant is separate. Editmamei runs as a stdio subprocess of your AI assistant (Claude Desktop, Cursor, etc.), and that assistant is itself a cloud service governed by its own privacy policy. When you ask the AI to look at a visual preview, Editmamei sends a downscaled JPEG to *that AI provider* on your behalf, exactly as if you'd dropped the file into a chat with it. So an internet connection is required for the AI to function, even if Editmamei the server isn't transmitting anything itself.

### Does it need Generative Fill / Adobe cloud features?

No generative feature is required or invoked: Editmamei runs against the standard ExtendScript automation surface, which has been in every Photoshop install since the early 2010s, and no tool in the current build touches Generative Fill or any other Adobe generative feature. One nuance on cloud: Photoshop's own Select Subject and Select Sky (included in Community) are Sensei-backed, and whether they run in Adobe's cloud or on-device depends on your **Preferences → Image Processing** setting; see [getting-started.md](getting-started.md#troubleshooting) if they error.

### Does Editmamei work with Photoshop Elements?

No. Photoshop Elements does not expose the same scripting interface that full Photoshop does.

---

## Using Editmamei

### Can the AI mess up my files?

The AI works on the open document in Photoshop, the same way you would. Standard Photoshop undo/redo applies; `ps_undo` and `ps_redo` are exposed as tools, and the AI uses them. You can also revert at any point through Photoshop's File → Revert.

The AI will not save over your original files unless you explicitly ask it to. Save and export tools all take explicit file paths.

That said: when running batch operations across many files, ask the AI to dry-run on one image first and verify the output before unleashing it on a folder.

### Can the AI delete files?

The current Community tool surface does not include a file-deletion tool. The AI can write new files (save / export) but cannot delete existing files outside the document scope. One Pro caveat: `ps_execute_script` runs arbitrary ExtendScript and is not so constrained; treat it with the same care as any script you'd run yourself.

### Can it batch edit a whole shoot?

Photo by photo, yes. There is no one-click folder runner. The workflow that scales is a Pro template: save a look once, then have the AI reapply it to each photo, re-deriving the settings for that image rather than stamping identical values, and checking each result against the template's criteria. Long many-image sessions are exactly where Claude Code's larger working memory pays off; see [Which AI client should I use?](#which-ai-client-should-i-use)

### How does the AI know what the image looks like?

Through `ps_get_preview`, which returns a downscaled JPEG of the current document state. The AI calls this when it needs to verify its own work or judge an aesthetic outcome. It can also call `ps_get_histogram` for per-channel pixel distributions and `ps_inspect` for dimensions, color mode, and embedded profile.

### Does the AI see my photos? Where do the vision models run?

Editmamei bundles small computer-vision models that run entirely on your machine. They find faces, objects, and edges so the AI can select and place things by name. No image content is uploaded by Editmamei. Separately, when you ask your AI assistant to look at a preview, that preview goes to the assistant the same way any image you paste into the chat does.

### Does Editmamei collect any data about my edits?

Nothing about the content of your edits goes to us: no images, document data, or file paths. Editmamei does send anonymous, content-free usage data (which tools ran, whether they succeeded, how long they took), which you can switch off; see [privacy.md](privacy.md) for every field. Separately, a richer local session log is written to `~/.editmamei/sessions/<session-id>.ndjson` (used for debugging and by the Templates system) that stays on your disk and is **not** transmitted. (When your AI assistant needs to see an edit, a downscaled preview goes to that assistant, per "Does it need an internet connection?" above; and what your AI client does with content you share in chat is governed by that provider's own privacy policy.)

### Can I run Editmamei against multiple Photoshop versions installed side by side?

Yes. Editmamei auto-detects Photoshop, and you can pin a specific install via the `PHOTOSHOP_PATH` env var in your MCP client config. See [installation.md](installation.md#optional-pin-a-specific-photoshop-install).

### Why does the AI take longer between edits as my session gets longer?

AI assistants have a working memory for the conversation, and as it grows, the AI takes longer to reason about each next step. Short sessions stay snappy. A session that runs into the hundreds of edits will see noticeable gaps build up between asking for an edit and seeing the next step happen.

This is a property of the AI client, not of Editmamei or Photoshop. Two things help:

1. **Start a fresh conversation when you switch projects.** Closing a session and starting a new one resets the working memory. If you've been on one image for an hour and want to move to the next, a new chat is faster than continuing the old one.
2. **Use Claude Code for sustained work.** Claude Code has a much larger working memory, which means it stays fast across hundreds of edits in one session. See [Which AI client should I use?](#which-ai-client-should-i-use) for when each client makes sense.

---

## Pro

### What's the difference between Community and Pro?

See the full breakdown in [pro-features.md](pro-features.md). Short version: Community covers the full working-photographer editing surface: documents, layers, layer transforms and straightening, non-destructive adjustment layers, filters, content-aware retouch, layer styles, masks, selections (including Photoshop's Select Subject and Select Sky), shape layers and pen paths, channel compositing, on-device scene awareness, per-channel histograms and visual verification, history, text, and image placement. Pro adds the develop-grade and precision toolkit: **Camera Raw develop** as a re-editable Smart Filter, **precision placement** (name a location, get verified geometry), **named-object masks**, **face-mesh perception**, **subject-instance targeting**, **warp**, the **whole reproducible-template system**, and **Photoshop Actions + ExtendScript scripting**. The [main README](../README.md#editions) carries the same split at a glance; [pro-features.md](pro-features.md) is the canonical version.

### Can it drive Camera Raw?

Pro can. The Camera Raw Filter applies to a Smart Object layer as a re-editable Smart Filter, so the develop settings stay live and individually adjustable later. The raw-file import dialog itself and Camera Raw's local masks are outside what Photoshop exposes to scripting here.

### What does "precision placement" actually do?

It replaces coordinate guessing. The AI names a location in words, local vision finds the anchors, and a deterministic resolver computes the exact pixels. An objective check compares the result against the real geometry before anything is applied. If a placement can't be verified, the AI says so instead of pretending.

### How do I activate a Pro license?

Buy Pro at [editmamei.com/pricing](https://editmamei.com/pricing), then activate it. Pro is delivered as a downloaded module: activating your license makes Editmamei fetch and load the Pro module alongside your Community install, so nothing gets reinstalled. If you run Editmamei through Claude Code or another npm client, run `editmamei activate YOUR-KEY` in your terminal and restart the client (check status anytime with `editmamei license`). If you use the Claude Desktop extension, open **Settings → Extensions → Editmamei**, paste your key into the **Pro license key** field, save, and restart Claude Desktop. Full walkthrough at [editmamei.com/activate](https://editmamei.com/activate). See [pro-features.md](pro-features.md) for what Pro adds.

### Pro stopped unlocking after an update. How do I fix it?

Run `editmamei repair` in a terminal. It re-downloads the Pro module and touches nothing else: your templates, settings, session logs, and license at `~/.editmamei/` stay put. Restart your AI client afterwards. If Pro still doesn't unlock, email [support@editmamei.com](mailto:support@editmamei.com).

### Do you offer a free trial?

Community is free forever, so you can use the full core toolkit at no cost before deciding on Pro. For current Pro plans and terms, see [editmamei.com/pricing](https://editmamei.com/pricing). If a paid subscription ever lapses, Editmamei keeps running as Community rather than locking you out.

---

## Issues & support

### Where do I file bugs?

[github.com/editmamei/editmamei/issues](https://github.com/editmamei/editmamei/issues). Pick the appropriate template (bug report or feature request) and fill it in.

### Where do I ask account or billing questions?

Email [support@editmamei.com](mailto:support@editmamei.com). Do not file billing issues in the public GitHub tracker; your invoice details don't belong there.

### How do I report a security issue?

See [SECURITY.md](../SECURITY.md) for the responsible disclosure process. Do not open security issues in the public tracker.

### Is there a community?

Not a dedicated one yet. The [issue tracker](https://github.com/editmamei/editmamei/issues) is the primary public forum, and [@editmamei on Instagram](https://www.instagram.com/editmamei/) is where demos and announcements land.
