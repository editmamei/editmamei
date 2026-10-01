# Editmamei GIMP bridge: named operations run inside a headless gimp-console session.
#
# session.ts spawns `gimp-console` with ONE fixed batch line (see its
# BATCH_LINE) that calls serve(<session dir>) from this file. serve() never
# returns until told to, so this python-fu-eval process becomes a request
# server inside GIMP with full PDB access, and nothing is installed.
# (`-b -` looks like the obvious route, but gimp-console reads stdin to EOF
# before running anything, so it can't serve interactively.)
#
# Requests are JSON files in <session dir>/rpc. Model-supplied values only
# ever arrive inside those files and are dispatched through OPS below; they
# are never evaluated as code. Images live in GIMP's core and are addressed
# by id.
#
# This file is exec'd by the batch line, not imported as a package, so it has
# no package context of its own — `lib` (the pure, gi-free helpers, unit
# tested standalone via test_lib.py) is imported by adding this file's own
# directory to sys.path first.

import math
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(os.environ['EM_GIMP_OPS'])))
import lib  # noqa: E402  (must follow the sys.path fix-up above)

import gi  # noqa: E402
gi.require_version('Gimp', '3.0')  # noqa: E402
gi.require_version('Gegl', '0.4')  # noqa: E402
from gi.repository import Gimp, Gio, Gegl  # noqa: E402

CHANNELS = {
    'value': Gimp.HistogramChannel.VALUE,
    'red': Gimp.HistogramChannel.RED,
    'green': Gimp.HistogramChannel.GREEN,
    'blue': Gimp.HistogramChannel.BLUE,
}

# Extensions GIMP core has no loader for by default (only with a raw-develop
# plug-in like darktable/RawTherapee/ART installed). Used only to word the
# error when a load actually fails -- the load is always attempted first, so
# an install that DOES have such a plug-in still opens these normally.
RAW_EXTENSIONS = {'.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.pef'}


def _image(args):
    image_id = lib.require(args, 'image')
    img = Gimp.Image.get_by_id(int(image_id))
    if img is None or not img.is_valid():
        raise ValueError('no open image with id %s' % image_id)
    # A preview proxy (see PROXIES below) is an internal, filter-free duplicate this bridge made
    # for itself -- never one a caller could legitimately know the id of (no op ever returns one),
    # so a request naming one is refused the same way an unknown id would be, not treated as a real
    # open document.
    if any(img.get_id() == proxy.get_id() for proxy in PROXIES.values()):
        raise ValueError('no open image with id %s' % image_id)
    return img


def _owning_image(item):
    """`item`'s own image, or None -- a plain wrapper around `Item.get_image()` so every id-based
    membership check below (`_layer`, `_resolve_parent_group`) reads the same way, and so a layer
    that somehow reports no image at all (should not happen for one just returned by GIMP, but
    never trusted blindly) degrades to "not found" rather than an AttributeError."""
    return item.get_image() if item is not None else None


def _layer(img, args):
    """Resolve the layer `args` addresses: `layer_id` (canonical -- GIMP allows duplicate layer
    names, so an id is the only handle that always tells two apart; the id `gimp_inspect`'s layer
    tree and `gimp_layer`'s own results report) takes priority over `layer` (name, searched inside
    groups too); neither given falls back to the selected layer, or the topmost layer if none is
    selected. `layer_id` is checked for IMAGE MEMBERSHIP the same way `_existing_filter` checks a
    filter_id -- a global id lookup could otherwise hand back a layer belonging to a different
    (possibly closed) image and let an op silently touch the wrong document."""
    layer_id = args.get('layer_id')
    if layer_id is not None:
        layer = Gimp.Layer.get_by_id(int(layer_id))
        owner = _owning_image(layer)
        if layer is None or owner is None or owner.get_id() != img.get_id():
            raise ValueError('no layer with id %s on image %s' % (layer_id, img.get_id()))
        return layer
    name = args.get('layer')
    if name:
        layer = img.get_layer_by_name(name)  # searches inside layer groups too
        if layer is None:
            raise ValueError('no layer named %r' % name)
        return layer
    selected = img.get_selected_layers()
    return selected[0] if selected else img.get_layers()[0]


def _all_layers(img):
    """Every layer in img, top of stack first, descending into layer groups (a group itself is
    included, then its children). `img.get_layers()` is top-level only, and `_layer` can resolve a
    layer nested inside a group, so every walk over the filter stack goes through this: a filter
    on a nested layer must be listed, mirrored onto the proxy, ledger-tracked, and seen by the
    geometry refusal like any other.

    Walked with an EXPLICIT stack, the same reasoning (and the same shape) as `_build_layer_tree`'s
    own walk: a pathological chain of nested single-child groups would otherwise risk Python's OWN
    recursion limit, not just some cap this function itself imposes (it imposes none -- every
    caller here matters exactly because it doesn't). A group's children are pushed in REVERSE order
    so popping (LIFO) still visits top-of-stack-first -- positional proxy mirroring and other
    callers depend on that exact order, not just on the same set of layers."""
    out = []
    stack = list(reversed(img.get_layers()))
    while stack:
        item = stack.pop()
        out.append(item)
        if item.is_group():
            stack.extend(reversed(item.get_children()))
    return out


def _describe(img):
    return {
        'image': img.get_id(),
        'width': img.get_width(),
        'height': img.get_height(),
        'base_type': img.get_base_type().value_nick,
        'precision': img.get_precision().value_nick,
        'layers': [l.get_name() for l in img.get_layers()],
    }


def _existing_filter(img, args, operation):
    """Look up filter_id AMONG img's own layers -- not just by a global id
    lookup, which would happily hand back a filter that belongs to some
    other open image (or one already closed) and let a re-edit silently
    touch the wrong document."""
    filter_id = int(args['filter_id'])
    for layer in _all_layers(img):
        for f in layer.get_filters():
            if f.get_id() == filter_id:
                if f.get_operation_name() != operation:
                    # Phrased with the tool's own `type` names (lib.OPERATION_TYPES, the merged
                    # adjust+effect inverse), not the raw GEGL op strings -- a caller sent
                    # `type: 'motion_blur'` or similar, not `gegl:motion-blur-linear`, so the
                    # refusal should name what they actually typed. Falls back to the raw
                    # operation name for anything not in that table (there is none today, but a
                    # future op added to one table and not the other must not raise here instead
                    # of just showing an unmapped name).
                    actual = lib.OPERATION_TYPES.get(f.get_operation_name(), f.get_operation_name())
                    expected = lib.OPERATION_TYPES.get(operation, operation)
                    raise ValueError('filter %s is %s, not %s' % (filter_id, actual, expected))
                return f
    raise ValueError('no filter with id %s on image %s' % (filter_id, img.get_id()))


def _channel(args):
    ch = args.get('channel', 'value')
    if ch not in CHANNELS:
        raise ValueError('channel must be one of %s' % sorted(CHANNELS))
    return CHANNELS[ch]


def _level(v, name):
    v = float(v)
    if not 0 <= v <= 255:
        raise ValueError('%s must be within 0..255' % name)
    return v / 255.0


def _composite(img):
    """A full-resolution flattened duplicate of img. Caller deletes it. Renders every live
    filter at full size: ~2 s per 24 MP with two curves on an 8-thread machine."""
    dup = img.duplicate()
    return dup, dup.flatten()


# Preview proxies, keyed by (image id, max_px): a filter-free downscale of the document made once,
# onto which the document's live filters are re-applied per preview. Rendering filters on ~0.7 MP
# instead of 24 MP is what gets preview under a second; every route that renders from the
# full-size document (flatten, scale, get_thumbnail's projection) costs 1.4-4.5 s after an
# edit. Exact for per-pixel filters (curves, levels); a spatial filter would need its radius
# scaled.
#
# The cache is correct ONLY because every op that changes pixels, layer structure, canvas size, or
# image mode ends with `_drop_proxies(img.get_id())`, not only the ops that add or edit a live
# filter.
# Layer create/create_group/delete/duplicate/move/reorder/set (opacity/mode/visible), merge_down,
# flatten, and bake all change the document's real pixels or its layer tree, so a proxy built
# before any of them would render stale content -- or worse, `_mirror_filters` zips the proxy's own
# layer list against the live document's POSITIONALLY, so a structural drift between them (a layer
# added, removed, or reordered on one side but not the other) would mis-attach a filter to the
# wrong layer rather than merely rendering an out-of-date preview; see that function's own guard.
# `create_document`/`place_image` (new layer tree), `canvas` (canvas size), and
# `convert_image_mode` (base type) all fall under the same rule. `select` is the one layer op that
# changes neither pixels nor structure and is deliberately exempt.
PROXIES = {}


def _proxy(img, max_px):
    key = (img.get_id(), max_px)
    proxy = PROXIES.get(key)
    if proxy is None or not proxy.is_valid():
        proxy = img.duplicate()
        for layer in _all_layers(proxy):
            for f in layer.get_filters():
                f.delete()
        w, h = proxy.get_width(), proxy.get_height()
        scale = min(1.0, float(max_px) / max(w, h))
        if scale < 1.0:
            proxy.scale(max(1, round(w * scale)), max(1, round(h * scale)))
        PROXIES[key] = proxy
    return proxy


def _mirror_filters(src_img, dst_img):
    """Re-create src's live filters, in stack order, on the matching layers of dst.

    Filters this bridge applied are rebuilt from the ledger, not from readback: after
    an XCF reload, libgimp's config for gimp:curves / gimp:levels reports only the `value`
    channel, so a readback copy of a red or blue curve comes out as identity (measured: the
    reopened document rendered R-B 25.4, a readback-mirrored proxy 10.6).

    dst is normally smaller than src (a preview proxy): every length-typed property named in
    `lib.SPATIAL_SCALE_PROPS` for the filter's operation is multiplied by dst/src's width ratio
    after the ledger's own params are applied, so a spatial filter's radius still reads in SRC's
    pixel units rather than rendering as if it were `radius` proxy-px wide. Integer neighbourhood
    sizes in `lib.INT_SPATIAL_SCALE_PROPS` (currently just noise-reduction's `iterations`) are
    scaled the same way but rounded, floored at 1 -- an approximation of the full-res effect, not
    an exact one, since a neighbourhood count doesn't scale as cleanly as a Gaussian radius does.
    Either way, the scaled value is clamped to the property's own pspec minimum before being set
    -- GObject silently KEEPS the property's prior value (the unscaled one `dst_cfg` already has
    from the loop above, not the intended small one) when asked to set something below its
    minimum, so without this clamp a small enough proxy would render as if the property were
    never scaled down at all. This is an approximation (see `op_preview`'s `proxy` flag) -- exact
    for everything else, since every other property here is scale-invariant (a hue shift, a
    level, a percentage).

    Invisible filters (toggled off via `filter op=set_visibility`) are skipped entirely, without
    even attempting to re-create them -- they contribute nothing to the render either way. A
    filter GIMP refuses to attach non-destructively (`_append_masked`'s own guard, the same
    silent-failure class it exists to catch) is likewise skipped here rather than raised: unlike
    `_apply_filter`'s CREATE path, where that refusal must be a hard error (nothing has been
    ledgered yet, so failing loudly is free), a proxy render already renders every OTHER live
    filter and is allowed to approximate by leaving one out rather than failing the whole preview/
    histogram/compare call. Returns the list of filter names that could not be mirrored (empty
    when every visible filter mirrored cleanly), which callers surface as `unmirrored_filters` in
    their own result."""
    filters, _unknown = _ledger_get(src_img)
    src_w = src_img.get_width()
    scale = (dst_img.get_width() / src_w) if src_w else 1.0
    unmirrored = []
    # dst is a duplicate of src (see `_proxy`), so both walks yield the same layers in the same
    # order -- PROVIDED the proxy-drop discipline above held. Checked explicitly rather than
    # trusted: a future structural op that forgets `_drop_proxies` would otherwise silently zip a
    # stale proxy's layer list against the live document's and mis-attach a filter to the wrong
    # layer instead of failing loudly. Comparing plain lengths alone would miss a COUNT-preserving
    # drift (e.g. two layers swapped by a reorder) -- the (name, is_group) shape at every position
    # is compared too, so a mismatch at any single slot is caught, not just a size change.
    src_layers, dst_layers = _all_layers(src_img), _all_layers(dst_img)
    src_shape = [(l.get_name(), l.is_group()) for l in src_layers]
    dst_shape = [(l.get_name(), l.is_group()) for l in dst_layers]
    if src_shape != dst_shape:
        raise lib.OpError(
            'gimp_op_failed',
            'internal error: the preview proxy has drifted from the document\'s layer structure -- '
            'a structural change did not drop the proxy cache',
        )
    for src, dst in zip(src_layers, dst_layers):
        for f in reversed(src.get_filters()):  # get_filters() is top-first
            if not f.get_visible():
                continue
            g = Gimp.DrawableFilter.new(dst, f.get_operation_name(), f.get_name())
            src_cfg, dst_cfg = f.get_config(), g.get_config()
            for p in src_cfg.list_properties():
                dst_cfg.set_property(p.name, src_cfg.get_property(p.name))
            rec = filters.get(f.get_name())
            mask = None
            if rec and rec['operation'] == f.get_operation_name():
                SETTERS[rec['operation']](dst_cfg, rec['params'])
                mask = rec['params'].get('mask')
                operation = rec['operation']
                pspecs = {p.name: p for p in dst_cfg.list_properties()}
                for prop_name in lib.SPATIAL_SCALE_PROPS.get(operation, ()):
                    scaled = dst_cfg.get_property(prop_name) * scale
                    minimum = getattr(pspecs.get(prop_name), 'minimum', None)
                    if minimum is not None and scaled < minimum:
                        scaled = minimum
                    dst_cfg.set_property(prop_name, scaled)
                for prop_name in lib.INT_SPATIAL_SCALE_PROPS.get(operation, ()):
                    scaled = max(1, round(dst_cfg.get_property(prop_name) * scale))
                    minimum = getattr(pspecs.get(prop_name), 'minimum', None)
                    if minimum is not None and scaled < minimum:
                        scaled = int(minimum)
                    dst_cfg.set_property(prop_name, scaled)
            g.set_opacity(f.get_opacity())
            g.set_blend_mode(f.get_blend_mode())
            try:
                _append_masked(dst_img, dst, g, mask)
            except lib.OpError:
                unmirrored.append(f.get_name())
                continue
            g.set_visible(True)
    return unmirrored


def _drop_proxies(image_id):
    for key in [k for k in PROXIES if k[0] == image_id]:
        proxy = PROXIES.pop(key)
        if proxy.is_valid():
            proxy.delete()


def _curve_points(curve):
    pts = []
    for i in range(curve.get_n_points()):
        x, y = curve.get_point(i)
        pts.append([round(x * 255, 2), round(y * 255, 2)])
    return pts


# What the bridge applied, per filter name, as JSON in a persistent image parasite. It travels
# inside the XCF, so it survives close/reopen; it is the source of truth for readback and the
# preview proxy wherever libgimp's own readback is lossy (see _mirror_filters). Schema, version
# handling, the merge, and the "don't rewrite a document I don't understand" decision all live in
# lib.parse_ledger / lib.merged_ledger_for_write.
META = 'editmamei-filters'


def _ledger_get(img):
    """Hands the parasite's raw BYTES to lib.parse_ledger rather than
    decoding here first: a corrupt/foreign parasite that isn't valid UTF-8
    used to raise straight out of a bare `.decode('utf-8')`, outside any
    try/except, taking down whatever op called this.

    Returns (filters, unknown_top_level) -- the validated view. A caller
    about to write the ledger back doesn't need the raw (pre-validation) map
    itself: `_ledger_put` re-reads the parasite and re-derives it, via
    `lib.merged_ledger_for_write`, at the moment it actually writes."""
    p = img.get_parasite(META)
    if not p:
        return {}, {}
    filters, unknown, _raw_filters = lib.parse_ledger(bytes(p.get_data()))
    return filters, unknown


def _ledger_put(img, filters, unknown, removed=None):
    """Persist filters/unknown as the ledger parasite. The merge (preserving
    any malformed/foreign record verbatim) and the decision whether writing
    is even safe (a newer-version or undecodable existing parasite) both
    live in `lib.merged_ledger_for_write` -- this function just reads the
    current parasite, calls it, and writes back whatever it returns, if
    anything. `None` means the write was skipped: the filter this call is
    for was still applied to the live image either way; only the persisted
    record is, and list_filters/preview/histogram fall back to readback for
    it exactly as they would for any other foreign filter.

    `removed`, when given, names filters to drop even though the freshly
    re-read parasite still has them -- see `lib.merged_ledger_for_write`'s
    own docstring for why a plain merge can't express a deletion by itself."""
    existing = img.get_parasite(META)
    existing_raw = bytes(existing.get_data()) if existing else b''
    merged = lib.merged_ledger_for_write(existing_raw, filters, unknown, removed=removed)
    if merged is None:
        sys.stderr.write(
            'editmamei-filters parasite on image %d was not rewritten (see '
            'lib.merged_ledger_for_write); this filter still applied to the live image\n'
            % img.get_id()
        )
        return
    img.attach_parasite(Gimp.Parasite.new(META, Gimp.PARASITE_PERSISTENT, merged))


def _unique_name(img, base):
    taken = {f.get_name() for layer in _all_layers(img) for f in layer.get_filters()}
    return lib.unique_name(taken, base)


def _unique_layer_name(img, base, exclude=None):
    """Like `_unique_name`, but over LAYER names (`gimp_layer`'s create/create_group/duplicate/
    set(name=...) naming) rather than filter names. `exclude`, when given, is a layer whose own
    current name never counts as "taken" -- renaming a layer to the name it already has must not
    force an unwanted suffix onto itself."""
    taken = {
        l.get_name() for l in _all_layers(img) if exclude is None or l.get_id() != exclude.get_id()
    }
    return lib.unique_name(taken, base)


def _set_curves(cfg, params):
    curve = Gimp.Curve.new()
    curve.clear_points()
    for x, y in params['points']:
        curve.add_point(_level(x, 'x'), _level(y, 'y'))
    cfg.set_property('trc', Gimp.TRCType.PERCEPTUAL)
    cfg.set_property('channel', _channel(params))
    cfg.set_property('curve', curve)


def _set_levels(cfg, params):
    cfg.set_property('trc', Gimp.TRCType.PERCEPTUAL)
    cfg.set_property('linear', False)
    cfg.set_property('channel', _channel(params))
    cfg.set_property('low-input', _level(params['in_low'], 'in_low'))
    cfg.set_property('high-input', _level(params['in_high'], 'in_high'))
    cfg.set_property('gamma', params['gamma'])
    cfg.set_property('low-output', _level(params['out_low'], 'out_low'))
    cfg.set_property('high-output', _level(params['out_high'], 'out_high'))


# GimpHueRange / GimpTransferMode enum members, keyed by the plain strings
# `lib.build_hue_saturation_params` / `lib.build_color_balance_params` validate against --
# those two functions are gi-free (unit-tested without GIMP), so the mapping to the real `gi`
# enum objects has to live here instead.
_HUE_RANGE_ENUM = {
    'all': Gimp.HueRange.ALL,
    'red': Gimp.HueRange.RED,
    'yellow': Gimp.HueRange.YELLOW,
    'green': Gimp.HueRange.GREEN,
    'cyan': Gimp.HueRange.CYAN,
    'blue': Gimp.HueRange.BLUE,
    'magenta': Gimp.HueRange.MAGENTA,
}
_TRANSFER_MODE_ENUM = {
    'shadows': Gimp.TransferMode.SHADOWS,
    'midtones': Gimp.TransferMode.MIDTONES,
    'highlights': Gimp.TransferMode.HIGHLIGHTS,
}

# gimp_transform_layer's `interpolation` choices, keyed the same way lib.TRANSFORM_LAYER_
# INTERPOLATIONS validates them against.
_INTERPOLATION_ENUM = {
    'none': Gimp.InterpolationType.NONE,
    'linear': Gimp.InterpolationType.LINEAR,
    'cubic': Gimp.InterpolationType.CUBIC,
    'nohalo': Gimp.InterpolationType.NOHALO,
    'lohalo': Gimp.InterpolationType.LOHALO,
}


def _set_exposure(cfg, params):
    cfg.set_property('exposure', params['exposure'])
    cfg.set_property('black-level', params['black-level'])


def _set_brightness_contrast(cfg, params):
    cfg.set_property('brightness', params['brightness'])
    cfg.set_property('contrast', params['contrast'])


def _set_hue_saturation(cfg, params):
    cfg.set_property('range', _HUE_RANGE_ENUM[params['range']])
    cfg.set_property('hue', params['hue'])
    cfg.set_property('saturation', params['saturation'])
    cfg.set_property('lightness', params['lightness'])


def _set_color_balance(cfg, params):
    cfg.set_property('range', _TRANSFER_MODE_ENUM[params['range']])
    cfg.set_property('cyan-red', params['cyan-red'])
    cfg.set_property('magenta-green', params['magenta-green'])
    cfg.set_property('yellow-blue', params['yellow-blue'])
    cfg.set_property('preserve-luminosity', params['preserve-luminosity'])


def _set_color_temperature(cfg, params):
    cfg.set_property('original-temperature', params['original-temperature'])
    cfg.set_property('intended-temperature', params['intended-temperature'])


def _set_shadows_highlights(cfg, params):
    for key in (
        'shadows', 'highlights', 'whitepoint', 'radius', 'compress',
        'shadows-ccorrect', 'highlights-ccorrect',
    ):
        cfg.set_property(key, params[key])


def _set_saturation(cfg, params):
    cfg.set_property('scale', params['scale'])


def _set_vibrance(cfg, params):
    cfg.set_property('vibrance', params['vibrance'])
    cfg.set_property('saturation', params['saturation'])


def _set_sharpen(cfg, params):
    cfg.set_property('std-dev', params['std-dev'])
    cfg.set_property('scale', params['scale'])
    cfg.set_property('threshold', params['threshold'])


def _set_noise_reduction(cfg, params):
    cfg.set_property('iterations', params['iterations'])


def _set_gaussian_blur(cfg, params):
    cfg.set_property('std-dev-x', params['std-dev-x'])
    cfg.set_property('std-dev-y', params['std-dev-y'])


# ---- gimp_add_effect setters (lib.EFFECT_OPERATIONS' parallel table to the adjust ones
# above) -- SETTERS itself is one shared dict below: an operation name is an operation name
# regardless of which tool (gimp_add_adjustment's `adjust` or gimp_add_effect's `effect`) created
# the filter, and _apply_filter/_mirror_filters dispatch on operation alone.

def _set_vignette(cfg, params):
    cfg.set_property('radius', params['radius'])
    cfg.set_property('softness', params['softness'])
    cfg.set_property('gamma', params['gamma'])
    cfg.set_property('x', params['x'])
    cfg.set_property('y', params['y'])


def _set_black_white(cfg, params):
    cfg.set_property('red', params['red'])
    cfg.set_property('green', params['green'])
    cfg.set_property('blue', params['blue'])
    cfg.set_property('preserve-luminosity', params['preserve-luminosity'])


def _set_motion_blur(cfg, params):
    cfg.set_property('length', params['length'])
    cfg.set_property('angle', params['angle'])


def _set_lens_blur(cfg, params):
    # gegl:focus-blur, not gegl:lens-blur -- see lib.build_lens_blur_params' own comment.
    #
    # Two properties are forced here, not part of `params` and not user-configurable:
    #  - `radius` (distinct from `blur-radius`) sizes a circular IN-FOCUS zone that stays
    #    perfectly sharp regardless of `blur-radius` -- verified live: at its own default (0.75),
    #    the center ~75% of the image never blurs at all, which is a tilt-shift/depth-of-field
    #    effect, not the uniform "lens blur" this tool advertises. Forced to 0 so the blur applies
    #    uniformly across the whole layer instead.
    #  - `blur-type` defaults to 'gaussian', which would make this a second, redundant
    #    gaussian_blur and leave `highlight_factor` inert. Forced to 'lens' -- verified live, that
    #    mode DOES attach as a non-destructive filter (the 'aux'-pad restriction that sank
    #    gegl:lens-blur does not apply inside this meta-operation) and produces a real bokeh
    #    highlight boost.
    cfg.set_property('radius', 0.0)
    cfg.set_property('blur-type', 'lens')
    cfg.set_property('blur-radius', params['blur-radius'])
    cfg.set_property('highlight-factor', params['highlight-factor'])


def _set_add_noise(cfg, params):
    # `independent=False`: what "add grain" means to a photographer is monochrome noise (the
    # same random value added to R, G, and B at a given pixel, like real film grain or sensor
    # noise's luminance component) -- GEGL's own default (`independent=True`) instead draws THREE
    # separate random values per pixel, one per channel, which reads as colour speckle/confetti
    # rather than grain. Not part of `params`, not user-configurable.
    cfg.set_property('independent', False)
    cfg.set_property('red', params['red'])
    cfg.set_property('green', params['green'])
    cfg.set_property('blue', params['blue'])
    cfg.set_property('alpha', params['alpha'])
    cfg.set_property('seed', params['seed'])


def _set_drop_shadow(cfg, params):
    # The rendered shadow is clipped to the layer's own bounds -- verified live, a large
    # offset/radius does not grow the layer or canvas (measured at the schema maxima and in
    # combination: no size change), it just gets cut off at the edge like any other
    # DrawableFilter here, so no separate cap against "ballooning" is needed.
    cfg.set_property('x', params['x'])
    cfg.set_property('y', params['y'])
    cfg.set_property('radius', params['radius'])
    cfg.set_property('opacity', params['opacity'])


SETTERS = {
    'gimp:curves': _set_curves,
    'gimp:levels': _set_levels,
    'gegl:exposure': _set_exposure,
    'gimp:brightness-contrast': _set_brightness_contrast,
    'gimp:hue-saturation': _set_hue_saturation,
    'gimp:color-balance': _set_color_balance,
    'gegl:color-temperature': _set_color_temperature,
    'gegl:shadows-highlights': _set_shadows_highlights,
    'gegl:saturation': _set_saturation,
    'gegl:vibrance': _set_vibrance,
    'gegl:unsharp-mask': _set_sharpen,
    'gegl:noise-reduction': _set_noise_reduction,
    'gegl:gaussian-blur': _set_gaussian_blur,
    'gegl:vignette': _set_vignette,
    'gegl:mono-mixer': _set_black_white,
    'gegl:motion-blur-linear': _set_motion_blur,
    'gegl:focus-blur': _set_lens_blur,
    'gegl:noise-rgb': _set_add_noise,
    'gegl:dropshadow': _set_drop_shadow,
}


