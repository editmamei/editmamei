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
    return img


def _layer(img, args):
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
    geometry refusal like any other."""
    out = []

    def walk(items):
        for item in items:
            out.append(item)
            if item.is_group():
                walk(item.get_children())

    walk(img.get_layers())
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


# Preview proxies, keyed by image id: a filter-free downscale of the document made once, onto
# which the document's live filters are re-applied per preview. Rendering filters on ~0.7 MP
# instead of 24 MP is what gets preview under a second; every route that renders from the
# full-size document (flatten, scale, get_thumbnail's projection) costs 1.4-4.5 s after an
# edit. Exact for per-pixel filters (curves, levels); a spatial filter would need its radius
# scaled. Every op in this file only ever changes layer pixels via a non-destructive filter
# (never bakes), so the proxy's filter-free base never goes stale.
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
    # dst is a duplicate of src (see `_proxy`), so both walks yield the same layers in the same order.
    for src, dst in zip(_all_layers(src_img), _all_layers(dst_img)):
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
    name, n = base, 2
    while name in taken:
        name, n = '%s %d' % (base, n), n + 1
    return name


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


def _channel_by_name(img, name):
    for ch in img.get_channels():
        if ch.get_name() == name:
            return ch
    raise ValueError('no mask channel named %r (create one with create_mask)' % name)


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
        img.select_item(Gimp.ChannelOps.REPLACE, _channel_by_name(img, mask))
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

def op_ping(args):
    major, minor, micro = lib.parse_gimp_version(Gimp.version())
    return {'major': major, 'minor': minor, 'micro': micro,
            'images': [i.get_id() for i in Gimp.get_images()]}


# `precision` open-time promotion, using the enum names GIMP 3 actually exposes (verified live).
# u16/float-non-linear is the "perceptual-encoded" bit depth banding-prone tone moves need
# (measured live: ~130ms to convert_precision a 24 MP image -- negligible next to the rest of
# `open`'s cost).
_PRECISION_ENUM = {
    '16': Gimp.Precision.U16_NON_LINEAR,
    '32': Gimp.Precision.FLOAT_NON_LINEAR,
}


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
    return _describe(img)


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


def op_list_filters(args):
    """Bridge-applied filters report the ledger record (`source: editmamei`) with `params` in the
    adjust tool's own field names and units (`lib.user_params`), so a listed value can be passed
    straight back on a re-edit. Anything else reports libgimp's readback (`source: readback`):
    raw GEGL property names and units, lossy for per-channel curves, with any value JSON can't
    carry (a Gegl.Color, say) stringified."""
    img = _image(args)
    filters, _unknown = _ledger_get(img)
    out = []
    for layer in _all_layers(img):
        for f in layer.get_filters():
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
            out.append({'layer': layer.get_name(), 'filter_id': f.get_id(), 'name': f.get_name(),
                        'operation': f.get_operation_name(), 'type': type_, 'visible': f.get_visible(),
                        'source': source, 'mask': mask, 'params': params})
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


def _refuse_if_masked_filters(img, op_name):
    masked, unverifiable = _classify_geometry_filters(img)
    if unverifiable:
        raise ValueError(
            '%s cannot proceed: filter(s) %s were not created by Editmamei (no matching ledger '
            'record for their name and operation), so whether they are masked cannot be checked. '
            'Delete them first, or make this geometry change before adding them.'
            % (op_name, ', '.join(repr(n) for n in sorted(unverifiable)))
        )
    if masked:
        raise ValueError(
            '%s would misalign the masked filter(s) %s: a filter\'s mask cannot move with '
            'this transform. Rotate, flip or resize before adding masked filters, or delete '
            'those filters first and re-create them afterwards. Crop is unaffected.'
            % (op_name, ', '.join(repr(n) for n in sorted(masked)))
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

    A live update failure for one filter does not stop the others. Unlike an earlier version of
    this function, the ledger is NOT left at the new (unapplied) params on failure: the ledger
    must always match what actually renders, so this instead tries to restore the filter's OLD
    params live (best effort -- if that ALSO fails, the filter is simply left wherever the failed
    attempt left it) and keeps the ledger record at the OLD params either way. The filter's name is
    collected and returned so the caller can report it (`effect_update_failures`) -- a silent
    partial failure here would otherwise look identical to a filter the geometry op never touched
    at all."""
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
    image's own size -- `op_create_mask`'s replace-by-name semantics."""
    for existing in img.get_channels():
        if existing.get_name() == name:
            img.remove_channel(existing)
    ch = Gimp.Channel.new(img, name, w, h, 50.0, Gegl.Color.new('black'))
    img.insert_channel(ch, None, 0)
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
    selected = sum(1 for b in data if b >= 128)
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
    RGB_LINEAR, and leaving the context at whatever it already was all produced byte-identical
    output (an exact linear ramp -- x=128 reads 128) once read back correctly. What DOES control
    the crossing point is the buffer format every reader of this channel (`_channel_coverage`,
    and the selection copy above) uses -- `"Y' u8"` (perceptual/gamma-encoded, matching the
    channel's own storage), not `'Y u8'` (linear light, which compresses the readback toward black,
    e.g. the geometric midpoint reading ~55 instead of ~128; this is what an earlier, incorrect
    version of this comment blamed on the blend color space instead). RGB_PERCEPTUAL is kept set
    here anyway as the explicit, correct-if-it-ever-starts-mattering choice for a caller who thinks
    in 0-255 terms, not because it changes anything measured today.

    `feather_px` has no effect here (a gradient is already a continuous ramp, nothing to feather);
    `invert` swaps which end is black vs white."""
    img = _image(args)
    type_ = args.get('type')
    if type_ not in lib.MASK_TYPES:
        raise ValueError('type must be one of %s' % sorted(lib.MASK_TYPES))
    name = args.get('name', 'Mask')
    if _mask_name_in_use(img, name):
        raise ValueError(
            'mask %r is already used by an existing filter; delete that filter or use a '
            'different name' % name
        )
    invert = bool(args.get('invert', False))
    feather_px = lib.validate_feather_px(args.get('feather_px', 0))
    w, h = img.get_width(), img.get_height()

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
        # "Y' u8" (perceptual), not "Y u8" (linear) -- see `_channel_coverage`'s comment. A hard
        # selection is 0/255 either way, but a FEATHERED one has a real falloff whose shape this
        # format choice controls.
        sel_data = img.get_selection().get_buffer().get(
            Gegl.Rectangle.new(0, 0, w, h), 1.0, "Y' u8", Gegl.AbyssPolicy.NONE
        )
        ch_buf = ch.get_buffer()
        ch_buf.set(Gegl.Rectangle.new(0, 0, w, h), "Y' u8", sel_data)
        ch_buf.flush()
        ch.update(0, 0, w, h)
    else:
        ch = _replace_named_channel(img, name, w, h)
        black, white = ('white', 'black') if invert else ('black', 'white')
        # A gradient fill paints `start_color` at (x1,y1) and `end_color` at (x2,y2). For
        # gradient_linear those points are the caller's own start/end -- black-at-x1 ramps
        # toward white-at-x2 exactly as given (verified live). For gradient_radial (x1,y1) is
        # always the CENTER and (x2,y2) the radius edge, and the intuitive reading of a radial
        # mask is a spotlight -- full effect (white) at the center, fading to none (black) at
        # the edge -- so the two colors are swapped relative to the linear case.
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
    Gimp.Selection.none(img)  # a mask is referenced by NAME at filter-creation time, not by
    # staying the active selection -- leaving it selected let the NEXT unmasked filter silently
    # inherit it (`_append_masked` also clears defensively, but the fix belongs here too).
    _drop_proxies(img.get_id())
    selected, fraction = _channel_coverage(ch, w, h)
    return {'channel': name, 'selected_pixels': selected, 'fraction': fraction}


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


def op_select_none(args):
    Gimp.Selection.none(_image(args))
    return {'selection': 'none'}


def op_close(args):
    img = _image(args)
    _drop_proxies(img.get_id())
    img.delete()
    return {'closed': int(args['image'])}


OPS = {
    'ping': op_ping, 'open': op_open, 'curves': op_curves, 'levels': op_levels,
    'adjust': op_adjust, 'filter': op_filter, 'effect': op_effect,
    'list_filters': op_list_filters, 'preview': op_preview, 'histogram': op_histogram,
    'compare': op_compare, 'export': op_export, 'close': op_close,
    'crop': op_crop, 'resize': op_resize, 'rotate': op_rotate, 'flip': op_flip,
    'create_mask': op_create_mask, 'describe_operation': op_describe_operation,
    'select_none': op_select_none,
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
