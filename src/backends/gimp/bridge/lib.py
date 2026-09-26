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
}

# The only operations `describe_operation` will probe -- an allow-list, not "any GEGL/GIMP
# operation name the caller cares to ask about": the probe instantiates a real DrawableFilter,
# and an unbounded operation name is an unnecessary surface (arbitrary-op instantiation, error
# text from GIMP's own PDB) for a probe whose only real job is confirming the schema of the
# operations this engine actually uses.
ALLOWED_DESCRIBE_OPERATIONS = frozenset(ADJUST_OPERATIONS.values())


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