def _append_masked(img, layer, f, mask):
    """Append f, confined to channel `mask` if given. A filter appended while a selection is
    active keeps that selection as its own mask, which persists after the selection is
    cleared and through XCF, so no extra layer or pixel copy is needed.

    When `mask` is falsy, this explicitly clears any active selection FIRST -- defence in depth
    against a stray selection left active by an earlier op (e.g. `create_mask` used to leave its
    own channel selected; that bug is fixed at the source too, but an unmasked filter must never
    silently inherit whatever happens to be selected regardless).

    Verifies the filter actually attached before returning. `Gimp.Drawable.append_filter`
    (`gimp-drawable-append-filter` in the PDB) can refuse an operation outright -- verified live
    for `gegl:lens-blur` ("effects with an 'aux' pad cannot be applied non-destructively") -- and
    does so SILENTLY on the Python side: a GIMP-Error goes to stderr, but `append_filter` itself
    raises nothing and returns `None`, the same as a successful call, with the DrawableFilter's
    own id still perfectly valid. Left unchecked, the caller (`_apply_filter`) would ledger a
    phantom filter: `filter_id` returned as if it worked, the image silently rendering with no
    effect at all. Raised here, before `_apply_filter` ever writes the ledger record, so a
    refused attach never gets persisted as one -- `_mirror_filters` (the other caller) catches
    this same exception instead of letting it propagate, since a proxy render is allowed to skip
    a filter it can't mirror rather than fail outright (see its own doc comment). `f.delete()`
    runs before raising either way, so a refused filter that never actually attached to anything
    doesn't linger as an orphaned DrawableFilter object."""
    if mask:
        img.select_item(Gimp.ChannelOps.REPLACE, _require_channel(img, mask))
    else:
        Gimp.Selection.none(img)
    try:
        layer.append_filter(f)
        if f.get_id() not in [x.get_id() for x in layer.get_filters()]:
            # The operation name is captured BEFORE delete() -- a deleted DrawableFilter is not
            # guaranteed to answer get_operation_name() usefully afterward -- and delete() itself
            # is wrapped so that if IT raises for some unrelated reason, that exception can never
            # replace (mask) the actionable OpError below with a confusing, unrelated traceback.
            operation_name = f.get_operation_name()
            try:
                f.delete()
            except Exception:
                pass
            raise lib.OpError(
                'gimp_op_failed',
                'GIMP refused to attach %s as a live filter (some GEGL operations with an '
                'auxiliary input cannot be applied non-destructively)' % operation_name
            )
    finally:
        if mask:
            Gimp.Selection.none(img)


def _apply_filter(img, args, operation, params, default_name, type_=None):
    """Create (or, with filter_id, update in place) a filter and record it in the ledger.
    A new filter may be confined to a mask channel (`mask`); a re-edit keeps the mask the
    filter was created with. `type_` is the user-facing adjust `type` (e.g. "shadows_highlights")
    recorded alongside `operation` (the GEGL op name) so a filter listing can report what the
    model asked for, not just the GEGL internals."""
    filters, unknown = _ledger_get(img)
    if args.get('filter_id') is not None:
        f = _existing_filter(img, args, operation)
        if args.get('mask'):
            raise ValueError('mask is fixed when the filter is created; add a new filter to change it')
        params['mask'] = filters.get(f.get_name(), {}).get('params', {}).get('mask')
        SETTERS[operation](f.get_config(), params)
        f.update()
    else:
        layer = _layer(img, args)
        f = Gimp.DrawableFilter.new(layer, operation, _unique_name(img, args.get('name', default_name)))
        SETTERS[operation](f.get_config(), params)
        params['mask'] = args.get('mask')
        _append_masked(img, layer, f, params['mask'])
    filters[f.get_name()] = {'operation': operation, 'type': type_, 'params': params}
    _ledger_put(img, filters, unknown)
    return {'filter_id': f.get_id(), 'name': f.get_name(), 'type': type_, 'mask': params['mask']}


# ---- operations -------------------------------------------------------------------------

def _document_ids():
    """Ids of the open documents. The preview proxies in `PROXIES` are real GIMP images but belong
    to the bridge, so they are never listed."""
    hidden = [p.get_id() for p in PROXIES.values() if p.is_valid()]
    return lib.visible_image_ids([i.get_id() for i in Gimp.get_images()], hidden)


def op_ping(args):
    major, minor, micro = lib.parse_gimp_version(Gimp.version())
    return {'major': major, 'minor': minor, 'micro': micro,
            'images': _document_ids()}


# `precision` open-time promotion, using the enum names GIMP 3 actually exposes (verified live).
# u16/float-non-linear is the "perceptual-encoded" bit depth banding-prone tone moves need
# (measured live: ~130ms to convert_precision a 24 MP image -- negligible next to the rest of
# `open`'s cost).
_PRECISION_ENUM = {
    '16': Gimp.Precision.U16_NON_LINEAR,
    '32': Gimp.Precision.FLOAT_NON_LINEAR,
}


# Rotation/flip steps (`lib.EXIF_ORIENTATION_STEPS`) as GIMP calls. The image variants act on a
# whole image; the layer variants on one (possibly unattached) layer.
_ORIENTATION_IMAGE_STEPS = {
    'cw90': lambda img: img.rotate(Gimp.RotationType.DEGREES90),
    'cw180': lambda img: img.rotate(Gimp.RotationType.DEGREES180),
    'cw270': lambda img: img.rotate(Gimp.RotationType.DEGREES270),
    'flip_h': lambda img: img.flip(Gimp.OrientationType.HORIZONTAL),
    'flip_v': lambda img: img.flip(Gimp.OrientationType.VERTICAL),
}
_ORIENTATION_LAYER_STEPS = {
    'cw90': lambda layer: layer.transform_rotate_simple(Gimp.RotationType.DEGREES90, True, 0, 0),
    'cw180': lambda layer: layer.transform_rotate_simple(Gimp.RotationType.DEGREES180, True, 0, 0),
    'cw270': lambda layer: layer.transform_rotate_simple(Gimp.RotationType.DEGREES270, True, 0, 0),
    'flip_h': lambda layer: layer.transform_flip_simple(Gimp.OrientationType.HORIZONTAL, True, 0),
    'flip_v': lambda layer: layer.transform_flip_simple(Gimp.OrientationType.VERTICAL, True, 0),
}

# Formats whose loader leaves EXIF orientation unapplied in a non-interactive load. Only JPEG is
# rotated here: other loaders apply their own orientation (HEIF's container rotation, TIFF's
# orientation tag, raw-develop plug-ins), and `.xcf` stores upright pixels, so rotating them
# again would turn them twice.
_ORIENTATION_EXTENSIONS = {'.jpg', '.jpeg', '.jpe', '.jfif'}


def _file_orientation(path, ext):
    """(orientation, metadata) from the source file at `path`: the EXIF Orientation (2-8) and the
    file's own metadata object, or (None, None) when the tag is missing, normal (1), unreadable,
    or the format is not one this bridge orients. Read from the file itself: the metadata a load
    attaches to the image is not a reliable source (it can carry another file's tags)."""
    if ext not in _ORIENTATION_EXTENSIONS:
        return None, None
    try:
        md = Gimp.Metadata.load_from_file(Gio.File.new_for_path(path))
    except Exception:
        return None, None
    orientation = lib.read_exif_orientation(md)
    if orientation is None or orientation == 1:
        return None, None
    return orientation, md


def _upright_open_image(img, orientation, md):
    """Turns a freshly loaded image upright for the EXIF `orientation` (2-8) and gives it the
    source file's own metadata with the orientation tag dropped (absent means normal; a tag SET
    to 1 does not reliably stick), so a viewer of a later copy cannot rotate it again."""
    for step in lib.exif_orientation_steps(orientation):
        _ORIENTATION_IMAGE_STEPS[step](img)
    # The pixels are already upright; metadata is a courtesy to later copies and never fails an open.
    try:
        if lib.clear_exif_orientation(md):
            img.set_metadata(md)
    except Exception:
        pass


def _upright_placed_layer(layer, orientation):
    """Turns a freshly loaded, unattached layer upright for the EXIF `orientation` (2-8)."""
    for step in lib.exif_orientation_steps(orientation):
        _ORIENTATION_LAYER_STEPS[step](layer)


def op_open(args):
    path = lib.require(args, 'path')
    if not os.path.exists(path):
        raise FileNotFoundError('no file at %s' % path)
    precision = args.get('precision', 'keep')
    if precision not in ('keep', '16', '32'):
        raise ValueError("precision must be one of 'keep', '16', '32'")
    ext = os.path.splitext(path)[1].lower()
    try:
        img = Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, Gio.File.new_for_path(path))
    except Exception as e:
        # Attempt the load first rather than refusing by extension alone: an
        # install with a raw-develop plug-in (darktable/RawTherapee/ART) can
        # open these directly. Only when the load actually fails AND the
        # extension is one we know GIMP core can't read natively do we
        # reframe it as gimp_unsupported_file with an actionable hint.
        if ext in RAW_EXTENSIONS:
            raise lib.OpError(
                'gimp_unsupported_file',
                'GIMP could not open this %s file (no raw loader by default); install a '
                'raw-develop plug-in (darktable, RawTherapee, or ART) for GIMP, or develop it '
                'externally first and open the resulting JPEG/TIFF. (%s)' % (ext, e),
            )
        raise
    # Everything from here on runs against a real, open `img` -- ANY exception in this block
    # (precision conversion, ledger pruning, or building the default proxy) must free it before
    # propagating, or a failure partway through leaks an open image nothing can ever reach again
    # (not just a precision-conversion failure specifically, which is all an earlier, narrower
    # version of this guard covered).
    try:
        # XCF stores the selection, so a file saved from the GUI can arrive with one active. Every
        # op here works on the whole canvas, and a transform with a selection active moves only
        # the selected pixels (leaving a floating selection), so it is cleared on the way in.
        Gimp.Selection.none(img)
        orientation_applied, source_md = _file_orientation(path, ext)
        if orientation_applied is not None:
            _upright_open_image(img, orientation_applied, source_md)
        if precision != 'keep':
            # `convert_precision` does NOT raise on failure -- verified live that it returns
            # plain `False` (GIMP logs a "Calling error" to stderr, e.g. "must not be of type
            # 'indexed'", but nothing propagates to Python), so a bare call here would silently
            # report `ok: true` with the ORIGINAL precision still in effect, misleading the
            # caller into thinking their promotion applied when it didn't. Checking the return
            # value turns that into a real, catchable failure.
            if not img.convert_precision(_PRECISION_ENUM[precision]):
                raise lib.OpError(
                    'gimp_op_failed',
                    "precision promotion to %r failed for this image (base_type=%s); GIMP "
                    "requires RGB or grayscale for precision conversion, not indexed"
                    % (precision, img.get_base_type().value_nick),
                )
        # Reconciled here, not just at the start of every geometry op's own check: a `.xcf` opened
        # from disk can carry ledger records for filters that no longer exist in it for any number
        # of reasons outside this bridge's control (edited by the GUI, hand-edited, a partial
        # write) -- pruning now means staleness never has a chance to accumulate across a session.
        _prune_stale_ledger_records(img)
        _proxy(img, 1024)  # build the default preview proxy now so the first preview is fast too
    except Exception:
        img.delete()
        raise
    result = _describe(img)
    if orientation_applied is not None:
        result['orientation_applied'] = orientation_applied
    return result


def _existing_ledger_params(img, args, operation):
    """The existing filter's own ledger `params`, when `args` names a `filter_id` for a
    bridge-applied filter of this exact operation -- the merge base a re-edit's builder resolves
    unspecified fields against. None on create.

    A re-edit of a filter this bridge did NOT create is refused: its current values can't be read
    back exactly (libgimp's readback is lossy, and there is no ledger record to merge from), so a
    partial re-edit would reset every unmentioned field to the creation default, and recording the
    result as ours would drop whatever mask the filter carries from the geometry refusal and the
    preview proxy."""
    if args.get('filter_id') is None:
        return None
    f = _existing_filter(img, args, operation)
    filters, _unknown = _ledger_get(img)
    rec = filters.get(f.get_name())
    if rec and rec.get('operation') == operation:
        return rec['params']
    parasite = img.get_parasite(META)
    if parasite and lib.ledger_is_newer_version(bytes(parasite.get_data())):
        raise ValueError(
            'filter %s cannot be re-edited: this document was saved by a newer Editmamei, whose '
            'filter records this version cannot read. Re-edit it with that version, or delete and '
            're-create the filter.' % f.get_id()
        )
    raise ValueError(
        'filter %s was not created by Editmamei; its current values cannot be read back exactly. '
        'Delete it and re-create it, or edit it in the GIMP GUI.' % f.get_id()
    )


def op_curves(args):
    """One gimp:curves filter per channel: a single filter carries one channel's curve
    (setting red then blue on one filter renders only blue). A re-edit that omits `channel` or
    `points` keeps the existing filter's own value for that field (the same merge-not-reset
    contract every other adjust type gets) rather than silently resetting `channel` to 'value' or
    requiring `points` to be resent every time."""
    img = _image(args)
    existing = _existing_ledger_params(img, args, 'gimp:curves')
    channel = args.get('channel', existing['channel'] if existing else 'value')
    if 'points' in args and args['points'] is not None:
        points = [[float(x), float(y)] for x, y in args['points']]
        if len(points) < 2:
            raise ValueError('points needs at least two [x, y] pairs')
    elif existing is not None:
        points = existing['points']
    else:
        raise ValueError('points is required')
    params = {'channel': channel, 'points': points}
    return _apply_filter(img, args, 'gimp:curves', params, 'Curves', type_='curves')


def op_levels(args):
    """Re-edit merges: any of channel/in_low/in_high/gamma/out_low/out_high omitted from a
    re-edit keeps the existing filter's own value rather than resetting to the create-time
    default (0/255/1.0/0/255)."""
    img = _image(args)
    existing = _existing_ledger_params(img, args, 'gimp:levels')
    defaults = existing or {
        'channel': 'value', 'in_low': 0.0, 'in_high': 255.0, 'gamma': 1.0,
        'out_low': 0.0, 'out_high': 255.0,
    }
    params = lib.validate_levels({
        'channel': args.get('channel', defaults['channel']),
        'in_low': float(args.get('in_low', defaults['in_low'])),
        'in_high': float(args.get('in_high', defaults['in_high'])),
        'gamma': float(args.get('gamma', defaults['gamma'])),
        'out_low': float(args.get('out_low', defaults['out_low'])),
        'out_high': float(args.get('out_high', defaults['out_high'])),
    })
    return _apply_filter(img, args, 'gimp:levels', params, 'Levels', type_='levels')


def op_adjust(args):
    """The single discriminated adjustment op: `type` picks the GEGL/GIMP operation
    (`lib.ADJUST_OPERATIONS`) and a pure, gi-free param builder (`lib.ADJUST_PARAM_BUILDERS`)
    that validates every range and returns GEGL-property-named params. curves/levels are folded
    in here too so ONE dispatch handles every adjust type, but keep their own richer argument
    shapes (a points list; per-side 0-255 levels) rather than forcing them through the generic
    builders.

    A re-edit (`filter_id` given) MERGES: the builder's `defaults` argument is the existing
    filter's own ledger params rather than this type's hardcoded creation defaults, so a re-edit
    that only mentions one field (e.g. `{contrast: 50}`) keeps every other field (e.g.
    `brightness`) exactly as it was, instead of silently resetting it."""
    type_ = args.get('type')
    if type_ in lib.ADJUST_OPERATIONS:  # curves and levels included
        lib.reject_foreign_fields(type_, args)
    if type_ == 'curves':
        return op_curves(args)
    if type_ == 'levels':
        return op_levels(args)
    builder = lib.ADJUST_PARAM_BUILDERS.get(type_)
    if builder is None:
        raise ValueError('type must be one of %s' % sorted(lib.ADJUST_OPERATIONS))
    img = _image(args)
    operation = lib.ADJUST_OPERATIONS[type_]
    defaults = _existing_ledger_params(img, args, operation) or lib.ADJUST_CREATE_DEFAULTS[type_]
    params = builder(args, defaults)
    default_name = type_.replace('_', ' ').title()
    return _apply_filter(img, args, operation, params, default_name, type_=type_)


def _filter_record(filters, layer, f):
    """One filter's `op_list_filters`-shaped record: `filters` is the ledger's own {name: {...}}
    map (`_ledger_get`'s first return value). Bridge-applied filters report the ledger record
    (`source: editmamei`) with `params` in the adjust tool's own field names and units
    (`lib.user_params`), so a listed value can be passed straight back on a re-edit. Anything else
    reports libgimp's readback (`source: readback`): raw GEGL property names and units, lossy for
    per-channel curves, with any value JSON can't carry (a Gegl.Color, say) stringified. Shared by
    `op_list_filters` (every filter on the image) and `op_describe`'s `what='filter'` (one, by id)."""
    rec = filters.get(f.get_name())
    if rec and rec['operation'] == f.get_operation_name():
        source = 'editmamei'
        type_ = rec.get('type') or lib.OPERATION_TYPES.get(rec['operation'])
        mask = rec['params'].get('mask')
        params = lib.user_params(type_, rec['params'])
    else:
        cfg, params, source, type_, mask = f.get_config(), {}, 'readback', None, None
        for p in cfg.list_properties():
            v = cfg.get_property(p.name)
            if isinstance(v, Gimp.Curve):
                v = _curve_points(v)
            elif hasattr(v, 'value_nick'):
                v = v.value_nick
            params[p.name] = lib.json_safe(v)
    return {'layer': layer.get_name(), 'layer_id': layer.get_id(), 'filter_id': f.get_id(),
            'name': f.get_name(), 'operation': f.get_operation_name(), 'type': type_,
            'visible': f.get_visible(), 'source': source, 'mask': mask, 'params': params}


def op_list_filters(args):
    img = _image(args)
    filters, _unknown = _ledger_get(img)
    out = []
    for layer in _all_layers(img):
        for f in layer.get_filters():
            out.append(_filter_record(filters, layer, f))
    return {'filters': out}


def _find_filter(img, filter_id):
    """Locate a filter by id AMONG img's own layers (same reasoning as `_existing_filter`: a
    global filter-id lookup could hand back one belonging to a different, possibly closed,
    image)."""
    for layer in _all_layers(img):
        for f in layer.get_filters():
            if f.get_id() == filter_id:
                return layer, f
    raise ValueError('no filter with id %s on image %s' % (filter_id, img.get_id()))


def op_effect(args):
    """`gimp_add_effect`: create (or, with `filter_id`, re-edit in place) one of the allow-listed
    GEGL effect filters (`lib.EFFECT_OPERATIONS`) -- the same merge/mask/ledger machinery
    `op_adjust` uses, but reading its own `type` against the EFFECT_* tables
    (`lib.EFFECT_PARAM_BUILDERS`/`EFFECT_CREATE_DEFAULTS`) rather than `op_adjust`'s ADJUST_*
    ones. Dispatched through the shared `_apply_filter`, so the ledger, mask confinement,
    merge-on-re-edit, geometry refusals and proxy mirroring all come free, unchanged.
    gimp_add_effect is its own tool (tier 'dev'), a sibling of gimp_add_adjustment, rather than a
    new op on gimp_filter (already 'community') -- tool-tiers.ts classifies per TOOL, not per op,
    so a new op on an already-shipping tool would have skipped the tier gate entirely."""
    effect_type = args.get('type')
    builder = lib.EFFECT_PARAM_BUILDERS.get(effect_type)
    if builder is None:
        raise ValueError('type must be one of %s' % sorted(lib.EFFECT_OPERATIONS))
    lib.reject_foreign_fields(effect_type, args)
    img = _image(args)
    operation = lib.EFFECT_OPERATIONS[effect_type]
    defaults = _existing_ledger_params(img, args, operation) or lib.EFFECT_CREATE_DEFAULTS[effect_type]
    params = builder(args, defaults)
    default_name = effect_type.replace('_', ' ').title()
    return _apply_filter(img, args, operation, params, default_name, type_=effect_type)


def op_filter(args):
    """Stack management: `op` in list | set_visibility | delete. There is deliberately no
    `reorder` -- `Gimp.DrawableFilter` exposes only delete/set_visible/update, and the PDB has no
    raise/lower-filter procedure (verified live, GIMP 3.2.6); emulating it means deleting and
    re-appending every filter above the moved one, which changes their ids and can't restore
    masks on filters this bridge didn't create."""
    img = _image(args)
    fop = args.get('op')
    if fop == 'list':
        return op_list_filters(args)
    if fop == 'set_visibility':
        filter_id = int(lib.require(args, 'filter_id'))
        _layer, f = _find_filter(img, filter_id)
        visible = lib.require_bool(args, 'visible')
        f.set_visible(visible)
        return {'filter_id': f.get_id(), 'visible': visible}
    if fop == 'delete':
        filter_id = int(lib.require(args, 'filter_id'))
        layer, f = _find_filter(img, filter_id)
        name = f.get_name()
        f.delete()
        filters, unknown = _ledger_get(img)
        filters.pop(name, None)
        # `removed={name}` is what actually keeps it gone -- see `_ledger_put`/
        # `lib.merged_ledger_for_write`: popping it from THIS in-memory dict alone doesn't stop a
        # stale on-disk copy from surviving the merge and resurrecting the record.
        _ledger_put(img, filters, unknown, removed={name})
        return {'filter_id': filter_id, 'name': name, 'deleted': True}
    if fop == 'reorder':
        raise ValueError(
            'filter reorder is not supported: GIMP has no reorder primitive for drawable '
            'filters in this beta -- delete and re-create in the desired order instead'
        )
    raise ValueError('op must be one of list, set_visibility, delete (got %r)' % fop)


DESCRIBE_TARGETS = ('document', 'layers', 'channels', 'filter')

# A hard cap on how many layer-tree nodes `describe`'s `document`/`layers` targets will build,
# counting every node in the WHOLE tree (top-level and every descendant), not just top-level --
# an output-size bound, and it is what makes `_build_layer_tree`'s walk itself safe: it stops
# outright once this many nodes have been visited, so neither a very wide document (many layers)
# nor a very deep one (many nested groups) can produce unbounded output. `truncated: true` in the
# result says the cap was hit; a group visited right at the cut-off may be missing some of its own
# children, since the walk simply stops rather than finishing that group first.
MAX_DESCRIBE_LAYER_NODES = 2000


def _layer_node_shallow(layer):
    """One layer's own fields for a describe-by-id layer tree node, with `children` left as an
    empty list -- `_build_layer_tree` fills it in as it walks. Id is canonical (unlike `_layer`'s
    name-based lookup, which can't tell two same-named layers apart -- GIMP allows duplicate
    names). `get_offsets()` returns (ok, x, y); `ok` is False only in a genuinely invalid-item
    case that shouldn't arise for a layer this walk just visited via `get_layers()`/
    `get_children()`, but is still checked rather than trusted blindly -- offsets fall back to
    null rather than reporting a wrong position."""
    ok, off_x, off_y = layer.get_offsets()
    node = {
        'layer_id': layer.get_id(),
        'name': layer.get_name(),
        'opacity': layer.get_opacity(),
        'mode': layer.get_mode().value_nick,
        'visible': layer.get_visible(),
        'offsets': {'x': off_x, 'y': off_y} if ok else {'x': None, 'y': None},
        'has_alpha': layer.has_alpha(),
        'is_group': layer.is_group(),
        'is_text_layer': layer.is_text_layer(),
        'children': [],
    }
    if node['is_text_layer']:
        # A text layer this engine can't read (an odd unit, a missing font) still describes as
        # a text layer; it never fails the whole document.
        try:
            node.update(_text_fields(layer))
        except Exception:
            pass
    return node


def _build_layer_tree(top_layers, max_nodes=MAX_DESCRIBE_LAYER_NODES):
    """The nested layer tree for `top_layers` (an image's own `get_layers()`, top of stack first),
    walked with an EXPLICIT stack rather than one recursive call per nesting level -- a
    pathological chain of nested single-child groups would otherwise risk Python's OWN recursion
    limit, not just some output-size limit of this op's choosing. Capped at `max_nodes` total
    nodes across the whole tree. Returns (nodes, truncated, total_nodes) -- `total_nodes` is simply
    the walk's own `seen` counter, so it costs nothing extra to report; it is what a truncated
    response is actually counted from, distinct from `top_level_count` (the caller's own
    `len(top_layers)`, always the TRUE top-level count even when the walk stopped before reaching
    every top-level sibling).

    Each stack entry is (layer, parent_id); a group's children are pushed in REVERSE order so
    popping (LIFO) still visits them top-of-stack-first, the same order `_all_layers` already
    relies on elsewhere. A layer's own node dict is built and recorded (`by_id`) the moment it is
    popped, and immediately appended into its parent's `children` list (or the top-level list) --
    safe because a layer is always popped strictly after its own parent (the parent's children
    are only ever pushed once the parent itself has already been popped and recorded), so the
    parent's node dict is guaranteed to already exist. This one pass is enough; no separate
    bottom-up assembly pass is needed."""
    truncated = False
    top = []
    by_id = {}
    stack = [(layer, None) for layer in reversed(top_layers)]
    seen = 0
    while stack:
        if seen >= max_nodes:
            truncated = True
            break
        layer, parent_id = stack.pop()
        seen += 1
        node = _layer_node_shallow(layer)
        by_id[layer.get_id()] = node
        if parent_id is None:
            top.append(node)
        else:
            by_id[parent_id]['children'].append(node)
        if layer.is_group():
            for child in reversed(layer.get_children()):
                stack.append((child, layer.get_id()))
    return top, truncated, seen


def _channels_summary(img):
    """Every named channel on img, by id and name only -- `document`'s cheap channel listing.
    Coverage (`_channel_coverage`) reads a channel's full pixel buffer, so it is computed only for
    `what='channels'` (`_channels_described`), never bundled into `document`'s broader, cheaper
    read."""
    return [{'channel_id': ch.get_id(), 'name': ch.get_name()} for ch in img.get_channels()]


