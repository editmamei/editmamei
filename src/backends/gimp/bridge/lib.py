# Pure, gi-free helpers for the GIMP bridge: PGM codec, histogram statistics,
# the `editmamei-filters` parasite ledger's parse/serialize, the request/
# response transport primitives (id/path derivation, atomic read/write, the
# request listing, and the request-processing pipeline itself), version-
# string parsing, and cross-platform process liveness.
#
# No `gi` import anywhere in this file — it runs standalone under
# `python -m unittest test_lib.py`, with no GIMP and no numpy. ops.py
# is exec'd by the bridge's batch line (not imported as a package), so it has
# no package context of its own to import a sibling module relatively; it
# adds its own directory to `sys.path` first and imports this module by name.
# "gi-free" describes the GIMP/GObject dependency, not I/O — the transport
# helpers below do real file I/O, same as any other stdlib code would.

import collections
import json
import math
import os
import re
import sys
import time
import traceback

LEDGER_VERSION = 1
LEDGER_WRITER = 'editmamei'

HIST_CHANNELS = ('luminance', 'red', 'green', 'blue')

# Sizes gimp_get_preview / the internal preview proxy may render at. Bounding
# this to a small fixed set keeps ops.py's PROXIES cache (one full duplicate
# of the document per (image, max_px) pair) at a bounded 3 entries per open
# image, instead of growing one entry per distinct value a caller ever asks
# for.
ALLOWED_PREVIEW_SIZES = (512, 1024, 2048)


def validate_max_px(value):
    """Validate a requested preview/proxy render size. Raises ValueError for
    anything outside ALLOWED_PREVIEW_SIZES; returns `value` unchanged otherwise."""
    if value not in ALLOWED_PREVIEW_SIZES:
        raise ValueError('max_px must be one of %s' % (ALLOWED_PREVIEW_SIZES,))
    return value


# A region histogram is computed on the (cheap) preview proxy when the region maps to at
# least this many proxy pixels on a side; otherwise it falls back to a full-resolution crop.
# Below this, the proxy has too few samples for the requested rectangle to mean anything.
MIN_PROXY_REGION_PX = 64


# ---- adjustment `type` -> GEGL operation, and pure (gi-free) parameter validation ----------
#
# Every adjust `type` maps to exactly one GEGL/GIMP operation, and its numeric ranges are
# validated here (pure Python, unit-tested without GIMP) before ops.py ever touches a
# DrawableFilter config. Keys in the dicts these `build_*_params` functions return are the
# GEGL property names verbatim (hyphenated), so ops.py's setters can set them directly.

ADJUST_OPERATIONS = {
    'curves': 'gimp:curves',
    'levels': 'gimp:levels',
    'exposure': 'gegl:exposure',
    'brightness_contrast': 'gimp:brightness-contrast',
    'hue_saturation': 'gimp:hue-saturation',
    'color_balance': 'gimp:color-balance',
    'color_temperature': 'gegl:color-temperature',
    'shadows_highlights': 'gegl:shadows-highlights',
    'saturation': 'gegl:saturation',
    'vibrance': 'gegl:vibrance',
    'sharpen': 'gegl:unsharp-mask',
    'noise_reduction': 'gegl:noise-reduction',
    'gaussian_blur': 'gegl:gaussian-blur',
}

# Length-typed GEGL properties that must be multiplied by the preview proxy's scale factor
# when a filter is mirrored onto it (see ops.py's `_mirror_filters`) -- an explicit allow-list
# per operation, not a heuristic (e.g. "any property named radius"), since a wrong guess here
# would silently mis-scale a filter that isn't actually spatial. Each entry's scaled value is
# also clamped to the operation's own pspec minimum (`ops.py` reads that back from the live
# config) so a small enough source scale never leaves GObject silently keeping the pre-scale
# value instead of the (invalid, too-small) one we asked for.
SPATIAL_SCALE_PROPS = {
    'gegl:shadows-highlights': ('radius',),
    'gegl:unsharp-mask': ('std-dev',),
    'gegl:gaussian-blur': ('std-dev-x', 'std-dev-y'),
    'gegl:motion-blur-linear': ('length',),
    'gegl:focus-blur': ('blur-radius',),
    'gegl:dropshadow': ('x', 'y', 'radius'),
    # gegl:vignette and gegl:mono-mixer are deliberately absent: vignette's radius/x/y are
    # proportional (fractions of the LAYER's own size, not absolute pixel lengths), and
    # mono-mixer is a per-pixel channel-weight filter with no spatial extent at all.
}

# Integer-valued properties that are scaled by the proxy factor too, but as a ROUNDED count
# rather than a continuous length -- `noise-reduction`'s `iterations` is a neighbourhood size,
# not a geometric radius, so scaling it is only an approximation of the full-res effect (unlike
# the exact scale-equivariance a Gaussian-blur-based radius gets); never below 1 (0 iterations
# is a no-op filter, which would silently discard the effect entirely on a small enough proxy).
INT_SPATIAL_SCALE_PROPS = {
    'gegl:noise-reduction': ('iterations',),
}

HUE_RANGES = ('all', 'red', 'yellow', 'green', 'cyan', 'blue', 'magenta')
TRANSFER_MODES = ('shadows', 'midtones', 'highlights')

# GIMP 3.2.6's file-tiff-export `compression` property is a plain string, not an introspectable
# enum -- these are the values that measured as accepted (an invalid string is silently ignored
# by GObject with a stderr warning and the export keeps its prior value, so a bad value here
# would export successfully with the WRONG compression rather than failing loudly). TIFF tag 259
# (Compression) values measured for each, on an 8-bit RGB export: none=1, lzw=5, packbits=32773,
# jpeg=7, adobe_deflate=8.
#
# `ccittfax3`/`ccittfax4` (CCITT Group 3/4) are deliberately NOT in this list: they are
# bilevel-only schemes, and applied to this engine's RGB content they measured as producing a
# degenerate ~8-byte file with no readable IFD at all -- a silent success reporting a byte count,
# not an error, for a genuinely broken output file. GIMP's own property still accepts the
# strings; this engine refuses them anyway rather than exposing an option two of whose seven
# values always produce a corrupt export.
TIFF_COMPRESSIONS = ('none', 'lzw', 'packbits', 'jpeg', 'adobe_deflate')

MASK_TYPES = ('rectangle', 'ellipse', 'gradient_linear', 'gradient_radial')

# gimp_layer's blend-mode allow-list: user-facing name -> the `Gimp.LayerMode` enum member NAME
# (a string; ops.py does `getattr(Gimp.LayerMode, LAYER_MODES[mode])` since this module stays
# gi-free). Deliberately the NON-legacy modes only, and only the ones with a plain Photoshop-style
# name -- GIMP 3.2.6 exposes ~30 more (LCH_*, *_LEGACY, DISSOLVE, BEHIND, ...) this tool doesn't
# surface. Probed live (GIMP 3.2.6) and goldened via each member's own `.value_nick`:
#   normal=normal multiply=multiply screen=screen overlay=overlay soft_light=softlight
#   hard_light=hardlight darken=darken-only lighten=lighten-only difference=difference
#   exclusion=exclusion addition=addition subtract=subtract divide=divide dodge=dodge burn=burn
#   hue=hsv-hue saturation=hsv-saturation color=hsl-color luminosity=luminance
# hue/saturation/color/luminosity map to the HSV/HSL (not LCH) variants -- those are the ones
# GIMP's own UI labels plainly "Hue"/"Saturation"/"Color"/"Luminosity" without a "(LCH)" suffix.
LAYER_MODES = {
    'normal': 'NORMAL',
    'multiply': 'MULTIPLY',
    'screen': 'SCREEN',
    'overlay': 'OVERLAY',
    'soft_light': 'SOFTLIGHT',
    'hard_light': 'HARDLIGHT',
    'darken': 'DARKEN_ONLY',
    'lighten': 'LIGHTEN_ONLY',
    'difference': 'DIFFERENCE',
    'exclusion': 'EXCLUSION',
    'addition': 'ADDITION',
    'subtract': 'SUBTRACT',
    'divide': 'DIVIDE',
    'dodge': 'DODGE',
    'burn': 'BURN',
    'hue': 'HSV_HUE',
    'saturation': 'HSV_SATURATION',
    'color': 'HSL_COLOR',
    'luminosity': 'LUMINANCE',
}


def validate_layer_mode(value):
    if value not in LAYER_MODES:
        raise ValueError('mode must be one of %s' % sorted(LAYER_MODES))
    return value


# gimp_layer op=create's fill options -- verified live that `Gimp.FillType.TRANSPARENT` exists
# and that a freshly created layer's content is otherwise undefined, so `create` always fills
# explicitly rather than trusting whatever `Gimp.Layer.new` leaves behind.
LAYER_FILLS = ('white', 'black', 'transparent')

# gimp_create_document / gimp_convert_image_mode's base-type choices -- indexed is deliberately
# absent (gimp_create_document has nothing to build a palette from, and gimp_convert_image_mode
# refuses an indexed source outright; see ops.py's own comments on both).
IMAGE_MODES = ('rgb', 'grayscale')

# Formats `_export_stripped` (ops.py) will write; every export/preview/compare raster save goes
# through it, and it refuses any other extension outright rather than falling back to a bare,
# metadata-unaware save.
EXPORT_FORMATS = {'.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp',
                  '.tif': 'tiff', '.tiff': 'tiff'}

BIT_DEPTHS = (8, 16)

# A DoS floor for `resize`: bounds a single call's memory/time cost regardless of how large the
# SOURCE document already is (crop/rotate/flip only ever shrink-or-preserve the existing canvas,
# so they don't need this; resize is the one op that can grow it arbitrarily from a tiny source).
MAX_RESIZE_SIDE_PX = 30_000
_DEFAULT_MAX_RESIZE_MEGAPIXELS = 250


def megapixel_cap_from_env(raw, default=_DEFAULT_MAX_RESIZE_MEGAPIXELS):
    """A host-supplied (`EM_GIMP_MAX_MEGAPIXELS`) ceiling that can only LOWER `default` -- a memory-
    constrained host (e.g. a small container) tightens every pixel-growing op's cap this way. Anything
    that is not a finite positive number below `default` (unset, empty, junk, NaN/inf, zero/negative,
    or an attempt to RAISE it) is ignored and `default` is returned unchanged."""
    if not raw:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value) or value <= 0 or value >= default:
        return default
    return value


MAX_RESIZE_MEGAPIXELS = megapixel_cap_from_env(os.environ.get('EM_GIMP_MAX_MEGAPIXELS'))

MAX_FEATHER_PX = 1000

# gimp_modify_selection's expand/contract/border radius cap -- much lower than MAX_FEATHER_PX.
# `Gimp.Selection.grow`/`shrink`/`border` are morphological (structuring-element) operations whose
# cost scales with the radius, unlike `feather` (a GEGL blur, flat ~0.5s regardless of radius on a
# 24MP image, measured live). This is the cap for a document at or below MORPHOLOGY_BASELINE_MP;
# a bigger document gets a SMALLER cap -- see `effective_morphology_px`.
MAX_MORPHOLOGY_PX = 150

# Measured live at px=150 (border, the most expensive of the three): ~30s at 24MP (6016x4000),
# ~73.5s at 100MP (14000x7143), and a GIMP session OUTRIGHT TIMEOUT past 180s at ~217MP
# (30000x7228, this bridge's own largest allowed document -- MAX_RESIZE_SIDE_PX/
# MAX_RESIZE_MEGAPIXELS). Cost does not scale linearly with megapixels (100MP was only ~2.45x the
# 24MP cost for a ~4.17x bigger image), but it very much does not fit inside
# gimp_modify_selection's budget either, so the cap itself has to shrink as the document grows.
MORPHOLOGY_BASELINE_MP = 24.0
# A document-size floor so a huge document still gets a meaningfully large morphology radius
# rather than being squeezed to single-digit pixels.
MIN_MORPHOLOGY_PX = 10


def effective_morphology_px(width, height):
    """The actual expand/contract/border cap for a `width`x`height` document: `MAX_MORPHOLOGY_PX`
    at or below `MORPHOLOGY_BASELINE_MP`, shrinking as 1/megapixels above it (simple and, per the
    live measurements on `MAX_MORPHOLOGY_PX`'s own comment, SAFELY conservative -- the real cost
    curve is sub-linear in megapixels, so this reduces the cap by more than the measured cost
    alone would require). Verified live at the two points that matter: at ~100MP the scaled cap
    (36px) cost ~11.8s; at ~217MP (this bridge's largest allowed document) the scaled cap (17px)
    cost ~27.2s -- both comfortably inside gimp_modify_selection's 45s budget with its own margin,
    even though a large document also carries a substantial FIXED per-call cost that shrinking
    `px` alone cannot remove (measured ~13-17s of that 27.2s at ~217MP comes from px=5 alone,
    i.e. just handling a document that size, before any morphology radius is even considered)."""
    megapixels = (width * height) / 1_000_000.0
    if megapixels <= MORPHOLOGY_BASELINE_MP:
        return MAX_MORPHOLOGY_PX
    scaled = MAX_MORPHOLOGY_PX * MORPHOLOGY_BASELINE_MP / megapixels
    return max(MIN_MORPHOLOGY_PX, min(MAX_MORPHOLOGY_PX, round(scaled)))


# gimp_transform_layer's scale/scale_x_percent/scale_y_percent bound -- generous enough for any
# real use (100x in either direction) while still keeping a single call's resulting layer size
# bounded alongside validate_resize_dims' own check on the actual pixel dimensions.
TRANSFORM_LAYER_MIN_SCALE_PERCENT = 1
TRANSFORM_LAYER_MAX_SCALE_PERCENT = 10_000

# gimp_transform_layer's `interpolation` choices -- the GIMP resampling filters this bridge
# exposes, by name. The gi-dependent mapping to the real `Gimp.InterpolationType` enum members
# lives in ops.py (this module stays gi-free).
TRANSFORM_LAYER_INTERPOLATIONS = ('none', 'linear', 'cubic', 'nohalo', 'lohalo')

# gimp_transform_layer's `free` op: offset_x/offset_y bound -- a sanity ceiling on the final
# absolute translation, well past MAX_RESIZE_SIDE_PX (30000) so any real placement fits, but
# tight enough that a wildly out-of-range value is refused here rather than only by the derived
# predicted-origin check (`_validated_move_offset`) it also feeds into.
TRANSFORM_LAYER_MAX_OFFSET_PX = 100_000

# gimp_transform_layer's own op -> the field names that op reads, the same role
# `type_fields`/`FILTER_COMMON_KEYS` play for gimp_add_adjustment/gimp_add_effect above --
# `reject_foreign_transform_fields` refuses any OTHER declared field a caller sent (e.g. a
# PS-style flat `delta_x`, or `skew_h_degrees` on op=scale), so a typo validates instead of
# silently being ignored by that op's own handler.
TRANSFORM_LAYER_COMMON_KEYS = frozenset(('image', 'op', 'layer', 'layer_id', 'interpolation'))

TRANSFORM_LAYER_OP_FIELDS = {
    'fit': ('mode',),
    'scale': ('scale_percent', 'scale_x_percent', 'scale_y_percent'),
    'move': ('delta', 'absolute', 'center_on'),
    'rotate': ('degrees',),
    'flip': ('axis',),
    'skew': ('skew_h_degrees', 'skew_v_degrees'),
    'free': ('scale_x_percent', 'scale_y_percent', 'degrees', 'offset_x', 'offset_y'),
}


