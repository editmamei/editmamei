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
    # proportional (fractions of the image's own size, not absolute pixel lengths), and
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
MAX_RESIZE_MEGAPIXELS = 250

MAX_FEATHER_PX = 1000


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
        raise ValueError('resize target must be at most %d MP' % MAX_RESIZE_MEGAPIXELS)
    return width, height


def validate_feather_px(value):
    return validate_range('feather_px', value, 0.0, MAX_FEATHER_PX)


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
# against GIMP 3.2.6's real GEGL pspecs.
EFFECT_CREATE_DEFAULTS = {
    'vignette': {'radius': 1.2, 'softness': 0.8, 'gamma': 2.0, 'x': 0.5, 'y': 0.5},
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

    Returns (masked_names, unverifiable_names), both lists, in the order `live_filters` was
    given."""
    masked = []
    unverifiable = []
    for name, operation in live_filters:
        rec = filters.get(name)
        if rec and rec.get('operation') == operation:
            if rec.get('params', {}).get('mask'):
                masked.append(name)
        else:
            unverifiable.append(name)
    return masked, unverifiable


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


def rotate_point_fraction(x_frac, y_frac, degrees, old_width, old_height, new_width, new_height):
    """Rotate a point expressed as a FRACTION of a layer's own width/height (vignette's center_x/
    center_y) by `degrees`, using the exact same clockwise-positive convention `ops.py`'s
    `op_rotate` applies to layer/channel pixels via `Item.transform_rotate`, re-expressing the
    result as a fraction of the possibly-different NEW extent (`rotate_effect_params` only ever
    passes a right angle here, so old/new either match or swap -- see `is_right_angle_degrees`).

    Exact for any angle, not just 90-degree multiples, though only right angles are ever passed
    in: rotating a rectangle around its own center always leaves the new bounding box centered at
    that SAME physical point, so the old and new centers coincide regardless of whether the
    dimensions swapped -- the old center (in old-extent coordinates) and the new center (in
    new-extent coordinates) name the identical point in space, which is what lets this convert
    between the two coordinate frames with no separate translation term."""
    old_cx, old_cy = old_width / 2.0, old_height / 2.0
    new_cx, new_cy = new_width / 2.0, new_height / 2.0
    dx = x_frac * old_width - old_cx
    dy = y_frac * old_height - old_cy
    theta = math.radians(degrees)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
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
    Operations with no direction-dependent param (black_white, add_noise, lens_blur) come back
    with the SAME values (a fresh dict, not the same object) -- there is nothing to change."""
    params = dict(params)
    if operation == 'gegl:vignette':
        if orientation == 'horizontal':
            params['x'] = 1.0 - params['x']
        else:
            params['y'] = 1.0 - params['y']
    elif operation == 'gegl:motion-blur-linear':
        if orientation == 'horizontal':
            params['angle'] = _wrap_angle_deg(180.0 - params['angle'])
        else:
            params['angle'] = _wrap_angle_deg(-params['angle'])
    elif operation == 'gegl:dropshadow':
        if orientation == 'horizontal':
            params['x'] = -params['x']
        else:
            params['y'] = -params['y']
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
    conventions reused here)."""
    params = dict(params)
    if operation == 'gegl:vignette':
        new_width, new_height = _dims_after_right_angle_rotation(layer_width, layer_height, degrees)
        params['x'], params['y'] = rotate_point_fraction(
            params['x'], params['y'], degrees, layer_width, layer_height, new_width, new_height
        )
    elif operation == 'gegl:motion-blur-linear':
        params['angle'] = _wrap_angle_deg(params['angle'] + degrees)
    elif operation == 'gegl:dropshadow':
        theta = math.radians(degrees)
        dx, dy = params['x'], params['y']
        params['x'] = dx * math.cos(theta) - dy * math.sin(theta)
        params['y'] = dx * math.sin(theta) + dy * math.cos(theta)
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
    black_white and add_noise have no absolute-pixel param either."""
    params = dict(params)
    isotropic_scale = math.sqrt(scale_x * scale_y)
    if operation == 'gegl:motion-blur-linear':
        theta = math.radians(params['angle'])
        vx = scale_x * math.cos(theta)
        vy = scale_y * math.sin(theta)
        params['length'] = params['length'] * math.hypot(vx, vy)
        params['angle'] = _wrap_angle_deg(math.degrees(math.atan2(vy, vx)))
    elif operation == 'gegl:focus-blur':
        params['blur-radius'] = params['blur-radius'] * isotropic_scale
    elif operation == 'gegl:dropshadow':
        params['x'] = params['x'] * scale_x
        params['y'] = params['y'] * scale_y
        params['radius'] = params['radius'] * isotropic_scale
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


def validate_effect_transform(op_name, operation, new_params):
    """Refuse `op_name` (the geometry op about to run) outright if any of `new_params` -- already
    computed for `operation` by flip_effect_params/rotate_effect_params/resize_effect_params --
    would leave the range its own create/re-edit path enforces. Called BEFORE the geometry
    mutation runs (ops.py's `_snapshot_effect_transform`), so a filter that would end up out of
    range never gets a chance to silently clamp via GObject's own property setter instead of a
    clear, actionable refusal -- and the geometry op never partially applies."""
    for prop, (lo, hi) in EFFECT_TRANSFORM_BOUNDS.get(operation, {}).items():
        if prop not in new_params:
            continue
        value = new_params[prop]
        if not lo <= value <= hi:
            type_ = OPERATION_TYPES.get(operation, operation)
            raise ValueError(
                "%s would leave the %s effect's %s at %.4g, outside its %s..%s range. Delete it "
                'and re-add it after this geometry change, or bake it into the image first.'
                % (op_name, type_, prop, value, lo, hi)
            )


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