# `_channels_described` checks this after every channel it reads, and stops once that many seconds
# have passed, rather than run gimp_inspect's own dispatch budget out on a document with many named
# channels (`operation-timeouts.ts`). A plain module global, not a function default, so a test
# fixture can reassign it directly (`test_set_channels_deadline`, fixtures/test_ops.py) and force
# the stop without needing dozens of real channels.
CHANNELS_DESCRIBE_DEADLINE_S = 15.0


def _channels_described(img):
    """Every named channel on img, with its coverage (`_channel_coverage`) -- the same stat
    `op_create_mask` returns for the one it just built. `what='channels'`-only; see
    `_channels_summary`'s own docstring for why `document` doesn't compute this.

    Reads at least the first channel unconditionally, then checks `CHANNELS_DESCRIBE_DEADLINE_S`
    after each one read: once elapsed time reaches it, stops and returns early. Returns
    {'channels', 'truncated', 'channels_skipped'} -- `channels` is whatever was read before
    stopping, `truncated` is whether any named channel was left unread, and `channels_skipped`
    counts them."""
    w, h = img.get_width(), img.get_height()
    channels = img.get_channels()
    out = []
    start = time.time()
    for ch in channels:
        selected, fraction = _channel_coverage(ch, w, h)
        out.append({
            'channel_id': ch.get_id(), 'name': ch.get_name(),
            'selected_pixels': selected, 'fraction': fraction,
        })
        if time.time() - start >= CHANNELS_DESCRIBE_DEADLINE_S:
            break
    return {
        'channels': out,
        'truncated': len(out) < len(channels),
        'channels_skipped': len(channels) - len(out),
    }


def op_describe(args):
    """`gimp_inspect`'s describe-by-id bridge op: `what` in document | layers | channels | filter
    (`documents` -- every open image's id -- stays on `op_ping`, unchanged; the tool layer never
    routes it here). `document` bundles dims/base_type/precision/resolution with the layer tree
    and a cheap by-id/name channel listing in one call; `layers` returns just the tree (capped and
    flagged, see `_build_layer_tree`/`MAX_DESCRIBE_LAYER_NODES`); `channels` returns the same
    channels WITH coverage (`_channels_described`), the one part `document` deliberately leaves
    out since it reads full pixel buffers -- and stops after its own time budget on a document with
    many named channels, returning whatever it already read (see `_channels_described`). `filter`
    reports one filter by id, in the exact shape `op_list_filters` reports it in (`_filter_record`,
    via `_find_filter` so a filter_id from a different or closed image is never mistaken for a
    match). `document`/`layers` also report `top_level_count` (the image's real top-level layer
    count, from `get_layers()` directly) and `total_nodes` (how many nodes THIS response carries)
    alongside `truncated`."""
    what = args.get('what')
    if what not in DESCRIBE_TARGETS:
        raise ValueError('what must be one of %s' % ', '.join(DESCRIBE_TARGETS))
    img = _image(args)
    if what == 'filter':
        filter_id = int(lib.require(args, 'filter_id'))
        layer, f = _find_filter(img, filter_id)
        filters, _unknown = _ledger_get(img)
        return _filter_record(filters, layer, f)
    if what == 'layers':
        top_layers = img.get_layers()
        layers, truncated, total_nodes = _build_layer_tree(top_layers)
        return {
            'layers': layers,
            'truncated': truncated,
            'top_level_count': len(top_layers),
            'total_nodes': total_nodes,
        }
    if what == 'channels':
        return _channels_described(img)
    ok, xres, yres = img.get_resolution()
    top_layers = img.get_layers()
    layers, truncated, total_nodes = _build_layer_tree(top_layers)
    return {
        'image': img.get_id(),
        'width': img.get_width(),
        'height': img.get_height(),
        'base_type': img.get_base_type().value_nick,
        'precision': img.get_precision().value_nick,
        'resolution': {'x': xres, 'y': yres} if ok else {'x': None, 'y': None},
        'layers': layers,
        'truncated': truncated,
        'top_level_count': len(top_layers),
        'total_nodes': total_nodes,
        'channels': _channels_summary(img),
    }


# ---- geometry -----------------------------------------------------------------------------
#
# Verified live (GIMP 3.2.6): unmasked filters, named mask CHANNELS, and the editmamei-filters
# ledger parasite all survive every op below -- `Image.crop`, `Item.transform_rotate`,
# `Image.flip`, and `Image.scale` all mutate the existing Image object in place rather than
# replacing it, so a parasite attached to the image is untouched, and layers/channels resize and
# reposition along with their drawable exactly as GIMP's own crop/rotate/flip tools would.
#
# A FILTER's OWN mask is a different story, and NOT what the paragraph above covers. Appending a
# filter while a selection is active bakes that selection in as a fixed internal snapshot at
# that moment -- `Gimp.DrawableFilter` exposes no `get_mask`/`set_mask` of any kind (verified
# live: not in its method list at all), so nothing on the Python API can re-point an EXISTING
# filter's mask at a channel's new content after a transform, no matter what the channel's own
# data ends up looking like. Measured live, per op:
#   - crop: the filter's own confinement survives and stays pixel-aligned with the surviving
#     content (its internal mask is offset/cropped along with everything else).
#   - rotate/flip: the filter's own confinement does NOT move -- it stays pinned to the
#     ORIGINAL, pre-transform pixel positions while the layer/channel content underneath it
#     rotates or flips, so the rendered result is silently wrong (misaligned) even though the
#     channel itself, and the ledger's `mask` field, both look fine.
#   - resize: the filter's own confinement does not scale either; measured as the filter
#     appearing to have NO effect at all afterward (an entirely blank mask), not merely
#     misaligned.
# rotate/flip/resize therefore REFUSE outright (`invalid_argument`) when the image has any filter
# whose ledger record names a mask, rather than silently rendering a masked edit in the wrong
# place -- the same "refuse rather than silently corrupt" contract as `filter op=reorder`. crop
# never refuses for this reason, since it verified correct.
#
# gimp_add_effect's own vignette/motion_blur/drop_shadow filters get a SEPARATE tracking
# mechanism, below (`_snapshot_effect_transform`/`_apply_planned_effect_transform`), that keeps
# their params locked to the content through flip/rotate(right angles only)/resize -- see lib.py's
# "geometry transforms for direction/position-dependent EFFECT params" comment for the full
# design. crop needs none of this: vignette's center is already a fraction of its LAYER's own
# extent, so cropping the layer naturally re-centres it on the new, smaller frame -- intended
# behaviour (the same way Lightroom's post-crop vignette re-centres), not a gap in tracking.

def _live_filter_names(img):
    return {f.get_name() for layer in _all_layers(img) for f in layer.get_filters()}


def _prune_stale_ledger_records(img):
    """Drop ledger records whose name no longer matches any LIVE filter -- the filter behind that
    record is simply gone (deleted outside `filter op=delete`, or a document edited by the GUI or
    another tool), and a stale record left in place would otherwise go on looking like a real,
    still-masked filter to `_classify_geometry_filters` forever. Called at the START of every
    geometry op's masked-filter check, and once at `open` time, so staleness never has a chance to
    accumulate silently. Returns the (possibly pruned) filters dict; writes the ledger back only
    if something was actually pruned."""
    filters, unknown = _ledger_get(img)
    stale = lib.stale_ledger_names(filters, _live_filter_names(img))
    if stale:
        for name in stale:
            filters.pop(name, None)
        _ledger_put(img, filters, unknown, removed=stale)
    return filters


def _classify_geometry_filters(img):
    """(masked_names, unverifiable_names) for every LIVE filter on `img` right now -- the
    ledger-pruned, gi-free classification lives in `lib.classify_geometry_filters`; this just
    supplies it the live GIMP state (every filter's own name + operation) instead of trusting the
    ledger alone, per the settled decision that a live filter the ledger doesn't recognise (never
    ledgered at all, e.g. because its own ledger write was skipped -- see
    `lib.merged_ledger_for_write` -- or one whose name/operation the ledger has no matching record
    for) must be treated as POSSIBLY masked, not silently assumed safe."""
    filters = _prune_stale_ledger_records(img)
    live = [(f.get_name(), f.get_operation_name()) for layer in _all_layers(img) for f in layer.get_filters()]
    return lib.classify_geometry_filters(filters, live)


def _refuse_if_masked_filters(img, op_name, before_hint='Rotate, flip or resize'):
    """`before_hint` names the alternative ordering this op's own refusal message suggests --
    'Rotate, flip or resize' for resize/rotate/flip, 'Extend the canvas' for `gimp_canvas` (see its
    own call site) -- so the advice matches the op that actually refused."""
    masked, unverifiable = _classify_geometry_filters(img)
    if unverifiable:
        # `sorted(set(...))`, not `sorted(...)`: classify_geometry_filters reports a duplicate
        # live filter NAME once per occurrence (so a caller counting what it iterated still gets
        # a consistent count), but the refusal message only needs to name it once.
        raise ValueError(
            '%s cannot proceed: filter(s) %s were not created by Editmamei (no matching ledger '
            'record for their name and operation), so whether they are masked cannot be checked. '
            'Delete them first, or make this geometry change before adding them.'
            % (op_name, ', '.join(repr(n) for n in sorted(set(unverifiable))))
        )
    if masked:
        raise ValueError(
            '%s would misalign the masked filter(s) %s: a filter\'s mask cannot move with '
            'this transform. %s before adding masked filters, or delete '
            'those filters first and re-create them afterwards. Crop is unaffected.'
            % (op_name, ', '.join(repr(n) for n in sorted(set(masked))), before_hint)
        )


# Operations whose params are position/direction-dependent under rotation -- an arbitrary
# (non-right-angle) rotation is refused outright while any LIVE, ledgered filter using one of
# these is present (see lib.py's own "ONLY exact cases are supported" comment for why).
ROTATE_DEPENDENT_OPERATIONS = frozenset({'gegl:vignette', 'gegl:motion-blur-linear', 'gegl:dropshadow'})


def _refuse_if_non_right_angle_with_tracked_effects(img, degrees, op_name):
    if lib.is_right_angle_degrees(degrees):
        return
    filters, _unknown = _ledger_get(img)
    live_names = _live_filter_names(img)
    tracked = sorted(
        name for name, rec in filters.items()
        if name in live_names and rec.get('operation') in ROTATE_DEPENDENT_OPERATIONS
    )
    if tracked:
        raise ValueError(
            '%s cannot use an arbitrary angle (%.4g°) while effect filter(s) %s are present: '
            'only an exact 0/90/180/270-degree rotation keeps them locked to the content. Rotate '
            'at a right angle instead, or delete these filters first and re-add them afterwards.'
            % (op_name, degrees, ', '.join(repr(n) for n in tracked))
        )


def _snapshot_effect_transform(img, op_name, transform_fn):
    """Precompute every ledgered effect filter's new params from a SNAPSHOT of the current
    ledger, validate each against this bridge's own field ranges, and raise -- refusing `op_name`
    outright -- if anything would land out of range, ALL BEFORE anything is mutated. Working from
    a snapshot (rather than re-reading `filters` mid-loop, which a naive loop could otherwise
    transform twice over if two live filters were ever ledgered under the same name) is what makes
    this safe to call before the geometry op has committed to anything.

    `transform_fn(operation, params, layer)` is called once per live, ledgered filter still
    present -- `layer` is that filter's OWNING layer, queried for its CURRENT (pre-mutation)
    dimensions where the transform needs them (only rotate's vignette case does; flip and resize
    ignore it). Returns {filter_name: (operation, new_params)} for every filter transform_fn
    actually changed -- callers apply these with `_apply_planned_effect_transform` AFTER the
    geometry mutation itself. A filter transform_fn has nothing to change for (black_white,
    add_noise, and every gimp_add_adjustment type -- out of scope for this table, see lib.py's own
    comment) comes back with the SAME values (by `==`) and is simply absent from the result."""
    filters, _unknown = _ledger_get(img)
    if not filters:
        return {}
    snapshot = {name: (rec['operation'], dict(rec['params'])) for name, rec in filters.items()}
    planned = {}
    for layer in _all_layers(img):
        for f in layer.get_filters():
            entry = snapshot.get(f.get_name())
            if entry is None or entry[0] != f.get_operation_name():
                continue
            operation, params = entry
            new_params = transform_fn(operation, params, layer)
            if new_params == params:
                continue
            lib.validate_effect_transform(op_name, operation, f.get_name(), new_params)
            planned[f.get_name()] = (operation, new_params)
    return planned


def _apply_planned_effect_transform(img, planned):
    """Push each planned (operation, new_params) -- already validated by
    `_snapshot_effect_transform` -- into the live GEGL config and the ledger record. Called AFTER
    the geometry mutation.

    A live update failure for one filter does not stop the others. The ledger must always match
    what actually renders, so a failure never leaves the ledger record at the new (unapplied)
    params: this instead tries to restore the filter's OLD params live (best effort -- if that
    ALSO fails, the filter is simply left wherever the failed attempt left it) and keeps the ledger
    record at the OLD params either way. The filter's name is collected and returned so the caller
    can report it (`effect_update_failures`) -- a silent partial failure here would otherwise look
    identical to a filter the geometry op never touched at all."""
    if not planned:
        return []
    failures = []
    filters, unknown = _ledger_get(img)
    for layer in _all_layers(img):
        for f in layer.get_filters():
            entry = planned.get(f.get_name())
            if entry is None:
                continue
            operation, new_params = entry
            rec = filters.get(f.get_name())
            old_params = rec['params'] if rec is not None else None
            try:
                SETTERS[operation](f.get_config(), new_params)
                f.update()
            except Exception as e:
                failures.append(f.get_name())
                sys.stderr.write(
                    'geometry transform: live update failed for filter %r (%s): %s -- '
                    'restoring its old params\n' % (f.get_name(), operation, e)
                )
                if old_params is not None:
                    try:
                        SETTERS[operation](f.get_config(), old_params)
                        f.update()
                    except Exception as restore_error:
                        sys.stderr.write(
                            'geometry transform: restoring filter %r also failed: %s\n'
                            % (f.get_name(), restore_error)
                        )
                continue  # ledger record stays at old_params -- never advances to new_params
            if rec is not None:
                rec['params'] = new_params
    _ledger_put(img, filters, unknown)
    return failures


def op_crop(args):
    img = _image(args)
    left, top = int(lib.require(args, 'left')), int(lib.require(args, 'top'))
    width, height = int(lib.require(args, 'width')), int(lib.require(args, 'height'))
    # `Image.crop(width, height, left, top)` is a raw resize-the-canvas primitive underneath --
    # it happily accepts a rectangle that's partly or fully outside the existing image (left/top
    # negative, or left+width/top+height past the current edges), silently padding the new canvas
    # with blank space rather than erroring. This bridge's `crop` is meant to be a bounds-checked
    # sub-rectangle of what's already there (the same contract `preview`'s `region` and
    # `histogram`/`compare`'s regions already enforce), so `left`/`top`/`width`/`height` are
    # validated against the CURRENT image bounds first (`invalid_argument` if not), same as any
    # other region. The DoS floor `resize` validates its own target against is applied too --
    # belt-and-braces, since a bounds-checked rectangle is already capped by the source image's own
    # size, but this keeps the two geometry ops' size ceiling identical rather than assuming that.
    lib.validate_region({'x': left, 'y': top, 'width': width, 'height': height}, img.get_width(), img.get_height())
    width, height = lib.validate_resize_dims(width, height)
    Gimp.Selection.none(img)  # see op_open: geometry always applies to the whole canvas
    img.crop(width, height, left, top)
    _drop_proxies(img.get_id())
    return {'width': img.get_width(), 'height': img.get_height()}


def op_resize(args):
    """Scale the image (and every layer/channel in it) -- Photoshop's "Image Size", not "Canvas
    Size" (that's `crop`). `width`/`height` given together stretch to exactly that box;
    given alone, the other side is derived to keep aspect; `long_edge` scales so the longer side
    lands there."""
    img = _image(args)
    _refuse_if_masked_filters(img, 'resize')
    width, height, long_edge = args.get('width'), args.get('height'), args.get('long_edge')
    w0, h0 = img.get_width(), img.get_height()
    if long_edge is not None:
        long_edge = int(long_edge)
        if long_edge <= 0:
            raise ValueError('long_edge must be positive')
        scale = float(long_edge) / max(w0, h0)
        width, height = max(1, round(w0 * scale)), max(1, round(h0 * scale))
    elif width is not None and height is not None:
        width, height = int(width), int(height)
    elif width is not None:
        width = int(width)
        height = max(1, round(h0 * (width / float(w0))))
    elif height is not None:
        height = int(height)
        width = max(1, round(w0 * (height / float(h0))))
    else:
        raise ValueError('resize needs one of width, height, or long_edge')
    width, height = lib.validate_resize_dims(width, height)
    scale_x, scale_y = width / float(w0), height / float(h0)
    planned = _snapshot_effect_transform(
        img, 'resize',
        lambda operation, params, layer: lib.resize_effect_params(operation, params, scale_x, scale_y),
    )
    Gimp.Selection.none(img)  # see op_open: geometry always applies to the whole canvas
    img.scale(width, height)
    failures = _apply_planned_effect_transform(img, planned)
    _drop_proxies(img.get_id())
    result = {'width': img.get_width(), 'height': img.get_height()}
    if failures:
        result['effect_update_failures'] = failures
    return result


def op_rotate(args):
    """Arbitrary-degree rotate (straighten): `Image.rotate` only offers the three 90-degree
    multiples, so every angle goes through `Item.transform_rotate` instead. `expand` resizes the
    canvas to the rotated layers' new bounds (`Image.resize_to_layers`); without it the canvas
    stays put and rotated content can fall outside it, same as a Photoshop free-transform without
    "reveal all". Any angle is accepted -- UNLESS a position/direction-dependent effect filter
    (vignette, motion_blur, drop_shadow) is present, in which case only an exact 0/90/180/270
    degrees is allowed (`_refuse_if_non_right_angle_with_tracked_effects`; see lib.py's own "ONLY
    exact cases are supported" comment for why).

    `transform_rotate`'s second argument is `auto_center` -- confusingly, passing True means
    "IGNORE the center_x/center_y given and use this item's own bounds' center instead," not
    "yes, use the center I computed." That must be False here: every layer AND every named mask
    channel has to rotate around the exact SAME point (the image's own center) to stay aligned
    with each other, and `auto_center=True` would rotate each one around its own individual
    center instead, which only happens to look right when there is nothing else to line up
    against. Refuses outright when a masked filter is present -- see this section's own comment
    for why rotating the channel isn't enough to keep such a filter's rendering aligned."""
    img = _image(args)
    _refuse_if_masked_filters(img, 'rotate')
    degrees = float(lib.require(args, 'degrees'))
    expand = bool(args.get('expand', False))
    _refuse_if_non_right_angle_with_tracked_effects(img, degrees, 'rotate')
    # Every affected filter's new params are computed and range-validated from each owning
    # layer's CURRENT (pre-rotation) dimensions before anything below mutates the image -- see
    # `_snapshot_effect_transform`'s own doc comment.
    planned = _snapshot_effect_transform(
        img, 'rotate',
        lambda operation, params, layer: lib.rotate_effect_params(
            operation, params, degrees, layer.get_width(), layer.get_height()
        ),
    )
    # With a selection active, transform_rotate moves only the selected pixels and leaves a
    # floating selection behind (see op_open).
    Gimp.Selection.none(img)
    old_w, old_h = img.get_width(), img.get_height()
    cx, cy = old_w / 2.0, old_h / 2.0
    angle = math.radians(degrees)
    for layer in img.get_layers():
        layer.transform_rotate(angle, False, cx, cy)
    for channel in img.get_channels():
        channel.transform_rotate(angle, False, cx, cy)
    if expand:
        img.resize_to_layers()
    failures = _apply_planned_effect_transform(img, planned)
    _drop_proxies(img.get_id())
    result = {'width': img.get_width(), 'height': img.get_height(), 'degrees': degrees}
    if failures:
        result['effect_update_failures'] = failures
    return result


_FLIP_ORIENTATIONS = {
    'horizontal': Gimp.OrientationType.HORIZONTAL,
    'vertical': Gimp.OrientationType.VERTICAL,
}


def op_flip(args):
    """Refuses outright when a masked filter is present -- see the geometry section's own comment
    for why flipping the channel isn't enough to keep such a filter's rendering aligned."""
    orientation = args.get('orientation')
    if orientation not in _FLIP_ORIENTATIONS:
        raise ValueError('orientation must be one of %s' % sorted(_FLIP_ORIENTATIONS))
    img = _image(args)
    _refuse_if_masked_filters(img, 'flip')
    planned = _snapshot_effect_transform(
        img, 'flip',
        lambda operation, params, layer: lib.flip_effect_params(operation, params, orientation),
    )
    Gimp.Selection.none(img)  # see op_open: geometry always applies to the whole canvas
    img.flip(_FLIP_ORIENTATIONS[orientation])
    failures = _apply_planned_effect_transform(img, planned)
    _drop_proxies(img.get_id())
    result = {'width': img.get_width(), 'height': img.get_height()}
    if failures:
        result['effect_update_failures'] = failures
    return result


def _proxy_render(img, max_px):
    """A flattened, downscaled render of img with its live filters: the proxy plus mirrored
    filters. Caller deletes it. Returns (dup, unmirrored_filters) -- the second element is
    `_mirror_filters`'s own return value, surfaced by every caller's result as
    `unmirrored_filters`."""
    dup = _proxy(img, max_px).duplicate()
    try:
        unmirrored = _mirror_filters(img, dup)
        dup.flatten()
    except Exception:
        dup.delete()
        raise
    return dup, unmirrored


def _region_full_res(img, region):
    """Full-res duplicate, cropped to `region`, flattened. Caller deletes it. A plain
    `Image.duplicate()` copies each layer's real live DrawableFilters (not just pixels), so
    rendering this way is exact -- the filter runs at native resolution over the cropped area
    BEFORE any later downscale, unlike the preview proxy (which shrinks the base first and then
    has to approximate a spatial filter's radius, see `_mirror_filters`).

    `region` is validated against `img`'s FULL-RES bounds before anything is duplicated (partly
    or fully outside raises `invalid_argument` rather than silently clamping to whatever sliver
    overlaps); the duplicate itself is torn down on ANY failure after that, not just the size
    check, so a crop/flatten error can never leak an orphaned image."""
    x, y, w, h = lib.validate_region(region, img.get_width(), img.get_height())
    dup = img.duplicate()
    try:
        dup.crop(w, h, x, y)
        layer = dup.flatten()
    except Exception:
        dup.delete()
        raise
    return dup, layer


def _scale_to_max(dup, max_px):
    w, h = dup.get_width(), dup.get_height()
    scale = min(1.0, float(max_px) / max(w, h))
    if scale < 1.0:
        dup.scale(max(1, round(w * scale)), max(1, round(h * scale)))
    return dup


def op_preview(args):
    """Proxy render with live filters, by default; `region` renders a full-res crop instead (see
    `_region_full_res`), which is exact for spatial filters rather than approximate. `proxy` in
    the result says which route was used, so the tool layer can flag a spatial filter's preview
    as approximate only when it actually is.

    Every preview leaves the bridge through `_export_stripped` -- the SAME metadata-stripping,
    format-refusing writer `export` uses -- because a preview routinely goes to a cloud model and
    a source photo's EXIF/GPS must never ride along on that path either."""
    img = _image(args)
    max_px = lib.validate_max_px(int(args.get('max_px', 1024)))
    region = args.get('region')
    out_path = lib.require(args, 'out_path')
    if region:
        dup, _layer = _region_full_res(img, region)
        try:
            _scale_to_max(dup, max_px)
            _export_stripped(dup, out_path)
            return {'path': out_path, 'width': dup.get_width(), 'height': dup.get_height(),
                    'proxy': False}
        finally:
            dup.delete()
    dup, unmirrored = _proxy_render(img, max_px)
    try:
        _export_stripped(dup, out_path)
        return {'path': out_path, 'width': dup.get_width(), 'height': dup.get_height(),
                'proxy': True, 'unmirrored_filters': unmirrored}
    finally:
        dup.delete()


def _channel_stats_from(dup, layer, channels):
    w, h = dup.get_width(), dup.get_height()
    buf = layer.get_buffer()
    rect = Gegl.Rectangle.new(0, 0, w, h)
    rgb = buf.get(rect, 1.0, "R'G'B' u8", Gegl.AbyssPolicy.NONE) if set(channels) - {'luminance'} else None
    lum = buf.get(rect, 1.0, "Y' u8", Gegl.AbyssPolicy.NONE) if 'luminance' in channels else None
    out = {}
    for ch in channels:
        out[ch] = lib.channel_stats(lum if ch == 'luminance' else rgb[('red', 'green', 'blue').index(ch)::3])
    return w, h, out