def reject_foreign_transform_fields(op, args):
    """Refuse any field `op` does not read -- the gimp_transform_layer analogue of
    `reject_foreign_fields` above, over `TRANSFORM_LAYER_OP_FIELDS` instead of the filter-type
    tables. `op`'s own schema is flat (one property per name across every op), so without this a
    field meant for a DIFFERENT op (`skew_h_degrees` on op=scale, or PS's flat `delta_x` instead
    of this tool's nested `delta`) validates, is ignored by that op's own handler, and silently
    does nothing. None values are ignored (an omitted field)."""
    own = TRANSFORM_LAYER_OP_FIELDS.get(op, ())
    foreign = sorted(
        k for k, v in args.items()
        if v is not None and k not in TRANSFORM_LAYER_COMMON_KEYS and k not in own
    )
    if foreign:
        raise ValueError(
            "op '%s' does not use field(s) %s; its fields are: %s"
            % (op, ', '.join(foreign), ', '.join(own) or '(none)')
        )


def ceil_with_margin(value):
    """`value` rounded UP to the next whole pixel, plus one more -- the conservative integer a
    cap check validates against for a float `transformed_bounds` predicts, matching the extra
    pixel GIMP's own ADJUST transform-resize can add by rounding each edge of a rotated/sheared
    bounding box outward independently (floor the min edge, ceil the max edge), which can land
    the ACTUAL resulting integer width/height one pixel past a plain `ceil` of the float width.
    Never used for the transform's own corner coordinates (those stay exact floats) -- only for
    deciding whether to refuse BEFORE any pixel moves."""
    return int(math.ceil(value)) + 1


def transform_layer_precision_bucket(precision_nick):
    """`Gimp.Precision.value_nick` (e.g. 'u8-non-linear', 'u16-perceptual', 'float-linear')
    bucketed into the '8'/'16'/'32' strings `validate_document_dims`'s own
    `DOCUMENT_MEGAPIXEL_CAP` is keyed by -- gimp_transform_layer validates a layer's predicted
    size against the SAME precision-aware cap gimp_create_document does, rather than always
    assuming 8-bit. u32/half/float/double all bucket to '32' (4+ bytes/channel, the most
    conservative bucket) -- this bridge has no DOCUMENT_MEGAPIXEL_CAP entry finer than that."""
    nick = precision_nick.lower()
    if nick.startswith('u8'):
        return '8'
    if nick.startswith('u16') or nick.startswith('half'):
        return '16'
    return '32'


def require(args, name):
    """Fetch a required field from an op's `args`, raising ValueError naming it -- the
    classifier maps that to `invalid_argument`. A bare `args[name]` raises KeyError instead,
    which classifies as the much less actionable `gimp_op_failed`."""
    if name not in args or args[name] is None:
        raise ValueError('%s is required' % name)
    return args[name]


def require_bool(args, name):
    """Like `require`, but also rejects anything that isn't a real JSON boolean -- `bool("false")`
    is `True` in Python (any non-empty string is truthy), so a caller that sends the STRING
    "false" for e.g. `visible` would otherwise silently set it True instead of raising."""
    value = require(args, name)
    if not isinstance(value, bool):
        raise ValueError('%s must be a boolean, got %r' % (name, value))
    return value


def optional_bool(args, name, default=False):
    """Like `require_bool`, but returns `default` when `name` is absent or explicitly null --
    for an opt-in flag (e.g. `discard_hidden`, `all`) rather than one the caller must always
    supply. Still rejects a non-boolean when the field IS present, the same `bool("false")`
    trap `require_bool` guards against."""
    if name not in args or args[name] is None:
        return default
    if not isinstance(args[name], bool):
        raise ValueError('%s must be a boolean, got %r' % (name, args[name]))
    return args[name]


def validate_range(name, value, lo, hi):
    """Validate a float field is within [lo, hi]. Raises ValueError naming
    `name` (which the bridge's error classifier maps to `invalid_argument`)."""
    value = float(value)
    if not lo <= value <= hi:
        raise ValueError('%s must be within %s..%s' % (name, lo, hi))
    return value


def validate_int_range(name, value, lo, hi):
    value = int(value)
    if not lo <= value <= hi:
        raise ValueError('%s must be within %s..%s' % (name, lo, hi))
    return value


def validate_choice(name, value, choices):
    if value not in choices:
        raise ValueError('%s must be one of %s' % (name, sorted(choices)))
    return value


def validate_region(region, img_width, img_height):
    """A `region` dict must be a rectangle with positive size, entirely within the image --
    partly outside (a negative origin, or one edge past the image bounds) or fully outside both
    raise ValueError naming the field, rather than silently clamping to whatever sliver of it
    happens to overlap (a 1px-wide crop is a confusing result to debug, not a helpful default).
    Returns (x, y, width, height) as ints."""
    x = require(region, 'x')
    y = require(region, 'y')
    width = require(region, 'width')
    height = require(region, 'height')
    x, y, width, height = int(x), int(y), int(width), int(height)
    if width <= 0 or height <= 0:
        raise ValueError('region width and height must be positive')
    if x < 0 or y < 0 or x + width > img_width or y + height > img_height:
        raise ValueError(
            'region [%d,%d,%d,%d] must lie entirely within the %dx%d image'
            % (x, y, width, height, img_width, img_height)
        )
    return x, y, width, height


def validate_resize_dims(width, height):
    """A DoS floor on `resize`'s target dimensions: each side capped, and the product capped
    separately (a very wide, very short target could pass a per-side check yet still allocate an
    enormous buffer)."""
    if width <= 0 or height <= 0:
        raise ValueError('width and height must be positive')
    if width > MAX_RESIZE_SIDE_PX or height > MAX_RESIZE_SIDE_PX:
        raise ValueError('width and height must each be at most %d px' % MAX_RESIZE_SIDE_PX)
    megapixels = (width * height) / 1_000_000.0
    if megapixels > MAX_RESIZE_MEGAPIXELS:
        raise ValueError('resize target must be at most %g MP' % MAX_RESIZE_MEGAPIXELS)
    return width, height


# gimp_create_document's own megapixel ceiling, precision-aware: MAX_RESIZE_MEGAPIXELS (250) is
# sized for 8-bit-per-channel content; a 16-bit image is 2 bytes/channel (half the pixel budget
# for the same memory footprint, 125 MP) and a 32-bit float image is 4 bytes/channel (a quarter,
# 60 MP -- rounded down from the exact 62.5 to a plain number). `create_document` is the one op
# that picks its own bit depth up front (`open`/`resize`/etc. all work on whatever precision an
# already-open image happens to be), so it is the one place this DoS floor needs to vary by
# precision rather than assuming 8-bit throughout.
# A lowered EM_GIMP_MAX_MEGAPIXELS scales the 16/32-bit caps down with the 8-bit one, never above
# their own defaults.
DOCUMENT_MEGAPIXEL_CAP = {
    '8': MAX_RESIZE_MEGAPIXELS,
    '16': min(125, MAX_RESIZE_MEGAPIXELS / 2),
    '32': min(60, MAX_RESIZE_MEGAPIXELS / 4),
}


def validate_document_dims(width, height, precision='8'):
    """Like `validate_resize_dims`, but the megapixel ceiling depends on `precision` ('8', '16', or
    '32') -- see `DOCUMENT_MEGAPIXEL_CAP`'s own comment for why create_document needs its own
    variant instead of the plain 8-bit-assuming one."""
    if width <= 0 or height <= 0:
        raise ValueError('width and height must be positive')
    if width > MAX_RESIZE_SIDE_PX or height > MAX_RESIZE_SIDE_PX:
        raise ValueError('width and height must each be at most %d px' % MAX_RESIZE_SIDE_PX)
    cap = DOCUMENT_MEGAPIXEL_CAP[precision]
    megapixels = (width * height) / 1_000_000.0
    if megapixels > cap:
        raise ValueError('a %s-bit document must be at most %g MP' % (precision, cap))
    return width, height


def validate_feather_px(value):
    return validate_range('feather_px', value, 0.0, MAX_FEATHER_PX)


_HEX_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')

# gimp_canvas's fill choices: the same white/black/transparent LAYER_FILLS a new layer gets, plus
# a #rrggbb hex color the fixed enum can't express -- validated by regex here since it's an open
# set, not a membership check like every other choice validator in this file.
CANVAS_FILLS = LAYER_FILLS


def validate_canvas_fill(value):
    if value in CANVAS_FILLS or (isinstance(value, str) and _HEX_COLOR_RE.fullmatch(value)):
        return value
    raise ValueError(
        "fill must be one of %s, or a '#rrggbb' hex color, got %r" % (sorted(CANVAS_FILLS), value)
    )


def validate_hex_color(name, value):
    """A '#rrggbb' hex color -- the same `_HEX_COLOR_RE` gimp_canvas's own fill validates against,
    reused here so a color field never silently reaches `Gegl.Color.new` with a string it cannot
    parse (which would otherwise fall back to black)."""
    if not isinstance(value, str) or not _HEX_COLOR_RE.fullmatch(value):
        raise ValueError('%s must be a "#rrggbb" hex color, got %r' % (name, value))
    return value


def _round_half_up(value):
    """Round half away from zero, unlike Python's builtin `round()` (round-half-to-even:
    `round(0.5) == 0`, `round(2.5) == 2`) -- surprising for a user-facing pixel radius, where
    "4.5 px" should become 5, not 4."""
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def validate_positive_px(name, value, max_px=MAX_FEATHER_PX):
    """A strictly positive pixel radius (expand/contract/border/feather). Rounds half-up to the
    nearest whole pixel FIRST, then refuses anything that is not strictly positive or exceeds
    max_px -- so a value that ROUNDS to 0 (e.g. 0.3) is refused, same as an outright 0 or
    negative, rather than silently accepted as a no-op radius."""
    rounded = int(_round_half_up(float(value)))
    if not 0 < rounded <= max_px:
        raise ValueError('%s must round to a value greater than 0 and at most %s' % (name, max_px))
    return rounded


# load_mask's own DoS floor on a SOURCE mask image's dimensions. Checked right after
# `Gimp.file_load` decodes the file (GIMP's Python environment has no cheap way to read a PNG/
# JPEG header's own width/height without decoding -- GdkPixbuf is not bound in this environment),
# so it bounds the IN-MEMORY size before the heavier work that follows (alpha compositing, scale,
# flatten), not the decode itself. Reuses the same cap `validate_resize_dims` applies to a resize
# target, since both are "how big a single in-memory image may get" limits.
def validate_loaded_mask_dims(width, height):
    return validate_resize_dims(width, height)


def compute_mask_paste_rect(ox, oy, tw, th, img_width, img_height):
    """Where a `tw`x`th` mask (already scaled to its target -- the whole image, or one layer's own
    bounds, at offset `(ox, oy)`) actually lands inside the `img_width`x`img_height` canvas: the
    intersection of [ox, ox+tw) x [oy, oy+th) with [0, img_width) x [0, img_height). Pure and
    gi-free so the off-canvas cases (a negative offset, or a layer hanging off the right/bottom
    edge) are unit-tested without GIMP. Returns (x0, y0, x1, y1); x1 <= x0 or y1 <= y0 means the
    mask lands ENTIRELY off-canvas (nothing to paste -- the channel stays all-black there)."""
    x0 = max(0, ox)
    y0 = max(0, oy)
    x1 = min(img_width, ox + tw)
    y1 = min(img_height, oy + th)
    return x0, y0, x1, y1


# gimp_canvas's anchor grid -> the fraction of the GROWTH (new size minus old size) that lands
# BEFORE the existing content on each axis. 0.0 pins that edge (no padding there); 1.0 puts all
# the padding there instead; 0.5 splits it evenly. Keyed by the full 3x3 grid a Photoshop-style
# "Canvas Size" anchor picker offers.
_CANVAS_ANCHOR_FRACTIONS = {
    'top_left': (0.0, 0.0), 'top_center': (0.5, 0.0), 'top_right': (1.0, 0.0),
    'middle_left': (0.0, 0.5), 'center': (0.5, 0.5), 'middle_right': (1.0, 0.5),
    'bottom_left': (0.0, 1.0), 'bottom_center': (0.5, 1.0), 'bottom_right': (1.0, 1.0),
}
CANVAS_ANCHORS = tuple(_CANVAS_ANCHOR_FRACTIONS)


def canvas_anchor_offset(anchor, old_width, old_height, new_width, new_height):
    """(offset_x, offset_y) for `Image.resize(new_width, new_height, offset_x, offset_y)` that
    places the EXISTING old_width x old_height content at `anchor` within the new, larger canvas.
    Pure arithmetic (gi-free) -- ops.py's `op_canvas` supplies the live image's own before/after
    dimensions and passes the result straight to the bridge primitive."""
    if anchor not in _CANVAS_ANCHOR_FRACTIONS:
        raise ValueError('anchor must be one of %s' % sorted(_CANVAS_ANCHOR_FRACTIONS))
    # Floor, not round: the growth is always >= 0 (gimp_canvas is extend-only), so floor is just
    # `int()` truncation here -- picked over `round()` because Python's round() is round-half-to-
    # EVEN (banker's rounding), which would silently flip which side of an odd split gets the
    # extra pixel depending on whether that half-pixel count happens to be even or odd. floor()
    # always gives the same, simpler rule: the leading edge (top/left) gets the smaller share.
    fx, fy = _CANVAS_ANCHOR_FRACTIONS[anchor]
    return (
        math.floor((new_width - old_width) * fx),
        math.floor((new_height - old_height) * fy),
    )


# EXIF Orientation (1-8) -> the steps that turn the stored pixels upright, in order. Each step is
# 'cw90' / 'cw180' / 'cw270' (clockwise rotation), 'flip_h' (mirror left-right) or 'flip_v'
# (mirror top-bottom). 1 (normal) needs none.
EXIF_ORIENTATION_STEPS = {
    1: (),
    2: ('flip_h',),
    3: ('cw180',),
    4: ('flip_v',),
    5: ('cw90', 'flip_h'),
    6: ('cw90',),
    7: ('cw90', 'flip_v'),
    8: ('cw270',),
}


def parse_exif_orientation(raw):
    """The EXIF Orientation value (1-8) from a metadata tag's raw value, or None when it is
    missing, non-numeric or out of range -- a broken tag is ignored, never an error."""
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value if value in EXIF_ORIENTATION_STEPS else None


def exif_orientation_steps(orientation):
    """The upright-making steps for an EXIF Orientation value; () for None, 1 or anything else."""
    return EXIF_ORIENTATION_STEPS.get(orientation, ())


EXIF_ORIENTATION_TAG = 'Exif.Image.Orientation'


def read_exif_orientation(metadata):
    """The orientation (1-8) a GimpMetadata-like object carries, or None when `metadata` is None,
    has no usable tag, or reading it raises."""
    if metadata is None:
        return None
    try:
        return parse_exif_orientation(metadata.try_get_tag_string(EXIF_ORIENTATION_TAG))
    except Exception:
        return None


# Every tag a viewer may read orientation from; the EXIF one is the one this bridge applies.
ORIENTATION_TAGS = (EXIF_ORIENTATION_TAG, 'Xmp.tiff.Orientation', 'Exif.Thumbnail.Orientation')


def clear_exif_orientation(metadata):
    """Removes the orientation tags from `metadata` (absent reads as normal); True when the EXIF
    one was cleared. Clearing is used rather than writing 1: GIMP's metadata object can silently
    ignore a write of that tag while still reporting success."""
    cleared = False
    for tag in ORIENTATION_TAGS:
        try:
            ok = bool(metadata.try_clear_tag(tag))
        except Exception:
            ok = False
        if tag == EXIF_ORIENTATION_TAG:
            cleared = ok
    return cleared


