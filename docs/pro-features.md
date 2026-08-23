# Pro features

Editmamei, the MCP server that drives Adobe Photoshop from your AI assistant, ships in two editions. Community installs free from the public npm registry. Pro is a **downloaded module**: you keep your Community install, activate a license, and Editmamei fetches the signed Pro module and loads it after a restart. Same CLI, same MCP server name; the Pro module is fetched and loaded automatically when your license entitles it, so there's no second package to install by hand.

Both editions follow the same rule: AI orchestration, not generation. Photoshop edits with its own real tools; Pro just gives the AI a deeper toolkit to orchestrate.

This page describes the line between Community and Pro as it stands today. The split may evolve; see [editmamei.com/pricing](https://editmamei.com/pricing) for the current state.

---

## Activating Pro

Pro is available now. Community is free; Pro is a paid license you buy at [editmamei.com/pricing](https://editmamei.com/pricing) and activate. Activating downloads the Pro module and loads it alongside your Community install.

- **Claude Code / npm clients:** run `editmamei activate YOUR-KEY` in your terminal, then restart your AI client. Check status anytime with `editmamei license`.
- **Claude Desktop extension:** open **Settings → Extensions → Editmamei**, paste your key into the **Pro license key** field, save, and restart Claude Desktop.

One license covers two devices; switch a device with `editmamei deactivate` or from your account portal. Pro works offline between periodic check-ins (roughly daily, with a seven-day grace window), and if a subscription lapses Editmamei keeps running as Community rather than locking you out. If Pro stops unlocking after an update, run `editmamei repair` to re-download the module; your templates, settings, and license stay untouched. Full walkthrough: [editmamei.com/activate](https://editmamei.com/activate).

---

## Community: what's included free

The Community edition covers the core editing surface most photographers need day to day:

- **Documents:** create, open, save layered PSDs, export JPEG/PNG, close, crop, resize
- **Layers:** create, duplicate, delete, rename, reorder, group, merge, flatten, stamp visible
- **Layer properties:** opacity, blend mode, visibility, locking, rasterize
- **Non-destructive adjustments:** Curves, Levels, Hue/Saturation, Brightness/Contrast as adjustment layers (an active selection becomes the new layer's mask automatically)
- **Filters and tonal tools:** Gaussian Blur, Motion Blur, Sharpen, Smart Sharpen, Reduce Noise, High Pass, Add Noise, Shadows/Highlights, Equalize. Destructive ops run on an auto-duplicated layer by default, so the original is preserved
- **Selections:** Magic Wand, Rectangle, color range, luminance range, Select All, Deselect, Invert, Feather, refine edge. Every selection returns rich feedback (area, edge complexity, pixel counts) plus a selection preview
- **Layer masks:** create from selection, apply, delete
- **Layer styles:** drop shadow, stroke, outer glow
- **Layer transforms and straightening:** move, scale, rotate, and fit-to-document on the active layer; background layers auto-promote instead of erroring, so you can straighten a tilted phone shot in one step
- **Content-aware retouch:** Content-Aware Fill, Patch, and Content-Aware Move, each driven against a selection the AI can verify first. Erase a distraction or repair a blemish without leaving the conversation
- **History:** undo, redo, inspect history states
- **Visual verification:** downscaled preview JPEGs returned inline, layer-bounds diffs, region comparison, and 256-bin per-channel histograms with mean, stdev, and median
- **Document insight:** camera metadata (make, model, lens, ISO, focal length, GPS), ACR develop settings, full layer tree as JSON, capability overview
- **Text:** create text layers, set font, size, color, and alignment, update content
- **Image placement:** place image files into the document
- **Scene awareness, on your machine:** `ps_detect` finds faces and objects on-device; `ps_read_scene` reads the scene; `ps_select_by_reference` turns a named thing ("the sky", "the person on the left") into a real selection
- **AI selections:** `ps_select_subject` and `ps_select_sky` (Photoshop's Sensei selections), each returning the same rich feedback bundle as every other selection so the AI can verify before committing
- **Vector shapes and pen paths:** `ps_shape` (rectangle, ellipse, line), `ps_path` (editable paths, path-to-selection and back), and `ps_vector_mask`
- **Channel compositing:** `ps_apply_image` and `ps_calculations` for luminosity blends and channel-math masks, plus save / load / duplicate / delete of selection channels
- **Canvas and guides:** rotate and flip the canvas, add guides and guide layouts, and skew / free-transform layers
- **One-step diagnostics:** `ps_report_problem` writes an anonymized, content-free bug-report bundle to your Downloads

This is enough to drive a full landscape or product editing workflow in conversation with your AI.

---

## What Pro adds to Editmamei

Pro adds the develop-grade and precision toolkit: Camera Raw develop, precision placement, named-object masks, face-aware editing, warp, subject-instance targeting, and the reproducible-template system, plus Photoshop Actions and scripting.

### Templates: the whole reproducible-recipe system

A template is a reproducible aesthetic recipe: capture a finished edit as a named bundle, then apply it later to new images. The **entire template surface is Pro**, authoring and use alike.

- `ps_template_create_evidence`: gathers session evidence (tool calls, history states, metadata snapshot) and renders before/after previews
- `ps_template_save`: saves the template bundle to `~/.editmamei/templates/<slug>/`, optionally with a machine-checkable style signature
- `ps_template_delete`: removes a saved template
- `ps_template_list`: lists saved templates
- `ps_template_apply`: applies a saved template to the current image; the AI re-derives each value for the new photo and self-judges against the template's exit criteria
- `ps_template_verify`: measures the current document against a template's machine-checkable style signature, with a corrective steer per miss
- `ps_template_recall`: re-surfaces one section of a template (exit criteria, tune dials, signature) as text, cheaply, late in a long session

Templates turn one-shot edits into repeatable looks. Bundling the whole surface as one paid feature matches how it's used: authoring and applying are two halves of the same workflow.

### Camera Raw develop, re-editable

`ps_apply_camera_raw` applies Photoshop's Camera Raw Filter to a Smart Object layer as a re-editable Smart Filter. The AI gets the develop controls photographers actually use: white balance, exposure and tone, texture, clarity, dehaze, the HSL color mixer, color grading, detail, optics, vignette and grain.

The part that matters: it reads back what's already applied. Ask for "a touch less dehaze" a day later and the AI reads the current settings, changes that one value, and reapplies. Nothing else moves, and nothing bakes into pixels.

Scope note, honestly: this develops open documents. The raw-file import dialog (the develop screen you see when double-clicking a .CR3) and Camera Raw's local masks are not driveable this way.

### Precision placement

`ps_resolve_placement` is how the AI stops guessing coordinates. It names a location the way you would ("under the left eye", "along the roofline", "halfway between the two boats"). Local computer vision finds the anchors (faces, objects, edges, corners), a deterministic resolver turns the phrase into exact document pixels, and an objective geometric check runs before anything is applied. The AI then reviews a zoomed crop of the placement, not the full frame, because that's the judgment it can actually make reliably. Placements are measured, not eyeballed.

It's the locator behind the precision workflow: name a place, get verified geometry, then drive the warps and named-object selection from it.

### Named-object selection

`ps_select_object` turns "select the surfboard" into a real, organic selection mask. The on-device detector finds the object, a local segmentation model traces it, and the result loads as a normal Photoshop selection with the same rich feedback as every other selection tool. Covers 80 common object categories. All of it runs on your machine.

### Face-aware editing

- `ps_detect_landmarks`: a 468-point face mesh, computed locally, returned as named regions and anchors.
- `ps_select_face_feature`: a real Photoshop selection of a named feature (eyes, teeth, skin, lips).

### Subject-instance targeting

- `ps_select_subject_instance`: aim Photoshop's Select Subject at one named subject among several, using local detection to isolate the instance before the selection runs. (Plain Select Subject and Select Sky are free in Community.)

### Warp

`ps_warp_layer` covers all of it under one `mode` argument:

- `mode=style`: Photoshop's built-in warp styles.
- `mode=mesh`: a custom mesh that holds one edge pinned while the rest lifts, bends, or tapers.
- `mode=along`: bend a layer to follow a named curve, like text along a shoreline.
- `mode=region`: bulge or pinch around a named point or region.
- `mode=to`: pin one edge and reach the far end to a named target.

### Actions and scripting

- `ps_list_actions` and `ps_play_action`: enumerate and play your recorded Photoshop Actions
- `ps_execute_script`: the escape hatch, arbitrary ExtendScript for when no specific tool fits

### Batch

- `ps_batch`: apply one recipe to a whole folder as a single Photoshop batch. The recipe becomes
  a Photoshop Action and Photoshop runs the set itself, so the per-call cost is paid once instead
  of once per image.
- `op=preview` reports what would be processed before anything is touched, and images a
  percent-based crop would ruin are skipped and reported rather than quietly mangled.

### Coming later

The [roadmap](roadmap.md) tracks what's in active development and being live-tested against Photoshop now. Which edition each capability lands in is decided when it's verified, so check the roadmap for the current in-progress list.

---

## Pricing

Pricing and purchase options are at [editmamei.com/pricing](https://editmamei.com/pricing): monthly, annual, or a one-time perpetual license, each covering two devices.