def op_histogram(args):
    """Stats for several channels from ONE render. Default (whole image): the 1024 px preview
    render (~0.3 s), or the full-resolution composite with exact=True (~3.7 s for 24 MP with
    filters). `region`: computed on the (mirrored) proxy when the region maps to at least
    `lib.MIN_PROXY_REGION_PX` on a side there, else a full-res crop -- same "too few proxy
    samples to mean anything" reasoning as `lib.MIN_PROXY_REGION_PX`'s own docstring; exact=True
    always forces the full-res crop regardless of size."""
    img = _image(args)
    channels = args.get('channels') or list(lib.HIST_CHANNELS)
    bad = [c for c in channels if c not in lib.HIST_CHANNELS]
    if bad:
        raise ValueError('channels must be drawn from %s, got %s' % (list(lib.HIST_CHANNELS), bad))
    exact = bool(args.get('exact', False))
    region = args.get('region')
    if region:
        lib.validate_region(region, img.get_width(), img.get_height())

    if region and not exact:
        img_w = img.get_width()
        scale = min(1.0, 1024.0 / max(img_w, img.get_height())) if img_w else 1.0
        px, py, pw, ph = lib.region_to_proxy_px(region, scale)
        if pw >= lib.MIN_PROXY_REGION_PX and ph >= lib.MIN_PROXY_REGION_PX:
            dup, unmirrored = _proxy_render(img, 1024)
            try:
                px = min(px, max(0, dup.get_width() - 1))
                py = min(py, max(0, dup.get_height() - 1))
                pw = min(pw, dup.get_width() - px)
                ph = min(ph, dup.get_height() - py)
                dup.crop(pw, ph, px, py)
                layer = dup.flatten()
                w, h, out = _channel_stats_from(dup, layer, channels)
            finally:
                dup.delete()
            return {'exact': False, 'width': w, 'height': h, 'pixels': w * h, 'channels': out,
                    'unmirrored_filters': unmirrored}
        region = dict(region)  # fall through to the full-res path below
        exact = True

    unmirrored = []
    if region:
        dup, layer = _region_full_res(img, region)
    elif exact:
        dup, layer = _composite(img)
    else:
        dup, unmirrored = _proxy_render(img, 1024)
        layer = dup.get_layers()[0]
    try:
        w, h, out = _channel_stats_from(dup, layer, channels)
    finally:
        dup.delete()
    result = {'exact': exact, 'width': w, 'height': h, 'pixels': w * h, 'channels': out}
    if not region and not exact:
        result['unmirrored_filters'] = unmirrored
    return result


def op_compare(args):
    """`mode: 'before_after'` -- proxy base (no filters) vs proxy+filters (both the existing
    preview-proxy machinery already builds), per-channel stat deltas, optional paired preview
    JPEGs. `mode: 'regions'` -- the same per-channel stats for two rects, no delta (the caller
    compares)."""
    img = _image(args)
    mode = args.get('mode')
    channels = args.get('channels') or list(lib.HIST_CHANNELS)
    bad = [c for c in channels if c not in lib.HIST_CHANNELS]
    if bad:
        raise ValueError('channels must be drawn from %s, got %s' % (list(lib.HIST_CHANNELS), bad))

    if mode == 'before_after':
        region = args.get('region')
        if region:
            lib.validate_region(region, img.get_width(), img.get_height())
        max_px = lib.validate_max_px(int(args.get('max_px', 1024)))
        # Both duplicates' CREATION now lives inside this try (it used to happen before the try
        # started), and each is set to None first: if `_proxy_render` (building `after`) raised
        # right after `base` was already a real duplicate, the old code's `finally` never even
        # started running, so `base` leaked. Guarding each delete on "was it actually assigned"
        # lets either half's construction fail without leaking the other.
        base = None
        after = None
        try:
            base = _proxy(img, max_px).duplicate()
            after, unmirrored = _proxy_render(img, max_px)
            if region:
                img_w = img.get_width()
                scale = min(1.0, float(max_px) / max(img_w, img.get_height())) if img_w else 1.0
                px, py, pw, ph = lib.region_to_proxy_px(region, scale)
                for dup in (base, after):
                    x = min(px, max(0, dup.get_width() - 1))
                    y = min(py, max(0, dup.get_height() - 1))
                    w = min(pw, dup.get_width() - x)
                    h = min(ph, dup.get_height() - y)
                    dup.crop(w, h, x, y)
            base_layer, after_layer = base.flatten(), after.flatten()
            _bw, _bh, before_stats = _channel_stats_from(base, base_layer, channels)
            _aw, _ah, after_stats = _channel_stats_from(after, after_layer, channels)
            deltas = {}
            for ch in channels:
                b, a = before_stats[ch], after_stats[ch]
                deltas[ch] = {
                    k: round(a[k] - b[k], 3) for k in ('mean', 'median', 'p1', 'p5', 'p95', 'p99')
                }
            result = {'before': before_stats, 'after': after_stats, 'delta': deltas, 'proxy': True,
                      'unmirrored_filters': unmirrored}
            before_path, after_path = args.get('before_path'), args.get('after_path')
            if before_path:
                _export_stripped(base, before_path)
                result['before_path'] = before_path
            if after_path:
                _export_stripped(after, after_path)
                result['after_path'] = after_path
            return result
        finally:
            if base is not None:
                base.delete()
            if after is not None:
                after.delete()

    if mode == 'regions':
        region_a, region_b = args.get('region_a'), args.get('region_b')
        if not region_a or not region_b:
            raise ValueError('regions mode needs both region_a and region_b')
        dup_a, layer_a = _region_full_res(img, region_a)
        try:
            _wa, _ha, stats_a = _channel_stats_from(dup_a, layer_a, channels)
        finally:
            dup_a.delete()
        dup_b, layer_b = _region_full_res(img, region_b)
        try:
            _wb, _hb, stats_b = _channel_stats_from(dup_b, layer_b, channels)
        finally:
            dup_b.delete()
        return {'region_a': stats_a, 'region_b': stats_b, 'proxy': False}

    raise ValueError("mode must be one of 'before_after', 'regions'")


def _strip_metadata(cfg, fmt):
    """Switch off every metadata-carrying option on an export config. Which options must exist,
    and which are set only when present, is decided by `lib.metadata_strip_settings` (gi-free, so
    the fail-loud path for a missing required option is unit-tested)."""
    prop_names = {p.name for p in cfg.list_properties()}
    for name in lib.metadata_strip_settings(fmt, prop_names):
        cfg.set_property(name, False)


def _export_stripped(dup, path, options=None):
    """The ONE place any flattened raster copy leaves the bridge -- `export`'s own flat branch,
    every `preview` (whole-image or region), and `compare`'s before/after outputs all go through
    this, so there is exactly one spot that decides how metadata is handled and what formats are
    even reachable, instead of N call sites that could each get it slightly differently (the
    original bug: `preview`/`compare` called a bare `Gimp.file_save`, which has no
    metadata-stripping properties to set AT ALL, while `export`'s own catch-all branch for an
    unrecognised extension did the exact same bare, unstripped save).

    Refuses any extension outside jpg/jpeg/png/webp/tif/tiff outright (`invalid_argument`) --
    there is no metadata-safe fallback for a format this bridge doesn't know the export
    procedure's properties for, so silently falling back to an unstripped save is not an option.

    Metadata: EXIF/XMP/IPTC/thumbnail/comment are always stripped via the format's own export
    config (verified live that GIMP's own defaults do NOT strip a source image's EXIF/GPS through
    `file-jpeg-export`, so this cannot be left to the exporter's defaults). The image's attached
    `Gimp.Metadata` is also cleared on `dup` itself before saving, belt-and-braces alongside the
    config flags (which are the mechanism actually verified to control what lands in the file).

    Bit depth: png/tiff accept `bit_depth: 8 | 16` (default 8); jpeg/webp are always 8-bit. Either
    way `dup`'s precision is converted to match BEFORE saving -- after a 16/32-bit `precision`
    promotion at open time, the flattened duplicate would otherwise still carry that higher bit
    depth into an export that never asked for it."""
    options = options or {}
    ext = os.path.splitext(path)[1].lower()
    fmt = lib.EXPORT_FORMATS.get(ext)
    if fmt is None:
        raise ValueError(
            'export path must end in .jpg, .jpeg, .png, .webp, .tif, or .tiff (got %r)' % ext
        )
    if fmt in ('png', 'tiff'):
        bit_depth = lib.validate_choice('bit_depth', options.get('bit_depth', 8), lib.BIT_DEPTHS)
    else:
        bit_depth = 8
    target_precision = (
        Gimp.Precision.U16_NON_LINEAR if bit_depth == 16 else Gimp.Precision.U8_NON_LINEAR
    )
    if dup.get_precision() != target_precision:
        dup.convert_precision(target_precision)
    try:
        dup.set_metadata(Gimp.Metadata.new())
    except Exception:
        pass

    pdb = Gimp.get_pdb()
    proc_name = {
        'jpeg': 'file-jpeg-export', 'png': 'file-png-export',
        'webp': 'file-webp-export', 'tiff': 'file-tiff-export',
    }[fmt]
    proc = pdb.lookup_procedure(proc_name)
    cfg = proc.create_config()
    if fmt == 'jpeg':
        cfg.set_property('quality', lib.pct_to_unit('quality', options.get('quality', 90), 1.0, 100.0))
    elif fmt == 'png':
        cfg.set_property(
            'compression', lib.validate_int_range('compression', options.get('compression', 3), 0, 9)
        )
    elif fmt == 'webp':
        cfg.set_property(
            'quality', lib.validate_range('quality', options.get('quality', 90), 0.0, 100.0)
        )
        cfg.set_property('lossless', bool(options.get('lossless', False)))
    elif fmt == 'tiff':
        cfg.set_property(
            'compression',
            lib.validate_choice('compression', options.get('compression', 'none'), lib.TIFF_COMPRESSIONS),
        )
    cfg.set_property('image', dup)
    cfg.set_property('file', Gio.File.new_for_path(path))
    _strip_metadata(cfg, fmt)
    # A failed write does not raise: run() returns an EXECUTION_ERROR status with GIMP's message
    # as the second value (verified live, GIMP 3.2.6, writing into a missing directory).
    result = proc.run(cfg)
    if result.index(0) != Gimp.PDBStatusType.SUCCESS:
        name = os.path.basename(path)
        detail = result.index(1) if result.length() > 1 else result.index(0).value_nick
        # GIMP's message quotes the full path ("Could not open '<path>' for writing"); keep just
        # the file name, as every other message here does.
        detail = str(detail)
        for spelling in sorted({Gio.File.new_for_path(path).get_path() or path, path}, key=len, reverse=True):
            detail = detail.replace(spelling, name)
        raise lib.OpError('gimp_op_failed', 'could not write %s: %s' % (name, detail))


def op_export(args):
    """Writes path by extension: .xcf saves the live document, anything else exports a flattened
    copy via `_export_stripped` (metadata stripped; jpeg quality 1-100 default 90; png compression
    0-9 default 3 -- GIMP's own default of 9 measured far slower for negligible size gain; webp
    quality 0-100 default 90 + lossless; tiff compression, default 'none'; png/tiff bit_depth 8 or
    16, default 8).

    Flat exports flatten a duplicate first and save that. Handing the live document to
    file_save lets the exporter render the filters itself, which measured 9.3 s for a 24 MP
    JPEG with three curves; flatten (3.0 s) + save of the flat copy (1.0 s) gives the same pixels."""
    img = _image(args)
    path = lib.require(args, 'path')
    if path.lower().endswith('.xcf'):
        # file_save reports a failed write by returning False, not by raising (verified live).
        if not Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, img, Gio.File.new_for_path(path), None):
            raise lib.OpError(
                'gimp_op_failed',
                'could not save %s (check that the folder exists and is writable)'
                % os.path.basename(path),
            )
    else:
        dup, _flat = _composite(img)
        try:
            _export_stripped(dup, path, args)
        finally:
            dup.delete()
    return {'path': path, 'bytes': os.path.getsize(path)}


def _replace_named_channel(img, name, w, h):
    """Remove any existing channel called `name` and insert a fresh, black-filled one of the
    image's own size -- `op_create_mask`'s replace-by-name semantics. Restores the image's
    selected layers afterward: `insert_channel` changes them as a side effect (verified live, the
    same class of surprise `op_place_image`'s own comment documents for `insert_layer`), which
    would otherwise silently retarget a later layer-defaulting call (e.g. `gimp_add_adjustment`
    with no `layer`) at whatever layer a channel happened to insert next to."""
    original_selection = img.get_selected_layers()
    for existing in img.get_channels():
        if existing.get_name() == name:
            img.remove_channel(existing)
    ch = Gimp.Channel.new(img, name, w, h, 50.0, Gegl.Color.new('black'))
    img.insert_channel(ch, None, 0)
    img.set_selected_layers(original_selection)
    return ch


def _channel_coverage(ch, w, h):
    # "Y' u8" (perceptual/non-linear), not "Y u8" (linear light): the channel's own storage is
    # non-linear (matching the image precision), and reading it back through the LINEAR format
    # applies a real, non-trivial conversion, not an identity one -- verified live, a gradient
    # painted as an even perceptual ramp (0..255 in file/mask terms) reads back compressed
    # toward black through 'Y u8' (e.g. the geometric midpoint reads ~55, not ~128), while "Y' u8"
    # reproduces the ramp exactly. Every mask/selection buffer read or write in this file uses
    # the primed, perceptual format for the same reason.
    data = ch.get_buffer().get(Gegl.Rectangle.new(0, 0, w, h), 1.0, "Y' u8", Gegl.AbyssPolicy.NONE)
    # `bytes.translate(None, delete)` runs the byte-by-byte pass in C rather than the interpreter
    # loop a `sum(1 for b in data if b >= 128)` generator pays per byte. `delete` names the bytes to
    # DROP, so deleting every byte below 128 (0..127) leaves exactly the >=128 ones behind: len() of
    # what's left IS the selected count directly, no subtraction needed. Same result as the
    # generator, measured live (GIMP 3.2.6, ~24MP) at ~120ms/channel -- what keeps `describe`'s
    # `channels` target, which reads this per NAMED channel rather than just one, fast enough to
    # stay inside its own time budget (`_channels_described`'s `CHANNELS_DESCRIBE_DEADLINE_S`).
    selected = len(data.translate(None, bytes(range(128))))
    return selected, round(selected / len(data), 4)


def _mask_name_in_use(img, name):
    """True if any bridge-applied filter's ledger record currently uses `name` as its mask --
    the check `create_mask` refuses on, so replacing a same-named channel can never silently
    change what an EXISTING filter is confined to (a filter's mask, once created, is meant to be
    fixed -- see `_apply_filter`'s own re-edit rule). A name nothing yet references is still free
    to reuse or replace, which is what lets a mask be iterated on before it's ever attached to a
    filter."""
    filters, _unknown = _ledger_get(img)
    return any(rec.get('params', {}).get('mask') == name for rec in filters.values())


def _refuse_mask_in_use(img, name):
    if _mask_name_in_use(img, name):
        raise ValueError(
            'mask %r is already used by an existing filter; delete that filter or use a '
            'different name' % name
        )


def _find_channel(img, name):
    for ch in img.get_channels():
        if ch.get_name() == name:
            return ch
    return None


def _require_channel(img, name):
    """`_find_channel`, refusing a miss with the one neutral message every caller (the filter
    mask lookup and every gimp_select-family channel reference) shares -- a channel can come from
    gimp_select, gimp_layer_mask op=create, or load_mask, so no single tool name belongs here."""
    ch = _find_channel(img, name)
    if ch is None:
        raise ValueError('no channel named %r' % name)
    return ch


def op_create_mask(args):
    """Geometric mask -> a named channel (replacing any same-named channel not already in use as
    a filter's mask -- see `_mask_name_in_use`), leaving the selection cleared afterward.

    rectangle/ellipse: `Image.select_rectangle`/`select_ellipse`, optional `Selection.invert`,
    optional `Selection.feather`, then the resulting selection's pixels are copied into the
    channel.

    gradient_linear/gradient_radial: `gegl:linear-gradient`/`gegl:radial-gradient` are NOT usable
    as drawable filters (verified live: their pspecs return None, `DrawableFilter.new` fails) --
    the working route is painting a black-to-white ramp directly into the channel with
    `Drawable.edit_gradient_fill` (verified live). `Gimp.context_push`/`context_pop` bracket every
    context change (foreground/background/gradient/blend space) so the session's ambient context
    -- which the user's own GUI or a later call might depend on -- is restored exactly regardless
    of how this function exits, rather than manually saving and restoring each property by hand.
    The gradient blend color space is explicitly set to RGB_PERCEPTUAL, but verified live that this
    has NO effect on a Channel fill's actual output either way: forcing RGB_PERCEPTUAL, forcing
    RGB_LINEAR, and leaving the context at whatever it already was all produce the same
    byte-identical ramp (an exact linear ramp -- x=128 reads 128) when read back with `"Y' u8"`.
    What DOES control the crossing point is the buffer format every reader of this channel
    (`_channel_coverage`, and the selection copy above) uses -- `"Y' u8"` (perceptual/gamma-encoded,
    matching the channel's own storage), not `'Y u8'` (linear light, which compresses the readback
    toward black, e.g. the geometric midpoint reading ~55 instead of ~128). RGB_PERCEPTUAL is kept
    set here anyway as the explicit, correct-if-it-ever-starts-mattering choice for a caller who
    thinks in 0-255 terms, not because it changes anything measured today.

    `feather_px` has no effect here (a gradient is already a continuous ramp, nothing to feather);
    `invert` swaps which end is black vs white."""
    img = _image(args)
    type_ = args.get('type')
    if type_ not in lib.MASK_TYPES:
        raise ValueError('type must be one of %s' % sorted(lib.MASK_TYPES))
    name = args.get('name', 'Mask')
    _refuse_mask_in_use(img, name)
    invert = bool(args.get('invert', False))
    feather_px = lib.validate_feather_px(args.get('feather_px', 0))
    w, h = img.get_width(), img.get_height()

    try:
        if type_ in ('rectangle', 'ellipse'):
            x, y = float(lib.require(args, 'x')), float(lib.require(args, 'y'))
            width, height = float(lib.require(args, 'width')), float(lib.require(args, 'height'))
            if type_ == 'rectangle':
                img.select_rectangle(Gimp.ChannelOps.REPLACE, x, y, width, height)
            else:
                img.select_ellipse(Gimp.ChannelOps.REPLACE, x, y, width, height)
            if invert:
                Gimp.Selection.invert(img)
            if feather_px > 0:
                Gimp.Selection.feather(img, feather_px)
            ch = _replace_named_channel(img, name, w, h)
            # "Y' u8" (perceptual), not "Y u8" (linear) -- see `_channel_coverage`'s comment. A
            # hard selection is 0/255 either way, but a FEATHERED one has a real falloff whose
            # shape this format choice controls.
            sel_data = img.get_selection().get_buffer().get(
                Gegl.Rectangle.new(0, 0, w, h), 1.0, "Y' u8", Gegl.AbyssPolicy.NONE
            )
            ch_buf = ch.get_buffer()
            ch_buf.set(Gegl.Rectangle.new(0, 0, w, h), "Y' u8", sel_data)
            ch_buf.flush()
            ch.update(0, 0, w, h)
        else:
            ch = _replace_named_channel(img, name, w, h)
            _paint_gradient_mask(ch, type_, invert, args, w, h)
    finally:
        Gimp.Selection.none(img)  # a mask is referenced by NAME at filter-creation time, not by
        # staying the active selection -- leaving it selected let the NEXT unmasked filter
        # silently inherit it (`_append_masked` also clears defensively, but the fix belongs
        # here too).
    _drop_proxies(img.get_id())
    selected, fraction = _channel_coverage(ch, w, h)
    return {'channel': name, 'selected_pixels': selected, 'fraction': fraction}


def _paint_gradient_mask(ch, type_, invert, args, w, h):
    """Paint a `type_` ('gradient_linear' | 'gradient_radial') black-to-white ramp directly into
    channel `ch`. `gegl:linear-gradient`/`gegl:radial-gradient` are NOT usable as drawable filters
    (verified live: their pspecs return None, `DrawableFilter.new` fails) -- the working route is
    `Drawable.edit_gradient_fill` (verified live). `Gimp.context_push`/`context_pop` bracket every
    context change (foreground/background/gradient/blend space) so the session's ambient context
    -- which the user's own GUI or a later call might depend on -- is restored exactly regardless
    of how this function exits, rather than manually saving and restoring each property by hand.
    The gradient blend color space is explicitly set to RGB_PERCEPTUAL, but verified live that this
    has NO effect on a Channel fill's actual output either way: forcing RGB_PERCEPTUAL, forcing
    RGB_LINEAR, and leaving the context at whatever it already was all produce the same
    byte-identical ramp (an exact linear ramp -- x=128 reads 128) when read back with `"Y' u8"`.
    What DOES control the crossing point is the buffer format every reader of this channel
    (`_channel_coverage`) uses -- `"Y' u8"` (perceptual/gamma-encoded, matching the channel's own
    storage), not `'Y u8'` (linear light, which compresses the readback toward black, e.g. the
    geometric midpoint reading ~55 instead of ~128). RGB_PERCEPTUAL is kept set here anyway as the
    explicit, correct-if-it-ever-starts-mattering choice for a caller who thinks in 0-255 terms, not
    because it changes anything measured today.

    No feather here (a gradient is already a continuous ramp, nothing to feather); `invert` swaps
    which end is black vs white. Shared by `op_create_mask` and `op_select`'s own gradient_linear/
    gradient_radial modes."""
    black, white = ('white', 'black') if invert else ('black', 'white')
    # A gradient fill paints `start_color` at (x1,y1) and `end_color` at (x2,y2). For
    # gradient_linear those points are the caller's own start/end -- black-at-x1 ramps toward
    # white-at-x2 exactly as given (verified live). For gradient_radial (x1,y1) is always the
    # CENTER and (x2,y2) the radius edge, and the intuitive reading of a radial mask is a
    # spotlight -- full effect (white) at the center, fading to none (black) at the edge -- so the
    # two colors are swapped relative to the linear case.
    if type_ == 'gradient_linear':
        start_color, end_color = black, white
        x1, y1 = float(args.get('x1', 0)), float(args.get('y1', 0))
        x2, y2 = float(args.get('x2', w)), float(args.get('y2', 0))
        gtype = Gimp.GradientType.LINEAR
    else:
        start_color, end_color = white, black
        cx, cy = float(args.get('cx', w / 2.0)), float(args.get('cy', h / 2.0))
        radius = float(args.get('radius', min(w, h) / 2.0))
        x1, y1, x2, y2 = cx, cy, cx + radius, cy
        gtype = Gimp.GradientType.RADIAL
    Gimp.context_push()
    try:
        Gimp.context_set_foreground(Gegl.Color.new(start_color))
        Gimp.context_set_background(Gegl.Color.new(end_color))
        Gimp.context_set_gradient_fg_bg_rgb()
        Gimp.context_set_gradient_blend_color_space(Gimp.GradientBlendColorSpace.RGB_PERCEPTUAL)
        ch.edit_gradient_fill(gtype, 0.0, False, 1, 0, False, x1, y1, x2, y2)
    finally:
        Gimp.context_pop()


def op_describe_operation(args):
    """Probe: `list_properties()` (name, type, min, max, default) for a named GEGL/GIMP
    operation, via a transient `DrawableFilter` on a throwaway 1x1 image that is never applied
    or rendered. This is what the GEGL-schema golden test snapshots per operation, so a GIMP
    upgrade that changes a property's range or default fails a test instead of silently shipping
    an adjust type whose validated range no longer matches the real op."""
    operation = lib.require(args, 'operation')
    if operation not in lib.ALLOWED_DESCRIBE_OPERATIONS:
        raise ValueError('operation must be one of %s' % sorted(lib.ALLOWED_DESCRIBE_OPERATIONS))
    img = Gimp.Image.new(1, 1, Gimp.ImageBaseType.RGB)
    try:
        layer = Gimp.Layer.new(img, 'probe', 1, 1, Gimp.ImageType.RGB_IMAGE, 100.0, Gimp.LayerMode.NORMAL)
        img.insert_layer(layer, None, 0)
        try:
            f = Gimp.DrawableFilter.new(layer, operation, operation)
        except Exception as e:
            raise ValueError('no such GEGL/GIMP operation %r (%s)' % (operation, e))
        cfg = f.get_config()
        props = []
        for p in cfg.list_properties():
            try:
                default = cfg.get_property(p.name)
                if isinstance(default, Gimp.Curve):
                    # A bare repr() of a GimpCurve embeds its object pointer address, which
                    # differs every run and would make the schema golden fail on every diff
                    # regardless of any real drift; its points are the stable, meaningful summary.
                    default = _curve_points(default)
                elif isinstance(default, Gegl.Color):
                    # Same reasoning as GimpCurve above -- a bare repr() of a GeglColor (e.g.
                    # vignette's/dropshadow's `color`) embeds two object pointer addresses that
                    # differ every run. `get_rgba()` is the stable, meaningful summary.
                    default = list(default.get_rgba())
                elif hasattr(default, 'value_nick'):
                    default = default.value_nick
                elif not isinstance(default, (int, float, str, bool, type(None))):
                    default = str(default)
            except Exception:
                default = None
            props.append({
                'name': p.name,
                'type': p.value_type.name if hasattr(p.value_type, 'name') else str(p.value_type),
                'minimum': getattr(p, 'minimum', None),
                'maximum': getattr(p, 'maximum', None),
                'default': default,
            })
        f.delete()
        return {'operation': operation, 'properties': props}
    finally:
        img.delete()