def pct_to_unit(name, value, lo=-100.0, hi=100.0):
    """User-facing -100..100 (or a narrower lo..hi) percent-like value -> the -1..1 unit
    GEGL/GIMP properties in this family use."""
    return validate_range(name, value, lo, hi) / 100.0


def degrees_to_unit(name, value, lo=-180.0, hi=180.0):
    """User-facing -180..180 degrees -> the -1..1 unit `gimp:hue-saturation`'s `hue` uses."""
    return validate_range(name, value, lo, hi) / 180.0


def resolve_field(args, user_key, defaults, gegl_key, convert):
    """One GEGL-unit field for an `adjust` type: the caller's OWN value (converted from
    user-facing units via `convert`) when `user_key` is present in `args`; otherwise whatever is
    already in `defaults` under `gegl_key` -- the type's hardcoded creation defaults when a
    filter is being CREATED, or the existing live filter's own ledger params when it's being
    RE-EDITED by `filter_id`.

    This is what makes a re-edit a MERGE rather than a reset: re-editing `{contrast: 50}` on a
    brightness_contrast filter must not silently snap `brightness` back to 0 just because this
    particular call didn't mention it."""
    if user_key in args:
        return convert(args[user_key])
    return defaults[gegl_key]


def build_exposure_params(args, defaults):
    # GEGL's own `exposure` pspec is unbounded (+/- DBL_MAX); +/-10 stops is a bound a real
    # photograph never needs and keeps the field meaningful as a user-facing range.
    return {
        'exposure': resolve_field(
            args, 'exposure', defaults, 'exposure',
            lambda v: validate_range('exposure', v, -10.0, 10.0),
        ),
        'black-level': resolve_field(
            args, 'black_level', defaults, 'black-level',
            lambda v: validate_range('black_level', v, -0.1, 0.1),
        ),
    }


def build_brightness_contrast_params(args, defaults):
    return {
        'brightness': resolve_field(
            args, 'brightness', defaults, 'brightness', lambda v: pct_to_unit('brightness', v)
        ),
        'contrast': resolve_field(
            args, 'contrast', defaults, 'contrast', lambda v: pct_to_unit('contrast', v)
        ),
    }


def build_hue_saturation_params(args, defaults):
    return {
        'range': resolve_field(
            args, 'range', defaults, 'range', lambda v: validate_choice('range', v, HUE_RANGES)
        ),
        'hue': resolve_field(args, 'hue', defaults, 'hue', lambda v: degrees_to_unit('hue', v)),
        'saturation': resolve_field(
            args, 'saturation', defaults, 'saturation', lambda v: pct_to_unit('saturation', v)
        ),
        'lightness': resolve_field(
            args, 'lightness', defaults, 'lightness', lambda v: pct_to_unit('lightness', v)
        ),
    }


def build_color_balance_params(args, defaults):
    # One filter targets one range (shadows/midtones/highlights), the same one-filter-per-facet
    # idiom as curves' one-filter-per-channel -- a full three-range grade is three filters.
    return {
        'range': resolve_field(
            args, 'range', defaults, 'range', lambda v: validate_choice('range', v, TRANSFER_MODES)
        ),
        'cyan-red': resolve_field(
            args, 'cyan_red', defaults, 'cyan-red', lambda v: pct_to_unit('cyan_red', v)
        ),
        'magenta-green': resolve_field(
            args, 'magenta_green', defaults, 'magenta-green', lambda v: pct_to_unit('magenta_green', v)
        ),
        'yellow-blue': resolve_field(
            args, 'yellow_blue', defaults, 'yellow-blue', lambda v: pct_to_unit('yellow_blue', v)
        ),
        'preserve-luminosity': resolve_field(
            args, 'preserve_luminosity', defaults, 'preserve-luminosity', bool
        ),
    }


def build_color_temperature_params(args, defaults):
    # `from_kelvin` (what the photo currently looks shot at) -> `original-temperature`;
    # `to_kelvin` (the corrected target) -> `intended-temperature`.
    return {
        'original-temperature': resolve_field(
            args, 'from_kelvin', defaults, 'original-temperature',
            lambda v: validate_range('from_kelvin', v, 1000.0, 12000.0),
        ),
        'intended-temperature': resolve_field(
            args, 'to_kelvin', defaults, 'intended-temperature',
            lambda v: validate_range('to_kelvin', v, 1000.0, 12000.0),
        ),
    }


def build_shadows_highlights_params(args, defaults):
    return {
        'shadows': resolve_field(
            args, 'shadows', defaults, 'shadows', lambda v: validate_range('shadows', v, -100.0, 100.0)
        ),
        'highlights': resolve_field(
            args, 'highlights', defaults, 'highlights',
            lambda v: validate_range('highlights', v, -100.0, 100.0),
        ),
        'whitepoint': resolve_field(
            args, 'whitepoint', defaults, 'whitepoint',
            lambda v: validate_range('whitepoint', v, -10.0, 10.0),
        ),
        'radius': resolve_field(
            args, 'radius', defaults, 'radius', lambda v: validate_range('radius', v, 0.1, 1500.0)
        ),
        'compress': resolve_field(
            args, 'compress', defaults, 'compress', lambda v: validate_range('compress', v, 0.0, 100.0)
        ),
        'shadows-ccorrect': resolve_field(
            args, 'shadows_ccorrect', defaults, 'shadows-ccorrect',
            lambda v: validate_range('shadows_ccorrect', v, 0.0, 100.0),
        ),
        'highlights-ccorrect': resolve_field(
            args, 'highlights_ccorrect', defaults, 'highlights-ccorrect',
            lambda v: validate_range('highlights_ccorrect', v, 0.0, 100.0),
        ),
    }


def build_saturation_params(args, defaults):
    return {
        'scale': resolve_field(
            args, 'scale', defaults, 'scale', lambda v: validate_range('scale', v, 0.0, 10.0)
        )
    }


def build_vibrance_params(args, defaults):
    return {
        'vibrance': resolve_field(
            args, 'vibrance', defaults, 'vibrance', lambda v: validate_range('vibrance', v, -100.0, 100.0)
        ),
        'saturation': resolve_field(
            args, 'saturation', defaults, 'saturation', lambda v: validate_range('saturation', v, 0.0, 10.0)
        ),
    }


def build_sharpen_params(args, defaults):
    return {
        'std-dev': resolve_field(
            args, 'radius', defaults, 'std-dev', lambda v: validate_range('radius', v, 0.0, 1500.0)
        ),
        'scale': resolve_field(
            args, 'amount', defaults, 'scale', lambda v: validate_range('amount', v, 0.0, 300.0)
        ),
        'threshold': resolve_field(
            args, 'threshold', defaults, 'threshold', lambda v: validate_range('threshold', v, 0.0, 1.0)
        ),
    }


def build_noise_reduction_params(args, defaults):
    return {
        'iterations': resolve_field(
            args, 'strength', defaults, 'iterations',
            lambda v: validate_int_range('strength', v, 1, 32),
        )
    }


def build_gaussian_blur_params(args, defaults):
    # One user-facing `radius` drives both axes: a symmetric blur, the only kind the tool exposes.
    # std-dev-x and std-dev-y always hold the same value, so the merge base can read either.
    std_dev = resolve_field(
        args, 'radius', defaults, 'std-dev-x', lambda v: validate_range('radius', v, 0.0, 1500.0)
    )
    return {'std-dev-x': std_dev, 'std-dev-y': std_dev}


def validate_levels(params):
    """Cross-field checks for a resolved levels record (user units, 0-255 levels). The setter
    range-checks each level on its own; these are the relationships it can't see: gamma within
    the tool's 0.1..10 bound (GEGL's own pspec is wider, so an out-of-range value would otherwise
    render), and an input range that isn't empty or inverted."""
    validate_range('gamma', params['gamma'], 0.1, 10.0)
    if not params['in_low'] < params['in_high']:
        raise ValueError(
            'in_low (%s) must be less than in_high (%s)' % (params['in_low'], params['in_high'])
        )
    return params


ADJUST_PARAM_BUILDERS = {
    'exposure': build_exposure_params,
    'brightness_contrast': build_brightness_contrast_params,
    'hue_saturation': build_hue_saturation_params,
    'color_balance': build_color_balance_params,
    'color_temperature': build_color_temperature_params,
    'shadows_highlights': build_shadows_highlights_params,
    'saturation': build_saturation_params,
    'vibrance': build_vibrance_params,
    'sharpen': build_sharpen_params,
    'noise_reduction': build_noise_reduction_params,
    'gaussian_blur': build_gaussian_blur_params,
}

# Creation-time defaults, already in GEGL-property units -- the `defaults` a builder receives
# when there is no existing filter to re-edit (a fresh `resolve_field` call for every field
# then falls through to these, since the caller gave none of them).
ADJUST_CREATE_DEFAULTS = {
    'exposure': {'exposure': 0.0, 'black-level': 0.0},
    'brightness_contrast': {'brightness': 0.0, 'contrast': 0.0},
    'hue_saturation': {'range': 'all', 'hue': 0.0, 'saturation': 0.0, 'lightness': 0.0},
    'color_balance': {
        'range': 'midtones', 'cyan-red': 0.0, 'magenta-green': 0.0, 'yellow-blue': 0.0,
        'preserve-luminosity': True,
    },
    'color_temperature': {'original-temperature': 6500.0, 'intended-temperature': 6500.0},
    'shadows_highlights': {
        'shadows': 0.0, 'highlights': 0.0, 'whitepoint': 0.0, 'radius': 100.0, 'compress': 50.0,
        'shadows-ccorrect': 100.0, 'highlights-ccorrect': 50.0,
    },
    'saturation': {'scale': 1.0},
    'vibrance': {'vibrance': 0.0, 'saturation': 1.0},
    'sharpen': {'std-dev': 3.0, 'scale': 0.5, 'threshold': 0.0},
    'noise_reduction': {'iterations': 4},
    'gaussian_blur': {'std-dev-x': 1.5, 'std-dev-y': 1.5},
}


# ---- gimp_add_effect: allow-listed GEGL effect filters --------------------------------------
#
# The parallel tables to ADJUST_OPERATIONS/ADJUST_PARAM_BUILDERS/ADJUST_CREATE_DEFAULTS above,
# for `gimp_add_effect`'s `type` field rather than `gimp_add_adjustment`'s `type` field -- a
# DIFFERENT bridge op (`effect`, dispatched to `op_effect` in ops.py -- gimp_add_effect is its
# own tool, tier 'dev', a sibling of gimp_add_adjustment rather than an op on gimp_filter), so
# these stay separate dicts rather than merged into the ADJUST_* ones; only the GEGL-property
# SETTERS functions in ops.py are shared across both (an operation name is an operation name
# regardless of which tool created the filter).
#
# Deliberately excludes gegl:gaussian-blur (already ADJUST_OPERATIONS' `gaussian_blur`, see
# gimp-adjustment-tools.ts) and gegl:c2g: c2g excluded, ~35s full-res export at 24 MP (measured
# live), over the ~30s budget -- does not ship here.
EFFECT_OPERATIONS = {
    'vignette': 'gegl:vignette',
    'black_white': 'gegl:mono-mixer',
    'motion_blur': 'gegl:motion-blur-linear',
    # gegl:focus-blur, NOT gegl:lens-blur -- see build_lens_blur_params' own comment: lens-blur
    # exists in this GIMP's GEGL, but GIMP itself refuses to attach it as a non-destructive
    # DrawableFilter (an 'aux'-pad operation), so it is unusable in this bridge's architecture.
    'lens_blur': 'gegl:focus-blur',
    'add_noise': 'gegl:noise-rgb',
    'drop_shadow': 'gegl:dropshadow',
}

# The inverse of ADJUST_OPERATIONS and EFFECT_OPERATIONS together, for a ledger record written
# without a `type` field -- one shared map, since `op_list_filters` looks a record's operation up
# here regardless of which tool (gimp_add_adjustment or gimp_add_effect) created it.
OPERATION_TYPES = {operation: type_ for type_, operation in ADJUST_OPERATIONS.items()}
OPERATION_TYPES.update({operation: type_ for type_, operation in EFFECT_OPERATIONS.items()})

# Every validate_range/validate_int_range call below uses `val`, not `v`, as its lambda's
# parameter name -- deliberately, so it is NOT matched by gimp-adjustment-tools.test.ts's own
# `parseLibPyBounds` regex (which requires the literal substring ", v,"). That regex scans this
# WHOLE file, not just ADJUST_PARAM_BUILDERS, so an accidental match here would silently fold a
# filter-effect bound into an unrelated adjust field's drift check (e.g. sharpen's `amount`) --
# `val` keeps the two files' schema-bounds-drift tests fully decoupled.


def build_vignette_params(args, defaults):
    # Proportional/scale-invariant, relative to the LAYER's own extent (the drawable this filter
    # attaches to, not the document canvas -- every GEGL op here runs per-drawable): x/y are a
    # fraction of width/height. `radius`'s own reference measured live as NOT a single clean
    # formula (e.g. a plain half-diagonal or half-width) across every aspect ratio tried -- rather
    # than assert a specific geometric claim this bridge can't fully verify, the description
    # instead states the one thing confirmed true and load-bearing for SPATIAL_SCALE_PROPS: it is
    # relative, not absolute pixels, so the same value looks visually equivalent at any
    # resolution. Unlike the spatial effects below, nothing here needs a SPATIAL_SCALE_PROPS entry
    # -- the same value renders correctly on the preview proxy as at full resolution.
    return {
        'radius': resolve_field(
            args, 'radius', defaults, 'radius', lambda val: validate_range('radius', val, 0.0, 3.0)
        ),
        'softness': resolve_field(
            args, 'softness', defaults, 'softness',
            lambda val: validate_range('softness', val, 0.0, 1.0),
        ),
        'gamma': resolve_field(
            args, 'gamma', defaults, 'gamma', lambda val: validate_range('gamma', val, 0.1, 10.0)
        ),
        'x': resolve_field(
            args, 'center_x', defaults, 'x', lambda val: validate_range('center_x', val, 0.0, 1.0)
        ),
        'y': resolve_field(
            args, 'center_y', defaults, 'y', lambda val: validate_range('center_y', val, 0.0, 1.0)
        ),
    }


def build_black_white_params(args, defaults):
    # `preserve_luminosity`: when True, GEGL rescales the weighted sum so the output matches the
    # ORIGINAL pixel's brightness even when the three weights don't sum to 1 -- verified live, a
    # flat 128-gray input stays 128 with weights (0.1, 0.1, 0.1) and preserve=True, but comes back
    # darker (measured 0x48) with the same weights and preserve=False. Weights summing to exactly
    # 0 (e.g. 0,0,0) do NOT divide by zero or produce NaN either way -- verified live, GEGL returns
    # plain black -- so no extra guard is needed here for that case.
    return {
        'red': resolve_field(
            args, 'red_weight', defaults, 'red',
            lambda val: validate_range('red_weight', val, -5.0, 5.0),
        ),
        'green': resolve_field(
            args, 'green_weight', defaults, 'green',
            lambda val: validate_range('green_weight', val, -5.0, 5.0),
        ),
        'blue': resolve_field(
            args, 'blue_weight', defaults, 'blue',
            lambda val: validate_range('blue_weight', val, -5.0, 5.0),
        ),
        # require_bool, not a bare `bool()` cast (bool("false") is True in Python -- any
        # non-empty string is truthy) -- resolve_field's own convert callback only ever sees the
        # raw VALUE, not (args, name), so the merge-not-reset fallback is inlined here instead of
        # going through resolve_field for this one field.
        'preserve-luminosity': (
            require_bool(args, 'preserve_luminosity')
            if 'preserve_luminosity' in args
            else defaults['preserve-luminosity']
        ),
    }


