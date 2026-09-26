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

- **GIMP 3.2 or newer.** GIMP 3.0 and 3.1 are refused outright with a clear version error. A newer
  3.x (3.3 and up) is allowed and runs, but logs a warning that it's newer than the tested 3.2.x
  line: Editmamei hasn't been verified against it yet.
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

On Linux, if you run GIMP through Flatpak from a non-standard location, set this to the literal value
`flatpak` instead of a path.

The same thing can be set persistently in `~/.editmamei/settings.json` as the `gimp_path` key (a
plain absolute path, or `flatpak`), or with `editmamei config set gimp_path <path>`. The env var wins
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
`privacy.send_previews_to_llm` setting, the same as the Photoshop side: when it's off, no image
bytes go to the model, only the dimensions and the file name. See
[privacy.md](privacy.md#what-you-control).

When you're done, `gimp_save_xcf` writes a `.xcf` you can open in the real GIMP application to see the
result directly, with every filter still live and re-editable there too.

---

## What the beta covers

- **Documents:** open (most formats GIMP can load: JPEG, PNG, TIFF, WebP, HEIC/HEIF, XCF, and more),
  close, save as `.xcf` (live, re-editable), export flattened to jpg/jpeg/png/webp/tif/tiff.
- **Non-destructive adjustments** (`gimp_add_adjustment`), 13 types: curves, levels, exposure,
  brightness/contrast, hue/saturation, color balance, color temperature, shadows/highlights,
  saturation, vibrance, sharpen, noise reduction, gaussian blur. Each stays live and re-editable by
  its `filter_id` until you export.
- **Masks:** `gimp_create_mask` builds a geometric mask (rectangle, ellipse, linear or radial
  gradient) that a new adjustment can be confined to.
- **Geometry:** crop, resize, rotate (arbitrary angle, for straightening), flip.
- **Verification:** preview render, per-channel histogram (mean, median, percentiles, full 256-bin
  histogram), before/after and region comparison.
- **Filter-stack management:** list, toggle visibility, delete.

---

## What it can't do yet

- No heal, clone, or content-aware retouch.
- No AI subject or sky selection (GIMP has no Sensei-equivalent built in; masks here are geometric
  only: rectangle, ellipse, or gradient).
- No text layers.
- No creating a new layer, or most layer-level operations beyond what an adjustment or a mask needs.
- No undo (see below).
- Raw camera files (DNG, CR2, CR3, NEF, ARW, and the like) need a raw-develop plug-in installed in
  GIMP (darktable, RawTherapee, or ART). Without one, opening a raw file is refused with a message
  pointing at those plug-ins; develop it externally first and open the resulting JPEG/TIFF/PNG here.

---

## No undo for geometry, live filters for everything else

Crop, resize, rotate, and flip are **irreversible in this session**: there's no undo. Save with
`gimp_save_xcf` before one of these if you might want to go back, and reopen that file to restore the
prior state.

Adjustments are the opposite: reversible any time. `gimp_filter` (op=delete) removes one, and passing
its `filter_id` back to `gimp_add_adjustment` re-edits it in place rather than stacking a second
correction on top.

One ordering rule ties the two together: straighten, flip, and resize the canvas **before** adding any
masked adjustment, then crop, then add masked adjustments. Rotate, flip, and resize all refuse
outright once a masked filter already exists (or any filter GIMP itself, or its GUI, created rather
than Editmamei), since GIMP has no way to keep a filter's baked-in mask aligned through those transforms.
Cropping is the one exception and is always safe.

---

## Troubleshooting

### GIMP isn't detected

Check that GIMP 3.2 or newer is installed in one of the [conventional locations](#detection) for your
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
lost, and there is no recovery. Save with `gimp_save_xcf` early, especially before a large or slow
operation (an exact histogram or a resize/rotate on a big document, for example), so a restart only
costs you the last few steps rather than the whole session.

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