# ---- layer management (gimp_layer) ---------------------------------------------------------
#
# `create_group` + `reorder`'s `parent_group` cover everything a dedicated group tool would --
# there is no separate group tool.
#
# Verified live (GIMP 3.2.6), the assumptions this section is built on:
#   - `Gimp.GroupLayer.new(image, name)` + `Image.insert_layer(layer, parent, position)` works for
#     both a plain layer and a group, nested arbitrarily deep; `Image.reorder_item(item, parent,
#     position)` moves an existing item (including into/out of a group) the same way. Duplicating a
#     group (`layer.copy()`) renames every descendant itself, uniquely, as `<name> #<n>` (the
#     ORIGINAL keeps its own name) -- verified across repeated and nested duplicates, so this
#     section never has to rename a duplicated group's own children itself.
#   - `layer.copy()` returns a new, unattached layer whose filters carry the SAME NAMES as the
#     source's -- and `DrawableFilter.set_name` does NOT exist on this GIMP build (verified: not in
#     its method list at all), so a copy of a layer with an Editmamei filter cannot be renamed. The
#     ledger is keyed by filter name (`_apply_filter`), so leaving the collision in place would
#     mean a later re-edit of EITHER copy silently rewrites the other's ledger record. `duplicate`
#     therefore refuses outright when the source (or, for a group, any descendant) carries an
#     Editmamei-ledgered filter.
#   - `Item.set_offsets(x, y)` is an ABSOLUTE move, not a delta -- verified live (two successive
#     calls land the layer exactly where each one asked, not summed). Called on a GROUP layer, it
#     moves every descendant by the same delta too (verified live: a child's own reported offset
#     shifts by exactly the same amount as the group's) -- `move` needs no special-casing for a
#     group target.
#   - A masked filter's confinement does NOT travel with `set_offsets`: verified live with a
#     brightness-contrast filter masked to the left half of a layer, moved by set_offsets -- the
#     darkened region did not reappear anywhere in the layer's new position (its mask stayed
#     pinned to the OLD canvas coordinates, the same "confinement is a fixed snapshot" physics
#     `_refuse_if_masked_filters`'s own comment documents for rotate/flip). `move` therefore
#     refuses under the same conditions, scoped to the moved layer's own subtree AND its containing
#     groups (an untouched OTHER, unrelated layer's masked filter is unaffected by this layer
#     moving) -- see `_refuse_if_masked_filters_on`'s own comment for why duplicate filter NAMES
#     are classified over the whole image even though the refusal itself stays scoped.
#   - `Image.merge_down(layer, merge_type)` merges INTO THE FIRST VISIBLE LAYER BELOW -- verified
#     live that a HIDDEN layer directly beneath the one being merged is skipped entirely and left
#     untouched, not merged and not removed. Refuses (returns None, no Python exception -- GIMP
#     logs "Cannot merge down to a layer group." / "There is no visible layer to merge down to." to
#     its own console) when that target would be a group, or when there is no visible layer below
#     at all; both are checked here first for a clean, specific error instead of a generic failure.
#   - `Image.merge_down` and `Image.flatten()` both render each source layer's live filters (masked
#     ones included) into real pixels BEFORE compositing -- verified live: a masked
#     brightness-contrast filter's confined darkening survived merge_down exactly, on a top-level
#     pair and on a pair nested inside a group. Both consume every live filter on every layer they
#     touch (verified: a layer being merged INTO, which had its own separate live filter, ends up
#     with `get_filters() == []` afterward too, not just the layer merged away) -- no masked-filter
#     refusal is needed for either, only a ledger prune afterward.
#   - `Image.flatten()` DISCARDS every hidden layer outright (verified live: a hidden layer's own
#     content never reaches the flattened composite, and the layer itself is simply gone
#     afterward, text layers included) rather than compositing it in -- `flatten` therefore refuses
#     by default when any layer is hidden, listing them, unless `discard_hidden: true` is given.
#     Always drops alpha (verified: `has_alpha()` is False on the result even when the only layer
#     had one) -- surfaced in the result and the tool description, not hidden.
#   - A VISIBLE text layer merges/flattens into an ordinary raster layer with no error (verified);
#     a HIDDEN one is simply discarded like any other hidden layer, never rasterized at all, so
#     `rasterized_text` only counts visible text layers.
#   - `Drawable.merge_filters()` (gimp_bake) does NOT rasterize a text layer -- verified live:
#     `is_text_layer()` still reads True after baking away its filter. Bake's result has no
#     `rasterized_text` field for this reason; the tool description just says so.
#   - A filter CAN be attached to a group layer (verified live: `DrawableFilter.new` and
#     `append_filter` both succeed on one) -- `gimp_add_adjustment` does not refuse it. `gimp_bake`
#     cannot bake one (`merge_filters()` errors on a group, see `_bake_one`), so `op=bake all: true`
#     reports any such group under `skipped_groups_with_filters` rather than silently ignoring it.


def _layer_subtree(layer):
    """`layer` itself, plus every descendant if it is a group -- the scope a structural op on
    `layer` actually reaches (deleting, duplicating, or moving a group takes its children with
    it). A plain (non-group) layer's subtree is just itself."""
    out = [layer]

    def walk(items):
        for item in items:
            out.append(item)
            if item.is_group():
                walk(item.get_children())

    if layer.is_group():
        walk(layer.get_children())
    return out


def _ledgered_filter_names_on(img, layers):
    """Names of live filters on `layers` (see `_layer_subtree`) that match an Editmamei ledger
    record -- the ones `duplicate` cannot safely carry onto a copy (see its own comment above)."""
    filters, _unknown = _ledger_get(img)
    out = []
    for layer in layers:
        for f in layer.get_filters():
            rec = filters.get(f.get_name())
            if rec and rec.get('operation') == f.get_operation_name():
                out.append(f.get_name())
    return out


def _layer_ancestors(layer):
    """Every GROUP layer between `layer` and the top of the stack, immediate parent first -- the
    complement of `_layer_subtree` (which walks DOWN into descendants, never up). A masked filter
    on one of these confines to that group's own rendered composite, which shifts under it when a
    layer inside the group moves, exactly the same misalignment a masked filter directly on the
    moving layer would suffer."""
    out = []
    parent = layer.get_parent()
    while parent is not None:
        out.append(parent)
        parent = parent.get_parent()
    return out


def _refuse_if_masked_filters_on(img, op_name, layer):
    """The same refuse-rather-than-corrupt check as `_refuse_if_masked_filters`, scoped to `layer`
    itself, its own subtree (`_layer_subtree` -- moving a group takes its children with it), and
    its containing groups (`_layer_ancestors`) -- moving `layer` cannot misalign a masked filter
    that lives on some OTHER, unrelated part of the image.

    Duplicate-name classification runs over the WHOLE image's live filters, not just this scope: a
    name is ambiguous the moment it appears on more than one live filter ANYWHERE in the image,
    since the ledger's {name: record} shape can only ever describe one of them -- a masked filter
    elsewhere hiding behind an unmasked one's ledger record in this scope (or the reverse) would
    otherwise slip through unnoticed. The refusal itself still only fires for a name that actually
    appears in `layer`'s own scope, so a masked filter on a completely unrelated layer never blocks
    this move."""
    scope = set(_layer_subtree(layer)) | set(_layer_ancestors(layer))
    scoped_names = {f.get_name() for l in scope for f in l.get_filters()}
    filters = _prune_stale_ledger_records(img)
    whole_image_live = [
        (f.get_name(), f.get_operation_name()) for l in _all_layers(img) for f in l.get_filters()
    ]
    masked, unverifiable = lib.classify_geometry_filters(filters, whole_image_live)
    masked = sorted(set(n for n in masked if n in scoped_names))
    unverifiable = sorted(set(n for n in unverifiable if n in scoped_names))
    if unverifiable:
        # An in-scope name lands here for one of two different reasons, which need different
        # advice: no matching ledger record at all (a genuinely foreign filter -- delete IT), or a
        # name carried by more than one live filter in the image. The ledger is keyed by name, so
        # in the second case it cannot say which copy is Editmamei's; the advice names every layer
        # carrying the name and leaves the choice to the caller. `name_counts` -- not
        # `lib.classify_geometry_filters`'s own return, which doesn't distinguish the two -- is what
        # tells them apart.
        name_counts = {}
        for live_name, _operation in whole_image_live:
            name_counts[live_name] = name_counts.get(live_name, 0) + 1
        duplicated = sorted(n for n in unverifiable if name_counts[n] > 1)
        unrecognized = sorted(n for n in unverifiable if name_counts[n] <= 1)
        reasons = []
        if unrecognized:
            reasons.append(
                'filter(s) %s on this layer, or a group containing it, were not created by '
                'Editmamei (no matching ledger record for their name and operation), so whether '
                'they are masked cannot be checked -- delete them first, or move the layer before '
                'adding them'
                % ', '.join(repr(n) for n in unrecognized)
            )
        if duplicated:
            dup_descriptions = []
            for name in duplicated:
                carriers = sorted({
                    l.get_name() for l in _all_layers(img) for f in l.get_filters()
                    if f.get_name() == name
                })
                dup_descriptions.append(
                    '%r (on layer(s) %s)' % (name, ', '.join(repr(c) for c in carriers))
                )
            reasons.append(
                'the name(s) %s are carried by more than one live filter, so which copy was '
                'created by Editmamei cannot be told apart -- rename or delete whichever copy was '
                'not created by Editmamei, then retry'
                % ', '.join(dup_descriptions)
            )
        raise ValueError('%s cannot proceed: %s.' % (op_name, '; '.join(reasons)))
    if masked:
        raise ValueError(
            '%s would misalign the masked adjustment(s) %s: a filter\'s mask does not travel with '
            'content that moves beneath it, whether the filter is on this layer or a group that '
            'contains it. Move the layer before adding masked adjustments, or delete those filters '
            'first and re-create them afterwards.'
            % (op_name, ', '.join(repr(n) for n in masked))
        )


def _resolve_parent_group(img, args):
    """`args['parent_group']` (a layer_id) resolved to a group layer belonging to `img`, or None
    for top-level (the key absent, or explicitly null). Membership- and group-checked the same way
    `_layer`'s own `layer_id` path is -- a stray id, one from another image, or one that names an
    ordinary layer, is refused rather than silently misinserted."""
    parent_id = args.get('parent_group')
    if parent_id is None:
        return None
    parent = Gimp.Layer.get_by_id(int(parent_id))
    owner = _owning_image(parent)
    if parent is None or owner is None or owner.get_id() != img.get_id():
        raise ValueError('no layer with id %s on image %s' % (parent_id, img.get_id()))
    if not parent.is_group():
        raise ValueError('parent_group %s is not a group layer' % parent_id)
    return parent


def _assert_layer_attached(img, layer, what):
    """Some GIMP calls return normally having silently done nothing at all rather than raising on
    failure (`convert_precision`, `op_open`'s own comment) -- so every insertion this section
    relies on is verified the same defensive way: confirm the layer is actually reachable by
    walking `img`'s own live layer tree (`_all_layers`, not just trusting `Item.get_image()`'s own
    metadata) before reporting success."""
    if not any(l.get_id() == layer.get_id() for l in _all_layers(img)):
        raise lib.OpError('gimp_op_failed', '%s did not attach to the image' % what)


def _discard_layer(img, layer):
    """Best-effort cleanup for a layer this op created or inserted but must not keep, on any
    failure path from that point on (never let a half-finished op leave an orphaned GIMP object
    behind): remove it from the image if it got that far, then delete the underlying object
    outright. Verified live that `Item.delete()` works both on a layer that was never inserted at
    all and on one already removed -- so this is safe to call unconditionally. Swallows its own
    failures: this runs while another exception is already propagating, and cleanup failing must
    never replace the real error."""
    owner = _owning_image(layer)
    if owner is not None and owner.get_id() == img.get_id():
        try:
            img.remove_layer(layer)
        except Exception:
            pass
    try:
        layer.delete()
    except Exception:
        pass


def _sibling_index(layer, parent):
    """`layer`'s own index among its current siblings (`parent`'s children, or the image's
    top-level layers when `parent` is None) -- compared by id, never by GObject identity (each
    `get_children()`/`get_layers()` call can hand back a fresh Python wrapper for the same
    underlying item)."""
    siblings = list(parent.get_children()) if parent is not None else list(_owning_image(layer).get_layers())
    return next((i for i, s in enumerate(siblings) if s.get_id() == layer.get_id()), None)


def _validated_position(args):
    position = int(args.get('position', 0))
    if position < 0:
        raise ValueError('position must be >= 0')
    return position


def _validated_move_offset(img, x, y):
    """A DoS floor on `move`'s target offset, the same spirit as `lib.validate_resize_dims`'s own
    bound on `resize`: nothing stops a layer from being moved far outside the canvas on its own,
    but combined with a later merge_down/flatten/resize_to_layers an arbitrarily distant offset
    could blow up the working canvas size. Bounded to within `lib.MAX_RESIZE_SIDE_PX` of either
    edge of the CURRENT canvas, not an absolute limit -- generous enough for any real placement,
    tight enough to keep a single call's downstream cost bounded."""
    lo_x, hi_x = -lib.MAX_RESIZE_SIDE_PX, img.get_width() + lib.MAX_RESIZE_SIDE_PX
    lo_y, hi_y = -lib.MAX_RESIZE_SIDE_PX, img.get_height() + lib.MAX_RESIZE_SIDE_PX
    if not lo_x <= x <= hi_x:
        raise ValueError('x must be within %d..%d for this %dpx-wide canvas' % (lo_x, hi_x, img.get_width()))
    if not lo_y <= y <= hi_y:
        raise ValueError('y must be within %d..%d for this %dpx-tall canvas' % (lo_y, hi_y, img.get_height()))


def _union_bbox(a, b):
    """The bounding box `Image.merge_down`'s EXPAND_AS_NECESSARY would produce for merging `a`
    into `b` -- the union of their two offset rectangles. Checked against the same DoS floor
    `resize` uses (`lib.validate_resize_dims`) BEFORE the merge runs: two layers offset far apart
    could otherwise expand the result to an enormous canvas."""
    _ok_a, ax, ay = a.get_offsets()
    _ok_b, bx, by = b.get_offsets()
    aw, ah = a.get_width(), a.get_height()
    bw, bh = b.get_width(), b.get_height()
    left, top = min(ax, bx), min(ay, by)
    right, bottom = max(ax + aw, bx + bw), max(ay + ah, by + bh)
    return right - left, bottom - top


def _merge_down_target(siblings, idx):
    """The layer `merge_down` will actually merge `siblings[idx]` into: the first VISIBLE layer
    below it in the same parent/level -- verified live that GIMP silently skips a hidden layer in
    between and merges into the next visible one instead, leaving the hidden layer untouched.
    Returns None if there is no visible layer below."""
    for candidate in siblings[idx + 1:]:
        if candidate.get_visible():
            return candidate
    return None


# Base types a NEW layer can be given a matching `Gimp.ImageType` for -- everywhere a fresh layer
# might need to be added (gimp_layer op=create, a gimp_canvas fill backdrop) reads this SAME dict
# rather than repeating the RGB/GRAY-only assumption independently, so the two call sites can
# never drift apart on which base types qualify.
_LAYER_CAPABLE_BASE_TYPES = {
    Gimp.ImageBaseType.RGB: Gimp.ImageType.RGBA_IMAGE,
    Gimp.ImageBaseType.GRAY: Gimp.ImageType.GRAYA_IMAGE,
}


def _layer_type_for(img):
    """The `Gimp.ImageType` a new layer should use so it matches `img`'s own color model instead
    of relying on GIMP's own silent coercion (verified live: an RGBA layer inserted into a
    grayscale image is quietly converted to GRAYA on insert -- this asks for the right type up
    front rather than lean on that)."""
    base = img.get_base_type()
    layer_type = _LAYER_CAPABLE_BASE_TYPES.get(base)
    if layer_type is None:
        raise ValueError(
            'gimp_layer op=create does not support %s images -- only RGB and grayscale' % base.value_nick
        )
    return layer_type


# `Gimp.FillType` has no BLACK member (verified live: WHITE, TRANSPARENT, FOREGROUND, BACKGROUND,
# PATTERN, CIELAB_MIDDLE_GRAY only) -- FOREGROUND/BACKGROUND are whatever color the session's
# ambient context happens to hold, not reliably black, so a black fill is done by pushing the
# context, setting the foreground to an explicit black, filling with FOREGROUND, and popping the
# context back -- the same push/pop bracket `op_create_mask` already uses around its own context
# changes. Module-level so a typo'd enum member here fails at import time, not on the first call
# that happens to hit it.
_LAYER_FILL_TYPES = {'white': Gimp.FillType.WHITE, 'transparent': Gimp.FillType.TRANSPARENT}


def _fill_new_layer(layer, fill):
    # `Drawable.fill()` reports failure by returning False rather than raising (the same "calling
    # error returns False" class `op_open`'s own `convert_precision` comment documents, verified
    # live for this call too) -- checked here so a failed fill is never silently reported as
    # success with the layer left at whatever undefined content `Layer.new` gave it.
    if fill == 'black':
        Gimp.context_push()
        try:
            Gimp.context_set_foreground(Gegl.Color.new('black'))
            ok = layer.fill(Gimp.FillType.FOREGROUND)
        finally:
            Gimp.context_pop()
    else:
        ok = layer.fill(_LAYER_FILL_TYPES[fill])
    if not ok:
        raise lib.OpError('gimp_op_failed', 'GIMP could not fill the new layer with %s' % fill)


def _op_layer_create(img, args):
    # Every field is validated BEFORE any GIMP mutation runs, and the whole insert+fill sequence
    # is one try/finally: a failure partway through must still drop the proxy cache (something may
    # already have changed) and must not leave an orphaned, half-inserted layer object behind.
    name = _unique_layer_name(img, args.get('name') or 'Layer')
    width = int(args['width']) if args.get('width') is not None else img.get_width()
    height = int(args['height']) if args.get('height') is not None else img.get_height()
    width, height = lib.validate_resize_dims(width, height)
    fill = lib.validate_choice('fill', args.get('fill', 'transparent'), lib.LAYER_FILLS)
    parent = _resolve_parent_group(img, args)
    position = _validated_position(args)
    layer_type = _layer_type_for(img)
    layer = Gimp.Layer.new(img, name, width, height, layer_type, 100.0, Gimp.LayerMode.NORMAL)
    try:
        img.insert_layer(layer, parent, position)
        _assert_layer_attached(img, layer, 'the new layer')
        _fill_new_layer(layer, fill)
    except Exception:
        _discard_layer(img, layer)
        raise
    finally:
        _drop_proxies(img.get_id())
    return {'layer_id': layer.get_id(), 'name': layer.get_name(), 'is_group': False}


def _op_layer_create_group(img, args):
    name = _unique_layer_name(img, args.get('name') or 'Group')
    parent = _resolve_parent_group(img, args)
    position = _validated_position(args)
    group = Gimp.GroupLayer.new(img, name)
    try:
        img.insert_layer(group, parent, position)
        _assert_layer_attached(img, group, 'the new group')
    except Exception:
        _discard_layer(img, group)
        raise
    finally:
        _drop_proxies(img.get_id())
    return {'layer_id': group.get_id(), 'name': group.get_name(), 'is_group': True}


def _op_layer_delete(img, args):
    layer = _layer(img, args)
    subtree = _layer_subtree(layer)
    removed_drawables = sum(1 for l in subtree if not l.is_group())
    total_drawables = sum(1 for l in _all_layers(img) if not l.is_group())
    if total_drawables - removed_drawables <= 0:
        raise ValueError(
            'cannot delete %r: it is (or contains) every remaining layer in this image -- an '
            'image needs at least one' % layer.get_name()
        )
    layer_id, name = layer.get_id(), layer.get_name()
    try:
        img.remove_layer(layer)
        if any(l.get_id() == layer_id for l in _all_layers(img)):
            raise lib.OpError('gimp_op_failed', 'GIMP did not remove this layer')
    finally:
        _prune_stale_ledger_records(img)
        _drop_proxies(img.get_id())
    return {'layer_id': layer_id, 'name': name, 'deleted': True}


def _op_layer_duplicate(img, args):
    layer = _layer(img, args)
    ledgered = _ledgered_filter_names_on(img, _layer_subtree(layer))
    if ledgered:
        raise ValueError(
            'cannot duplicate %r: it carries Editmamei filter(s) %s. GIMP has no way to rename a '
            "copied filter in this build (DrawableFilter.set_name does not exist), and the ledger "
            "is keyed by filter name, so the copy's filter would silently rewrite the original's "
            'own record the next time either is re-edited. Bake it first (gimp_bake) or delete it, '
            'then duplicate.' % (layer.get_name(), ', '.join(repr(n) for n in sorted(set(ledgered))))
        )
    copy = layer.copy()
    if copy is None:
        raise lib.OpError('gimp_op_failed', 'GIMP could not duplicate this layer')
    try:
        copy.set_name(_unique_layer_name(img, layer.get_name()))
        parent = layer.get_parent()
        position = _sibling_index(layer, parent)
        img.insert_layer(copy, parent, position if position is not None else 0)
        _assert_layer_attached(img, copy, 'the duplicated layer')
    except Exception:
        _discard_layer(img, copy)
        raise
    finally:
        _drop_proxies(img.get_id())
    return {'layer_id': copy.get_id(), 'name': copy.get_name(), 'is_group': copy.is_group()}


def _op_layer_select(img, args):
    # The one sub-op that changes neither pixels nor structure -- deliberately does NOT drop
    # proxies (see the PROXIES cache's own comment).
    layer = _layer(img, args)
    img.set_selected_layers([layer])
    return {'layer_id': layer.get_id(), 'name': layer.get_name()}


def _op_layer_set(img, args):
    layer = _layer(img, args)
    # Every field is validated FIRST, before any setter runs at all: a later field failing
    # validation must never leave an earlier one already applied with nothing to show for it (no
    # proxy drop, no error).
    to_apply = []
    if args.get('opacity') is not None:
        to_apply.append(('opacity', lib.validate_range('opacity', args['opacity'], 0.0, 100.0)))
    if args.get('mode') is not None:
        to_apply.append(('mode', lib.validate_layer_mode(args['mode'])))
    if 'visible' in args and args['visible'] is not None:
        to_apply.append(('visible', lib.require_bool(args, 'visible')))
    if args.get('name') is not None:
        new_name = str(args['name']).strip()
        if not new_name:
            raise ValueError('name must not be empty')
        to_apply.append(('name', _unique_layer_name(img, new_name, exclude=layer)))
    if not to_apply:
        raise ValueError('set needs at least one of opacity, mode, visible, name')

    changed = {}
    try:
        for field, value in to_apply:
            if field == 'opacity':
                layer.set_opacity(value)
            elif field == 'mode':
                layer.set_mode(getattr(Gimp.LayerMode, lib.LAYER_MODES[value]))
            elif field == 'visible':
                layer.set_visible(value)
            else:
                layer.set_name(value)
            changed[field] = value
    finally:
        if changed:
            _drop_proxies(img.get_id())
    return {'layer_id': layer.get_id(), 'name': layer.get_name(), **changed}


def _op_layer_reorder(img, args):
    layer = _layer(img, args)
    parent = _resolve_parent_group(img, args) if 'parent_group' in args else layer.get_parent()
    # GIMP itself only logs a "Gimp-Core-CRITICAL" console assertion for this (verified live) --
    # it does not raise -- so it is checked here explicitly rather than left to that assertion plus
    # the post-hoc `_sibling_index` check below to catch it.
    if parent is not None and any(s.get_id() == parent.get_id() for s in _layer_subtree(layer)):
        raise ValueError('parent_group cannot be the layer itself, or one of its own descendants')
    position = _validated_position(args)
    try:
        img.reorder_item(layer, parent, position)
        if _sibling_index(layer, parent) is None:
            raise lib.OpError('gimp_op_failed', 'GIMP did not reorder this layer')
    finally:
        _drop_proxies(img.get_id())
    return {'layer_id': layer.get_id(), 'parent_group': parent.get_id() if parent is not None else None}


def _op_layer_merge_down(img, args):
    layer = _layer(img, args)
    if layer.is_group():
        raise ValueError(
            'merge_down does not accept a group layer -- move its children out first, or use '
            'flatten to collapse the whole image'
        )
    # Verified live: GIMP's own merge_down silently fails (returns None) when the SOURCE layer's
    # own visibility is off, regardless of the target -- checked explicitly, right after the group
    # check above, so the refusal names the real reason instead of surfacing as a generic
    # gimp_op_failed. An ancestor group being hidden does not trigger this: verified live, GIMP
    # merges two VISIBLE siblings inside a hidden group without complaint, since the merge only
    # ever touches the two layers directly involved.
    if not layer.get_visible():
        raise ValueError(
            'merge_down refuses on the HIDDEN layer %r -- GIMP cannot merge a hidden layer down. '
            'Make it visible first, or use gimp_layer op=delete to drop just that layer instead.'
            % layer.get_name()
        )
    parent = layer.get_parent()
    siblings = list(parent.get_children()) if parent is not None else list(img.get_layers())
    idx = next((i for i, s in enumerate(siblings) if s.get_id() == layer.get_id()), None)
    target = _merge_down_target(siblings, idx) if idx is not None else None
    if target is None:
        raise ValueError(
            'there is no VISIBLE layer below %r to merge into (a hidden layer in between is '
            'skipped, not merged, so it is never a valid target)' % layer.get_name()
        )
    if target.is_group():
        raise ValueError(
            'cannot merge %r into %r: GIMP cannot merge a layer into a group'
            % (layer.get_name(), target.get_name())
        )
    lib.validate_resize_dims(*_union_bbox(layer, target))
    rasterized_text = layer.is_text_layer() or target.is_text_layer()
    try:
        merged = img.merge_down(layer, Gimp.MergeType.EXPAND_AS_NECESSARY)
        if merged is None:
            raise lib.OpError('gimp_op_failed', 'GIMP could not merge this layer down')
    finally:
        _prune_stale_ledger_records(img)
        _drop_proxies(img.get_id())
    return {'layer_id': merged.get_id(), 'name': merged.get_name(), 'rasterized_text': rasterized_text}


def _effectively_visible(layer):
    """Whether `layer` actually renders: its own visible flag AND every ANCESTOR group's own
    visible flag. `Item.get_visible()` reflects only that one item's own checkbox -- a visible
    child of a hidden group renders as invisible (and flatten discards it) exactly like a directly
    hidden layer would."""
    return layer.get_visible() and all(a.get_visible() for a in _layer_ancestors(layer))


def _op_layer_flatten(img, args):
    all_layers = _all_layers(img)
    hidden = [l for l in all_layers if not _effectively_visible(l)]
    discard_hidden = lib.optional_bool(args, 'discard_hidden')
    if hidden and not discard_hidden:
        raise ValueError(
            'flatten would discard %d hidden layer(s) (%s) -- GIMP drops a hidden layer entirely '
            'rather than compositing it in (a layer inside a hidden group counts as hidden too, '
            'even when its own visibility is on). Pass discard_hidden: true to proceed, or make '
            'them visible first.' % (len(hidden), ', '.join(repr(l.get_name()) for l in hidden))
        )
    # Every LAYER hidden -- not just every leaf's content. A visible GROUP whose own content is
    # all hidden (or which has no children at all) never trips this: the group itself is not
    # hidden, and verified live, `Image.flatten()` handles that case fine on its own, producing a
    # single background-colored layer rather than failing -- so nothing extra is needed here for
    # it.
    if len(hidden) == len(all_layers):
        raise ValueError('cannot flatten: every layer is hidden, and flatten needs at least one visible layer')
    rasterized_text = any(l.is_text_layer() and _effectively_visible(l) for l in all_layers)
    discarded_hidden_layers = [{'layer_id': l.get_id(), 'name': l.get_name()} for l in hidden]
    try:
        flat = img.flatten()
        if flat is None:
            raise lib.OpError('gimp_op_failed', 'GIMP could not flatten this image')
    finally:
        _prune_stale_ledger_records(img)
        _drop_proxies(img.get_id())
    return {
        'layer_id': flat.get_id(), 'name': flat.get_name(),
        'rasterized_text': rasterized_text, 'has_alpha': flat.has_alpha(),
        'discarded_hidden_layers': discarded_hidden_layers,
    }