def build_motion_blur_params(args, defaults):
    return {
        'length': resolve_field(
            args, 'length', defaults, 'length', lambda val: validate_range('length', val, 0.0, 1000.0)
        ),
        'angle': resolve_field(
            args, 'angle', defaults, 'angle', lambda val: validate_range('angle', val, -180.0, 180.0)
        ),
    }


def build_lens_blur_params(args, defaults):
    # gegl:lens-blur (GIMP 3.2's GEGL does ship it) turned out unusable here -- verified live,
    # `gimp-drawable-append-filter` refuses it outright ("effects with an 'aux' pad cannot be
    # applied non-destructively"), so every call would silently attach nothing (no exception, no
    # ledger record, filter count staying 0). gegl:focus-blur DOES attach; its blur amount
    # property is named `blur-radius`, not `radius` (the external field name here stays `radius`
    # regardless -- see EFFECT_CREATE_DEFAULTS). Two more properties are forced in ops.py's
    # `_set_lens_blur`, not part of this dict and not user-configurable:
    #  - `radius` (an unrelated, same-named property sizing an in-focus zone that never blurs) is
    #    forced to 0, so the effect is a uniform blur, not a tilt-shift one.
    #  - `blur-type` is forced to 'lens' (its own default is 'gaussian', which would make this a
    #    second, redundant gaussian_blur and leave `highlight_factor` inert -- verified live:
    #    'lens' mode produces a real bokeh highlight boost, a bright spot's halo reaching ~3x
    #    farther out at highlight_factor 1 vs 0, and 'lens' mode DOES attach as a non-destructive
    #    filter despite being the more elaborate mode -- the 'aux'-pad restriction that sank
    #    gegl:lens-blur does not apply inside this meta-operation).
    # `blur-radius`'s cap is lowered from the union's 1500 to 150: 'lens' mode measured live as
    # much more expensive than a separable blur (~35s for a full-res 24 MP export at radius 300,
    # ~17s at 150), so the cap keeps the worst case comfortably under the ~30s budget every
    # effect here is held to.
    return {
        'blur-radius': resolve_field(
            args, 'radius', defaults, 'blur-radius',
            lambda val: validate_range('radius', val, 0.0, 150.0),
        ),
        'highlight-factor': resolve_field(
            args, 'highlight_factor', defaults, 'highlight-factor',
            lambda val: validate_range('highlight_factor', val, 0.0, 1.0),
        ),
    }


def build_add_noise_params(args, defaults):
    # One user-facing `noise_amount` drives red/green/blue uniformly, the same "one field, several
    # identical GEGL properties" idiom `build_gaussian_blur_params` uses for std-dev-x/std-dev-y.
    amount = resolve_field(
        args, 'noise_amount', defaults, 'red',
        lambda val: validate_range('noise_amount', val, 0.0, 1.0),
    )
    return {
        'red': amount,
        'green': amount,
        'blue': amount,
        'alpha': resolve_field(
            args, 'alpha', defaults, 'alpha', lambda val: validate_range('alpha', val, 0.0, 1.0)
        ),
        'seed': resolve_field(
            args, 'seed', defaults, 'seed',
            lambda val: validate_int_range('seed', val, 0, 4294967295),
        ),
    }


def build_drop_shadow_params(args, defaults):
    # Only meaningful on a layer with an alpha channel -- a shadow is cast from what's transparent
    # around the opaque content; on a fully opaque layer there is nothing for it to show through.
    return {
        'x': resolve_field(
            args, 'offset_x', defaults, 'x', lambda val: validate_range('offset_x', val, -500.0, 500.0)
        ),
        'y': resolve_field(
            args, 'offset_y', defaults, 'y', lambda val: validate_range('offset_y', val, -500.0, 500.0)
        ),
        'radius': resolve_field(
            args, 'radius', defaults, 'radius', lambda val: validate_range('radius', val, 0.0, 1500.0)
        ),
        'opacity': resolve_field(
            args, 'opacity', defaults, 'opacity', lambda val: validate_range('opacity', val, 0.0, 1.0)
        ),
    }


EFFECT_PARAM_BUILDERS = {
    'vignette': build_vignette_params,
    'black_white': build_black_white_params,
    'motion_blur': build_motion_blur_params,
    'lens_blur': build_lens_blur_params,
    'add_noise': build_add_noise_params,
    'drop_shadow': build_drop_shadow_params,
}

# Creation-time defaults, already in GEGL-property units -- probed live via `describe_operation`
# against GIMP 3.2.6's real GEGL pspecs, except vignette's radius and softness: GEGL's own 1.2/0.8
# renders the corners black, so these are chosen for a subtle vignette (corners about a quarter
# darker, measured on real photos).
EFFECT_CREATE_DEFAULTS = {
    'vignette': {'radius': 2.0, 'softness': 1.0, 'gamma': 2.0, 'x': 0.5, 'y': 0.5},
    'black_white': {'red': 0.333, 'green': 0.333, 'blue': 0.333, 'preserve-luminosity': False},
    'motion_blur': {'length': 10.0, 'angle': 0.0},
    'lens_blur': {'blur-radius': 25.0, 'highlight-factor': 0.0},
    'add_noise': {'red': 0.2, 'green': 0.2, 'blue': 0.2, 'alpha': 0.0, 'seed': 0},
    'drop_shadow': {'x': 20.0, 'y': 20.0, 'radius': 10.0, 'opacity': 0.5},
}


def _scaled(factor):
    # Rounded so a GEGL value that went through a /100 or /180 on the way in reads back as the
    # number the caller typed (0.2 * 100 is 20.000000000000004 in binary floating point). A value
    # given with at most 6 decimals round-trips exactly; one with more comes back rounded to 6,
    # a difference of about 1e-8 in GEGL units, far below one 8-bit level.
    return lambda v: round(v * factor, 6)


def _same(v):
    return v


# GEGL-unit ledger params -> the tool's own field names and units, per adjust type: the inverse
# of each build_*_params above, as (user_key, gegl_key, convert). `gimp_filter op=list` reports
# these, so a model can pass a listed value straight back on a re-edit. curves/levels already
# store user units.
USER_FIELDS = {
    'exposure': (
        ('exposure', 'exposure', _same),
        ('black_level', 'black-level', _same),
    ),
    'brightness_contrast': (
        ('brightness', 'brightness', _scaled(100)),
        ('contrast', 'contrast', _scaled(100)),
    ),
    'hue_saturation': (
        ('range', 'range', _same),
        ('hue', 'hue', _scaled(180)),
        ('saturation', 'saturation', _scaled(100)),
        ('lightness', 'lightness', _scaled(100)),
    ),
    'color_balance': (
        ('range', 'range', _same),
        ('cyan_red', 'cyan-red', _scaled(100)),
        ('magenta_green', 'magenta-green', _scaled(100)),
        ('yellow_blue', 'yellow-blue', _scaled(100)),
        ('preserve_luminosity', 'preserve-luminosity', _same),
    ),
    'color_temperature': (
        ('from_kelvin', 'original-temperature', _same),
        ('to_kelvin', 'intended-temperature', _same),
    ),
    'shadows_highlights': (
        ('shadows', 'shadows', _same),
        ('highlights', 'highlights', _same),
        ('whitepoint', 'whitepoint', _same),
        ('radius', 'radius', _same),
        ('compress', 'compress', _same),
        ('shadows_ccorrect', 'shadows-ccorrect', _same),
        ('highlights_ccorrect', 'highlights-ccorrect', _same),
    ),
    'saturation': (('scale', 'scale', _same),),
    'vibrance': (
        ('vibrance', 'vibrance', _same),
        ('saturation', 'saturation', _same),
    ),
    'sharpen': (
        ('radius', 'std-dev', _same),
        ('amount', 'scale', _same),
        ('threshold', 'threshold', _same),
    ),
    'noise_reduction': (('strength', 'iterations', _same),),
    'gaussian_blur': (('radius', 'std-dev-x', _same),),
    # ---- gimp_add_effect's effects (EFFECT_OPERATIONS, not ADJUST_OPERATIONS) ------------------
    'vignette': (
        ('radius', 'radius', _same),
        ('softness', 'softness', _same),
        ('gamma', 'gamma', _same),
        ('center_x', 'x', _same),
        ('center_y', 'y', _same),
    ),
    'black_white': (
        ('red_weight', 'red', _same),
        ('green_weight', 'green', _same),
        ('blue_weight', 'blue', _same),
        ('preserve_luminosity', 'preserve-luminosity', _same),
    ),
    'motion_blur': (
        ('length', 'length', _same),
        ('angle', 'angle', _same),
    ),
    'lens_blur': (
        ('radius', 'blur-radius', _same),
        ('highlight_factor', 'highlight-factor', _same),
    ),
    'add_noise': (
        ('noise_amount', 'red', _same),
        ('alpha', 'alpha', _same),
        ('seed', 'seed', _same),
    ),
    'drop_shadow': (
        ('offset_x', 'x', _same),
        ('offset_y', 'y', _same),
        ('radius', 'radius', _same),
        ('opacity', 'opacity', _same),
    ),
}

CURVES_USER_FIELDS = ('channel', 'points')
LEVELS_USER_FIELDS = ('channel', 'in_low', 'in_high', 'gamma', 'out_low', 'out_high')

# Keys every adjust/effect call may carry whatever its type: addressing, identity, and the mask.
FILTER_COMMON_KEYS = frozenset(('image', 'type', 'layer', 'layer_id', 'filter_id', 'mask', 'name'))


def type_fields(type_):
    """The tool-facing field names `type_`'s builder reads (same tables `user_params` reports)."""
    if type_ == 'curves':
        return CURVES_USER_FIELDS
    if type_ == 'levels':
        return LEVELS_USER_FIELDS
    return tuple(user for user, _gegl, _convert in USER_FIELDS.get(type_, ()))


def reject_foreign_fields(type_, args):
    """Refuse any field `type_` does not read. The tool schemas are flat (one property per name
    across every type), so without this a field meant for another type -- `saturation` on type
    `saturation`, whose knob is `scale` -- validates, is ignored by the builder, and creates a
    filter that does nothing. None values are ignored (an omitted field)."""
    own = type_fields(type_)
    foreign = sorted(
        k for k, v in args.items()
        if v is not None and k not in FILTER_COMMON_KEYS and k not in own
    )
    if foreign:
        raise ValueError(
            "type '%s' does not use field(s) %s; its fields are: %s"
            % (type_, ', '.join(foreign), ', '.join(own) or '(none)')
        )


def user_params(type_, params):
    """A ledger record's `params` in the tool's own field names and units -- what `list` reports
    for a filter this bridge created. `type_` may be None for a record written before `type` was
    stored; the caller passes the type derived from the operation instead. The filter's `mask` is
    reported separately, so it is not repeated here. Unknown types fall back to the raw params
    (minus `mask`) rather than guessing."""
    if type_ == 'curves':
        return {k: params[k] for k in CURVES_USER_FIELDS if k in params}
    if type_ == 'levels':
        return {k: params[k] for k in LEVELS_USER_FIELDS if k in params}
    fields = USER_FIELDS.get(type_)
    if fields is None:
        return {k: v for k, v in params.items() if k != 'mask'}
    return {user: convert(params[gegl]) for user, gegl, convert in fields if gegl in params}


def json_safe(value):
    """A readback property value made JSON-serialisable: plain JSON scalars pass through, lists
    and dicts are walked, a GeglColor becomes its [r, g, b, a] (see below), and anything else (a
    path object, bytes) becomes its str(). One foreign filter with such a property must not fail
    `list` for the whole image."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)  # JSON has no NaN/Infinity; Node's JSON.parse rejects them
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    # lib.py is gi-free (no `import gi`/`Gegl`), so a GeglColor can only be recognized by duck
    # type, not `isinstance` -- the same reproducibility problem `op_describe_operation`'s own
    # GeglColor handling exists to fix (a bare str() embeds a live object pointer address that
    # differs every run, e.g. a foreign vignette/dropshadow filter's `color` property read back
    # through `op_list_filters`), solved the same way: `get_rgba()` is the stable, meaningful
    # summary. Any other object that merely happens to expose a zero-arg `get_rgba()` would be
    # vanishingly unlikely and still degrades safely to a 4-number list.
    get_rgba = getattr(value, 'get_rgba', None)
    if callable(get_rgba):
        try:
            return [json_safe(c) for c in get_rgba()]
        except Exception:
            pass
    return str(value)

# The only operations `describe_operation` will probe -- an allow-list, not "any GEGL/GIMP
# operation name the caller cares to ask about": the probe instantiates a real DrawableFilter,
# and an unbounded operation name is an unnecessary surface (arbitrary-op instantiation, error
# text from GIMP's own PDB) for a probe whose only real job is confirming the schema of the
# operations this engine actually uses.
ALLOWED_DESCRIBE_OPERATIONS = frozenset(ADJUST_OPERATIONS.values()) | frozenset(EFFECT_OPERATIONS.values())


# ---- geometry-op masked-filter detection (pure logic; ops.py supplies the live GIMP state) -----


def stale_ledger_names(filters, live_names):
    """Names present in the ledger's `filters` dict that no longer match any LIVE filter name.
    These must be pruned before a geometry op's masked-filter check runs, or a filter someone
    deleted outside `filter op=delete` (the GUI, a foreign tool, a document edited elsewhere)
    would go on blocking rotate/flip/resize forever for a filter that isn't even there."""
    return set(filters) - set(live_names)


def classify_geometry_filters(filters, live_filters):
    """Decide, for every LIVE filter currently on the image, whether it's masked, unmasked, or
    impossible to verify -- the basis for `rotate`/`flip`/`resize`'s refusal check, which iterates
    LIVE filters rather than trusting the ledger alone (a live filter the ledger doesn't know
    about might still be masked; the ledger alone can't say either way).

    `filters` is the ledger's own {name: {"operation":..., "params": {...}}} map (already pruned
    of stale entries -- see `stale_ledger_names`). `live_filters` is an iterable of
    (name, operation) pairs for every filter actually attached to a layer right now.

    A live filter counts as OURS only when the ledger has a record under the SAME name AND that
    record's operation matches the live filter's own operation (the same double-check
    `_existing_filter` uses elsewhere, so a name collision with a different operation is never
    mistaken for a match) -- for an ours filter, `masked` is decided by that record's own `mask`
    param. Anything else (no record at all, or a name/operation the ledger doesn't recognise) is
    reported `unverifiable`: it might be masked, and there is no way to tell, so the caller must
    treat it as if it were.

    A name seen on MORE THAN ONE live filter is unverifiable too, regardless of what the ledger
    says: the ledger's {name: record} shape can only ever describe ONE of them, so a lookup by
    name can silently answer for the wrong filter -- a masked one hiding behind an unmasked one's
    ledger record (or the reverse) would otherwise slip through unnoticed. This bridge's own
    create path never produces a duplicate (`_unique_name` checks every layer first), but nothing
    stops a foreign filter (the GUI, a hand-edited document) from colliding with one this bridge
    DID create.

    Returns (masked_names, unverifiable_names), both lists, in the order `live_filters` was
    given (a duplicate name appears in `unverifiable` once per occurrence, not de-duplicated, so
    the caller's own count of what it iterated still lines up)."""
    live_filters = list(live_filters)
    name_counts = {}
    for name, _operation in live_filters:
        name_counts[name] = name_counts.get(name, 0) + 1
    masked = []
    unverifiable = []
    for name, operation in live_filters:
        if name_counts[name] > 1:
            unverifiable.append(name)
            continue
        rec = filters.get(name)
        if rec and rec.get('operation') == operation:
            if rec.get('params', {}).get('mask'):
                masked.append(name)
        else:
            unverifiable.append(name)
    return masked, unverifiable


