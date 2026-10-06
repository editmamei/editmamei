# GIMP (beta)

Editmamei drives GIMP the same way it drives Photoshop: you describe the edit, the AI plans it, and
GIMP carries it out with its own real filters and tools. This page covers what's different about
the GIMP side: it runs headless, it's newer, and today it covers a smaller slice of editing than
the Photoshop surface does.

This is a **beta**. The `gimp_*` tools are new to Community as of 1.6.0, and the surface will grow
from here. If something behaves oddly, [open an issue](https://github.com/editmamei/editmamei/issues).

---

## What it is

A second, independent editor backend alongside Photoshop. When GIMP is detected on your machine (or
you've pinned Editmamei to it), the server registers a `gimp_*` tool set next to (or instead of) the
`ps_*` one. Which set the AI reaches for depends on what you asked for: use GIMP when you say so, or
when Photoshop isn't available.

Unlike Photoshop, there's no visible window. Editmamei starts a background `gimp-console` process and
talks to it directly; nothing is installed into your regular GIMP, and if you have the GIMP GUI open
separately, it's a completely different process that won't update. You follow along through rendered
previews in the conversation instead of watching a window change. See
[Headless: no window, previews instead](#headless-no-window-previews-instead) below.

---

## Requirements

- **GIMP 3.2.** GIMP 3.0 and 3.1 are refused outright with a clear version error, and so is any
  version outside the 3.x line. A newer 3.x (3.3 and up) is allowed and runs, but logs a warning
  that it's newer than the tested 3.2.x line: Editmamei hasn't been verified against it yet.
- **Windows, macOS, or Linux.** GIMP itself runs on all three; Editmamei's Photoshop side only
  supports Windows and macOS, so GIMP is currently the only editor Editmamei supports on Linux.
- GIMP must be built with Python support (`python-fu-eval`). Every official GIMP 3.2 build ships
  this; it's only missing on a hand-built install with Python explicitly disabled.

---

## Detection

Editmamei looks for GIMP in the conventional install locations for your OS:

| OS | Where it looks |
|---|---|
| **Windows** | `%LOCALAPPDATA%\Programs\GIMP 3\bin\` and `C:\Program Files\GIMP 3\bin\`, for `gimp-console-3.2.exe` or `gimp-console-3.exe` |
| **macOS** | `/Applications/GIMP.app/Contents/MacOS` and `~/Applications/GIMP.app/Contents/MacOS`, for `gimp-console-3.2`, `gimp-console-3`, or `gimp-console` |
| **Linux** | Your `PATH`, for `gimp-console-3.2`, `gimp-console-3`, or `gimp-console`, then a Flatpak install of `org.gimp.GIMP` |

If none of those match, `gimp_*` tools won't register, unless you've pinned the editor to `gimp`:
see [Pinning the editor](#pinning-the-editor) below, in which case they register anyway and every
call fails with a clear `gimp_not_installed` error instead of the surface silently not existing.

### Pointing at a custom install

If GIMP is installed somewhere the detector doesn't check, set the `EDITMAMEI_GIMP_PATH` environment
variable to the absolute path of your `gimp-console` binary, in your MCP client config's `env` block:

```json
{
  "mcpServers": {
    "editmamei": {
      "command": "npx",
      "args": ["-y", "editmamei", "serve"],
      "env": {
        "EDITMAMEI_GIMP_PATH": "D:\\GIMP 3\\bin\\gimp-console-3.2.exe"
      }
    }
  }
}
```

On Linux, to launch GIMP through Flatpak, set the environment variable to the literal value
`flatpak` instead of a path. This works only in the environment variable, not in the settings file.

The same thing can be set persistently in `~/.editmamei/settings.json` as the `gimp_path` key (a
plain absolute path), or with `editmamei config set gimp_path <path>`. The env var wins
over the settings file for the current run. An install that doesn't actually exist at the configured
path falls back to the normal auto-detect search rather than failing outright.

### Pinning the editor

By default (`editor: "auto"` in settings, or no `EDITMAMEI_EDITOR` env var), Editmamei registers
Photoshop tools always, and adds GIMP tools too if GIMP is found. To force one editor:

- `editmamei config set editor gimp` (or `EDITMAMEI_EDITOR=gimp`): register only `gimp_*` tools, even
  if Photoshop is also installed. If GIMP isn't found, the tools still register and report
  `gimp_not_installed` on every call, rather than vanishing.
- `editmamei config set editor photoshop` (or `EDITMAMEI_EDITOR=photoshop`): register only `ps_*`
  tools, regardless of what's installed.

The env var wins over the settings file for the current run, same as `gimp_path`.

---

## Headless: no window, previews instead

There's nothing to watch. `gimp_get_preview` renders the current state and returns it inline in the
conversation as a JPEG; it also writes the same render to `latest-preview.jpg` in the session's temp
folder, so a person following along can keep that file open and refresh it. `gimp_get_histogram` and
`gimp_compare` are the numeric checks alongside it.

`gimp_get_preview` and `gimp_compare`'s optional before/after previews both respect the
`privacy.send_previews_to_llm` setting: when it's off, no image bytes go to the model, only the
numbers. `latest-preview.jpg` is still written on your own disk. See
[privacy.md](privacy.md#what-you-control).

When you're done, `gimp_save_xcf` writes a `.xcf` you can open in the real GIMP application to see the
result directly, with every filter still live and re-editable there too. The `.xcf` keeps the photo's original
metadata (including any GPS location); only `gimp_export` removes it.

---

## What the beta covers

- **Documents:** open (most formats GIMP can load: JPEG, PNG, TIFF, WebP, HEIC/HEIF, XCF, and more),
  create a blank one, close, save as `.xcf` (live, re-editable), export flattened to
  jpg/jpeg/png/webp/tif/tiff. Convert between color and grayscale. JPEG photos tagged with an EXIF
  orientation (phone portraits, for example) are rotated upright on open and on `gimp_place_image`;
  other formats keep whatever orientation their own loader applies.
- **Layers:** create, delete, duplicate, group, reorder, rename, set opacity, blend mode and
  visibility, merge down, flatten (`gimp_layer`). Place another photo into the document as a new
  layer (`gimp_place_image`) to build a composite, and extend the canvas for borders and frames
  (`gimp_canvas`).
- **Non-destructive adjustments** (`gimp_add_adjustment`), 13 types: curves, levels, exposure,
  brightness/contrast, hue/saturation, color balance, color temperature, shadows/highlights,
  saturation, vibrance, sharpen, noise reduction, gaussian blur. Each stays live and re-editable by
  its `filter_id`; exporting writes a flattened copy and leaves the live document as it was.
- **Effects** (`gimp_add_effect`): vignette, black and white, motion blur, lens blur, noise, and
  drop shadow, live and re-editable the same way. `gimp_bake` merges a layer's live filters into its
  pixels when you want them fixed.
- **Selections and masks:** build a selection from a rectangle, ellipse, polygon, color range, magic
  wand, a layer's opaque pixels or a gradient, and save it under a name (`gimp_select`). Attach
  one as a layer mask, or remove, apply or invert a mask (`gimp_layer_mask`), and check the result
  in a rendered preview (`gimp_get_selection_preview`). A saved selection also confines a filter
  when you pass its name as `mask`.
- **Text:** live text layers you can create and restyle later, with content, font, color and
  alignment (`gimp_text`).
- **Moving and transforming layers:** fit, scale, move, rotate, flip, skew or free-transform a single
  layer (`gimp_transform_layer`). Moving a layer used to be a `gimp_layer` operation; it lives here
  now.
- **Geometry:** crop, resize, rotate (arbitrary angle, for straightening), flip.
- **Verification:** preview render, per-channel histogram (mean, median, percentiles, full 256-bin
  histogram), before/after and region comparison.
- **Filter-stack management:** list, toggle visibility, delete.
- **Checkpoints** (`gimp_checkpoint`): save the image's current state and restore it later.

---

## What it can't do yet

- No heal, clone, or content-aware retouch.
- No AI-backed selection (subject, sky, object): GIMP has no Sensei-equivalent built in, so selections are geometric, color-based or gradient.
- No step-by-step undo: use checkpoints instead (see below).
- Raw camera files (DNG, CR2, CR3, NEF, ARW, and the like) need a raw-develop plug-in installed in
  GIMP (darktable, RawTherapee, or ART). Without one, opening a raw file is refused with a message
  pointing at those plug-ins; develop it externally first and open the resulting JPEG/TIFF/PNG here.

---

## Checkpoints instead of undo, live filters for everything else

GIMP has no undo when it runs headless, so crop, resize, rotate, flip, merging and flattening can't
be stepped back one at a time. Instead, `gimp_checkpoint` saves the image's current state, every live
filter included, and restores it later: restoring replaces the open image with the saved state and
reports a new image id to use from then on. `gimp_checkpoint` op=list shows the checkpoints you have. Make one before anything you
might want to take back. Each image keeps up to 5 checkpoints (20 in all); they're deleted when
Editmamei exits, so save a `.xcf` for anything you want to keep.

Adjustments are the opposite: reversible any time. `gimp_filter` (op=delete) removes one, and passing
its `filter_id` back to `gimp_add_adjustment` re-edits it in place rather than stacking a second
correction on top.

One ordering rule ties the two together: straighten, flip, and resize the canvas **before** adding any
masked filter, then crop, then add masked filters. Rotate, flip, and resize all refuse
outright once a masked filter already exists (or any filter GIMP itself, or its GUI, created rather
than Editmamei), since GIMP has no way to keep a filter's baked-in mask aligned through those transforms.
Cropping is the one exception and is always safe.

---

## Troubleshooting

### GIMP isn't detected

Check that GIMP 3.2 is installed in one of the [conventional locations](#detection) for your
OS. If it's somewhere else, point at it directly with `EDITMAMEI_GIMP_PATH` or the `gimp_path`
setting: see [Pointing at a custom install](#pointing-at-a-custom-install). Restart your AI client
after changing either one; the server reads them once at startup.

### `gimp_starting`

The very first GIMP launch on a machine can take a few minutes: GIMP builds its font cache and scans
plug-ins on that first run. `gimp_ping` reports `starting: true` rather than failing while this is in
progress; call it again in about 30 seconds. Every launch after that first one is fast, usually a
few seconds (around 10 seconds on macOS).

### "The session restarted" / unsaved work is gone

If a call times out, or GIMP crashes, the session restarts and every open image and unsaved filter is
lost. Checkpoints survive this: `gimp_checkpoint` op=restore reopens one by its id (op=list shows them). Make one,
or save with `gimp_save_xcf`, before a large or slow operation (an exact histogram or a resize/rotate
on a big document, for example), so a restart only costs you the last few steps rather than the
whole session.

### Flatpak (Linux)

A Flatpak-packaged GIMP runs in its own process namespace, so Editmamei can't tie its lifetime to the
parent process the way it does elsewhere. If Editmamei's own process is killed abruptly, a Flatpak
GIMP process can be left running until the next session's cleanup, or until you close it or reboot.

### "This GIMP install has no Python support"

Reinstall GIMP with Python support enabled (`python-fu-eval` must be available). Every official GIMP
3.2 build includes this; it's only missing on a custom build with it explicitly stripped out.

### Pro doesn't add anything here

Pro's extra tools (Camera Raw develop, precision placement, named-object masks, face-mesh, warp,
templates, Actions and scripting) are Photoshop-only. See [pro-features.md](pro-features.md).