LAYER_OPS = {
    'create': _op_layer_create,
    'create_group': _op_layer_create_group,
    'delete': _op_layer_delete,
    'duplicate': _op_layer_duplicate,
    'select': _op_layer_select,
    'set': _op_layer_set,
    'reorder': _op_layer_reorder,
    'merge_down': _op_layer_merge_down,
    'flatten': _op_layer_flatten,
}


def op_layer(args):
    img = _image(args)
    lop = args.get('op')
    fn = LAYER_OPS.get(lop)
    if fn is None:
        raise ValueError('op must be one of %s' % sorted(LAYER_OPS))
    return fn(img, args)


# ---- gimp_text / gimp_inspect what=fonts ------------------------------------------------------
#
# A text layer stays a live Gimp.TextLayer: text, font, size, colour and justification are
# properties of the layer, re-rendered by GIMP on every change. Sizes are exchanged in points and
# stored in pixels (pt * the image's vertical resolution / 72). A rendered layer past the engine's
# size cap is refused: a new layer is discarded, an edit is rolled back to the previous values.

_JUSTIFICATIONS = {
    'left': Gimp.TextJustification.LEFT,
    'right': Gimp.TextJustification.RIGHT,
    'center': Gimp.TextJustification.CENTER,
    'fill': Gimp.TextJustification.FILL,
}


def _font_list():
    """Every installed font as `{name: Gimp.Font}`. A freshly started GIMP can report an empty
    list while its font cache is still loading, so an empty result is retried briefly."""
    for _ in range(20):
        fonts = Gimp.fonts_get_list('')
        if fonts:
            return {f.get_name(): f for f in fonts}
        time.sleep(0.25)
    raise lib.OpError('gimp_op_failed', 'GIMP reports no installed fonts (the font list is empty)')


def op_fonts(args):
    """`gimp_inspect what=fonts`: installed font names, sorted, optionally narrowed by a
    case-insensitive substring `filter`, capped (`total` counts every match)."""
    flt = args.get('filter')
    if flt is not None and not isinstance(flt, str):
        raise ValueError('filter must be a string')
    installed = list(_font_list())
    names, total = lib.list_fonts(installed, flt)
    return {'fonts': names, 'total': total, 'returned': len(names), 'truncated': len(names) < total,
            'default': lib.pick_default_font(installed)}


def _image_ppi(img):
    ok, _xres, yres = img.get_resolution()
    return yres if ok else None


def _text_font_size_pt(layer):
    size, unit = layer.get_font_size()
    return lib.unit_size_to_pt(
        size, unit.get_id() == Gimp.Unit.pixel().get_id(), unit.get_factor(),
        _image_ppi(layer.get_image()),
    )


def _text_color_rgb(layer):
    r, g, b, _a = layer.get_color().get_rgba()
    return {'red': lib.linear_to_srgb_u8(r), 'green': lib.linear_to_srgb_u8(g),
            'blue': lib.linear_to_srgb_u8(b)}


def _has_markup(layer):
    """Whether the layer's text is stored as markup (per-character styling from the GUI), in
    which case it has no plain text."""
    return bool(layer.get_markup())


def _text_fields(layer):
    """A text layer's own state, in gimp_text's units (points, 0-255 colour, ps_text-style
    alignment names). Shared by `describe`'s layer nodes and gimp_text's results. The text is
    capped for reporting (`text_length` is the full length); a markup layer reports '' with
    `has_markup`."""
    font = layer.get_font()
    has_markup = _has_markup(layer)
    text, length, truncated = lib.text_for_report('' if has_markup else layer.get_text())
    return {
        'text': text,
        'text_length': length,
        'text_truncated': truncated,
        'has_markup': has_markup,
        'font': font.get_name() if font is not None else None,
        'font_size': _text_font_size_pt(layer),
        'color': _text_color_rgb(layer),
        'alignment': lib.alignment_name(layer.get_justification().value_nick),
    }


def _text_record(layer):
    ok, off_x, off_y = layer.get_offsets()
    record = {'layer_id': layer.get_id(), 'name': layer.get_name()}
    record.update(_text_fields(layer))
    ppi = _image_ppi(layer.get_image())
    record['ppi'] = ppi
    record['font_size_px'] = round(_text_size_px(layer), 1)
    record['bounds'] = {
        'x': off_x if ok else None, 'y': off_y if ok else None,
        'width': layer.get_width(), 'height': layer.get_height(),
    }
    return record


def _set_text_color(layer, rgb):
    color = Gegl.Color.new('black')
    color.set_rgba(lib.srgb_u8_to_linear(rgb[0]), lib.srgb_u8_to_linear(rgb[1]),
                   lib.srgb_u8_to_linear(rgb[2]), 1.0)
    layer.set_color(color)


_TEXT_PROBE_PX = 8.0


def _check_estimated_text_size(text, font, size_px, img, layer=None):
    """Refuse text that would render past the size cap BEFORE rendering it at full size: lay it
    out once on a throwaway layer at a tiny size and scale the measured extent up (with headroom,
    plus `layer`'s own letter/line spacing and indent, which do not scale), so an absurd request
    never makes GIMP allocate and draw an enormous layer just to be refused. Fails closed: when
    no estimate can be made, the request is refused."""
    if font is None:
        font = _resolved_font(_font_list(), None)
    probe = Gimp.TextLayer.new(img, text, font, _TEXT_PROBE_PX, Gimp.Unit.pixel())
    if probe is None:
        raise lib.OpError('gimp_op_failed', 'GIMP could not lay out the text to check its size')
    try:
        spacing = {}
        if layer is not None:
            spacing = {
                'letter_spacing': layer.get_letter_spacing(),
                'line_spacing': layer.get_line_spacing(),
                'indent': layer.get_indent(),
            }
        width, height = lib.estimate_text_extent(
            probe.get_width(), probe.get_height(), _TEXT_PROBE_PX, size_px,
            chars=len(text), lines=text.count('\n') + 1, **spacing
        )
    finally:
        probe.delete()
    lib.check_estimated_text_size(width, height)


def _text_size_px(layer):
    """The layer's font size in pixels, whichever unit it is stored in."""
    size, unit = layer.get_font_size()
    if unit.get_id() == Gimp.Unit.pixel().get_id():
        return size
    return lib.pt_to_px(_text_font_size_pt(layer), _image_ppi(layer.get_image()))


def _text_state(layer):
    return {
        'text': layer.get_text(), 'font': layer.get_font(), 'size': layer.get_font_size(),
        'color': layer.get_color(), 'justification': layer.get_justification(),
    }


def _same_size(a, b):
    return a[0] == b[0] and a[1].get_id() == b[1].get_id()


def _text_restore(layer, state):
    """Best-effort rollback to a `_text_state` snapshot, touching only what changed (each setter
    re-renders the layer). When the size grew it is restored first, so the font and text go back
    at the smaller size. Never raises (it runs while the original failure is propagating)."""
    try:
        current_font = layer.get_font()
        size_changed = not _same_size(layer.get_font_size(), state['size'])
        shrink_first = size_changed and _text_size_px(layer) > _size_px_of(layer, state['size'])
        if shrink_first:
            layer.set_font_size(state['size'][0], state['size'][1])
        if state['font'] is not None and (
            current_font is None or current_font.get_name() != state['font'].get_name()
        ):
            layer.set_font(state['font'])
        if state['text'] is not None and layer.get_text() != state['text']:
            layer.set_text(state['text'])
        if size_changed and not shrink_first:
            layer.set_font_size(state['size'][0], state['size'][1])
        layer.set_color(state['color'])
        if layer.get_justification() != state['justification']:
            layer.set_justification(state['justification'])
    except Exception:
        pass


def _size_px_of(layer, size):
    """A stored (value, unit) font size in pixels."""
    value, unit = size
    if unit.get_id() == Gimp.Unit.pixel().get_id():
        return value
    pt = lib.unit_size_to_pt(value, False, unit.get_factor(), _image_ppi(layer.get_image()))
    return lib.pt_to_px(pt, _image_ppi(layer.get_image()))


def _resolved_font(fonts, font_name):
    if font_name is None:
        return fonts[lib.pick_default_font(list(fonts))]
    name, _how = lib.resolve_font(font_name, list(fonts))
    return fonts[name]


def _op_text_create(img, args):
    text = lib.validate_text_content(lib.require(args, 'text'))
    size_pt = lib.validate_font_size_pt(args.get('font_size', lib.TEXT_DEFAULT_FONT_PT))
    x = int(args.get('x', 100))
    y = int(args.get('y', 100))
    _validated_move_offset(img, x, y)
    rgb = lib.validate_text_rgb(args)
    justification = None
    if args.get('alignment') is not None:
        justification = _JUSTIFICATIONS[lib.justification_nick(args['alignment'])]
    _layer_type_for(img)  # refuses image modes a text layer cannot be added to (indexed)
    font = _resolved_font(_font_list(), args.get('font_name'))
    size_px = lib.pt_to_px(size_pt, _image_ppi(img))
    _check_estimated_text_size(text, font, size_px, img)
    layer = Gimp.TextLayer.new(img, text, font, size_px, Gimp.Unit.pixel())
    if layer is None:
        raise lib.OpError('gimp_op_failed', 'GIMP could not create the text layer')
    try:
        img.insert_layer(layer, None, 0)
        _assert_layer_attached(img, layer, 'the new text layer')
        # Colour and justification only take effect once the layer is in the image.
        if rgb is not None:
            _set_text_color(layer, rgb)
        if justification is not None:
            layer.set_justification(justification)
        lib.check_text_layer_size(layer.get_width(), layer.get_height())
        layer.set_offsets(x, y)
        record = _text_record(layer)
    except Exception:
        _discard_layer(img, layer)
        raise
    finally:
        _drop_proxies(img.get_id())
    return record


def _text_target(img, args):
    layer = _layer(img, args)
    if not layer.is_text_layer():
        raise ValueError(
            'layer %r is not a text layer; address a text layer by layer_id (gimp_inspect '
            'what=layers flags them with is_text_layer)' % layer.get_name()
        )
    if _has_markup(layer):
        raise ValueError(
            'layer %r has per-character styling (markup), which gimp_text cannot edit without '
            'losing it; create a new text layer instead' % layer.get_name()
        )
    return layer


def _op_text_edit(img, args, apply_fn, precheck_fn=None):
    """Run `apply_fn(layer)` on the targeted text layer. `precheck_fn(layer)` runs first, before
    anything changes, so a refusal there costs no re-render. On any failure in `apply_fn`, or if
    the re-rendered layer is past the size cap, restore the previous values and re-raise."""
    layer = _text_target(img, args)
    if precheck_fn is not None:
        precheck_fn(layer)
    state = _text_state(layer)
    try:
        apply_fn(layer)
        lib.check_text_layer_size(layer.get_width(), layer.get_height())
    except Exception:
        _text_restore(layer, state)
        raise
    finally:
        _drop_proxies(img.get_id())
    return _text_record(layer)


def _op_text_set_content(img, args):
    text = lib.validate_text_content(lib.require(args, 'text'))
    return _op_text_edit(
        img, args, lambda layer: layer.set_text(text),
        precheck_fn=lambda layer: _check_estimated_text_size(
            text, layer.get_font(), _text_size_px(layer), img, layer),
    )


def _op_text_set_font(img, args):
    font_name = lib.require(args, 'font_name')
    size_pt = lib.validate_font_size_pt(args['font_size']) if args.get('font_size') is not None else None
    font = _resolved_font(_font_list(), font_name)
    new_size_px = lib.pt_to_px(size_pt, _image_ppi(img)) if size_pt is not None else None

    def precheck_fn(layer):
        size_px = new_size_px if new_size_px is not None else _text_size_px(layer)
        _check_estimated_text_size(layer.get_text(), font, size_px, img, layer)

    def apply_fn(layer):
        # Shrinking: size first, so the new font never renders at the larger old size.
        if new_size_px is not None and new_size_px < _text_size_px(layer):
            layer.set_font_size(new_size_px, Gimp.Unit.pixel())
            layer.set_font(font)
        else:
            layer.set_font(font)
            if new_size_px is not None:
                layer.set_font_size(new_size_px, Gimp.Unit.pixel())

    return _op_text_edit(img, args, apply_fn, precheck_fn=precheck_fn)


def _op_text_set_color(img, args):
    rgb = lib.validate_text_rgb(args)
    if rgb is None:
        raise ValueError('red, green and blue are required')
    return _op_text_edit(img, args, lambda layer: _set_text_color(layer, rgb))


def _op_text_set_alignment(img, args):
    justification = _JUSTIFICATIONS[lib.justification_nick(lib.require(args, 'alignment'))]
    return _op_text_edit(img, args, lambda layer: layer.set_justification(justification))


TEXT_OPS = {
    'create': _op_text_create,
    'set_content': _op_text_set_content,
    'set_font': _op_text_set_font,
    'set_color': _op_text_set_color,
    'set_alignment': _op_text_set_alignment,
}


def op_text(args):
    img = _image(args)
    top = args.get('op')
    fn = TEXT_OPS.get(top)
    if fn is None:
        raise ValueError('op must be one of %s' % sorted(TEXT_OPS))
    return fn(img, args)


# ---- gimp_bake --------------------------------------------------------------------------------


def _bake_one(layer):
    """Bake every live filter on `layer` into its own pixels via `Drawable.merge_filters()` --
    probed live (GIMP 3.2.6) and confirmed correct even for a masked filter (its confinement
    survives into the baked pixels exactly), and confirmed NOT to rasterize a text layer (it stays
    a text layer, filters gone). Returns False (a no-op, not an error) for a layer with no filters.
    Raises for a group layer: verified live that GIMP accepts the call but silently does nothing (a
    console \"Calling error ... cannot be modified because it is a group item\", no Python
    exception, no filters removed) -- the same "returned without raising, but didn't do it" failure
    class `_assert_layer_attached`'s own comment names, so this is refused up front rather than
    reported as a silent success."""
    if layer.is_group():
        raise ValueError(
            'layer %r is a group; bake targets individual layers, not groups -- GIMP has no way to '
            'merge filters on a group item' % layer.get_name()
        )
    if not layer.get_filters():
        return False
    layer.merge_filters()
    if layer.get_filters():
        raise lib.OpError('gimp_op_failed', 'GIMP did not bake every filter on layer %r' % layer.get_name())
    return True


def op_bake(args):
    """`layer_id`/`layer` bakes one layer (defaulting to the selected/topmost layer, same as any
    other `_layer` call, when neither is given); `all: true` bakes every non-group layer on the
    image that has any live filters. A group layer can legitimately carry its own filter (verified
    live), but GIMP cannot bake one -- `all: true` reports any such group under
    `skipped_groups_with_filters` rather than silently ignoring it; a single-target `bake` on a
    group is refused outright (`_bake_one`). Either way, baked filters' ledger records are pruned
    (`_prune_stale_ledger_records`, the same generic staleness sweep every other structural op
    relies on) and the proxy cache is dropped -- both in a `finally`, so a failure partway through
    `all: true` still leaves the ledger and proxy consistent with whatever DID get baked. Baking a
    layer's masked filter also clears it from the next geometry op's refusal check for free:
    `_refuse_if_masked_filters`/`_refuse_if_masked_filters_on` only ever look at LIVE filters, and
    baking leaves none behind."""
    img = _image(args)
    if lib.optional_bool(args, 'all'):
        baked = []
        skipped_groups_with_filters = []
        try:
            for layer in _all_layers(img):
                if layer.is_group():
                    if layer.get_filters():
                        skipped_groups_with_filters.append(
                            {'layer_id': layer.get_id(), 'name': layer.get_name()}
                        )
                    continue
                if not layer.get_filters():
                    continue
                _bake_one(layer)
                baked.append({'layer_id': layer.get_id(), 'name': layer.get_name()})
        finally:
            _prune_stale_ledger_records(img)
            _drop_proxies(img.get_id())
        return {'baked_layers': baked, 'skipped_groups_with_filters': skipped_groups_with_filters}
    layer = _layer(img, args)
    try:
        baked = _bake_one(layer)
    finally:
        _prune_stale_ledger_records(img)
        _drop_proxies(img.get_id())
    return {'layer_id': layer.get_id(), 'name': layer.get_name(), 'baked': baked}


# ---- document composition (gimp_create_document / gimp_place_image / gimp_canvas /
# gimp_convert_image_mode) -----------------------------------------------------------------
#
# Verified live (GIMP 3.2.6):
#   - `Gimp.Image.resize(width, height, offx, offy)` is the canvas-resize primitive `op_crop`'s
#     own `Image.crop` already wraps for the shrink direction; called directly here for the grow
#     direction it also supports. It repositions every existing layer by ADDING (offx, offy) to
#     that layer's own current offset -- layer CONTENT and size are untouched, only where it sits
#     in the (now larger) canvas moves.
#   - That repositioning is exactly the "layer moves, its own pixels don't" case
#     `_refuse_if_masked_filters`'s own comment already documents for rotate/flip/resize: a masked
#     filter's confinement is a fixed snapshot that does NOT travel with a moving layer (verified
#     live with a rectangle-masked brightness-contrast filter on the right half of a layer --
#     after growing the canvas on the left, the darkened region stayed at the OLD absolute pixel
#     positions, not the layer's new ones) -- `gimp_canvas` therefore refuses under the same
#     conditions `resize`/`rotate`/`flip` do. An UNMASKED effect filter (vignette, motion_blur,
#     drop_shadow) is unaffected: its own params key off the LAYER's own unchanged extent, never
#     the image/canvas, so no transform-tracking table entry is needed here the way rotate/resize
#     need one for those.
#   - `Gimp.FillType` has no BLACK (see `_fill_new_layer`'s own comment); a hex fill goes through
#     the same context-push/foreground/pop bracket.
#   - `Gimp.file_load_layer(run_mode, image, file)` returns an UNATTACHED layer (an explicit
#     `image.insert_layer` is still required -- verified live: the loaded layer is not a member of
#     `image.get_layers()` until that call, even though `layer.get_image()` already answers
#     non-None before it) already converted to `image`'s own base type at LOAD time, before that
#     insert -- verified both directions (a grayscale source loaded into an RGB target reports
#     `rgb-image` even before insert; an RGB source into a grayscale target reports `gray-image`
#     after). Loading into a HIGHER-precision (16/32-bit) target succeeds with no error either.
#     Placing a file carrying its own metadata (EXIF/XMP) does not attach anything to the TARGET
#     image's own metadata -- verified with a real GPS-bearing source. Given a MULTI-layer source
#     (e.g. a `.xcf`), only ONE layer comes back -- GIMP's own choice, not a flattened composite of
#     the whole file -- and that ONE layer's own LIVE FILTERS come with it (verified live: a
#     brightness-contrast filter on the source's layer is present on the loaded, still-unattached
#     layer too, `Drawable.merge_filters()` bakes it there cleanly even before insert, and a
#     SAME-NAMED filter already on the target's own, unrelated layer is provably untouched by the
#     bake) -- `op_place_image` always bakes before inserting, so a placed layer is never a
#     ledger-name-collision risk the way `gimp_layer op=duplicate` guards against for a copy.
#   - Inserting a NEW layer changes the image's own SELECTED layer to it -- verified live (a layer
#     explicitly selected beforehand is no longer selected once a different layer is inserted) --
#     which is why a failure after `insert_layer` restores the pre-call selection explicitly rather
#     than assuming discarding the newly-inserted layer alone leaves everything as it was.
#   - `Item.scale(width, height, local_origin)` resizes just that one layer; called here while its
#     offset is still whatever `file_load_layer` gave it (verified: local_origin's own effect on
#     the resulting offset only matters when the pre-scale offset is non-zero), and the caller's
#     `x`/`y` are applied afterward via the same absolute `set_offsets` call every layer-move op
#     in this bridge uses -- so the requested position is always exact regardless of
#     local_origin's own math. Both
#     `Drawable.scale()` and `Drawable.fill()` report failure by returning `False` rather than
#     raising (the same class `op_open`'s own `convert_precision` comment documents) -- checked
#     everywhere this file calls either, including the pre-existing `_fill_new_layer` shared with
#     `gimp_layer op=create`.
#   - `Gimp.Image.convert_rgb()` / `convert_grayscale()` exist; calling one when the image is
#     ALREADY that base type is the same "calling error returns False, doesn't raise" class
#     `op_open`'s own `convert_precision` comment documents, which is why `op_convert_image_mode`
#     checks the current base type itself first rather than relying on that return value to tell
#     the two cases apart.
#   - `fill: transparent`'s "no fill layer" is only genuinely transparent in a LIVE, layered
#     document (e.g. saved via `gimp_save_xcf`) -- verified live that both `Image.flatten()`
#     (`gimp_layer op=flatten`) and `_composite`'s own flatten (every `gimp_export`) fill any
#     transparent area with GIMP's ambient BACKGROUND context color (white, unmodified here) and
#     drop alpha entirely, not with transparency. A PNG exported WITHOUT going through that flatten
#     path (this bridge always does, via `_composite`) would keep the padding genuinely
#     transparent, but that route is not one `gimp_export` takes -- the tool description says so.


def op_create_document(args):
    precision = args.get('precision')
    if precision is not None and precision not in ('16', '32'):
        raise ValueError("precision must be one of '16', '32'")
    # The megapixel ceiling is precision-aware (`lib.DOCUMENT_MEGAPIXEL_CAP`) -- a 16/32-bit
    # request costs 2x/4x the memory of the same pixel count at 8-bit, so it gets a
    # correspondingly lower cap rather than the plain 8-bit-assuming `validate_resize_dims`.
    width, height = lib.validate_document_dims(
        int(lib.require(args, 'width')), int(lib.require(args, 'height')), precision or '8'
    )
    fill = lib.validate_choice('fill', args.get('fill', 'white'), lib.LAYER_FILLS)
    mode = lib.validate_choice('mode', args.get('mode', 'rgb'), lib.IMAGE_MODES)
    name = args.get('name') or 'Background'
    base_type = Gimp.ImageBaseType.RGB if mode == 'rgb' else Gimp.ImageBaseType.GRAY
    img = Gimp.Image.new(width, height, base_type)
    try:
        if precision is not None:
            if not img.convert_precision(_PRECISION_ENUM[precision]):
                raise lib.OpError(
                    'gimp_op_failed',
                    'precision promotion to %r failed for a new %s image' % (precision, mode),
                )
        layer = Gimp.Layer.new(img, name, width, height, _layer_type_for(img), 100.0, Gimp.LayerMode.NORMAL)
        img.insert_layer(layer, None, 0)
        _assert_layer_attached(img, layer, 'the background layer')
        _fill_new_layer(layer, fill)
        Gimp.Selection.none(img)
        _proxy(img, 1024)  # see op_open: build the default preview proxy up front too
    except Exception:
        img.delete()
        raise
    return _describe(img)


def _path_free_detail(detail):
    """A GIMP- or Python-supplied error detail, made safe to surface -- DROPPED ENTIRELY (not
    redacted in place) when it contains anything that looks like a filesystem path (a `/` or `\\`
    separator) or a `file:` URI scheme. Unlike `_export_stripped`'s rewrite, which only ever has to
    erase the ONE exact path spelling this bridge itself passed in, a detail string coming back
    from GIMP or a raised Python exception could quote the caller's path in any number of
    normalizations (forward slash, backslash, a `file://` URI, a different case) -- there is no
    substitution list that could cover all of them, so this refuses to guess and drops the whole
    detail instead. Returns '' (nothing to append) when unsafe or absent; otherwise ' (<detail>)',
    ready to append directly to a message."""
    if not detail or '/' in detail or '\\' in detail or 'file:' in detail:
        return ''
    return ' (%s)' % detail