def unique_name(taken, base):
    """`base`, or `base` suffixed " 2", " 3", ... until it is not in `taken` (an iterable of
    already-used names). GIMP allows duplicate names for both filters and layers, so nothing on
    the GIMP side stops a caller who doesn't check first -- this is what backs the "unique names
    enforced" contract for both the filter ledger (ops.py's `_unique_name`) and `gimp_layer`'s own
    layer naming (`_unique_layer_name`)."""
    taken = set(taken)
    name, n = base, 2
    while name in taken:
        name, n = '%s %d' % (base, n), n + 1
    return name


# ---- geometry transforms for direction/position-dependent EFFECT params ---------------------
#
# Scoped to gimp_add_effect's new effects only: vignette (center_x/center_y), motion_blur
# (angle), and drop_shadow (offset_x/offset_y, radius) have params whose MEANING is tied to a
# direction or a position, which flip/rotate/resize can silently misalign relative to the
# content unless the param itself is transformed the same way the pixels were. black_white and
# add_noise are pure per-pixel operations (no direction or position at all) -- neither needs a
# flip/rotate entry, and both are simply absent from those two tables below. lens_blur is a
# symmetric radial blur (no direction either) but DOES scale under resize (see
# resize_effect_params). Existing gimp_add_adjustment types (gaussian_blur, sharpen,
# shadows_highlights) are NOT covered here -- a deliberate scope cut, not an oversight.
#
# ONLY exact cases are supported: flip (horizontal/vertical) for all three; rotate by an exact
# right angle (0/90/180/270, mod 360) for all three; any uniform or anisotropic resize. Rotating
# by anything else while one of these effects is present is REFUSED outright by ops.py's
# `op_rotate` (see `is_right_angle_degrees`) rather than silently approximated -- vignette's own
# param is a fraction of its LAYER's own extent (see build_vignette_params), and a layer's own
# bounding box only has a well-defined "old vs new size" relationship at a right angle (swap at
# 90/270, unchanged at 0/180); at an arbitrary angle a rotated rectangle's bounding box depends on
# more than just the old width/height, so there is no single honest formula for the layer's own
# new extent. Refusing is simpler and more honest than a formula that would be exact for two of
# the three effects and wrong for the third.
#
# ops.py calls these BEFORE mutating the image at all (`_snapshot_effect_transform`): every
# affected filter's new params are computed from a SNAPSHOT of the ledger and validated against
# this bridge's own field ranges (`validate_effect_transform`) first, and the WHOLE geometry op is
# refused up front if anything would land out of range -- only once every filter's new params are
# known-valid does the geometry mutation itself run, followed by pushing the precomputed values
# into the live GEGL config and the ledger. This also happens only once `_refuse_if_masked_
# filters` has already confirmed every live filter is unmasked and ledgered.


def _wrap_angle_deg(angle):
    """Wrap to the (-180, 180] range validate_range enforces for every `angle` field here."""
    wrapped = ((angle + 180.0) % 360.0) - 180.0
    if wrapped <= -180.0:
        wrapped += 360.0
    return wrapped


def is_right_angle_degrees(degrees, tolerance=1e-6):
    """True when `degrees` is 0/90/180/270 (mod 360, either sign) within `tolerance` -- the only
    rotations op_rotate allows while a position/direction-dependent effect (vignette, motion_blur,
    drop_shadow) is present. See this section's own comment for why any other angle is refused
    rather than approximated."""
    normalized = degrees % 90.0
    return normalized < tolerance or normalized > 90.0 - tolerance


def _dims_after_right_angle_rotation(width, height, degrees):
    """The new (width, height) of a rectangle rotated by an exact right angle about its own
    center: 90/270 (mod 360) swap the two; 0/180 leave them as they were. Only ever called with a
    `degrees` `is_right_angle_degrees` has already confirmed."""
    normalized = degrees % 180.0
    if abs(normalized - 90.0) < 1e-6:
        return height, width
    return width, height


def _right_angle_k(degrees):
    """`degrees` as a whole number of 90-degree clockwise steps, 0-3. `is_right_angle_degrees`
    only confirms `degrees` is within floating-point TOLERANCE of an exact multiple of 90 (e.g.
    89.9999999 or 90.0000003 both pass) -- rounding to the nearest integer multiple here snaps it
    to the exact canonical step before any trig happens, so that tolerance-level noise can never
    reach `_right_angle_cos_sin`."""
    return round(degrees / 90.0) % 4


def _right_angle_cos_sin(degrees):
    """Exact cos/sin for a right-angle rotation, looked up from {0, 1, -1} rather than computed
    via `math.cos`/`math.sin(math.radians(...))` -- the latter returns a tiny nonzero (e.g.
    6.123233995736766e-17) for cos(90 degrees) instead of an exact 0.0. Left uncorrected, that
    noise propagates into a value that should land EXACTLY on its pre-rotation number (a vignette
    center at a canvas edge, 0.0 or 1.0; a drop shadow offset at the schema's own bound, +/-500),
    and `gimp_filter op=list` would report something like 4.999999999999999e-17 or
    500.00000000000006 instead of a clean value -- and, worse, could push a value that started
    exactly AT a validated bound just outside it."""
    k = _right_angle_k(degrees)
    cos_by_k = (1.0, 0.0, -1.0, 0.0)
    sin_by_k = (0.0, 1.0, 0.0, -1.0)
    return cos_by_k[k], sin_by_k[k]


# How many decimal places a transformed float is rounded to before it is validated or written to
# the ledger -- defence in depth alongside the exact right-angle trig above: resize's sqrt/hypot
# math has genuine (much smaller) irrational rounding noise of its own that no lookup table can
# remove, and this keeps every transform's output equally clean rather than exact-only for
# rotation and merely "close" for resize.
_TRANSFORM_ROUND_NDIGITS = 9


def _round_transform_value(value):
    """A single transformed float, rounded to `_TRANSFORM_ROUND_NDIGITS` places. Applied ONLY to
    the specific field(s) a flip_effect_params/rotate_effect_params/resize_effect_params branch
    below actually computes -- never blanket-applied to a whole params dict. A value this module
    never touches (every gimp_add_adjustment type's own fields, since none of them are in this
    table; black_white/add_noise's fields; the other two effects' fields when only one of the
    three is present) must come back bit-for-bit IDENTICAL to its input: `_snapshot_effect_
    transform`'s own `new_params == params` check is what decides whether a filter needs
    re-applying at all, and rounding a value that was never actually touched would manufacture a
    spurious "this filter changed" for it -- re-setting, re-ledgering, and (if the live update ever
    failed) wrongly reporting it in `effect_update_failures`, on every single flip/rotate/resize
    regardless of what it actually did. hue_saturation's own `hue` (stored as degrees/180, a
    non-terminating binary fraction for most degree values) is exactly the kind of value a
    blanket, whole-dict round would perturb in its 9th-10th decimal place -- already enough for
    `==` to call it "changed" even though nothing about it should have moved at all."""
    return round(value, _TRANSFORM_ROUND_NDIGITS)


def rotate_point_fraction(x_frac, y_frac, degrees, old_width, old_height, new_width, new_height):
    """Rotate a point expressed as a FRACTION of a layer's own width/height (vignette's center_x/
    center_y) by `degrees` -- always an exact right angle, see `is_right_angle_degrees` -- using
    the exact same clockwise-positive convention `ops.py`'s `op_rotate` applies to layer/channel
    pixels via `Item.transform_rotate`, re-expressing the result as a fraction of the
    possibly-different NEW extent (old/new either match or swap at a right angle).

    Rotating a rectangle around its own center always leaves the new bounding box centered at
    that SAME physical point, so the old and new centers coincide regardless of whether the
    dimensions swapped -- the old center (in old-extent coordinates) and the new center (in
    new-extent coordinates) name the identical point in space, which is what lets this convert
    between the two coordinate frames with no separate translation term. Uses the EXACT cos/sin
    lookup (`_right_angle_cos_sin`), not raw trig, so a point already at an extent's edge (0.0 or
    1.0) lands exactly back on an edge rather than a hair off it."""
    old_cx, old_cy = old_width / 2.0, old_height / 2.0
    new_cx, new_cy = new_width / 2.0, new_height / 2.0
    dx = x_frac * old_width - old_cx
    dy = y_frac * old_height - old_cy
    cos_t, sin_t = _right_angle_cos_sin(degrees)
    rx = dx * cos_t - dy * sin_t
    ry = dx * sin_t + dy * cos_t
    return (new_cx + rx) / new_width, (new_cy + ry) / new_height


def flip_effect_params(operation, params, orientation):
    """New params for a ledgered effect filter's `operation` after a flip along `orientation`
    ('horizontal' or 'vertical'), so the effect stays locked to the content instead of the raw
    pixel grid. Verified live: vignette's `x`/`y` are plain image-pixel-convention fractions (0 =
    left/top edge, increasing right/down); motion-blur-linear's `angle` is 0 = along +x
    (horizontal), 90 = along +y (vertical, i.e. downward), increasing CLOCKWISE -- the same sense
    `op_rotate` uses; dropshadow's `x`/`y` are plain pixel offsets (positive = right/down).
    Operations with no direction-dependent param -- black_white, add_noise, lens_blur, and every
    OTHER operation this table has no branch for at all (every gimp_add_adjustment type included)
    -- come back as the EXACT SAME object, untouched: `_snapshot_effect_transform` compares the
    result to the input by `==` to decide whether a filter needs re-applying at all, so this must
    never manufacture a spurious difference (a stray rounding of a value it was never asked to
    change) for a filter it has nothing to say about."""
    if operation == 'gegl:vignette':
        params = dict(params)
        if orientation == 'horizontal':
            params['x'] = _round_transform_value(1.0 - params['x'])
        else:
            params['y'] = _round_transform_value(1.0 - params['y'])
        return params
    if operation == 'gegl:motion-blur-linear':
        params = dict(params)
        if orientation == 'horizontal':
            params['angle'] = _round_transform_value(_wrap_angle_deg(180.0 - params['angle']))
        else:
            params['angle'] = _round_transform_value(_wrap_angle_deg(-params['angle']))
        return params
    if operation == 'gegl:dropshadow':
        params = dict(params)
        if orientation == 'horizontal':
            params['x'] = _round_transform_value(-params['x'])
        else:
            params['y'] = _round_transform_value(-params['y'])
        return params
    return params


def rotate_effect_params(operation, params, degrees, layer_width, layer_height):
    """New params for a ledgered effect filter's `operation` after a rotate by an exact right
    angle (0/90/180/270 mod 360 -- op_rotate refuses any other angle while a filter this table
    covers is present, see `is_right_angle_degrees`). `layer_width`/`layer_height` are the OWNING
    LAYER's own PRE-rotation dimensions (not the canvas/image's): vignette's center_x/center_y are
    a fraction of the LAYER's own extent (build_vignette_params), and a layer's own bounding box
    swaps width/height under a 90/270 rotation independently of whether the canvas itself grows
    (`expand`) to match. motion_blur and drop_shadow need no dimensions at all -- their params are
    layer-agnostic at a right angle (see flip_effect_params's own doc comment for the angle/offset
    conventions reused here, including why every OTHER operation -- every gimp_add_adjustment type
    included -- comes back as the exact same object, untouched). `degrees` is snapped to its exact
    canonical step (`_right_angle_k`) before use everywhere below, including the plain addition
    for motion_blur's angle -- not just where trig is involved -- so a tolerance-fuzzy `degrees`
    (e.g. 90.0000003) can never leak into a stored value."""
    if operation == 'gegl:vignette':
        params = dict(params)
        new_width, new_height = _dims_after_right_angle_rotation(layer_width, layer_height, degrees)
        x, y = rotate_point_fraction(
            params['x'], params['y'], degrees, layer_width, layer_height, new_width, new_height
        )
        params['x'], params['y'] = _round_transform_value(x), _round_transform_value(y)
        return params
    if operation == 'gegl:motion-blur-linear':
        params = dict(params)
        canonical_degrees = _right_angle_k(degrees) * 90.0
        params['angle'] = _round_transform_value(_wrap_angle_deg(params['angle'] + canonical_degrees))
        return params
    if operation == 'gegl:dropshadow':
        params = dict(params)
        cos_t, sin_t = _right_angle_cos_sin(degrees)
        dx, dy = params['x'], params['y']
        params['x'] = _round_transform_value(dx * cos_t - dy * sin_t)
        params['y'] = _round_transform_value(dx * sin_t + dy * cos_t)
        return params
    return params


def resize_effect_params(operation, params, scale_x, scale_y):
    """New params for a ledgered effect filter's `operation` after a resize that scales width by
    `scale_x` and height by `scale_y` (independently -- gimp_resize_image's width+height form can
    stretch aspect).

    motion_blur is a directional vector (length, angle), so an ANISOTROPIC resize (scale_x !=
    scale_y) changes both: treating the blur direction as a unit vector (cos(angle), sin(angle))
    in the same clockwise-positive, y-down convention flip_effect_params documents, its two
    components scale independently by (scale_x, scale_y); the resulting vector's own length and
    angle are the new length and angle -- length' = length * hypot(scale_x * cos(angle), scale_y *
    sin(angle)), angle' = atan2(scale_y * sin(angle), scale_x * cos(angle)). Exact for any
    scale_x/scale_y, and reduces to plain isotropic scaling (length * scale_x, angle unchanged)
    when scale_x == scale_y, since hypot(s*cos,s*sin) == s and atan2(s*sin,s*cos) == atan2(sin,cos)
    for any positive s.

    lens_blur's `blur-radius` and drop_shadow's `radius` are ISOTROPIC (one scalar radius, no
    direction), scaled by the geometric mean of scale_x/scale_y -- exact when the resize is
    uniform, and the least-wrong single number when it isn't (a circular blur/shadow has no single
    exact radius under an anisotropic stretch). drop_shadow's offset_x/offset_y scale along their
    own axis exactly. vignette's radius/x/y are already proportional (a fraction of the layer's
    own, now-resized extent) and need no change at all -- absent from this table on purpose.
    black_white and add_noise have no absolute-pixel param either, and every OTHER operation this
    table has no branch for at all (every gimp_add_adjustment type included) comes back as the
    exact same object, untouched -- see flip_effect_params's own doc comment for why that matters."""
    if operation == 'gegl:motion-blur-linear':
        params = dict(params)
        theta = math.radians(params['angle'])
        vx = scale_x * math.cos(theta)
        vy = scale_y * math.sin(theta)
        params['length'] = _round_transform_value(params['length'] * math.hypot(vx, vy))
        params['angle'] = _round_transform_value(_wrap_angle_deg(math.degrees(math.atan2(vy, vx))))
        return params
    if operation == 'gegl:focus-blur':
        params = dict(params)
        isotropic_scale = math.sqrt(scale_x * scale_y)
        params['blur-radius'] = _round_transform_value(params['blur-radius'] * isotropic_scale)
        return params
    if operation == 'gegl:dropshadow':
        params = dict(params)
        isotropic_scale = math.sqrt(scale_x * scale_y)
        params['x'] = _round_transform_value(params['x'] * scale_x)
        params['y'] = _round_transform_value(params['y'] * scale_y)
        params['radius'] = _round_transform_value(params['radius'] * isotropic_scale)
        return params
    return params


