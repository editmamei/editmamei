---
name: editmamei
description: Photoshop photo editing via the Editmamei MCP server. Disciplined non-destructive assess→plan→enact→check→iterate workflow. Triggers on photo edit, retouch, color grade, or Photoshop requests.
---

# Self-introduction (do this on activation, every time)

The first message after this skill loads must include this disclosure verbatim:

> "I'll use the Editmamei workflow for this edit — a disciplined non-destructive loop that preserves your original layer at every step. If you'd rather I didn't apply this skill, you can disable it in Settings > Customize > Skills."

Keep the disclosure short. Do not pad it with feature lists. The user opted into discovery by enabling the skill; the disclosure exists so they remember they did, not to upsell.

# MCP availability check

Before any photo-editing work, **invoke `ps_ping` as your first tool call.** Do NOT infer availability from your tool list, your training, or assumptions about the user's setup — actually call it. The ping result is the only source of truth.

- **Success** (returns a Photoshop version string or equivalent payload) → MCP is connected. Proceed with the workflow.
- **Error indicating the tool doesn't exist / isn't registered** (Claude's runtime reports "tool not available" or similar) → THEN report the install instructions below.
- **Any other error** (Photoshop not running, can't detect install, etc.) → relay the actual error to the user verbatim. Do not generalize to "MCP isn't connected" when the MCP server is what reported the error.

If and only if the ping fails because the tool itself is not registered, tell the user:

> "I have the Editmamei skill loaded but the MCP server isn't connected. Install it on the machine where Claude Desktop is running:
>
> ```
> npm install -g editmamei
> editmamei install
> ```
>
> Then restart Claude Desktop and try again. (Editmamei drives Adobe Photoshop locally over stdio — it's a Claude Desktop integration, not a claude.ai web feature.)"

Then stop. Do not invent edits, do not roleplay as if Photoshop is connected, do not propose a workflow you can't actually execute.

**Counter-example to avoid (real failure mode from 2026-06-05):** Claude told the user "you don't have the tools installed yet" without ever invoking `ps_ping`. The hallucination of absence — pattern-matching against "common MCP-not-installed scenario" instead of verifying — produced a false negative. The first call to `ps_ping` is the cure: cheap (~1 second), unambiguous, and removes every reason to guess.

# Tool discovery — the chain to follow every session

After `ps_ping` succeeds, call `ps_overview` once to read the workflow brief and capabilities map. The discovery chain is exactly three steps and must be followed in order:

1. **`ps_ping`** — liveness and session-start signals (open documents, user templates, custom action sets).
2. **`ps_overview`** — how the tools combine (the workflow contract, the verification primitives, the escape-hatch policy).
3. **`tools/list`** — your authoritative inventory of what tools exist in *this* session. The overview teaches the workflow; `tools/list` tells you which specific tools you can call.

Never speculate that a tool exists. If you reference an operation that isn't in your `tools/list`, work around it or surface the gap to the user. The overview describes the workflow tier-agnostically; the inventory in your `tools/list` is what's actually available.

# The core loop

Apply to every photo-editing request, no exceptions. The loop is the discipline that makes terse prompts produce the same quality as detailed ones.

1. **Assess.** Read the source. Run `ps_inspect` (what=metadata, then what=layer_tree) to see what's actually in the document. Run `ps_get_preview` to see the image. Run `ps_get_histogram` if tonal range matters to the request. Note `is_raw_source` in the `ps_open_document` result (or check the source format via metadata) — when true, "RAW sources — develop first" below governs your first enacting step. Describe what you see in 2-3 sentences before planning. Do not skip this step when the prompt is terse — terse prompts need MORE assessment, not less.

2. **Plan.** Propose a non-destructive layered edit as an ordered list of steps. Each step names the tool, the layer that step creates or modifies, and one sentence of intent. Examples of intent: "shift midtones toward warm to compensate for the overcast cast"; "raise the dark point to keep crushed shadows readable." If the user's prompt was terse or open-ended, share the plan and ask for confirmation before enacting. If the user's prompt was prescriptive, skip confirmation and proceed.

3. **Enact.** Execute the plan one tool call at a time. After each tool call, the structured output tells you what changed. Read it. Do not chain three tool calls in one turn and hope.

4. **Check.** After the last enacting tool call, render `ps_get_preview` again. If the request was tonal or color, also run `ps_get_histogram` and compare against the assess-step histogram. If the request was spatial (a thing moved, a thing was placed), use `ps_get_layer_bounds_diff` or `ps_compare_regions` to verify the geometry. The check is non-optional even when the preview "looks right" at a glance.

5. **Iterate.** Before proposing any refinement, run `ps_inspect` (what=layer_tree). Scan for existing layers whose mask or target zone overlaps with the correction you're considering — try tuning opacity on an existing layer before spawning a new one (see "Tune before add" below). Then propose ONE refinement and run the loop again from Enact. The collaboration model for the iterate step is task-type-dependent — see the next section.

# Re-orienting mid-session

If you lose track of what tools exist — this skill or the overview scrolled out of context, or you're unsure which tool does a job — call `ps_list_capabilities`. It returns a compact, live map of every tool grouped by capability (purpose + tool names per group), cheaper than re-reading the overview. Use it to find the right tool name, then look up its full schema as usual.

# Task precision: subjective vs precision-critical

Editmamei is collaborative Photoshop editing. The depth of iteration AND how often you bring the user into the loop scales with task type. Mis-categorizing is the most common quality failure.

**Precision-critical tasks** — image placement, transforms (move / scale / rotate / fit-to-document), masking, selection refinement, alignment, compositing, anything where there is an objective "right" position or shape that exists in the user's head and which they will recognize at a glance.

For these: after the check step, **surface the preview to the user and ask for confirmation or feedback before declaring done.** The user's eye is the most accurate judge of "is this where I wanted it" — your verification primitives (`get_layer_bounds_diff`, `compare_regions`) only tell you the geometry is what you set, not whether it's what the user meant. Lean toward MORE iteration cycles, not fewer. Three rounds of "is this close enough? let me know what to adjust" is the right pattern; one round of "done, moving on" that leaves the user to redo it manually is the wrong one. Examples of asks: "I've placed the logo at the bottom-right with 40px margin — is the size right, or should it scale up/down?"; "the mask follows the hair edge but I'm not sure about the strands on the left — does this look correct?"; "rotated by 1.5° to level the horizon — does this match what you saw, or should I dial it?"

**Subjective adjustment tasks** — color grading, exposure correction, contrast, tonal recovery, vibrance, mood, look development, anything where "perfect" is taste and there is no objectively correct answer. These tasks pass when the result reads as intended; they have no pixel-level target.

For these: do NOT loop the user in every cycle. Apply the 2% done-criteria rule (stop when the next refinement is sub-perceptual). The user came to make a picture, not to babysit slider micro-tweaks. If they want more depth in shadows after you ship, they will say so.

**The collaboration principle.** The more complex or precise the task, the more collaborative the workflow. The check step is your opportunity to bring the user into the loop — use it generously for precision work, conservatively for routine adjustments the user didn't ask you to iterate on. When in doubt, lean toward asking. An extra "does this look right?" message costs nothing; shipping a misaligned composite costs the user a redo.

# Respecting prescriptive prompts

When the user is explicit — "add a Curves adjustment layer with input black 12, white 240, midtone gamma 1.05, masked to the sky selection" — do exactly that. Do not add steps the user did not ask for. Do not propose stylistic improvements. Do not over-explain. Enact, check, report what changed, stop.

Counter-example to avoid: user says "raise the shadows by 15." You do that, then proactively add a contrast bump because "it tends to flatten the image." Don't. The user can ask for more if they want it.

# RAW sources — develop first

`ps_open_document` reports `is_raw_source: true` for raw captures (DNG, NEF, CR3, ARW, …). The open applied last-used/default Camera Raw settings — no deliberate develop has happened yet. When `tools/list` includes a camera-raw develop tool, the FIRST enacting step on a raw document is that develop pass, applied to the base smart object. Do not open a raw and start stacking Levels/Curves adjustment layers for global tone — that is a real failure mode (2026-08): the same brighten/contrast goal redone through the develop pass produced a materially better result with more headroom. On raw sources the develop pass owns global tone and color; adjustment layers come after, for local/masked corrections and finishing moves it can't express.

**Be confident, not timid.** A first pass that nudges three sliders reads as "untouched." Deliver a finished-looking first frame in ONE apply call, working the full surface as the image warrants:

- **Tone**: exposure, contrast, highlights/shadows, AND whites/blacks — set the endpoints, don't leave them at 0.
- **Presence**: texture, clarity, dehaze.
- **Parametric curve** for tonal shape a single contrast slider can't give.
- **Color**: white balance, vibrance, per-channel HSL where specific colors need steering, and the color-grading wheels (shadows/midtones/highlights) for the look.
- **Detail**: capture sharpening + noise reduction — raws get none by default.
- **Optics/effects**: vignette and lens corrections when they serve the image.

Large moves are safe: the develop is a re-editable smart filter, nothing bakes. Start bold, check the preview and histogram, then ease off — that beats creeping up over five timid rounds.

**Iterating on the develop:** call the develop tool again in its adjust-existing mode. It reads the current filter state, changes only the sliders you pass, and preserves the rest. Never add a second camera-raw filter, and never reach for an adjustment layer to fix what the develop pass can still express.

**If no camera-raw develop tool is in your `tools/list`:** tell the user in one sentence that a develop pass isn't available in this session, then build global tone with adjustment layers per the canonical stack. Don't fabricate a develop pass or name tools you don't have.

**User override:** prescriptive prompts win, as always (see "Respecting prescriptive prompts"). If the user names the exact layers to create or says to skip Camera Raw, obey. A terse "edit this photo" on a raw file is NOT an override — it's exactly when develop-first applies.

# Tune before add — the layer audit rule

Before creating a new adjustment layer in response to feedback or a correction, run `ps_inspect` (what=layer_tree) and scan for existing layers that already target the same zone.

- **Existing layer, same type, same mask target → try increasing its opacity first.** If raising opacity fixes the problem, stop. Adding a second Exposure layer on top of the first (both masking the background) is always a sign this audit was skipped.
- **Existing layer at 100% opacity but not strong enough → the value is wrong, not the count.** You cannot edit adjustment layer values after creation (the camera-raw develop smart filter is the exception — it IS re-editable via its adjust-existing mode; tune it there rather than replacing it). Create a replacement at stronger values and delete the old one rather than stacking a correction on top.
- **No existing layer covers the zone, or the type fundamentally can't express the needed correction → create a new layer.** This is the only valid reason to add rather than tune.

Counter-example: the background isn't dark enough. You already have `BG Darken` (Exposure, -0.4 EV, background mask). The right move: increase `BG Darken`'s opacity — or, if at 100%, replace it with -1.2 EV and delete the old one. Wrong move: add `BG Crush` on top. Two Exposure layers stacked on the same mask is a code smell, not a technique.

# Selection persistence — save before you lose it

Any selection that required more than a single rectangle call is non-trivial. Non-trivial selections include AI subject/sky selections, feathered rectangles over 150px, and any selection built across multiple calls.

**If you need the same mask on two or more layers:** build the selection once, then add ALL layers that share that mask while the selection is still active. Deselect only when you're done with that mask zone. This prevents the single most common mask-rebuild waste — an AI subject selection run 4 times in one session for 4 layers that should have shared one mask.

**If you need the mask later in the session:** note the selection parameters (tool, bounds, feather radius) so you can rebuild in one call rather than re-deriving from scratch.

**If your `tools/list` includes a script execution tool:** use it to save the selection to a named Photoshop channel (`doc.channels.add()` + `doc.selection.store(channel)`) so it can be reloaded via `doc.selection.load(channel)` in a later call. Use this for any mask you expect to reuse more than twice.

# Co-working — when the user has touched the document

The document state in your working memory is stale the moment the user touches Photoshop. Three patterns to handle:

**User reports a manual change** (they moved a layer, picked a LUT, adjusted a slider, made a selection): do NOT respond based on your prior mental model. Run `ps_inspect` (what=layer_tree) + `ps_get_preview` first, read what's actually there, then respond. Acknowledging a change you haven't verified is a guess.

**User provides targeted mid-edit feedback** ("that blue is too much", "the face is still dark"): before proposing anything, run `ps_inspect` (what=layer_tree) to recall every layer that already exists and what it targets. Look for layers that partially address the feedback — propose tuning first (see "Tune before add"). Do not jump to a new layer as the first response to feedback.

**User builds on your work manually**: if the user says they tweaked an opacity, adjusted a curve, or changed a blend mode after your last enact step — acknowledge the change, read the actual layer state, and integrate it. Don't override their manual adjustment with a subsequent tool call that re-sets the same property.

The cost of `ps_inspect` (what=layer_tree) is ~0.5 seconds. It eliminates the entire class of "my plan was based on a stale mental model" errors. Run it whenever you're unsure what's in the document.

# Non-destructive principles (always apply, no exceptions)

- **Adjustment layers over bake operations** for every tonal and color change on non-raw sources. On raw sources the camera-raw develop pass owns global tone and color first (see "RAW sources — develop first") — it is equally non-destructive, re-editable at any time; adjustment layers then handle local/masked and finishing work. The `ps_add_adjustment_layer` tool covers the full surface (curves, levels, hue/saturation, brightness/contrast, black & white, color balance, photo filter, vibrance, channel mixer, selective color, gradient map, exposure, color lookup, invert, posterize, threshold).
- **Mask every adjustment that applies to part of the image**, not the whole. Use a selection first; the adjustment layer auto-masks from the active selection.
- **Preserve the original.** Pixel-modifying filters auto-duplicate the active layer by default (the auto-duplicate-first pattern). Do not pass `apply_to_active_layer: true` unless the user explicitly asked you to bake into the original.
- **Group by canonical stack order.** Pre-plan your groups before enacting. Use the professional stack order (bottom to top): Retouching → Dodge & Burn → Global Tone → Color → Effects → Sharpening (see "Canonical layer stack" below). Never let any category grow beyond 3 ungrouped layers — create the group before you add the 4th, not after. A 17-layer flat stack is harder to hand off than a 5-group stack with 3 layers each.
- **Never erase, always mask.** Use `ps_layer_mask` (op `create`) and paint black to hide, white to reveal. A masked pixel can always be recovered; a deleted pixel cannot. If a mask covers too much, paint it back or invert it — never reach for the eraser.
- **Sharpen last, blend Luminosity.** Sharpening amplifies every artifact in the render pipeline above it. Always place sharpening at the very top of the layer stack, after all tone and color work. Set blend mode to `"luminosity"` via `ps_set_layer` (property `blend_mode`) to prevent color fringing on high-contrast edges.

Counter-example to avoid: a user asks to "make the image warmer." You run a Photo Filter on a duplicated pixel layer and merge it down. Don't. Use the `ps_add_adjustment_layer` Photo Filter type so the user can adjust intensity later.

# Canonical layer stack — professional ordering

Professional stacks follow a fixed rendering order — bottom layers process first, top layers last. Pre-plan and create groups in this order before enacting:

1. **Original / Background** — locked pixel layer, never touched. The undo-everything safety net. On raw sources this is the smart object carrying the camera-raw develop smart filter — the develop pass lives here at the very bottom, processed before everything above it.
2. **Retouching** — healing, cloning, content-aware fills, spot removal.
3. **Dodge & Burn** — local brightness sculpting via the 50% gray method (see below).
4. **Global Tone** — Curves, Levels, Exposure, Brightness/Contrast. Set tone before dialing color.
5. **Color** — Hue/Saturation, Color Balance, Selective Color, Photo Filter, Vibrance. After tone, before effects.
6. **Effects** — Vignettes (Curves + Multiply), grain, texture overlays.
7. **Sharpening** — always at the very top, blend mode Luminosity.

Why this order matters: sharpening halos amplify color fringing if color layers sit above the sharpening layer. Tone should be neutral before color is tuned — otherwise color corrections fight a shifting baseline. The order is causal, not aesthetic.

Create groups bottom-to-top with `ps_group` (op=create) — each new group lands above the active layer as a SIBLING, even if a group is currently active (the tool hoists it out from inside that group by default; pass `into_active_group:true` only if you deliberately want the new group nested inside the active one). If you realize mid-edit that a group is out of order, use `ps_move_layer_to_position` to correct it before adding more layers. Photoshop's layer color labels (settable in the layer panel) are a professional convention for group orientation — suggest red for Retouching, yellow for Tone, green for Color, blue for Effects when handing off files.

# Dodge & Burn — the 50% gray method

Painting directly on a pixel layer to dodge or burn is destructive. The professional non-destructive method:

1. `ps_create_layer` — name it "Dodge & Burn".
2. `ps_fill_layer` — fill with 50% gray (`#808080`). Visually invisible in Overlay or Soft Light blend mode — 50% gray is the mode's mathematical no-op.
3. `ps_set_layer` (property `blend_mode`) — set to `"soft light"` for portraits (gentler) or `"overlay"` for stronger local contrast. Painting white brightens (dodge); painting black darkens (burn). Use 10–25% brush opacity — full strength is almost always too heavy.

One D&B layer handles all local contrast sculpting. Do not stack multiple D&B layers on the same scene.

Blend mode caveat: Overlay also boosts saturation, which shifts skin tones. If the check step reveals color shift on the D&B layer, switch to `"soft light"` or add a Hue/Saturation adjustment clipped above it with Saturation at 0.

# Verification primitives — call them, don't skip them

- **`ps_get_preview`** is the default check. Pass `annotations` (rectangles, guides, points, current-selection markers) when verifying spatial work — a red rectangle over the target region + a green rectangle over the actual placement turns a hard spatial estimation into an easy visual comparison.
- **`ps_get_histogram`** is for tonal and color verification. Compare the post-edit histogram against the pre-edit. A shadow recovery that didn't shift the dark-point mass is a no-op even if the preview "looks brighter."
- **`ps_get_layer_bounds_diff`** for "did the layer end up where I intended" checks.
- **`ps_compare_regions`** for "do these two areas now match" checks (color match, exposure match between exposures).

Skipping the check step is the most common failure mode in this workflow. The preview may look correct because vision-language models are good at semantic content but unreliable at quantitative shifts. The histogram tells the truth.

# When typed tools aren't enough

Before assuming an operation requires custom scripting, decompose. Many "I need a script for this" tasks are actually compositions of three native tools in `tools/list` — make a selection, create a mask, fill black, for example. Re-read your inventory before reaching for anything heavier.

If you find no typed tool fits AND the operation isn't a composition, surface the gap to the user rather than fabricating a workaround. Don't speculate about a tool by name — only reference what's in your `tools/list`.

# Templates

When `tools/list` includes template tools, they're reproducible aesthetic recipes saved at `~/.editmamei/templates/<slug>/`.

A template binds OUTCOMES, not steps — it is a recipe for a *style* of editing that adapts to each photo, not an action to replay. Every value in it was derived from a different image. To apply a saved template, the flow is one tool call (read your `tools/list` for the apply-template tool name). It returns the recipe markdown as text plus before/after thumbnails inline. Assess the target photo first, then read the markdown as guidance: re-derive every value and geometry from THIS image, skip steps whose objective the source already meets, add what this photo needs, and drive the pipeline tools in `tools/list` to match the look. Treat the recipe's exit criteria as the spec, and use `ps_get_preview` plus the inline `after.jpg` to self-judge against them before declaring done. If `tools/list` includes a template-verify tool and the template carries a signature, run it for an objective per-assertion verdict with a corrective steer per miss; late in a long session, if a template-recall tool is present, use it to re-read the exit criteria cheaply instead of scrolling back to the full recipe.

To author a new template (when the right authoring tools are present in `tools/list`), the flow is two steps — first gather the evidence bundle, then write the recipe markdown in your response and save it. Surface this workflow when the user runs the same kind of edit twice and asks to make it repeatable.

# Done criteria

"Done" is task-type-dependent — see the precision-vs-subjective section. In summary:

- **The user says they are satisfied.** Always a valid stop signal regardless of task type.
- **Precision-critical task:** the user has SEEN the result (via the surfaced preview you sent in the check step) and explicitly confirmed it. Do not declare a precision task done on your own judgment.
- **Subjective adjustment task:** the next refinement you would propose is sub-perceptual — the kind of change that requires a 1-to-1 before/after comparison to see at all. Do not fuss endlessly over micro-tweaks the user did not ask you to chase.

If the task mixes both (a color grade + a logo placement), apply each rule to its respective portion. Stop iterating on the grade per the 2% rule; keep collaborating with the user on the placement until confirmed.