def op_place_image(args):
    # `requireAbsoluteGimpPath` (the tool layer) is unchanged by this discipline: it only
    # validates and echoes back the CALLER'S OWN `file_path` value, the same as every other gimp_*
    # path argument (including community-tier ones) -- it never adds a path the caller didn't
    # already send. What changed here is this op's OWN messages: every one is built from
    # `basename` only, and any further detail GIMP or Python supplies is passed through
    # `_path_free_detail`, which drops it outright rather than trying to redact it, if it looks
    # like it might carry a path of its own.
    img = _image(args)
    path = lib.require(args, 'path')
    basename = os.path.basename(path)
    if not os.path.exists(path):
        raise FileNotFoundError('no file named %s to place' % basename)
    ext = os.path.splitext(path)[1].lower()
    load_error = None
    try:
        loaded = Gimp.file_load_layer(Gimp.RunMode.NONINTERACTIVE, img, Gio.File.new_for_path(path))
    except Exception as e:
        loaded = None
        load_error = str(e)
    # A failed load does not always raise: verified live, an unreadable raw-extension file with no
    # loader plug-in installed makes `file_load_layer` return `None` outright (the same "returned
    # normally having silently done nothing" class `_assert_layer_attached`'s own comment names),
    # not raise -- so the raw/no-loader reframing below has to cover BOTH `loaded is None` and a
    # real exception, not just the exception case `op_open`'s own analogous try/except assumes is
    # the only failure shape.
    if loaded is None:
        detail = _path_free_detail(load_error)
        if ext in RAW_EXTENSIONS:
            raise lib.OpError(
                'gimp_unsupported_file',
                'GIMP could not load %s as a layer (no raw loader by default); install a '
                'raw-develop plug-in (darktable, RawTherapee, or ART) for GIMP, or develop it '
                'externally first and place the resulting JPEG/TIFF.%s' % (basename, detail),
            )
        raise lib.OpError('gimp_op_failed', 'could not load %s as a layer%s' % (basename, detail))

    # Everything below either fully succeeds or leaves `img` exactly as it was: every field is
    # validated (and, for width/height, resolved against the loaded layer's OWN natural size)
    # BEFORE `insert_layer` ever runs, and the SELECTED layer is restored on any failure --
    # `insert_layer` changes the image's own selection as a side effect (verified live), even for
    # an insert that is about to be undone.
    original_selection = img.get_selected_layers()
    baked_filters = []
    try:
        # The DoS floor applies to the SOURCE file's own size too; checked before any rotation
        # (it is symmetric in width and height, so the upright size passes or fails alike).
        lib.validate_resize_dims(loaded.get_width(), loaded.get_height())
        orientation_applied, _md = _file_orientation(path, ext)
        if orientation_applied is not None:
            _upright_placed_layer(loaded, orientation_applied)
        w0, h0 = loaded.get_width(), loaded.get_height()

        width, height = args.get('width'), args.get('height')
        if width is not None or height is not None:
            if width is not None and height is not None:
                width, height = int(width), int(height)
            elif width is not None:
                width = int(width)
                height = max(1, round(h0 * (width / float(w0))))
            else:
                height = int(height)
                width = max(1, round(w0 * (height / float(h0))))
            width, height = lib.validate_resize_dims(width, height)
        else:
            width, height = w0, h0

        x, y = int(args.get('x', 0)), int(args.get('y', 0))
        _validated_move_offset(img, x, y)

        default_name = os.path.splitext(basename)[0] or 'Layer'
        name = _unique_layer_name(img, args.get('name') or default_name)
        parent = _resolve_parent_group(img, args)
        position = _validated_position(args)

        # `file_load_layer` on a multi-layer `.xcf` source carries that ONE layer's own live
        # filters onto the loaded (still unattached) layer -- verified live. Baked here, BEFORE
        # insert, so the placed layer always lands as plain pixels: the ledger this bridge writes
        # lives in the TARGET image's own parasite and is keyed by filter NAME, so an unbaked
        # filter could silently collide with (and get overwritten by, or overwrite) an existing
        # target filter that happens to share its name -- baking first means there is never a
        # filter object left on the placed layer for that collision to happen to.
        if loaded.get_filters():
            baked_filters = [f.get_name() for f in loaded.get_filters()]
            loaded.merge_filters()
            if loaded.get_filters():
                raise lib.OpError(
                    'gimp_op_failed', "could not bake the placed layer's own live filter(s)"
                )

        loaded.set_name(name)
        img.insert_layer(loaded, parent, position)
        _assert_layer_attached(img, loaded, 'the placed layer')

        if (width, height) != (w0, h0):
            if not loaded.scale(width, height, False):
                raise lib.OpError('gimp_op_failed', 'GIMP could not scale the placed layer')
        loaded.set_offsets(x, y)
    except Exception:
        img.set_selected_layers(original_selection)
        _discard_layer(img, loaded)
        raise
    finally:
        _drop_proxies(img.get_id())
    ok, off_x, off_y = loaded.get_offsets()
    result = {
        'layer_id': loaded.get_id(),
        'name': loaded.get_name(),
        'width': loaded.get_width(),
        'height': loaded.get_height(),
        'x': off_x if ok else None,
        'y': off_y if ok else None,
        'parent_group': parent.get_id() if parent is not None else None,
    }
    if baked_filters:
        result['baked_filters'] = baked_filters
    if orientation_applied is not None:
        result['orientation_applied'] = orientation_applied
    return result


def _fill_canvas_layer(layer, fill):
    if fill in lib.LAYER_FILLS:
        _fill_new_layer(layer, fill)  # white/black -- reuses the same push/pop-context bracket
        return                        # and the same fill()-return-value check ('transparent'
                                       # never reaches here -- op_canvas skips the layer entirely)
    # Otherwise `fill` is a validated '#rrggbb' hex string. On a GRAYSCALE image, filling with an
    # RGB foreground color converts to that color's LUMINANCE (verified live: '#336699' -> gray
    # level 98, matching neither the R, G, nor B channel alone but their weighted luminance) --
    # the same automatic base-type coercion `_layer_type_for`'s own comment documents for a plain
    # layer insert, applied here by GIMP's own fill implementation instead.
    Gimp.context_push()
    try:
        Gimp.context_set_foreground(Gegl.Color.new(fill))
        ok = layer.fill(Gimp.FillType.FOREGROUND)
    finally:
        Gimp.context_pop()
    if not ok:
        raise lib.OpError('gimp_op_failed', 'GIMP could not fill the canvas backdrop layer')


def op_canvas(args):
    img = _image(args)
    old_w, old_h = img.get_width(), img.get_height()
    new_w, new_h = int(lib.require(args, 'width')), int(lib.require(args, 'height'))
    if new_w < old_w or new_h < old_h:
        raise ValueError(
            'gimp_canvas only extends the canvas: %dx%d is smaller than the current %dx%d in at '
            'least one dimension -- use gimp_crop_document to shrink it instead'
            % (new_w, new_h, old_w, old_h)
        )
    if new_w == old_w and new_h == old_h:
        raise ValueError(
            'gimp_canvas needs a target that grows at least one dimension -- %dx%d is the '
            'current size already' % (old_w, old_h)
        )
    new_w, new_h = lib.validate_resize_dims(new_w, new_h)
    fill = lib.validate_canvas_fill(args.get('fill', 'transparent'))
    # Checked before anything mutates: a non-transparent fill needs a backdrop layer, and
    # `_LAYER_CAPABLE_BASE_TYPES` (the same allow-list `_layer_type_for` reads) only covers
    # RGB/GRAY -- refusing here keeps the canvas untouched, rather than committing the resize and
    # only then discovering the backdrop layer can't be created.
    if fill != 'transparent' and img.get_base_type() not in _LAYER_CAPABLE_BASE_TYPES:
        raise ValueError(
            'gimp_canvas cannot add a %s backdrop layer to an image of type %s -- only RGB and grayscale '
            'support a non-transparent fill; use fill=transparent instead'
            % (fill, img.get_base_type().value_nick)
        )
    anchor = args.get('anchor')
    has_explicit_offset = 'offset_x' in args or 'offset_y' in args
    if has_explicit_offset and anchor is not None:
        raise ValueError('give either anchor or offset_x/offset_y, not both')
    if has_explicit_offset:
        offset_x, offset_y = int(lib.require(args, 'offset_x')), int(lib.require(args, 'offset_y'))
    else:
        offset_x, offset_y = lib.canvas_anchor_offset(anchor or 'center', old_w, old_h, new_w, new_h)
    if not (0 <= offset_x <= new_w - old_w) or not (0 <= offset_y <= new_h - old_h):
        raise ValueError(
            'offset_x/offset_y must keep the existing %dx%d content fully within the new %dx%d '
            'canvas: 0..%d for offset_x, 0..%d for offset_y'
            % (old_w, old_h, new_w, new_h, new_w - old_w, new_h - old_h)
        )
    # Checked only once the ACTUAL offset is known, and skipped entirely at (0, 0): a masked
    # filter's confinement is a fixed snapshot of the existing content's position, and content that
    # does not move at all (top-left anchor, or an explicit offset_x/offset_y of 0/0) cannot
    # misalign it -- refusing here anyway would block the single most common gimp_canvas call
    # (extend to the bottom-right) for no real reason.
    if (offset_x, offset_y) != (0, 0):
        _refuse_if_masked_filters(img, 'canvas', before_hint='Extend the canvas')
    Gimp.Selection.none(img)  # see op_open: geometry always applies to the whole canvas
    try:
        img.resize(new_w, new_h, offset_x, offset_y)
        if (img.get_width(), img.get_height()) != (new_w, new_h):
            raise lib.OpError(
                'gimp_op_failed',
                'GIMP did not resize the canvas to %dx%d (now %dx%d)'
                % (new_w, new_h, img.get_width(), img.get_height()),
            )
        if fill != 'transparent':
            name = _unique_layer_name(img, 'Canvas Fill')
            layer = Gimp.Layer.new(img, name, new_w, new_h, _layer_type_for(img), 100.0, Gimp.LayerMode.NORMAL)
            try:
                img.insert_layer(layer, None, len(img.get_layers()))  # bottom of the top-level stack
                _assert_layer_attached(img, layer, 'the canvas fill layer')
                _fill_canvas_layer(layer, fill)
            except Exception as e:
                _discard_layer(img, layer)
                # The canvas resize itself already committed and is not undone here (reversing it
                # risks compounding one failure into two) -- the error says so plainly instead.
                raise lib.OpError(
                    'gimp_op_failed',
                    'the canvas was extended to %dx%d, but the %s backdrop layer could not be '
                    'added (%s) -- retry with fill=transparent to skip it, or add a backdrop '
                    'layer manually' % (new_w, new_h, fill, e),
                )
    finally:
        _drop_proxies(img.get_id())
    return {
        'width': img.get_width(), 'height': img.get_height(),
        'offset_x': offset_x, 'offset_y': offset_y,
    }


def op_convert_image_mode(args):
    img = _image(args)
    mode = lib.validate_choice('mode', args.get('mode'), lib.IMAGE_MODES)
    if img.get_base_type() == Gimp.ImageBaseType.INDEXED:
        raise ValueError('gimp_convert_image_mode does not support an indexed image as the source')
    # The no-op check runs BEFORE the live-filter refusal: an image already in the requested mode
    # has nothing for a color-dependent filter to be endangered by, so a live filter must never
    # turn a true no-op into a spurious refusal.
    target_type = Gimp.ImageBaseType.RGB if mode == 'rgb' else Gimp.ImageBaseType.GRAY
    if img.get_base_type() == target_type:
        return {'mode': mode, 'converted': False}
    live_filters = _live_filter_names(img)
    if live_filters:
        raise ValueError(
            'gimp_convert_image_mode refuses while any live filter is present (%s): a '
            'color-dependent filter could change meaning across a mode change. Bake it first '
            "(gimp_bake) or delete it (gimp_filter op=delete), then convert."
            % ', '.join(repr(n) for n in sorted(live_filters))
        )
    try:
        ok = img.convert_rgb() if mode == 'rgb' else img.convert_grayscale()
        if not ok:
            raise lib.OpError('gimp_op_failed', 'GIMP could not convert this image to %s' % mode)
    finally:
        _drop_proxies(img.get_id())
    return {'mode': mode, 'converted': True}


# ---- gimp_transform_layer ---------------------------------------------------------------------
#
# A per-LAYER affine transform (fit/scale/move/rotate/flip/skew/free) -- distinct from the
# whole-CANVAS geometry ops above (crop/resize/rotate/flip), which move or resize every layer
# together. Addressed the same way every other gimp_* layer op is (`_layer`): layer_id takes
# priority over layer (name), neither given falls back to the selected layer, or the topmost one.
#
# Verified live (GIMP 3.2.6), the assumptions this section is built on:
#   - `Item.transform_scale`/`transform_rotate`/`transform_flip_simple`/`transform_matrix` all
#     carry the layer's own mask along automatically, repositioned and resized to match the
#     layer's new bounds exactly -- no separate mask transform is needed.
#   - Calling any of these on a GROUP layer transforms the whole group as a unit: every
#     descendant's own offsets and size update too, in lockstep with the group's. No special-
#     casing is needed for a group target.
#   - `Context.transform_resize` set to ADJUST (rather than the default CLIP) is what makes
#     `rotate`/`skew`/`free` grow the layer's own bounding box to its new, larger extent instead
#     of clipping corners that rotate/shear outside the old one -- the same growth
#     `gimp_transform_canvas`'s `expand` gives the whole canvas, but always-on here since a
#     layer (unlike the canvas) has no reason to ever clip its own content.
#   - `Context.interpolation` is read by the transform itself, not passed as an argument to any
#     of the methods above -- set explicitly before every call (never left at whatever a PRIOR
#     call happened to leave it at).
#   - A layer with no alpha channel (e.g. a flattened base layer) would otherwise fill any area
#     a transform exposes outside its old bounds with an opaque background color rather than
#     transparency -- `add_alpha()` first avoids that, for every op, not only ones that grow the
#     bounding box (harmless on one that doesn't need it). Skipped for a group target, which has
#     no pixels of its own to add a channel to.
#   - Refuses outright when the layer (or a containing group) carries a masked or unverifiable
#     adjustment filter -- `_refuse_if_masked_filters_on` (the same scoped check the whole-image
#     geometry ops' own `_refuse_if_masked_filters` is a sibling of); an UNMASKED filter is
#     unaffected and simply moves/scales along with the layer.


def _transform_layer_center(layer):
    ok, x, y = layer.get_offsets()
    return (x if ok else 0) + layer.get_width() / 2.0, (y if ok else 0) + layer.get_height() / 2.0


def _transform_layer_bounds(layer):
    ok, x, y = layer.get_offsets()
    return {
        'x': x if ok else None, 'y': y if ok else None,
        'width': layer.get_width(), 'height': layer.get_height(),
    }


def _set_transform_layer_interpolation(args):
    choice = lib.validate_choice(
        'interpolation', args.get('interpolation', 'cubic'), lib.TRANSFORM_LAYER_INTERPOLATIONS
    )
    Gimp.context_set_interpolation(_INTERPOLATION_ENUM[choice])
    return choice


def _ensure_layer_alpha(layer):
    """Adds an alpha channel to `layer` if it doesn't have one already, UNLESS it's a group (no
    pixels of its own to add a channel to). Returns whether alpha was actually added."""
    if layer.is_group() or layer.has_alpha():
        return False
    if not layer.add_alpha():
        raise lib.OpError('gimp_op_failed', 'GIMP could not add an alpha channel to this layer')
    return True


def _transform_layer_fit(layer, img, args):
    mode = lib.validate_choice('mode', args.get('mode', 'fit'), ('fit', 'fill'))
    w, h = layer.get_width(), layer.get_height()
    fraction = lib.fit_scale_fraction(w, h, img.get_width(), img.get_height(), mode)
    new_w, new_h = w * fraction, h * fraction
    lib.validate_resize_dims(max(1, round(new_w)), max(1, round(new_h)))
    alpha_added = _ensure_layer_alpha(layer)
    x0 = (img.get_width() - new_w) / 2.0
    y0 = (img.get_height() - new_h) / 2.0
    layer.transform_scale(x0, y0, x0 + new_w, y0 + new_h)
    return {'mode': mode, 'scale_percent': round(fraction * 100.0, 6), 'alpha_added': alpha_added}


def _transform_layer_scale(layer, img, args):
    lo, hi = lib.TRANSFORM_LAYER_MIN_SCALE_PERCENT, lib.TRANSFORM_LAYER_MAX_SCALE_PERCENT
    sp = args.get('scale_percent')
    sx_in, sy_in = args.get('scale_x_percent'), args.get('scale_y_percent')
    if sx_in is None and sy_in is None:
        if sp is None:
            raise ValueError('scale requires scale_percent, or scale_x_percent/scale_y_percent')
        sx = sy = lib.validate_range('scale_percent', sp, lo, hi)
    else:
        sx = lib.validate_range('scale_x_percent', sx_in if sx_in is not None else (sp if sp is not None else 100.0), lo, hi)
        sy = lib.validate_range('scale_y_percent', sy_in if sy_in is not None else (sp if sp is not None else 100.0), lo, hi)
    ok, ox, oy = layer.get_offsets()
    w, h = layer.get_width(), layer.get_height()
    new_w, new_h = w * sx / 100.0, h * sy / 100.0
    lib.validate_resize_dims(max(1, round(new_w)), max(1, round(new_h)))
    alpha_added = _ensure_layer_alpha(layer)
    cx, cy = (ox if ok else 0) + w / 2.0, (oy if ok else 0) + h / 2.0
    x0, y0 = cx - new_w / 2.0, cy - new_h / 2.0
    layer.transform_scale(x0, y0, x0 + new_w, y0 + new_h)
    return {'scale_x_percent': sx, 'scale_y_percent': sy, 'alpha_added': alpha_added}


def _transform_layer_move(layer, img, args):
    delta, absolute, center_on = args.get('delta'), args.get('absolute'), args.get('center_on')
    given = [m for m in (delta, absolute, center_on) if m is not None]
    if len(given) == 0:
        raise ValueError('move requires exactly one of delta, absolute, center_on')
    if len(given) > 1:
        raise ValueError('move accepts only ONE of delta, absolute, center_on -- not more than one')
    ok, ox, oy = layer.get_offsets()
    ox, oy = (ox if ok else 0), (oy if ok else 0)
    w, h = layer.get_width(), layer.get_height()
    if delta is not None:
        nx, ny = ox + float(lib.require(delta, 'x')), oy + float(lib.require(delta, 'y'))
    elif absolute is not None:
        nx, ny = float(lib.require(absolute, 'x')), float(lib.require(absolute, 'y'))
    else:
        nx = float(lib.require(center_on, 'x')) - w / 2.0
        ny = float(lib.require(center_on, 'y')) - h / 2.0
    _validated_move_offset(img, nx, ny)
    alpha_added = _ensure_layer_alpha(layer)
    layer.set_offsets(round(nx), round(ny))
    return {'alpha_added': alpha_added}


def _transform_layer_rotate(layer, img, args):
    degrees = float(lib.require(args, 'degrees'))
    if not math.isfinite(degrees):
        raise ValueError('degrees must be finite')
    cx, cy = _transform_layer_center(layer)
    ok, ox, oy = layer.get_offsets()
    w, h = layer.get_width(), layer.get_height()
    matrix = lib.compose_layer_matrix(cx, cy, 100.0, 100.0, degrees, 0.0, 0.0, 0.0, 0.0)
    _, _, new_w, new_h = lib.transformed_bounds(matrix, ox if ok else 0, oy if ok else 0, w, h)
    lib.validate_resize_dims(max(1, round(new_w)), max(1, round(new_h)))
    alpha_added = _ensure_layer_alpha(layer)
    Gimp.context_set_transform_resize(Gimp.TransformResize.ADJUST)
    layer.transform_rotate(math.radians(degrees), True, 0.0, 0.0)
    return {'degrees': degrees, 'alpha_added': alpha_added}


def _transform_layer_flip(layer, img, args):
    axis = args.get('axis')
    if axis not in _FLIP_ORIENTATIONS:
        raise ValueError('axis must be one of %s' % sorted(_FLIP_ORIENTATIONS))
    alpha_added = _ensure_layer_alpha(layer)
    layer.transform_flip_simple(_FLIP_ORIENTATIONS[axis], True, 0.0)
    return {'axis': axis, 'alpha_added': alpha_added}


def _transform_layer_skew(layer, img, args):
    skew_h, skew_v = args.get('skew_h_degrees'), args.get('skew_v_degrees')
    if skew_h is None and skew_v is None:
        raise ValueError('skew requires at least one of skew_h_degrees, skew_v_degrees')
    skew_h = float(skew_h) if skew_h is not None else 0.0
    skew_v = float(skew_v) if skew_v is not None else 0.0
    if not (math.isfinite(skew_h) and math.isfinite(skew_v)):
        raise ValueError('skew_h_degrees/skew_v_degrees must be finite')
    cx, cy = _transform_layer_center(layer)
    ok, ox, oy = layer.get_offsets()
    w, h = layer.get_width(), layer.get_height()
    matrix = lib.compose_layer_matrix(cx, cy, 100.0, 100.0, 0.0, skew_h, skew_v, 0.0, 0.0)
    _, _, new_w, new_h = lib.transformed_bounds(matrix, ox if ok else 0, oy if ok else 0, w, h)
    lib.validate_resize_dims(max(1, round(new_w)), max(1, round(new_h)))
    alpha_added = _ensure_layer_alpha(layer)
    Gimp.context_set_transform_resize(Gimp.TransformResize.ADJUST)
    layer.transform_matrix(*matrix)
    return {'skew_h_degrees': skew_h, 'skew_v_degrees': skew_v, 'alpha_added': alpha_added}


def _transform_layer_free(layer, img, args):
    lo, hi = lib.TRANSFORM_LAYER_MIN_SCALE_PERCENT, lib.TRANSFORM_LAYER_MAX_SCALE_PERCENT
    sx = lib.validate_range('scale_x_percent', args.get('scale_x_percent', 100.0), lo, hi)
    sy = lib.validate_range('scale_y_percent', args.get('scale_y_percent', 100.0), lo, hi)
    degrees = float(args.get('degrees', 0.0))
    offset_x = float(args.get('offset_x', 0.0))
    offset_y = float(args.get('offset_y', 0.0))
    if not (math.isfinite(degrees) and math.isfinite(offset_x) and math.isfinite(offset_y)):
        raise ValueError('degrees/offset_x/offset_y must be finite')
    cx, cy = _transform_layer_center(layer)
    ok, ox, oy = layer.get_offsets()
    w, h = layer.get_width(), layer.get_height()
    matrix = lib.compose_layer_matrix(cx, cy, sx, sy, degrees, 0.0, 0.0, offset_x, offset_y)
    _, _, new_w, new_h = lib.transformed_bounds(matrix, ox if ok else 0, oy if ok else 0, w, h)
    lib.validate_resize_dims(max(1, round(new_w)), max(1, round(new_h)))
    alpha_added = _ensure_layer_alpha(layer)
    Gimp.context_set_transform_resize(Gimp.TransformResize.ADJUST)
    layer.transform_matrix(*matrix)
    return {
        'scale_x_percent': sx, 'scale_y_percent': sy, 'degrees': degrees,
        'offset_x': offset_x, 'offset_y': offset_y, 'alpha_added': alpha_added,
    }


TRANSFORM_LAYER_OPS = {
    'fit': _transform_layer_fit,
    'scale': _transform_layer_scale,
    'move': _transform_layer_move,
    'rotate': _transform_layer_rotate,
    'flip': _transform_layer_flip,
    'skew': _transform_layer_skew,
    'free': _transform_layer_free,
}


def op_transform_layer(args):
    img = _image(args)
    top = args.get('op')
    fn = TRANSFORM_LAYER_OPS.get(top)
    if fn is None:
        raise ValueError('op must be one of %s' % sorted(TRANSFORM_LAYER_OPS))
    layer = _layer(img, args)
    _refuse_if_masked_filters_on(img, top, layer)
    # Interpolation (and, for rotate/skew/free, the ADJUST transform-resize mode) are ambient
    # Context settings the transform methods below read rather than take as arguments -- pushed
    # and popped so this call's choice never leaks into a LATER, unrelated gimp_* call (the same
    # bracket `_fill_new_layer` uses around its own context changes). Each op validates its own
    # arguments and raises BEFORE calling `_ensure_layer_alpha` (own code) or mutating anything,
    # so a rejected call never adds an alpha channel it then goes on to refuse.
    Gimp.context_push()
    try:
        interpolation = _set_transform_layer_interpolation(args)
        extra = fn(layer, img, args)
    finally:
        Gimp.context_pop()
        _drop_proxies(img.get_id())
    result = {
        'layer_id': layer.get_id(),
        'bounds': _transform_layer_bounds(layer),
        'interpolation': interpolation,
    }
    result.update(extra)
    return result


def op_select_none(args):
    Gimp.Selection.none(_image(args))
    return {'selection': 'none'}


# ---------- selection: gimp_select / gimp_modify_selection / gimp_layer_mask / masks ------------

_CHANNEL_OPS = {
    'replace': Gimp.ChannelOps.REPLACE, 'add': Gimp.ChannelOps.ADD,
    'subtract': Gimp.ChannelOps.SUBTRACT, 'intersect': Gimp.ChannelOps.INTERSECT,
}


def _selection_to_channel(img, name):
    """Copy the active selection into a (replaced) named channel, clear the selection, and return
    the op result every selection op reports."""
    w, h = img.get_width(), img.get_height()
    rect = Gegl.Rectangle.new(0, 0, w, h)
    data = img.get_selection().get_buffer().get(rect, 1.0, "Y' u8", Gegl.AbyssPolicy.NONE)
    ch = _replace_named_channel(img, name, w, h)
    buf = ch.get_buffer()
    buf.set(rect, "Y' u8", data)
    buf.flush()
    ch.update(0, 0, w, h)
    Gimp.Selection.none(img)
    _drop_proxies(img.get_id())
    selected, fraction = _channel_coverage(ch, w, h)
    return {'channel': name, 'selected_pixels': selected, 'fraction': fraction}


def _with_scratch_channel(img, w, h, fn):
    """Run `fn(scratch_channel)` against a throwaway channel inserted for the duration of the
    call, then remove it regardless of outcome -- including when `fn` itself raises partway
    through (e.g. a bad gradient argument), so a failed select never leaves a stray channel
    behind. Used to stash a selection's pixel data somewhere durable (a GIMP selection is a
    single, unnamed piece of image state -- building a SECOND shape while the first is still
    needed, as combine != 'replace' does, has nowhere else to put it).

    Verified the same defensive way `_assert_layer_attached` checks a new layer: some GIMP calls
    report success having silently done nothing, so insertion is confirmed by walking the image's
    own live channel list rather than trusting the call's return value alone. If that check fails,
    there is nothing to remove (the channel was never actually attached). Restores the image's
    selected layers afterward -- see `_replace_named_channel`'s identical comment for why."""
    original_selection = img.get_selected_layers()
    scratch = Gimp.Channel.new(img, '__select_scratch__', w, h, 50.0, Gegl.Color.new('black'))
    img.insert_channel(scratch, None, 0)
    if not any(ch.get_id() == scratch.get_id() for ch in img.get_channels()):
        raise lib.OpError('gimp_op_failed', 'the scratch channel did not attach to the image')
    img.set_selected_layers(original_selection)
    try:
        return fn(scratch)
    finally:
        img.remove_channel(scratch)
        img.set_selected_layers(original_selection)


def _capture_selection(img, w, h, scratch):
    """Copy the CURRENT active selection's pixels into `scratch`'s own buffer -- a durable
    snapshot the caller can reload as the active selection later, after building a SECOND shape
    (`_shape_selection`'s next call) would otherwise overwrite the first one."""
    data = img.get_selection().get_buffer().get(
        Gegl.Rectangle.new(0, 0, w, h), 1.0, "Y' u8", Gegl.AbyssPolicy.NONE)
    buf = scratch.get_buffer()
    buf.set(Gegl.Rectangle.new(0, 0, w, h), "Y' u8", data)
    buf.flush()
    scratch.update(0, 0, w, h)