# Bounds for the GEGL properties a geometry transform can touch, keyed by operation -- the SAME
# ranges build_vignette_params/build_motion_blur_params/build_lens_blur_params/
# build_drop_shadow_params validate on create/re-edit, so a value THIS bridge computes from a
# flip/rotate/resize can never silently land somewhere those entry points would have refused (a
# plain GObject property setter would otherwise just clamp it there without telling anyone).
EFFECT_TRANSFORM_BOUNDS = {
    'gegl:vignette': {'x': (0.0, 1.0), 'y': (0.0, 1.0)},
    'gegl:motion-blur-linear': {'length': (0.0, 1000.0), 'angle': (-180.0, 180.0)},
    'gegl:focus-blur': {'blur-radius': (0.0, 150.0)},
    'gegl:dropshadow': {'x': (-500.0, 500.0), 'y': (-500.0, 500.0), 'radius': (0.0, 1500.0)},
}

# The user-facing (gimp_add_effect) field name for each EFFECT_TRANSFORM_BOUNDS entry -- so a
# refusal message can say "center_x", "offset_x", or "radius" (what the model actually typed and
# what gimp_filter op=list reports back), not the internal GEGL property name ("x") a caller has
# never seen. TestEffectTransformBoundsMatchBuilders (test_lib.py) pins that every entry here maps
# to a real field the matching build_*_params function actually validates.
EFFECT_TRANSFORM_FIELD_NAMES = {
    ('gegl:vignette', 'x'): 'center_x',
    ('gegl:vignette', 'y'): 'center_y',
    ('gegl:motion-blur-linear', 'length'): 'length',
    ('gegl:motion-blur-linear', 'angle'): 'angle',
    ('gegl:focus-blur', 'blur-radius'): 'radius',
    ('gegl:dropshadow', 'x'): 'offset_x',
    ('gegl:dropshadow', 'y'): 'offset_y',
    ('gegl:dropshadow', 'radius'): 'radius',
}


def validate_effect_transform(op_name, operation, filter_name, new_params):
    """Refuse `op_name` (the geometry op about to run) outright if any of `new_params` -- already
    computed for `operation` by flip_effect_params/rotate_effect_params/resize_effect_params --
    would leave the range its own create/re-edit path enforces. Called BEFORE the geometry
    mutation runs (ops.py's `_snapshot_effect_transform`), so a filter that would end up out of
    range never gets a chance to silently clamp via GObject's own property setter instead of a
    clear, actionable refusal -- and the geometry op never partially applies. Names the filter
    (`filter_name`, the same way `_refuse_if_masked_filters` does) and the field in gimp_add_
    effect's OWN terms (`EFFECT_TRANSFORM_FIELD_NAMES`), not the raw GEGL property name."""
    for prop, (lo, hi) in EFFECT_TRANSFORM_BOUNDS.get(operation, {}).items():
        if prop not in new_params:
            continue
        value = new_params[prop]
        if not lo <= value <= hi:
            field = EFFECT_TRANSFORM_FIELD_NAMES.get((operation, prop), prop)
            # "the %s field of filter %r" rather than "%r's %s" -- the latter puts repr()'s own
            # closing quote directly against a literal possessive "'s", printing as a confusing
            # doubled apostrophe ("'Motion Blur''s"). %.6g (not %.4g): enough significant figures
            # that a value just barely out of range (1000.1 against a 1000.0 bound) still shows
            # the ".1" that IS the reason for the refusal, instead of rounding it away to "1000".
            raise ValueError(
                '%s would leave the %s field of filter %r at %.6g, outside its %s..%s range. '
                'Delete it (gimp_filter op=delete) and re-add it after this geometry change.'
                % (op_name, field, filter_name, value, lo, hi)
            )



# ---- gimp_transform_layer: pure geometry math (fit/fill scale, matrix composition, bounds) ----
#
# A layer-level affine transform (scale/rotate/skew/free), distinct from the whole-CANVAS
# geometry ops above and from the direction/position-dependent EFFECT param remapping above.
# `Item.transform_matrix` (ops.py) applies the given 3x3 matrix directly in ABSOLUTE
# document-pixel coordinates -- verified live (GIMP 3.2.6): a matrix built by
# `compose_layer_matrix` below, applied to a layer at a known offset, moved it to exactly the
# bounding box this module's own `transformed_bounds` predicts for the same matrix and corners
# (within floating-point rounding). So every matrix built here already carries whatever
# translation is needed to anchor the transform at the layer's own center; there is no separate
# "local" coordinate frame to convert into or out of first.


def fit_scale_fraction(layer_width, layer_height, canvas_width, canvas_height, mode):
    """The uniform scale fraction (1.0 = 100%) that makes a `layer_width` x `layer_height`
    rectangle fit inside (mode='fit', letterbox -- the SMALLER of the two axis ratios) or fill
    (mode='fill', cover -- the LARGER) a `canvas_width` x `canvas_height` canvas, preserving
    aspect. `op_transform_layer`'s `fit` scales by this fraction and centers the result; fitting
    an already-fitted layer computes a fraction of 1.0, a no-op scale -- what makes that op
    idempotent."""
    if mode not in ('fit', 'fill'):
        raise ValueError("mode must be one of 'fit', 'fill'")
    width_ratio = canvas_width / float(layer_width)
    height_ratio = canvas_height / float(layer_height)
    return min(width_ratio, height_ratio) if mode == 'fit' else max(width_ratio, height_ratio)


def _mat_mul(a, b):
    """3x3 matrix product, both `a` and `b` flat row-major 9-lists (the same layout
    `Item.transform_matrix`'s own 9 positional args use), applied to a column vector [x,y,1] as
    p' = a*(b*p) -- `b` is the transform applied FIRST."""
    return [
        a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
        a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
        a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
        a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
        a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
        a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
        a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
        a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
        a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
    ]


def _mat_translate(tx, ty):
    return [1.0, 0.0, tx, 0.0, 1.0, ty, 0.0, 0.0, 1.0]


def _mat_scale(sx, sy):
    return [sx, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 1.0]


def _mat_rotate(degrees):
    theta = math.radians(degrees)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    return [cos_t, -sin_t, 0.0, sin_t, cos_t, 0.0, 0.0, 0.0, 1.0]


def _mat_shear_h(skew_h_degrees):
    """A pure horizontal shear: x' = x - tan(skew_h_degrees)*y, y' = y -- determinant exactly 1
    for any angle. Positive `skew_h_degrees` slants the top edge right (a point above center,
    smaller y, moves toward +x) -- the convention `gimp_transform_layer`'s own schema documents,
    and the one `ps_transform_layer`'s op=skew uses."""
    return [1.0, -math.tan(math.radians(skew_h_degrees)), 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]


def _mat_shear_v(skew_v_degrees):
    """A pure vertical shear: x' = x, y' = -tan(skew_v_degrees)*x + y -- determinant exactly 1
    for any angle. Positive `skew_v_degrees` slants the left edge down (a point left of center,
    smaller x, moves toward +y)."""
    return [1.0, 0.0, 0.0, -math.tan(math.radians(skew_v_degrees)), 1.0, 0.0, 0.0, 0.0, 1.0]


def _mat_determinant(m):
    """The determinant of `m`'s linear (non-translation) 2x2 part -- the translation column
    (indices 2, 5) never affects it. Zero means the transform collapses the rectangle to a line
    or a point; negative means it mirrors (flips handedness) rather than purely scaling/
    rotating/shearing it."""
    return m[0] * m[4] - m[1] * m[3]


# A composed matrix below this |determinant| is treated the same as an exact 0: numerically
# indistinguishable from a transform that collapses the layer to a line, so refused outright
# rather than handed to `Item.transform_matrix` to silently produce a degenerate result.
TRANSFORM_LAYER_MIN_DETERMINANT = 1e-6


def compose_layer_matrix(cx, cy, scale_x_percent, scale_y_percent, degrees,
                          skew_h_degrees, skew_v_degrees, offset_x, offset_y):
    """The 9 row-major coefficients for `Item.transform_matrix`: a scale (percent, 100 =
    unchanged), then a skew (skew_h_degrees/skew_v_degrees, composed as two independent real
    shears -- Sh_v . Sh_h, each with its OWN determinant of exactly 1, so the composed skew's
    determinant is always exactly 1 too, for any angle), then a rotation (degrees, clockwise),
    all anchored at the layer's own center (`cx`, `cy`, document pixels), followed by an absolute
    translation (`offset_x`, `offset_y`). Never the single combined-shear matrix
    [[1,-tan(h)],[-tan(v),1]] -- that matrix's OWN determinant is `1 - tan(h)*tan(v)`, which
    reaches exactly 0 at h=v=45 (collapsing the rectangle to a line) and goes NEGATIVE past that
    (silently mirroring it instead of shearing it). `op_transform_layer`'s `free` op calls this
    directly (scale + degrees + offset, no skew); `skew` calls it with scale 100/100, degrees 0,
    offset 0/0; `rotate`'s own bounds check (not its actual transform, which goes through
    `Item.transform_rotate` instead -- see ops.py) reuses it with scale 100/100, skew 0/0, offset
    0/0 purely to predict the post-rotation bounding box via `transformed_bounds`.

    Raises if the FINAL composed matrix's determinant is below `TRANSFORM_LAYER_MIN_DETERMINANT`
    or negative -- scale alone is already bounded away from both by its own 1..10000% range, but
    this is the belt-and-braces check against the composed result as a whole, not just its own
    skew component."""
    m = _mat_translate(-cx, -cy)
    m = _mat_mul(_mat_scale(scale_x_percent / 100.0, scale_y_percent / 100.0), m)
    m = _mat_mul(_mat_shear_v(skew_v_degrees), _mat_mul(_mat_shear_h(skew_h_degrees), m))
    m = _mat_mul(_mat_rotate(degrees), m)
    m = _mat_mul(_mat_translate(cx, cy), m)
    m = _mat_mul(_mat_translate(offset_x, offset_y), m)
    det = _mat_determinant(m)
    if not math.isfinite(det) or det < 0 or abs(det) < TRANSFORM_LAYER_MIN_DETERMINANT:
        raise ValueError(
            'this combination of scale/skew/rotate collapses or mirrors the layer (determinant '
            '%.6g) instead of transforming it -- reduce the scale or skew and try again' % det
        )
    return m


def transformed_bounds(matrix, x, y, width, height):
    """The axis-aligned bounding box of a `width` x `height` rectangle at document-pixel origin
    (`x`, `y`), after mapping each of its four corners through `matrix` (9 row-major
    coefficients, `Item.transform_matrix`'s own layout) -- what the transformed layer's new
    offsets/width/height will measure to. Used to validate a rotate/skew/free transform against
    the same size cap `validate_resize_dims` enforces, BEFORE any pixel actually moves. Returns
    (new_x, new_y, new_width, new_height)."""
    corners = ((x, y), (x + width, y), (x, y + height), (x + width, y + height))
    xs = [matrix[0] * cx + matrix[1] * cy + matrix[2] for cx, cy in corners]
    ys = [matrix[3] * cx + matrix[4] * cy + matrix[5] for cx, cy in corners]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    return min_x, min_y, max_x - min_x, max_y - min_y


def region_to_proxy_px(region, scale):
    """Map a document-pixel `region` dict into proxy-pixel integer bounds at the proxy's
    `scale` factor (0 < scale <= 1). Returns (x, y, width, height); width/height are at least
    1px so a tiny region never rounds down to an empty crop. Assumes `region` was already
    validated (`validate_region`) against the FULL-RES image -- this only rescales it."""
    x = round(float(region['x']) * scale)
    y = round(float(region['y']) * scale)
    w = max(1, round(float(region['width']) * scale))
    h = max(1, round(float(region['height']) * scale))
    return x, y, w, h


def visible_image_ids(all_ids, hidden_ids):
    """The ids in `all_ids` that are real documents: every id in `hidden_ids` (the bridge's own
    preview-proxy images, which are live GIMP images but not the user's) is dropped, order kept."""
    hidden = set(hidden_ids)
    return [i for i in all_ids if i not in hidden]


def read_pgm(raw):
    """Decode minimal binary PGM (P5, maxval 255) bytes. Returns (width, height, data).

    Bounds-checked against `raw` running out before the four header fields
    (magic, width, height, maxval) are found — an empty file or one truncated
    mid-header used to spin forever: `b''.isspace()` is `False`, so the
    "scan until whitespace" loop read `raw[pos:pos+1]` past the end forever,
    each iteration seeing the same empty slice and treating it as "another
    non-whitespace byte" rather than "out of input"."""
    n = len(raw)
    fields, pos = [], 0
    while len(fields) < 4:
        while pos < n and raw[pos:pos + 1].isspace():
            pos += 1
        if pos >= n:
            raise ValueError('truncated PGM header')
        start = pos
        while pos < n and not raw[pos:pos + 1].isspace():
            pos += 1
        fields.append(raw[start:pos])
    if fields[0] != b'P5' or int(fields[3]) != 255:
        raise ValueError('mask must be a binary 8-bit PGM (P5, maxval 255)')
    w, h = int(fields[1]), int(fields[2])
    data = raw[pos + 1:pos + 1 + w * h]
    if len(data) != w * h:
        raise ValueError('truncated PGM')
    return w, h, data


def write_pgm(w, h, data):
    """Encode (width, height, data) as binary PGM (P5, maxval 255) bytes."""
    return b'P5\n%d %d\n255\n' % (w, h) + bytes(data)


def channel_stats(data):
    """mean/median/percentiles/256-bin histogram for one channel's raw byte data."""
    counts = collections.Counter(data)
    bins = [counts.get(v, 0) for v in range(256)]
    n = len(data)

    def pct(p):
        target, acc = p * n, 0
        for v, c in enumerate(bins):
            acc += c
            if acc >= target:
                return v
        return 255

    return {
        'mean': round(sum(v * c for v, c in enumerate(bins)) / n, 3),
        'median': pct(0.5),
        'p1': pct(0.01),
        'p5': pct(0.05),
        'p95': pct(0.95),
        'p99': pct(0.99),
        'bins': bins,
    }


# ---- editmamei-filters ledger (persistent image parasite) -------------------

_warned_messages = set()


def _warn_once(message):
    """Log `message` to stderr, but never more than once per distinct
    message for the life of this process — a corrupt or foreign parasite is
    read on every op that touches live filters, and re-logging identically
    on each one would just be noise."""
    if message in _warned_messages:
        return
    _warned_messages.add(message)
    sys.stderr.write('%s\n' % message)


def _decode_ledger_bytes(raw):
    """Normalize `raw` (str, bytes/bytearray, or falsy) to a str, or None if
    it can't be decoded as UTF-8. Bytes arrive here directly from a GIMP
    parasite's raw data — `.decode('utf-8')` on a corrupt/foreign parasite
    used to happen at the CALLER (ops.py), outside any try/except, which
    would take the whole op down instead of degrading to "ledger absent"."""
    if not raw:
        return ''
    if isinstance(raw, (bytes, bytearray)):
        try:
            return raw.decode('utf-8')
        except UnicodeDecodeError:
            return None
    return raw


