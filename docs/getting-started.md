# Getting started

This guide walks you through your first session with Editmamei, the MCP server that drives Adobe Photoshop from your AI assistant. It goes from confirming Photoshop is connected to making your first real edit, and assumes you've already done the [installation](installation.md).

The pattern throughout is the same: **you describe what you want in your own words; the AI plans it; your Photoshop carries it out.** You're not learning a new app; you're learning to ask for what you already know how to do.

---

## Step 1: ping Photoshop

With Photoshop open and the MCP client you want to use restarted (any of Claude Desktop, Cursor, or Claude Code; `editmamei install` writes to all three in one pass), start a new conversation and ask:

> "Is Photoshop connected? What version is running?"

The AI calls `ps_ping`, which reports whether Photoshop is connected and what version is running. You'll see something like:

> Yes, Photoshop is connected. You're running Photoshop 2026 (version 27.7.0) on Windows.

If you instead see "tool not found" or a connection error, jump to [Troubleshooting](#troubleshooting) at the bottom of this page.

---

## Step 2: open a document

> "Open `C:\Users\me\Pictures\test.jpg` in Photoshop and tell me the dimensions and color profile."

The AI calls `ps_open_document` and `ps_inspect`. You'll see the document appear in Photoshop and the AI report back with the file's dimensions, color mode, and embedded ICC profile.

Use any path that points to an image file you have. JPEG, PNG, TIFF, PSD, DNG, and most raw formats are supported.

---

## Step 3: make a non-destructive edit

> "Add a Curves adjustment layer named 'tone' that gently lifts the shadows."

The AI calls `ps_add_adjustment_layer` with `type: "curves"` and appropriate curve points. You should see the new adjustment layer appear in the Photoshop Layers panel, and the document should visibly brighten in the shadows.

Editmamei always prefers non-destructive operations (adjustment layers, masks, and Smart Objects) over destructive bakes, so you can iterate without losing data.

---

## Step 4: ask the AI to verify

> "Show me what the image looks like now."

The AI calls `ps_get_preview`, which returns a downscaled JPEG of the current document state inline. This is how the AI sees its own work; the preview goes to your AI assistant, which is a cloud service (see [privacy.md](privacy.md#your-ai-assistant-is-a-cloud-service)). You can ask it to compare against the original, evaluate exposure, or check if a particular edit landed.

---

## Step 5: export

> "Save the layered PSD next to the original and export a 2400px JPEG to the same folder."

The AI calls `ps_save_psd` for the PSD and `ps_export` for the JPEG (`ps_export` also produces PNG and the other formats). Both files appear in your filesystem at the specified paths.

---

## What's next: three workflows to try

Once the basics work, try one of these:

**A landscape grade:**

> "Build a non-destructive editing stack on this photo: a Levels layer, a Curves layer with an S-curve, and a Hue/Saturation layer with +15 blue saturation. Group them as 'grade'."

**A portrait retouching setup:**

> "Click the background near the subject with `ps_select` (mode `magic_wand`, tolerance 30, anti_alias true), feather the selection 2 pixels, invert the selection, then add a Curves adjustment layer clipped to that selection that gently warms the skin tones."

*(Sensei-backed `ps_select_subject` does the same thing in one call and is included free in Community.)*

**Reproduce an aesthetic later (Pro):**

> "Save this current edit as a template called 'warm coastal'. Then later, apply 'warm coastal' to every image in `C:\Photos\new-shoot\`."

More workflow examples are on the [product page](https://editmamei.com/product).

---

## When the AI starts feeling slow

AI assistants have a working memory for the conversation. Short sessions stay snappy. Once a conversation has run through a lot of edits, previews, and back-and-forth, that memory fills up and the AI takes longer between each step. You'll notice it as gaps of thirty seconds or more between asking for an edit and seeing the next step happen.

This isn't an Editmamei limit and it isn't a Photoshop limit; it's a property of the AI client itself.

Two things help, in order:

1. **Start a fresh conversation when you switch projects.** Closing a session and starting a new one resets the working memory. If you've been on one image for an hour and want to move to the next, a new chat is faster than continuing the old one.
2. **Use Claude Code for sustained work.** Claude Code has a much larger working memory, which means it stays fast across hundreds of edits in one session. Setup is a one-time terminal install; once it's running, it works the same way Desktop does: you type, the AI edits, Photoshop carries it out.

If you frequently work in long batches (real-estate sets, wedding selects, template authoring), Code is the recommended client. The [installation guide](installation.md#register-with-your-mcp-clients) covers the setup, and the [FAQ](faq.md#which-ai-client-should-i-use) compares the three supported clients side by side.

---

## Per-user data

Editmamei writes per-user data to `~/.editmamei/`:

- `~/.editmamei/sessions/<session-id>.ndjson`: one line per tool call, used for debugging and by the Templates system
- `~/.editmamei/templates/<slug>/`: saved editing recipes (Pro only)

These survive uninstall and upgrade. Delete them manually with `rm -rf ~/.editmamei/` if you want a clean slate.

---

## Troubleshooting

### "Tool not found": the AI doesn't see Photoshop tools

Your MCP client didn't pick up the Editmamei registration. Check:

1. Did you restart the client *fully* after installing? (Not just a new conversation; fully quit and reopen.)
2. Run `editmamei status` to confirm Editmamei is registered with your client. (Photoshop detection is reported by the `ps_ping` tool in a session, not by `status`.)
3. Run `editmamei install` again; it'll re-register and report any config errors.
4. Check the client config file by hand (see [installation.md](installation.md)) and verify the `editmamei` entry is present and the JSON is valid.

### When no specific tool covers what you need: the escape hatch (Pro)

If you hit a Photoshop operation Editmamei doesn't have a dedicated tool for, Pro's `ps_execute_script` can send an ExtendScript snippet directly to Photoshop and return the result. This is the safety valve for edge cases the dedicated tool surface hasn't grown into yet; whether the AI reaches for it on its own depends on the AI client, so if the AI seems stuck on "no tool for this," ask it to use `ps_execute_script` explicitly. On Community, ask the AI to run `ps_list_capabilities` to see what is available, and [open an issue](https://github.com/editmamei/editmamei/issues) for the tool you're missing.

### Photoshop version support

Editmamei is tested against **Photoshop 2026 (internal version 27.x)**, the only Photoshop version every ActionManager descriptor has been ground-truth captured against. Earlier versions (Photoshop 2025 / 2024 / 2023 / 2022) may work, but they're unverified; Adobe rotates event IDs between major versions and silent-no-op descriptor failures on untested PS majors cannot be ruled out. The auto-detector still finds older installs so you can try.

PS 2026 introduced a few descriptor changes that affected some adjustment-layer and selection paths; current builds work around the known ones. If you hit a tool that fails (on PS 2026 or any other version), [open an issue](https://github.com/editmamei/editmamei/issues) and include the output of `editmamei status` plus the relevant snippet from `~/.editmamei/sessions/<session-id>.ndjson`. Please mention your Photoshop version so we can route the bug correctly.

### `ps_ping` hangs or times out

Photoshop isn't responding to the automation request. Common causes:

- **Photoshop isn't open.** Open it first, then retry.
- **Different user accounts.** On Windows, Photoshop and the MCP client must run as the same user; COM automation respects user boundaries.
- **Photoshop is busy.** If a modal dialog is open (e.g. an unsaved-changes prompt, an Adobe sign-in modal), dismiss it and retry.
- **macOS automation permissions.** First time only: macOS will prompt you to allow the MCP client to control Photoshop. Approve it in System Settings → Privacy & Security → Automation.

### "Parameters not valid" on `ps_select_subject` / `ps_select_sky` / `ps_replace_sky`

These tools (included in Community) depend on Photoshop's Sensei AI features, and the error usually means the currently selected processing option (Cloud or Device) isn't available on your machine.

In Photoshop: **Preferences → Image Processing**, switch the processing option (for example Cloud → Process Locally (Device)), then close and reopen Photoshop.

### `ps_replace_sky` stops working part-way through a session

Sky replacements that succeeded earlier begin failing without anything else changing: Photoshop's sky model can become unavailable mid-session. Restart Photoshop and it comes back.

### Reporting something not listed here

Open an issue at [github.com/editmamei/editmamei/issues](https://github.com/editmamei/editmamei/issues); the bug report template will guide you through what to include. **Do not paste your license key in a public issue.**