def _color_arg(img, drawable, args, sample_merged):
    """The target color for mode=color_range: an explicit `color` hex, or the color AT a sample
    point (x, y), always in document pixels. `Gimp.Image.pick_color` takes document coordinates
    regardless of `sample_merged` and itself reports failure -- rather than a wrong or default
    pixel -- for a point outside the image, or (when not sampling the composite) outside the one
    given drawable's own bounds (verified live, GIMP 3.2.6: an out-of-bounds point returns
    `(False, None)`, never raises and never silently samples the wrong pixel)."""
    color = args.get('color')
    if color is not None:
        return Gegl.Color.new(lib.validate_hex_color('color', color))
    if args.get('x') is None or args.get('y') is None:
        raise ValueError('color_range needs `color` (e.g. "#c0392b") or a sample point x, y')
    x, y = float(args['x']), float(args['y'])
    success, picked = img.pick_color([drawable], x, y, sample_merged, False, 0.0)
    if not success or picked is None:
        where = 'the image' if sample_merged else 'layer %r' % drawable.get_name()
        raise ValueError('sample point (%g, %g) is outside %s' % (x, y, where))
    return picked


def _layer_local_point(drawable, x, y):
    """Convert a DOCUMENT-space point to coordinates local to `drawable`, refusing one outside its
    bounds. `Gimp.Image.select_contiguous_color` (unlike `pick_color`) takes LOCAL coordinates when
    sampling one drawable rather than the composite -- verified live, GIMP 3.2.6: an unconverted
    document-space point on an offset layer selected the wrong region of that layer entirely
    (or nothing, if the document point happened to fall outside the layer's own pixel extent)."""
    _ok, ox, oy = drawable.get_offsets()
    lx, ly = x - ox, y - oy
    lw, lh = drawable.get_width(), drawable.get_height()
    if not (0 <= lx < lw and 0 <= ly < lh):
        raise ValueError(
            'sample point (%g, %g) is outside layer %r (%dx%d at offset %d,%d)'
            % (x, y, drawable.get_name(), lw, lh, ox, oy)
        )
    return lx, ly


# A DoS floor on mode=polygon's point count -- the same reasoning as the resize/document pixel
# caps elsewhere in this file.
MAX_POLYGON_POINTS = 10_000


def _polygon_segments(points):
    """Validate `points` (mode=polygon's own argument) and flatten it into GIMP's flat
    [x1, y1, x2, y2, ...] segment list. Every point must be an [x, y] pair of finite numbers -- a
    malformed one (not a pair, a non-numeric value, NaN/Infinity) is refused here rather than
    reaching `Gimp.Image.select_polygon` as garbage or silently coercing to 0."""
    if not isinstance(points, list) or len(points) < 3:
        raise ValueError('points must be a list of at least 3 [x, y] pairs')
    if len(points) > MAX_POLYGON_POINTS:
        raise ValueError('points must be at most %d pairs' % MAX_POLYGON_POINTS)
    segs = []
    for i, p in enumerate(points):
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise ValueError('points[%d] must be an [x, y] pair' % i)
        x, y = p
        if (
            not isinstance(x, (int, float)) or not isinstance(y, (int, float))
            or not (math.isfinite(x) and math.isfinite(y))
        ):
            raise ValueError('points[%d] must be finite numbers' % i)
        segs.extend([float(x), float(y)])
    return segs


def _shape_selection(img, mode, args, w, h):
    """Build `mode`'s shape as the ACTIVE SELECTION, in ISOLATION (every branch uses
    `Gimp.ChannelOps.REPLACE` against whatever was selected before, which is irrelevant -- the
    caller always starts from a cleared selection). `op_select` applies `invert`/`feather_px` to
    this shape ALONE, immediately after, before it is ever combined with an existing channel --
    see `op_select`'s own docstring for why that order matters."""
    REPLACE = Gimp.ChannelOps.REPLACE
    sample_merged = lib.optional_bool(args, 'sample_merged', True)
    Gimp.context_push()
    try:
        Gimp.context_set_feather(False)
        Gimp.context_set_antialias(True)
        threshold = lib.validate_range('threshold', args.get('threshold', 15), 0, 255)
        Gimp.context_set_sample_threshold(threshold / 255.0)
        Gimp.context_set_sample_merged(sample_merged)
        Gimp.context_set_sample_criterion(Gimp.SelectCriterion.COMPOSITE)
        # Set explicitly rather than inherited from whatever the session's own ambient context
        # happens to already hold (a GUI action, or an earlier call, could have left either at a
        # non-default value): sample_transparent False matches color_range/magic_wand's own
        # "colour" framing -- a fully transparent pixel has no colour to match, so it is excluded
        # from both the sampled target and the contiguous region, the same as GIMP's own tool
        # defaults. diagonal_neighbors False keeps magic_wand's contiguous region 4-connected
        # (up/down/left/right only), also GIMP's own tool default.
        Gimp.context_set_sample_transparent(False)
        Gimp.context_set_diagonal_neighbors(False)
        if mode == 'all':
            img.select_rectangle(REPLACE, 0, 0, w, h)
        elif mode in ('rectangle', 'ellipse'):
            x, y = float(lib.require(args, 'x')), float(lib.require(args, 'y'))
            ww, hh = float(lib.require(args, 'width')), float(lib.require(args, 'height'))
            (img.select_rectangle if mode == 'rectangle' else img.select_ellipse)(REPLACE, x, y, ww, hh)
        elif mode == 'polygon':
            segs = _polygon_segments(lib.require(args, 'points'))
            img.select_polygon(REPLACE, segs)
        elif mode == 'color_range':
            drawable = _layer(img, args)
            img.select_color(REPLACE, drawable, _color_arg(img, drawable, args, sample_merged))
        elif mode == 'magic_wand':
            drawable = _layer(img, args)
            x, y = float(lib.require(args, 'x')), float(lib.require(args, 'y'))
            if sample_merged:
                # select_contiguous_color takes DOCUMENT coordinates when sampling the composite
                # (verified live) -- bounds-checked against the image itself, since GIMP silently
                # selects nothing for an out-of-image point rather than refusing it.
                if not (0 <= x < w and 0 <= y < h):
                    raise ValueError('sample point (%g, %g) is outside the %dx%d image' % (x, y, w, h))
                img.select_contiguous_color(REPLACE, drawable, x, y)
            else:
                # ...but LOCAL coordinates when sampling one drawable (verified live) -- see
                # _layer_local_point's own comment.
                lx, ly = _layer_local_point(drawable, x, y)
                img.select_contiguous_color(REPLACE, drawable, lx, ly)
        elif mode == 'alpha':
            img.select_item(REPLACE, _layer(img, args))
        elif mode == 'channel':
            src = _require_channel(img, lib.require(args, 'source'))
            img.select_item(REPLACE, src)
        else:
            raise ValueError('unknown mode %r' % mode)
    finally:
        Gimp.context_pop()


def op_select(args):
    """Every mode builds its shape ALONE first (`_shape_selection`, or a gradient painted directly
    into a scratch channel) -- `invert`/`feather_px` apply to that shape by itself, matching how a
    feathered marquee combines in a raster editor: draw the new region, feather IT, then union/
    subtract/intersect with whatever was already selected. Combining the raw (un-invert/feathered)
    shape first would let those two options reach into the EXISTING channel's content instead,
    which is not what either name promises."""
    img = _image(args)
    mode = lib.require(args, 'mode')
    name = args.get('name', 'Selection')
    combine = args.get('combine', 'replace')
    if combine not in _CHANNEL_OPS:
        raise ValueError('combine must be one of %s' % sorted(_CHANNEL_OPS))
    _refuse_mask_in_use(img, name)
    existing = _find_channel(img, name)
    if combine != 'replace' and existing is None:
        raise ValueError('combine=%s needs an existing channel named %r' % (combine, name))
    invert = bool(args.get('invert', False))
    feather_px = lib.validate_feather_px(args.get('feather_px', 0))
    if feather_px > 0 and mode in ('gradient_linear', 'gradient_radial'):
        raise ValueError(
            'feather_px has no effect on a gradient (already a continuous ramp) -- omit it for '
            'mode=%s rather than pass a value that would silently do nothing' % mode
        )
    w, h = img.get_width(), img.get_height()

    try:
        Gimp.Selection.none(img)
        if mode in ('gradient_linear', 'gradient_radial'):
            def _paint(scratch):
                _paint_gradient_mask(scratch, mode, invert, args, w, h)
                img.select_item(Gimp.ChannelOps.REPLACE, scratch)
            _with_scratch_channel(img, w, h, _paint)
            # invert is already applied above, as a color swap done while painting.
        else:
            _shape_selection(img, mode, args, w, h)
            if invert:
                Gimp.Selection.invert(img)
            if feather_px > 0:
                Gimp.Selection.feather(img, feather_px)

        # The active selection is now the new shape ALONE, already invert/feathered -- never yet
        # combined with whatever `name` previously held.
        if combine == 'replace':
            return _selection_to_channel(img, name)

        def _combine(scratch):
            _capture_selection(img, w, h, scratch)
            img.select_item(Gimp.ChannelOps.REPLACE, existing)
            img.select_item(_CHANNEL_OPS[combine], scratch)
        _with_scratch_channel(img, w, h, _combine)
        return _selection_to_channel(img, name)
    finally:
        Gimp.Selection.none(img)


def op_modify_mask(args):
    img = _image(args)
    name = lib.require(args, 'channel')
    out = args.get('output') or name
    _refuse_mask_in_use(img, out)
    ch = _require_channel(img, name)
    how = lib.require(args, 'op')
    try:
        img.select_item(Gimp.ChannelOps.REPLACE, ch)
        if how in ('expand', 'contract', 'border'):
            # Capped well below feather's own range -- these are morphological ops whose cost
            # scales with the radius AND the document's own megapixel count (see
            # `effective_morphology_px`'s own comment for the live measurements behind this).
            morphology_cap = lib.effective_morphology_px(img.get_width(), img.get_height())
            px = lib.validate_positive_px('px', lib.require(args, 'px'), max_px=morphology_cap)
            if how == 'expand':
                Gimp.Selection.grow(img, px)
            elif how == 'contract':
                Gimp.Selection.shrink(img, px)
            else:
                Gimp.Selection.border(img, px)
        elif how == 'feather':
            px = lib.validate_positive_px('px', lib.require(args, 'px'))
            Gimp.Selection.feather(img, px)
        elif how == 'invert':
            Gimp.Selection.invert(img)
        elif how == 'harden':
            Gimp.Selection.sharpen(img)
        elif how == 'smooth':
            # Round off jaggies: feather, then re-threshold at 50%. `px` is optional here (unlike
            # the four ops above) -- a plain smoothing pass with no caller-chosen radius is still
            # meaningful, so it floors at 1.0 rather than requiring one.
            px = lib.validate_range('px', args.get('px', 0), 0, lib.MAX_FEATHER_PX)
            Gimp.Selection.feather(img, max(px, 1.0))
            Gimp.Selection.sharpen(img)
        else:
            raise ValueError('unknown op %r' % how)
        return _selection_to_channel(img, out)
    finally:
        Gimp.Selection.none(img)


_LAYER_MASK_SOURCES = {
    'white': Gimp.AddMaskType.WHITE, 'black': Gimp.AddMaskType.BLACK,
    'alpha': Gimp.AddMaskType.ALPHA, 'grayscale': Gimp.AddMaskType.COPY,
}


def op_layer_mask(args):
    img = _image(args)
    layer = _layer(img, args)
    how = lib.require(args, 'op')
    mask = layer.get_mask()
    if how == 'create':
        source = args.get('source', 'channel')
        # Resolve and validate EVERYTHING (the channel exists, or `source` names a real kind)
        # before touching the layer's EXISTING mask: a typo'd channel name must never destroy a
        # hand-tuned mask already in place. The new mask is built in full -- `create_mask` (a
        # candidate GimpLayerMask object, not yet attached) succeeds independently of whatever
        # mask the layer currently has -- and only once that succeeds is the old one discarded.
        if source == 'channel':
            ch = _require_channel(img, lib.require(args, 'channel'))
            img.select_item(Gimp.ChannelOps.REPLACE, ch)
            try:
                new = layer.create_mask(Gimp.AddMaskType.SELECTION)
            finally:
                Gimp.Selection.none(img)
        elif source in _LAYER_MASK_SOURCES:
            new = layer.create_mask(_LAYER_MASK_SOURCES[source])
        else:
            raise ValueError('source must be one of %s' % sorted(['channel'] + list(_LAYER_MASK_SOURCES)))
        if mask is not None:
            layer.remove_mask(Gimp.MaskApplyMode.DISCARD)
        if not layer.add_mask(new):
            # Best-effort: put the old mask back rather than leaving the layer maskless on top of
            # having failed to attach the new one. If this ALSO fails, the layer is left without a
            # mask either way, but the attempt costs nothing.
            if mask is not None:
                layer.add_mask(mask)
            raise lib.OpError(
                'gimp_op_failed', 'GIMP could not attach the new mask to layer %r' % layer.get_name()
            )
        # `invert` runs AFTER add_mask -- verified live that inverting the mask object before it is
        # attached to the layer has no visible effect (the invert is silently lost).
        if lib.optional_bool(args, 'invert', False):
            new.invert(False)
    elif mask is None:
        raise ValueError('layer %r has no mask' % layer.get_name())
    elif how == 'delete':
        layer.remove_mask(Gimp.MaskApplyMode.DISCARD)
    elif how == 'apply':
        layer.remove_mask(Gimp.MaskApplyMode.APPLY)
    elif how == 'invert':
        mask.invert(False)
    else:
        raise ValueError('unknown op %r' % how)
    _drop_proxies(img.get_id())
    return {'layer': layer.get_name(), 'layer_id': layer.get_id(), 'op': how,
            'has_mask': layer.get_mask() is not None}


def _gray_bytes_image(data, w, h):
    """A new GRAY image carrying `data` as its one layer's pixels. Caller deletes it. `tmp` is torn
    down on any failure after its own creation (layer build, insert, or buffer write) -- otherwise
    an exception here would leave the image orphaned in GIMP with no reference left to free it."""
    tmp = Gimp.Image.new(w, h, Gimp.ImageBaseType.GRAY)
    try:
        lay = Gimp.Layer.new(tmp, 'm', w, h, Gimp.ImageType.GRAY_IMAGE, 100.0, Gimp.LayerMode.NORMAL)
        tmp.insert_layer(lay, None, 0)
        buf = lay.get_buffer()
        buf.set(Gegl.Rectangle.new(0, 0, w, h), "Y' u8", data)
        buf.flush()
    except Exception:
        tmp.delete()
        raise
    return tmp, lay


def op_mask_preview(args):
    img = _image(args)
    ch = _require_channel(img, lib.require(args, 'channel'))
    out_path = lib.require(args, 'out_path')
    max_px = lib.validate_max_px(int(args.get('max_px', 1024)))
    w, h = img.get_width(), img.get_height()
    data = ch.get_buffer().get(Gegl.Rectangle.new(0, 0, w, h), 1.0, "Y' u8", Gegl.AbyssPolicy.NONE)
    tmp, lay = _gray_bytes_image(data, w, h)
    try:
        _scale_to_max(tmp, max_px)
        dw, dh = tmp.get_width(), tmp.get_height()
        if args.get('style', 'overlay') == 'mask':
            _export_stripped(tmp, out_path)
            return {'path': out_path, 'width': dw, 'height': dh, 'unmirrored_filters': []}
        small = lay.get_buffer().get(Gegl.Rectangle.new(0, 0, dw, dh), 1.0, "Y' u8",
                                     Gegl.AbyssPolicy.NONE)
    finally:
        tmp.delete()
    dup, unmirrored = _proxy_render(img, max_px)
    try:
        if dup.get_base_type() != Gimp.ImageBaseType.RGB:
            dup.convert_rgb()
        if (dup.get_width(), dup.get_height()) != (dw, dh):
            dup.scale(dw, dh)
        red = Gimp.Layer.new(dup, 'overlay', dw, dh, Gimp.ImageType.RGBA_IMAGE, 50.0,
                             Gimp.LayerMode.NORMAL)
        dup.insert_layer(red, None, 0)
        Gimp.context_push()
        try:
            Gimp.context_set_foreground(Gegl.Color.new('red'))
            red.fill(Gimp.FillType.FOREGROUND)
        finally:
            Gimp.context_pop()
        m = red.create_mask(Gimp.AddMaskType.WHITE)
        red.add_mask(m)
        mb = m.get_buffer()
        # Quick Mask style: red covers what is NOT selected.
        mb.set(Gegl.Rectangle.new(0, 0, dw, dh), "Y' u8", small.translate(bytes(range(255, -1, -1))))
        mb.flush()
        dup.flatten()
        _export_stripped(dup, out_path)
        return {'path': out_path, 'width': dw, 'height': dh, 'unmirrored_filters': unmirrored}
    finally:
        dup.delete()


def op_load_mask(args):
    """A grey mask image (PNG/JPEG, white = selected) -> a named channel. With a layer, the mask
    is taken to cover that layer's own bounds (e.g. a mask computed from `render_layer`).

    Flattened onto an explicit OPAQUE BLACK layer at the bottom of the stack always -- never
    GIMP's own flatten default (the session's current background colour, verified live) -- so a
    source smaller than its own canvas, or carrying alpha, never picks up stray colour for the
    gap/transparent area: a transparent (or uncovered) pixel means "not part of the mask" NOT
    "selected". Every alpha-carrying layer's own composite space is set to RGB_PERCEPTUAL before
    flattening, so the result is value x alpha IN PERCEPTUAL SPACE (verified live: a 50%-alpha
    white pixel over black reads ~128, the plain 255 x 0.5), not a linear-light blend (which would
    read ~186 for the same input) -- a mask is a plain 0-255 coverage value, not a photographed
    light, so the perceptual (byte-arithmetic) reading is the one that matches every other mask
    value this bridge produces."""
    img = _image(args)
    name = args.get('name', 'Mask')
    _refuse_mask_in_use(img, name)
    path = lib.require(args, 'path')
    basename = os.path.basename(path)
    if not os.path.exists(path):
        raise FileNotFoundError('no file named %s to load as a mask' % basename)
    w, h = img.get_width(), img.get_height()
    if args.get('layer') or args.get('layer_id') is not None:
        layer = _layer(img, args)
        _ok, ox, oy = layer.get_offsets()
        tw, th = layer.get_width(), layer.get_height()
    else:
        ox = oy = 0
        tw, th = w, h
    load_error = None
    try:
        src = Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, Gio.File.new_for_path(path))
    except Exception as e:
        src = None
        load_error = str(e)
    if src is None:
        detail = _path_free_detail(load_error)
        raise lib.OpError('gimp_op_failed', 'could not load %s as a mask%s' % (basename, detail))
    try:
        lib.validate_loaded_mask_dims(src.get_width(), src.get_height())
        if src.get_base_type() != Gimp.ImageBaseType.GRAY:
            src.convert_grayscale()
        for src_layer in src.get_layers():
            if src_layer.has_alpha():
                src_layer.set_composite_space(Gimp.LayerColorSpace.RGB_PERCEPTUAL)
        bg = Gimp.Layer.new(src, 'mask-bg', src.get_width(), src.get_height(),
                            Gimp.ImageType.GRAY_IMAGE, 100.0, Gimp.LayerMode.NORMAL)
        src.insert_layer(bg, None, len(src.get_layers()))
        Gimp.context_push()
        try:
            Gimp.context_set_foreground(Gegl.Color.new('black'))
            bg.fill(Gimp.FillType.FOREGROUND)
        finally:
            Gimp.context_pop()
        if (src.get_width(), src.get_height()) != (tw, th):
            src.scale(tw, th)
        flat = src.flatten()
        data = flat.get_buffer().get(Gegl.Rectangle.new(0, 0, tw, th), 1.0, "Y' u8",
                                     Gegl.AbyssPolicy.NONE)
    finally:
        src.delete()
    ch = _replace_named_channel(img, name, w, h)
    x0, y0, x1, y1 = lib.compute_mask_paste_rect(ox, oy, tw, th, w, h)
    if x1 > x0 and y1 > y0:
        if (ox, oy, tw, th) == (0, 0, w, h):
            sub = data
        else:
            sub = b''.join(data[(y - oy) * tw + (x0 - ox):(y - oy) * tw + (x1 - ox)]
                           for y in range(y0, y1))
        buf = ch.get_buffer()
        buf.set(Gegl.Rectangle.new(x0, y0, x1 - x0, y1 - y0), "Y' u8", sub)
        buf.flush()
        ch.update(0, 0, w, h)
    Gimp.Selection.none(img)
    _drop_proxies(img.get_id())
    selected, fraction = _channel_coverage(ch, w, h)
    return {'channel': name, 'selected_pixels': selected, 'fraction': fraction}


def op_render_layer(args):
    """One layer's own pixels (not the composite), downscaled, to out_path -- the input for a mask
    that should follow that layer. Returns the layer's bounds in document pixels.

    Rendered as if the layer were fully VISIBLE, at 100% opacity, in Normal mode -- set on the
    duplicated layer before flatten, so a hidden, partially-transparent, or blend-mode layer still
    renders its own pixels plainly rather than the (possibly empty or blended-dark) result its
    current display settings would otherwise produce. The layer's own mask and any live filters
    are still included, exactly as they would render in the document. Any remaining transparency
    (the layer's own alpha, not just visibility/opacity/mode) is flattened onto an explicit OPAQUE
    WHITE background -- not whatever the session's own ambient context background happens to be --
    since the output feeds a subject/object detector that expects an ordinary opaque photo."""
    img = _image(args)
    layer = _layer(img, args)
    out_path = lib.require(args, 'out_path')
    max_px = lib.validate_max_px(int(args.get('max_px', 2048)))
    lw, lh = layer.get_width(), layer.get_height()
    _ok, ox, oy = layer.get_offsets()
    tmp = Gimp.Image.new(lw, lh, Gimp.ImageBaseType.RGB)
    try:
        nl = Gimp.Layer.new_from_drawable(layer, tmp)
        tmp.insert_layer(nl, None, 0)
        nl.set_offsets(0, 0)
        nl.set_visible(True)
        nl.set_opacity(100.0)
        nl.set_mode(Gimp.LayerMode.NORMAL)
        bg = Gimp.Layer.new(tmp, 'render-bg', lw, lh, Gimp.ImageType.RGB_IMAGE, 100.0,
                            Gimp.LayerMode.NORMAL)
        tmp.insert_layer(bg, None, 1)
        Gimp.context_push()
        try:
            Gimp.context_set_foreground(Gegl.Color.new('white'))
            bg.fill(Gimp.FillType.FOREGROUND)
        finally:
            Gimp.context_pop()
        _scale_to_max(tmp, max_px)
        tmp.flatten()
        _export_stripped(tmp, out_path)
        return {'path': out_path, 'width': tmp.get_width(), 'height': tmp.get_height(),
                'layer_id': layer.get_id(), 'bounds': {'x': ox, 'y': oy, 'width': lw, 'height': lh}}
    finally:
        tmp.delete()


def op_close(args):
    img = _image(args)
    _drop_proxies(img.get_id())
    img.delete()
    return {'closed': int(args['image'])}


OPS = {
    'ping': op_ping, 'open': op_open, 'curves': op_curves, 'levels': op_levels,
    'adjust': op_adjust, 'filter': op_filter, 'effect': op_effect, 'describe': op_describe,
    'list_filters': op_list_filters, 'preview': op_preview, 'histogram': op_histogram,
    'compare': op_compare, 'export': op_export, 'close': op_close,
    'crop': op_crop, 'resize': op_resize, 'rotate': op_rotate, 'flip': op_flip,
    'create_mask': op_create_mask, 'describe_operation': op_describe_operation,
    'select_none': op_select_none, 'layer': op_layer, 'bake': op_bake,
    'create_document': op_create_document, 'place_image': op_place_image,
    'canvas': op_canvas, 'convert_image_mode': op_convert_image_mode,
    'text': op_text, 'fonts': op_fonts,
    'select': op_select, 'modify_mask': op_modify_mask, 'layer_mask': op_layer_mask,
    'mask_preview': op_mask_preview, 'load_mask': op_load_mask, 'render_layer': op_render_layer,
    'transform_layer': op_transform_layer,
}


def _dispatch(op, args):
    """The real OPS-table lookup `lib.process_request` calls for each
    request. Raising `lib.OpError('invalid_argument', ...)` for an unknown op
    (rather than a bare KeyError) is what makes process_request's own
    classification report it as invalid_argument, not gimp_op_failed."""
    fn = OPS.get(op)
    if fn is None:
        raise lib.OpError('invalid_argument', 'unknown op %r' % op)
    return fn(args)


def serve(session_dir, poll_s=0.005, parent_check_s=1.0):
    """Handle rpc/req-<id>.json in id order until rpc/shutdown appears, or
    the parent process (EM_GIMP_PARENT_PID, checked about once a second) is
    gone -- a dead driver otherwise leaves this headless GIMP running
    forever with nothing left to ever write rpc/shutdown. (Absent entirely
    for a Flatpak-launched GIMP, whose pid namespace can't see the host
    parent anyway -- see session.ts's env-building for that decision.)"""
    rpc = os.path.join(session_dir, 'rpc')
    with open(os.path.join(rpc, 'ready.tmp'), 'w') as fh:
        fh.write(str(os.getpid()))
    os.replace(os.path.join(rpc, 'ready.tmp'), os.path.join(rpc, 'ready'))

    parent_pid_raw = os.environ.get('EM_GIMP_PARENT_PID')
    parent_pid = int(parent_pid_raw) if parent_pid_raw else None
    last_parent_check = time.time()

    while not os.path.exists(os.path.join(rpc, 'shutdown')):
        now = time.time()
        if parent_pid is not None and now - last_parent_check >= parent_check_s:
            last_parent_check = now
            if not lib.is_process_alive(parent_pid):
                sys.stderr.write('parent process %d is gone; exiting\n' % parent_pid)
                return
        names = lib.list_requests(rpc)
        if not names:
            time.sleep(poll_s)
            continue
        for name in names:
            try:
                lib.process_request(os.path.join(rpc, name), rpc, _dispatch)
            except Exception:
                # process_request is designed to never raise (see its own
                # docstring) -- this is belt-and-suspenders so a bug in that
                # contract takes down one request, not the whole session.
                sys.stderr.write(
                    'process_request raised for %s:\n%s\n' % (name, traceback.format_exc())
                )