def _valid_filter_record(record):
    """A ledger filter record must be a dict with a str `operation` and a
    dict `params` — anything else (a stray string, a list, a dict missing
    one of those fields) is dropped as if the entry were never there, rather
    than crashing whatever later reads `record['operation']`."""
    return (
        isinstance(record, dict)
        and isinstance(record.get('operation'), str)
        and isinstance(record.get('params'), dict)
    )


def _validate_filters(filters):
    valid = {}
    dropped = False
    for name, record in filters.items():
        if _valid_filter_record(record):
            valid[name] = record
        else:
            dropped = True
    if dropped:
        _warn_once('editmamei-filters parasite has a malformed filter record; skipping it')
    return valid


def parse_ledger(raw):
    """Parse the parasite's raw data (str, or bytes/bytearray straight from
    `parasite.get_data()`) into (filters_by_name, unknown_top_level,
    raw_filters_by_name).

    - No data (parasite absent): ({}, {}, {}).
    - Bytes that aren't valid UTF-8, unparsable JSON, or JSON that isn't an
      object: the whole ledger is treated as absent (logged once, not every
      call) rather than raising — a corrupt parasite must degrade to "no
      bridge-applied filters known" (every filter then falls back to
      readback), never take the op down. `ledger_is_undecodable` is how a
      caller distinguishes this case from a genuinely empty ledger before
      deciding whether a rewrite is safe to persist.
    - Versioned vs. legacy is decided by SHAPE, not by the presence of a "v"
      key alone: a dict with an int "v" AND a dict "filters" is versioned;
      anything else (including a legacy document that happens to contain a
      literal key named "v") is the pre-versioning format, where the
      parasite bytes ARE the filters map directly (no wrapper). Treated as
      v1-compatible so files written before the ledger was versioned keep
      working.
    - Versioned + "v" == LEDGER_VERSION: "filters" is the map; any OTHER
      top-level key is returned as `unknown_top_level` so a future writer's
      extra fields round-trip untouched through serialize_ledger.
    - Versioned + "v" != LEDGER_VERSION (in practice: greater, from a future
      writer): every filter is treated as absent — the caller falls back to
      readback for all of them, per the documented contract that we never
      guess at a schema we don't recognize. `unknown_top_level` still
      carries the non-filters keys through, but the caller must NOT persist
      a rewrite in this case (see ops.py's `_ledger_put`) — we don't
      understand the current document well enough to safely overwrite it.
    - Every returned filter record is individually shape-checked (dict, str
      `operation`, dict `params`) before landing in `filters_by_name`; a
      malformed one is dropped as if it were never in the ledger for READ
      purposes (logged once), but it still appears, untouched, in
      `raw_filters_by_name` — a rewrite that starts from the raw map instead
      of the validated one preserves malformed or foreign records verbatim
      rather than silently dropping them the next time this bridge writes
      the ledger.
    """
    text = _decode_ledger_bytes(raw)
    if text is None:
        _warn_once('editmamei-filters parasite is not valid UTF-8; treating as absent')
        return {}, {}, {}
    if not text:
        return {}, {}, {}
    try:
        doc = json.loads(text)
    except (ValueError, TypeError):
        _warn_once('editmamei-filters parasite is not valid JSON; treating as absent')
        return {}, {}, {}
    if not isinstance(doc, dict):
        _warn_once('editmamei-filters parasite is not a JSON object; treating as absent')
        return {}, {}, {}
    versioned = isinstance(doc.get('v'), int) and isinstance(doc.get('filters'), dict)
    if not versioned:
        raw_filters = dict(doc)
        return _validate_filters(raw_filters), {}, raw_filters
    unknown = {k: v for k, v in doc.items() if k not in ('v', 'writer', 'filters')}
    raw_filters = dict(doc['filters'])
    if doc['v'] != LEDGER_VERSION:
        return {}, unknown, raw_filters
    return _validate_filters(raw_filters), unknown, raw_filters


def ledger_is_undecodable(raw):
    """True when the parasite's raw bytes can't be read as a ledger AT ALL —
    not valid UTF-8, not valid JSON, or valid JSON that isn't even an object
    — as opposed to a well-formed document this bridge just doesn't
    recognize every filter in (that's `ledger_is_newer_version`). Callers use
    this to refuse a rewrite entirely rather than overwrite bytes they never
    actually parsed: `parse_ledger`'s "treat as absent" degrade is safe to
    READ from (an op just gets no bridge-applied history), but overwriting
    those same bytes with a fresh `filters: {}` document would permanently
    lose whatever they actually were. Absent (`raw` falsy) is NOT
    undecodable — there is nothing there to lose."""
    text = _decode_ledger_bytes(raw)
    if text is None:
        return True
    if not text:
        return False
    try:
        doc = json.loads(text)
    except (ValueError, TypeError):
        return True
    return not isinstance(doc, dict)


def ledger_is_newer_version(raw):
    """True when the parasite is a versioned document (int "v" + dict
    "filters") whose version is newer than this bridge understands. Callers
    use this to refuse to rewrite a document they can't safely round-trip —
    the filter still applies to the live image either way; only the
    persisted record is skipped. `raw` may be str or bytes/bytearray."""
    text = _decode_ledger_bytes(raw)
    if not text:
        return False
    try:
        doc = json.loads(text)
    except (ValueError, TypeError):
        return False
    if not isinstance(doc, dict):
        return False
    if not (isinstance(doc.get('v'), int) and isinstance(doc.get('filters'), dict)):
        return False
    return doc['v'] > LEDGER_VERSION


def serialize_ledger(filters_by_name, unknown_top_level=None):
    """Serialize filters_by_name as the current-version ledger, preserving any
    unknown_top_level keys carried over from parse_ledger byte-for-byte
    (as JSON values -- not literal bytes, but nothing under them is rewritten)."""
    doc = dict(unknown_top_level or {})
    doc['v'] = LEDGER_VERSION
    doc['writer'] = LEDGER_WRITER
    doc['filters'] = filters_by_name
    return json.dumps(doc)


def merged_ledger_for_write(raw, filters, unknown, removed=None):
    """Compute the bytes to persist as the editmamei-filters parasite, or
    None if the write should be SKIPPED entirely -- the caller's filter still
    applied to the live image either way; only the persisted record is
    skipped in that case (the caller logs it, this function just decides).

    `raw` is the CURRENT parasite bytes, read fresh right before writing.
    `filters`/`unknown` are the caller's own updated view (e.g. `filters`
    with one new or edited record merged in) of what was read from this same
    `raw` a moment earlier, via `parse_ledger`. `removed`, if given, is an
    iterable of filter NAMES to drop even though `raw` (re-read fresh, and so
    possibly written by someone else since `filters` was derived) still has
    them -- a plain `dict.update` only ever ADDS or OVERWRITES keys present
    in `filters`; it can never express "this name is gone now," which is
    exactly what deleting a filter needs (the deleted name is simply absent
    from `filters`, and used to come back to life because `raw_filters`
    still had a copy of it and nothing ever told the merge to drop it).

    Returns None (skip the write) when:
    - `raw` is a newer version than this bridge understands
      (`ledger_is_newer_version`) -- writing would silently downgrade a
      future writer's document to this bridge's own schema.
    - `raw` isn't decodable as a ledger at all (`ledger_is_undecodable`) --
      writing would permanently destroy bytes that were never actually
      parsed in the first place.

    Otherwise, re-parses `raw` for its own `raw_filters_by_name` (which
    preserves a malformed or foreign record verbatim -- see `parse_ledger`),
    drops every name in `removed` from that, and returns the serialized
    ledger as UTF-8 bytes: those raw filters merged with `filters` (`filters`
    wins on a shared key, since it's the caller's own newer view), keeping
    `unknown` as the top-level passthrough fields. This is the ONE place
    that decides whether and how a rewrite happens -- callers (`ops.py`'s
    `_ledger_put`) just hand it bytes in and get bytes-or-None back, with no
    merge or skip logic of their own to keep in sync with this module's."""
    if ledger_is_newer_version(raw) or ledger_is_undecodable(raw):
        return None
    _valid, _existing_unknown, raw_filters = parse_ledger(raw)
    merged = dict(raw_filters)
    for name in (removed or ()):
        merged.pop(name, None)
    merged.update(filters)
    return serialize_ledger(merged, unknown).encode('utf-8')


# ---- request/response transport ---------------------------------------------

_REQUEST_NAME_RE = re.compile(r'^req-(\d+)\.json$')


def id_from_filename(path):
    """Recover the numeric id from a `req-<id>.json` path, or None if the
    basename doesn't match that naming convention."""
    match = _REQUEST_NAME_RE.match(os.path.basename(path))
    return int(match.group(1)) if match else None


def response_path(rpc_dir, req_id):
    """Where the response for request `req_id` is written -- ALWAYS derived
    from the id and the rpc directory, never from anything inside the
    request body. The request used to carry its own `resp` path; a bridge
    that trusted it would let a malformed/malicious request steer a write
    anywhere else on disk, so the field is no longer read at all."""
    return os.path.join(rpc_dir, 'resp-%d.json' % req_id)


def list_requests(rpc_dir):
    """`req-<id>.json` names in id order, silently skipping anything that
    doesn't match the naming convention rather than letting a stray file
    crash the sort (a bare int() on a non-numeric name would take the whole
    serve loop down with it)."""
    numbered = []
    for name in os.listdir(rpc_dir):
        if not (name.startswith('req-') and name.endswith('.json')):
            continue
        try:
            req_id = int(name[4:-5])
        except ValueError:
            continue
        numbered.append((req_id, name))
    numbered.sort()
    return [name for _req_id, name in numbered]


def read_request(req_path, attempts=5, delay_s=0.02, on_retry=None):
    """Read + parse a request file. Retries ONLY on OSError (e.g. a
    PermissionError from anti-virus or a file indexer holding a brief lock on
    a just-renamed file on Windows) -- a JSONDecodeError means the content
    itself is bad and is raised immediately; retrying that would just mask a
    genuinely malformed file rather than a transient lock.

    `on_retry(exc, attempt)`, if given, is called right before each sleep --
    the bridge logs the exception type through it; tests can assert on it
    without capturing stderr."""
    last_err = None
    for attempt in range(attempts):
        try:
            with open(req_path, encoding='utf-8') as fh:
                return json.load(fh)
        except json.JSONDecodeError:
            raise
        except OSError as e:
            last_err = e
            if on_retry:
                on_retry(e, attempt)
            time.sleep(delay_s)
    raise last_err


def write_response(path, resp):
    """Atomic tmp+rename write. Falls back to a minimal, definitely-JSON-
    serializable error response if `resp` itself can't be encoded rather than
    leaving the caller's request hanging forever with no response file at
    all. Catches ANY exception from `json.dump`, not just TypeError -- a
    circular reference raises ValueError, a value outside JSON's numeric
    range raises OverflowError, and a raw GObject reference leaking out of an
    op's result could plausibly hit any of the three depending on where it
    ends up in the structure.

    If even the fallback write fails (e.g. the response directory itself
    disappeared underneath us), this logs and returns rather than raising --
    letting the caller's request go unanswered is the same outcome either
    way, and raising here would take `serve()`'s loop down with it."""
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(resp, fh)
        os.replace(tmp, path)
    except Exception:
        try:
            fallback = {
                'id': resp.get('id'),
                'ok': False,
                'code': 'gimp_op_failed',
                'error': 'response not serialisable: %s' % type(resp.get('result')).__name__,
            }
            with open(tmp, 'w', encoding='utf-8') as fh:
                json.dump(fallback, fh)
            os.replace(tmp, path)
        except Exception as e:
            sys.stderr.write('write_response: fallback write also failed for %s: %s\n' % (path, e))


def _is_within(path, directory):
    """True if `path` resolves to somewhere inside `directory` (both
    resolved through symlinks). Used to gate a delete driven by an
    externally-derived path -- a `req_path` is always constructed by this
    module from `rpc_dir` in practice, but `process_request` also accepts it
    as a bare argument, so this is the check that keeps a future caller (or a
    symlink planted in the rpc directory) from ever turning that delete into
    one outside it.

    `os.path.commonpath` raises ValueError when the two paths don't even
    share a root (e.g. `C:\\...` vs `D:\\...` on Windows) rather than just
    returning a path that fails the equality check below -- treated the same
    as any other "can't confirm this is inside" case: not within."""
    try:
        path_real = os.path.realpath(path)
        dir_real = os.path.realpath(directory)
        return os.path.commonpath([path_real, dir_real]) == dir_real
    except (OSError, ValueError):
        return False


def safe_remove(path):
    """Delete a file, ignoring "it's already gone" -- every caller here races
    against nothing but itself, so ENOENT on remove is never a real error."""
    try:
        os.remove(path)
    except OSError:
        pass


class OpError(Exception):
    """Raised by an op (or by `process_request` itself, for a request-shape
    problem) that knows its own error code, bypassing the type-based
    classification in `classify()` below -- e.g. a raw image file is a
    ValueError in spirit but must map to gimp_unsupported_file, not
    invalid_argument."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def classify(exc):
    """The error `code` a response reports for `exc`. gi-free -- ops.py's
    GIMP-specific exceptions (raw-file handling, etc.) raise `OpError`
    directly rather than needing a case here."""
    if isinstance(exc, OpError):
        return exc.code
    if isinstance(exc, FileNotFoundError):
        return 'file_not_found'
    if isinstance(exc, ValueError):
        return 'invalid_argument'
    return 'gimp_op_failed'


def _log_read_retry(exc, attempt):
    sys.stderr.write(
        'transient %s reading a request (attempt %d): %s\n' % (type(exc).__name__, attempt + 1, exc)
    )


def process_request(req_path, rpc_dir, dispatch):
    """Answer one request file. Never raises, and deletes `req_path` on every
    path once it resolves inside `rpc_dir` (see `_is_within`) -- a bug here
    must not take down `serve()`'s loop or spin it forever re-reading a file
    it can never finish with.

    `dispatch(op, args)` is a plain callable returning the op's result or
    raising on failure; it has no `gi` dependency requirement of its own,
    which is what makes this function unit-testable with a fake dispatch
    (see test_lib.py). ops.py passes a dispatch that looks up `op` in its
    real OPS table.

    The response id is ALWAYS the one embedded in the FILENAME
    (`req-<id>.json`), never trusted from the request body: a body `id` that
    isn't an int, or that disagrees with the filename, is rejected with
    `invalid_argument` rather than used -- handing a non-int id to
    `response_path` used to raise OUTSIDE this function's own error
    handling, which meant the request file was never deleted and `serve()`
    re-read (and re-failed on) it forever."""
    t0 = time.perf_counter()
    filename_id = id_from_filename(req_path)
    try:
        if filename_id is None:
            # Not our naming convention at all -- nothing safe to answer.
            return

        try:
            req = read_request(req_path, on_retry=_log_read_retry)
        except json.JSONDecodeError as e:
            write_response(response_path(rpc_dir, filename_id), {
                'id': filename_id, 'ok': False, 'code': 'invalid_argument',
                'error': 'malformed request file: %s: %s' % (type(e).__name__, e),
            })
            return
        except OSError as e:
            # read_request already retried this internally (RESP_READ_RETRY_
            # ATTEMPTS-equivalent on its side); reaching here means those
            # retries were exhausted, not that the content is bad -- an
            # operational failure, not a client error.
            write_response(response_path(rpc_dir, filename_id), {
                'id': filename_id, 'ok': False, 'code': 'gimp_op_failed',
                'error': 'could not read request file: %s: %s' % (type(e).__name__, e),
            })
            return

        if not isinstance(req, dict):
            write_response(response_path(rpc_dir, filename_id), {
                'id': filename_id, 'ok': False, 'code': 'invalid_argument',
                'error': 'request body must be a JSON object',
            })
            return

        body_id = req.get('id')
        if body_id is not None and (
            not isinstance(body_id, int)
            or isinstance(body_id, bool)  # bool is an int subclass in Python
            or body_id != filename_id
        ):
            write_response(response_path(rpc_dir, filename_id), {
                'id': filename_id, 'ok': False, 'code': 'invalid_argument',
                'error': 'request id %r does not match its filename id %d' % (body_id, filename_id),
            })
            return

        op = req.get('op')
        args = req.get('args', {})
        try:
            if op is None:
                raise OpError('invalid_argument', 'request is missing "op"')
            result = dispatch(op, args if isinstance(args, dict) else {})
            resp = {'id': filename_id, 'ok': True, 'result': result}
        except Exception as e:
            resp = {
                'id': filename_id, 'ok': False, 'code': classify(e),
                'error': '%s: %s' % (type(e).__name__, e), 'trace': traceback.format_exc(),
            }
        resp['op_ms'] = round((time.perf_counter() - t0) * 1000, 1)
        write_response(response_path(rpc_dir, filename_id), resp)
    finally:
        if _is_within(req_path, rpc_dir):
            safe_remove(req_path)
        else:
            sys.stderr.write(
                'process_request: refusing to remove %s -- it does not resolve inside %s\n'
                % (req_path, rpc_dir)
            )


def parse_gimp_version(version_string):
    """Parse a dotted version string into (major, minor, micro) ints, taking
    only the leading digits of each part so a pre-release suffix like
    "3.2.0-RC1" still parses as (3, 2, 0). `Gimp.version()` returns a STRING
    ("3.2.6"), not a tuple of ints -- measured live on 3.2.6; naively
    unpacking it as `major, minor, micro = Gimp.version()` unpacks the
    STRING's characters instead ('3', '.', '2')."""
    parts = str(version_string).split('.')

    def leading_int(s):
        m = re.match(r'\d+', s)
        return int(m.group(0)) if m else 0

    major = leading_int(parts[0]) if len(parts) > 0 else 0
    minor = leading_int(parts[1]) if len(parts) > 1 else 0
    micro = leading_int(parts[2]) if len(parts) > 2 else 0
    return major, minor, micro


# ---- cross-platform process liveness (parent-death check) -------------------

def is_process_alive(pid):
    """Cross-platform liveness probe for a pid this process did not spawn
    (the driver's own pid, checked so `serve()` can exit once its parent is
    gone rather than becoming an orphan headless GIMP forever).

    POSIX: `os.kill(pid, 0)` sends no signal, only checks whether the pid
    exists and is signalable; ESRCH means gone.

    Windows: NEVER `os.kill` here -- signal 0 on Windows is CTRL_C_EVENT,
    which sends a real console-control event to a process GROUP instead of
    probing existence, and could interrupt an unrelated process sharing this
    console. Use `OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject` instead:
    a handle that fails to open means the pid is gone; a handle that opens
    but whose wait returns immediately signaled means the process already
    exited (its handle became signaled at exit, even though the pid slot
    hasn't been fully reclaimed)."""
    if os.name == 'nt':
        return _is_process_alive_windows(pid)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        # e.g. EPERM: it exists but we can't signal it -- still alive.
        return True


def _is_process_alive_windows(pid):
    import ctypes

    PROCESS_SYNCHRONIZE = 0x00100000
    WAIT_TIMEOUT = 0x00000102

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_SYNCHRONIZE, False, pid)
    if not handle:
        return False
    try:
        result = kernel32.WaitForSingleObject(handle, 0)
        return result == WAIT_TIMEOUT  # not yet signaled -> still running
    finally:
        kernel32.CloseHandle(handle)


# Metadata stripping. `include-exif` / `include-xmp` MUST exist on every format the bridge writes:
# stripping explicitly instead of trusting a format's default is pointless if the option can stop
# existing (an export-procedure rename, say) with nothing noticing, so a missing one fails loudly.
# The rest are set only when present (file-webp-export has no `include-comment`; GIMP 3.2's
# file-tiff-export has no `save-geotiff`).
METADATA_REQUIRED_OPTIONS = ('include-exif', 'include-xmp')
METADATA_OPTIONAL_OPTIONS = ('include-iptc', 'include-thumbnail', 'include-comment')


def metadata_strip_settings(fmt, prop_names):
    """The export-config options to set False for format `fmt`, given the config's property names.
    Raises OpError('gimp_op_failed') when a required option is missing."""
    names = set(prop_names)
    for required in METADATA_REQUIRED_OPTIONS:
        if required not in names:
            raise OpError(
                'gimp_op_failed',
                '%s export config has no %r option to strip metadata with' % (fmt, required),
            )
    settings = list(METADATA_REQUIRED_OPTIONS)
    settings += [o for o in METADATA_OPTIONAL_OPTIONS if o in names]
    if fmt == 'tiff' and 'save-geotiff' in names:
        settings.append('save-geotiff')
    return settings


# ---- text layers (gimp_text) -----------------------------------------------------------------

TEXT_MAX_CHARS = 2000
TEXT_MIN_FONT_PT = 1
TEXT_MAX_FONT_PT = 1296
TEXT_DEFAULT_FONT_PT = 24
TEXT_FONT_LIST_CAP = 200
FONT_SUGGESTION_LIMIT = 8
DEFAULT_TEXT_FONT = 'Sans-serif'
DEFAULT_RESOLUTION_PPI = 72.0

# gimp_text's `alignment` enum is ps_text's. GIMP's own justification has only left / right /
# center / fill, so the three "last line" variants Photoshop adds are refused rather than
# approximated.
TEXT_ALIGNMENTS = {'LEFT': 'left', 'CENTER': 'center', 'RIGHT': 'right', 'FULLYJUSTIFIED': 'fill'}
TEXT_UNSUPPORTED_ALIGNMENTS = ('LEFTJUSTIFIED', 'CENTERJUSTIFIED', 'RIGHTJUSTIFIED')
_JUSTIFICATION_TO_ALIGNMENT = {nick: name for name, nick in TEXT_ALIGNMENTS.items()}

# Words that describe a face of a family rather than the family itself, used to tell "Arial" +
# "Narrow Bold" (a face of the family) from an unrelated font whose name merely starts the same.
_FONT_STYLE_WORDS = frozenset((
    'regular', 'book', 'roman', 'normal', 'medium', 'bold', 'italic', 'oblique', 'light', 'thin',
    'extralight', 'ultralight', 'semilight', 'semibold', 'demibold', 'extrabold', 'ultrabold',
    'black', 'heavy', 'condensed', 'semicondensed', 'extracondensed', 'narrow', 'cond', 'expanded',
    'semiexpanded', 'extra', 'ultra', 'semi', 'demi', 'variable',
))
_FONT_REGULAR_ORDER = ('regular', 'book', 'roman', 'normal', 'medium')


def validate_text_content(value):
    if not isinstance(value, str):
        raise ValueError('text must be a string')
    if value == '':
        raise ValueError('text must not be empty')
    if len(value) > TEXT_MAX_CHARS:
        raise ValueError('text must be at most %d characters (got %d)' % (TEXT_MAX_CHARS, len(value)))
    return value


def validate_font_size_pt(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('font_size must be a number')
    return validate_range('font_size', value, TEXT_MIN_FONT_PT, TEXT_MAX_FONT_PT)


def validate_text_rgb(args):
    """(r, g, b) ints 0..255 from `red`/`green`/`blue`, or None when none of the three is given.
    Giving only some of them is refused rather than guessing the rest."""
    given = [k for k in ('red', 'green', 'blue') if args.get(k) is not None]
    if not given:
        return None
    if len(given) != 3:
        raise ValueError('red, green and blue must all be given together (missing: %s)'
                         % ', '.join(k for k in ('red', 'green', 'blue') if k not in given))
    out = []
    for key in ('red', 'green', 'blue'):
        value = args[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
            raise ValueError('%s must be an integer 0..255' % key)
        out.append(validate_int_range(key, value, 0, 255))
    return tuple(out)


def srgb_u8_to_linear(value):
    """An 8-bit sRGB channel as the linear-light float GEGL's set_rgba expects."""
    c = value / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb_u8(value):
    """A linear-light float channel (GEGL's get_rgba) as an 8-bit sRGB integer."""
    v = min(1.0, max(0.0, value))
    c = v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
    return int(round(c * 255))


def justification_nick(alignment):
    """GIMP's justification nick ('left' | 'right' | 'center' | 'fill') for a ps_text-style
    `alignment`; refuses the variants GIMP has no equivalent for, naming what is supported."""
    if alignment in TEXT_UNSUPPORTED_ALIGNMENTS:
        raise ValueError(
            'alignment %s is not supported by GIMP text layers; use one of %s'
            % (alignment, ', '.join(TEXT_ALIGNMENTS))
        )
    if alignment not in TEXT_ALIGNMENTS:
        raise ValueError('alignment must be one of %s'
                         % ', '.join(list(TEXT_ALIGNMENTS) + list(TEXT_UNSUPPORTED_ALIGNMENTS)))
    return TEXT_ALIGNMENTS[alignment]


def alignment_name(nick):
    """The ps_text-style alignment name for a GIMP justification nick (None when unknown)."""
    return _JUSTIFICATION_TO_ALIGNMENT.get(nick)


def _resolution_ppi(ppi):
    return float(ppi) if ppi and ppi > 0 else DEFAULT_RESOLUTION_PPI


def pt_to_px(pt, ppi):
    """Points -> pixels at the image's vertical resolution (1 pt = 1/72 in)."""
    return pt * _resolution_ppi(ppi) / 72.0


def px_to_pt(px, ppi):
    return round(px * 72.0 / _resolution_ppi(ppi), 2)


def unit_size_to_pt(size, unit_is_pixel, units_per_inch, ppi):
    """A text layer's font size in points, whichever unit it is stored in: pixels convert through
    the image resolution; any other unit through its own units-per-inch factor."""
    if unit_is_pixel or not units_per_inch:
        return px_to_pt(size, ppi)
    return round(size / units_per_inch * 72.0, 2)


def _font_tokens(name):
    return re.sub(r'[-_]+', ' ', name).lower().split()


def _font_key(name):
    return ' '.join(_font_tokens(name))


def font_suggestions(query, names, limit=FONT_SUGGESTION_LIMIT):
    """Up to `limit` installed font names closest to `query`: names containing it (or contained
    by it) first, then the nearest by spelling."""
    import difflib
    q = _font_key(query)
    ordered = sorted(set(names), key=lambda n: n.lower())
    out = [n for n in ordered if q and (q in _font_key(n) or _font_key(n) in q)][:limit]
    if len(out) < limit:
        by_key = {}
        for n in ordered:
            by_key.setdefault(_font_key(n), n)
        for key in difflib.get_close_matches(q, list(by_key), n=limit, cutoff=0.0):
            if by_key[key] not in out:
                out.append(by_key[key])
            if len(out) >= limit:
                break
    return out[:limit]


def resolve_font(query, names):
    """Resolve a family ("Inter", "Open Sans") or full name ("Inter Bold") to an installed font
    name, case- and spacing-insensitively. Returns (name, matched_by) with matched_by in
    'name' | 'family+regular' | 'family'. Raises ValueError listing the closest installed names
    when nothing matches."""
    if not isinstance(query, str) or not query.strip():
        raise ValueError('font_name must be a non-empty string')
    ordered = sorted(set(names), key=lambda n: n.lower())
    q = _font_key(query)
    for n in ordered:
        if _font_key(n) == q:
            return n, 'name'
    q_sorted = sorted(q.split())
    for n in ordered:
        if sorted(_font_tokens(n)) == q_sorted:
            return n, 'name'
    for style in _FONT_REGULAR_ORDER:
        wanted = q + ' ' + style
        for n in ordered:
            if _font_key(n) == wanted:
                return n, 'family+regular'
    family = [
        n for n in ordered
        if _font_key(n).startswith(q + ' ')
        and all(t in _FONT_STYLE_WORDS for t in _font_key(n)[len(q) + 1:].split())
    ]
    if family:
        return min(family, key=lambda n: (len(n), n.lower())), 'family'
    suggestions = font_suggestions(query, ordered)
    if not suggestions:
        raise ValueError('no installed font matches %r (no fonts are installed)' % query[:100])
    raise ValueError(
        'no installed font matches %r. Closest installed names: %s' % (query[:100], ', '.join(suggestions))
    )


def pick_default_font(names):
    """The font a text layer gets when none is named: GIMP's built-in generic sans if listed,
    else the first installed name (None when there are none)."""
    ordered = sorted(set(names), key=lambda n: n.lower())
    for n in ordered:
        if _font_key(n) == _font_key(DEFAULT_TEXT_FONT):
            return n
    return ordered[0] if ordered else None


def list_fonts(names, substring=None):
    """(page, total) for gimp_inspect what=fonts: names sorted case-insensitively, filtered by a
    case-insensitive substring, capped at TEXT_FONT_LIST_CAP; `total` counts every match."""
    ordered = sorted(set(names), key=lambda n: n.lower())
    if substring:
        needle = substring.lower()
        ordered = [n for n in ordered if needle in n.lower()]
    return ordered[:TEXT_FONT_LIST_CAP], len(ordered)


# Headroom on the small-size layout probe: glyph advances hinted at a few pixels round to whole
# pixels, so scaling a probe up can undershoot the full-size layout.
TEXT_ESTIMATE_MARGIN = 1.3


def estimate_text_extent(probe_w, probe_h, probe_px, size_px, chars=0, lines=1, letter_spacing=0.0,
                         line_spacing=0.0, indent=0.0):
    """The (width, height) in px a text layer will render at `size_px`, from its layout measured
    at `probe_px` (`probe_w` x `probe_h`), with headroom. Letter spacing, line spacing and indent
    are absolute pixels that do not scale with the font, so each adds its full worst case: spacing
    after every character and between every line, plus the indent. Never below 1x1."""
    scale = size_px / float(probe_px)
    width = math.ceil(probe_w * scale * TEXT_ESTIMATE_MARGIN) + chars * max(0.0, letter_spacing) + max(0.0, indent)
    height = math.ceil(probe_h * scale * TEXT_ESTIMATE_MARGIN) + max(0, lines - 1) * max(0.0, line_spacing)
    return max(1, int(math.ceil(width))), max(1, int(math.ceil(height)))


def check_estimated_text_size(width, height):
    """Refuses text whose estimated size (`estimate_text_extent`) is past the engine's size cap,
    before anything is drawn at full size."""
    try:
        validate_resize_dims(width, height)
    except ValueError as exc:
        raise ValueError(
            'the text would render as about %dx%d px, past the size limit (%s); use a smaller '
            'font_size or less text' % (width, height, exc)
        )


TEXT_REPORT_MAX_CHARS = 200


def text_for_report(text):
    """(text, length, truncated) for reporting a layer's text: at most TEXT_REPORT_MAX_CHARS,
    since a layer opened from a file can hold any amount."""
    text = text or ''
    return text[:TEXT_REPORT_MAX_CHARS], len(text), len(text) > TEXT_REPORT_MAX_CHARS


def check_text_layer_size(width, height):
    """Refuses a rendered text layer past the engine's size cap (`validate_resize_dims`)."""
    try:
        validate_resize_dims(width, height)
    except ValueError as exc:
        raise ValueError(
            'the text would render as a %dx%d px layer, past the size limit (%s); use a smaller '
            'font_size or less text' % (width, height, exc)
        )
