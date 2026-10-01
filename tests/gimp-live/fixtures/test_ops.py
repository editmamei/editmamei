# Test-only bridge for tests/gimp-live. GimpSession runs this in place of the shipped ops.py (its
# `opsPyPath` option); it loads the real bridge first, then adds ops the shipped bridge
# deliberately does not expose: loading/exporting a mask as a PGM file, and building fixture
# state (a layer group, a leftover selection, a filter the ledger knows nothing about) that no
# gimp_* tool can create. None of this ships: scripts/copy-gimp-bridge.ts stages only the files
# under src/backends/gimp/bridge/.
#
# Exec'd by session.ts's batch line exactly like ops.py, so EM_GIMP_OPS names THIS file. The real
# ops.py finds its sibling lib.py through EM_GIMP_OPS, so that is repointed before the exec.

import os
import time

_here = os.path.dirname(os.path.abspath(os.environ['EM_GIMP_OPS']))
_real_ops = os.path.normpath(
    os.path.join(_here, '..', '..', '..', 'src', 'backends', 'gimp', 'bridge', 'ops.py')
)
os.environ['EM_GIMP_OPS'] = _real_ops
with open(_real_ops, encoding='utf-8') as _fh:
    exec(_fh.read(), globals())


def op_test_select_mask(args):
    """Load an 8-bit PGM (image size, >=128 = selected) into a named channel and leave it as the
    active selection."""
    img = _image(args)
    with open(lib.require(args, 'mask_path'), 'rb') as fh:
        w, h, data = lib.read_pgm(fh.read())
    if (w, h) != (img.get_width(), img.get_height()):
        raise ValueError('mask is %dx%d, image is %dx%d' % (w, h, img.get_width(), img.get_height()))
    name = args.get('name', 'Mask')
    _refuse_mask_in_use(img, name)
    ch = _replace_named_channel(img, name, w, h)
    buf = ch.get_buffer()
    buf.set(Gegl.Rectangle.new(0, 0, w, h), "Y' u8", data)
    buf.flush()
    ch.update(0, 0, w, h)
    img.select_item(Gimp.ChannelOps.REPLACE, ch)
    _drop_proxies(img.get_id())
    selected = sum(1 for b in data if b >= 128)
    return {'channel': name, 'selected_pixels': selected, 'fraction': round(selected / len(data), 4)}


def op_test_export_mask(args):
    """Write the active selection (default) or a named channel as an 8-bit PGM."""
    img = _image(args)
    path = lib.require(args, 'path')
    channel = args.get('channel')
    src = img.get_selection() if channel in (None, 'selection') else _require_channel(img, channel)
    w, h = img.get_width(), img.get_height()
    data = src.get_buffer().get(Gegl.Rectangle.new(0, 0, w, h), 1.0, "Y' u8", Gegl.AbyssPolicy.NONE)
    with open(path, 'wb') as fh:
        fh.write(lib.write_pgm(w, h, data))
    return {'path': path, 'width': w, 'height': h}


def op_test_select_rect(args):
    """Leave a rectangular selection active, as a GUI-saved .xcf can arrive with one."""
    img = _image(args)
    img.select_rectangle(
        Gimp.ChannelOps.REPLACE,
        float(args['x']), float(args['y']), float(args['width']), float(args['height']),
    )
    return {'selection_empty': Gimp.Selection.is_empty(img)}


def op_test_selection_empty(args):
    return {'selection_empty': Gimp.Selection.is_empty(_image(args))}


def op_test_wrap_in_group(args):
    """Put a copy of the top layer inside a new layer group, above it: group 'Group' containing
    layer 'Nested'. A filter on 'Nested' lives below the top level of img.get_layers()."""
    img = _image(args)
    base = img.get_layers()[0]
    group = Gimp.GroupLayer.new(img, 'Group')
    img.insert_layer(group, None, 0)
    nested = Gimp.Layer.new_from_drawable(base, img)
    nested.set_name('Nested')
    img.insert_layer(nested, group, 0)
    _drop_proxies(img.get_id())  # cached proxies predate these layers
    return {'layers': [l.get_name() for l in _all_layers(img)]}


def op_test_add_foreign_filter(args):
    """Append a filter directly, with no ledger record: what a filter added in the GIMP GUI looks
    like to the bridge. `props` maps GEGL property names to plain values."""
    img = _image(args)
    layer = _layer(img, args)
    f = Gimp.DrawableFilter.new(layer, lib.require(args, 'operation'), args.get('name', 'Foreign'))
    cfg = f.get_config()
    for key, value in (args.get('props') or {}).items():
        cfg.set_property(key, value)
    Gimp.Selection.none(img)
    layer.append_filter(f)
    return {'filter_id': f.get_id(), 'name': f.get_name()}


def op_test_metadata_tag(args):
    """One tag from the metadata GIMP loaded with the image (None when absent): proves a fixture's
    metadata actually reached GIMP, so a stripped export means something."""
    md = _image(args).get_metadata()
    tag = lib.require(args, 'tag')
    if md is None:
        return {'value': None}
    for getter in ('try_get_tag_string', 'get_tag_string'):
        fn = getattr(md, getter, None)
        if fn is None:
            continue
        try:
            return {'value': fn(tag)}
        except Exception:
            continue
    return {'value': None}


def op_test_proxy_filter_count(args):
    """How many filters sit on the cached preview proxy's own layers (group children included).
    The proxy must be filter-free -- the document's filters are mirrored onto a copy of it per
    render -- so anything above 0 is a filter the proxy builder missed."""
    img = _image(args)
    proxy = _proxy(img, lib.validate_max_px(int(args.get('max_px', 1024))))
    return {'filters': sum(len(layer.get_filters()) for layer in _all_layers(proxy))}


def op_test_proxy_ids(args):
    """The image ids of every live preview proxy the bridge holds."""
    return {'ids': [p.get_id() for p in PROXIES.values() if p.is_valid()]}


def _pick_a_font():
    """`Gimp.context_get_font()`, falling back to the first of `Gimp.fonts_get_list('')` (both
    verified live) -- observed live that the context font can read None under concurrent load (a
    fresh gimp-console still building its font cache while several others start at once), so a
    single reliance on the context alone is flaky. Retries briefly (the font list itself can still
    be loading, not just the context default) before giving up."""
    font = Gimp.context_get_font()
    if font is not None:
        return font
    for _ in range(20):
        fonts = Gimp.fonts_get_list('')
        if fonts:
            return fonts[0]
        time.sleep(0.25)
    return None


def op_test_add_text_layer(args):
    """Insert a real text layer at the top of the stack -- what `describe`'s `is_text_layer` flag
    is meant to catch, exercised against the real thing rather than only a plain pixel layer
    (which always reads False). `Gimp.TextLayer.new` needs a `Gimp.Font`, not a font name string
    (verified live) -- `_pick_a_font` supplies one, retrying past a transient None rather than
    failing this whole fixture on it."""
    img = _image(args)
    font = _pick_a_font()
    if font is None:
        raise ValueError(
            'no font available to build the text-layer fixture (GIMP font list empty or never '
            'became ready)'
        )
    layer = Gimp.TextLayer.new(img, args.get('text', 'Hi'), font, 24, Gimp.Unit.pixel())
    img.insert_layer(layer, None, 0)
    _drop_proxies(img.get_id())  # cached proxies predate this layer
    return {'layer_id': layer.get_id(), 'name': layer.get_name()}


def op_test_nest_groups(args):
    """Two levels of group nesting plus a separate empty group -- deep/edge-case structure for
    `describe`'s layer tree: 'Outer' (group) > 'Inner' (group) > 'Deepest' (a copy of the base
    layer), and a sibling 'Empty' group with no children at all."""
    img = _image(args)
    base = img.get_layers()[0]
    outer = Gimp.GroupLayer.new(img, 'Outer')
    img.insert_layer(outer, None, 0)
    inner = Gimp.GroupLayer.new(img, 'Inner')
    img.insert_layer(inner, outer, 0)
    deepest = Gimp.Layer.new_from_drawable(base, img)
    deepest.set_name('Deepest')
    img.insert_layer(deepest, inner, 0)
    empty = Gimp.GroupLayer.new(img, 'Empty')
    img.insert_layer(empty, None, 0)
    _drop_proxies(img.get_id())
    return {'layers': [l.get_name() for l in _all_layers(img)]}


def op_test_build_layer_tree(args):
    """Direct probe of `_build_layer_tree`'s own `max_nodes` cap, bypassing `describe`'s fixed
    MAX_DESCRIBE_LAYER_NODES (2000) -- lets a live test exercise truncation behaviour (the cutoff
    itself, a group left with missing children, and the exactly-full-tree case) against a small
    fixture instead of needing a 2000+-node one."""
    img = _image(args)
    max_nodes = int(lib.require(args, 'max_nodes'))
    layers, truncated, total_nodes = _build_layer_tree(img.get_layers(), max_nodes=max_nodes)
    return {'layers': layers, 'truncated': truncated, 'total_nodes': total_nodes}


def op_test_all_layers_order(args):
    """The name of every layer `_all_layers` visits, in order -- top-of-stack-first, descending
    into each group before moving on to its next sibling."""
    img = _image(args)
    return {'names': [l.get_name() for l in _all_layers(img)]}


def op_test_set_channels_deadline(args):
    """Overrides `CHANNELS_DESCRIBE_DEADLINE_S` for the rest of this session, returning the
    previous value so a test can restore it afterward -- lets a live test force `describe`'s
    `channels` target to stop early without needing dozens of real named channels."""
    global CHANNELS_DESCRIBE_DEADLINE_S
    previous = CHANNELS_DESCRIBE_DEADLINE_S
    CHANNELS_DESCRIBE_DEADLINE_S = float(lib.require(args, 'seconds'))
    return {'previous': previous}


def op_test_apply_raw_effect(args):
    """Drive the REAL `_apply_filter` (not a bypass, unlike `op_test_add_foreign_filter` above)
    through an arbitrary GEGL operation with a trivial passthrough setter -- for proving
    `_append_masked`'s attach-failure guard actually fires from the production create path, not
    just when called directly. `operation` names any GEGL op (bypassing lib.EFFECT_OPERATIONS'
    allow-list entirely); `props` are raw GEGL property names -> values, set verbatim.

    Temporarily registers `_raw_setter` in the SHARED module-level `SETTERS` dict (the real
    ops.py's own dispatch table `_apply_filter`/`_mirror_filters` read for every filter, real
    effects included) and restores whatever was there before in a `finally` -- either the real
    setter, if `operation` is one of the allow-listed ones, or nothing at all, so a probe against
    a real operation name can never leave a throwaway passthrough setter permanently shadowing
    it for the rest of the session."""
    img = _image(args)
    operation = lib.require(args, 'operation')
    props = dict(args.get('props') or {})

    def _raw_setter(cfg, params):
        for key, value in params.items():
            cfg.set_property(key, value)

    previous_setter = SETTERS.get(operation)
    SETTERS[operation] = _raw_setter
    try:
        return _apply_filter(img, args, operation, props, 'Test Raw Effect')
    finally:
        if previous_setter is None:
            SETTERS.pop(operation, None)
        else:
            SETTERS[operation] = previous_setter


def op_test_mirror_unattachable(args):
    """Exercises `_mirror_filters`' catch-and-skip path for an attach refusal directly, rather
    than relying on a real GEGL operation that behaves this way: no operation in the allow-list
    naturally attaches on the source image (proving it can be live at all) yet fails to
    re-attach on the proxy duplicate specifically (gegl:lens-blur, the one operation that DOES
    refuse to attach, refuses identically everywhere, so it can never be live on the source
    either -- see build_lens_blur_params' own comment). Instead, this temporarily replaces the
    module-level `_append_masked` with a stub that raises `gimp_op_failed` for one named filter
    and delegates to the real function for every other one, calls the real (unmodified)
    `_proxy_render`, and restores the original `_append_masked` in a `finally` regardless of
    outcome. `filter_name` names the ledgered filter to sabotage; `max_px` defaults to 1024."""
    img = _image(args)
    target_name = lib.require(args, 'filter_name')
    max_px = int(args.get('max_px', 1024))

    real_append_masked = globals()['_append_masked']

    def _poisoned_append_masked(dst_img, layer, f, mask):
        if f.get_name() == target_name:
            f.delete()
            raise lib.OpError('gimp_op_failed', 'poisoned for test: %s' % target_name)
        return real_append_masked(dst_img, layer, f, mask)

    globals()['_append_masked'] = _poisoned_append_masked
    try:
        dup, unmirrored = _proxy_render(img, max_px)
        dup.delete()
        return {'unmirrored_filters': unmirrored}
    finally:
        globals()['_append_masked'] = real_append_masked


def op_test_force_effect_update_failure(args):
    """Exercises `_apply_planned_effect_transform`'s failure-and-restore path directly: replaces
    SETTERS[operation] with a stub that applies the REAL setter and then raises, on its FIRST
    call only (simulating a live update that partially succeeds -- e.g. `f.update()` failing
    after every `cfg.set_property()` already ran -- not one that never touches the filter at
    all). Every later call behaves normally, so the SAME poisoned setter also serves as the
    restore attempt `_apply_planned_effect_transform` makes with the filter's OLD params,
    round-tripping the live config back for real rather than merely leaving it untouched.
    Restores the real setter in a `finally` regardless of outcome.

    `operation` names the GEGL operation to sabotage (e.g. 'gegl:vignette'); `geometry_op` is
    'rotate' | 'flip' | 'resize'; every other arg is forwarded to that op (image, degrees/
    orientation/width etc.)."""
    operation = lib.require(args, 'operation')
    geometry_op = lib.require(args, 'geometry_op')
    real_setter = SETTERS[operation]
    calls = {'n': 0}

    def _poisoned_setter(cfg, params):
        calls['n'] += 1
        real_setter(cfg, params)
        if calls['n'] == 1:
            raise RuntimeError('poisoned for test: %s' % operation)

    SETTERS[operation] = _poisoned_setter
    try:
        fn = {'rotate': op_rotate, 'flip': op_flip, 'resize': op_resize}[geometry_op]
        return fn(args)
    finally:
        SETTERS[operation] = real_setter


def op_test_add_offset_layer(args):
    """A new, blank layer smaller than the canvas and positioned at an offset -- for proving a
    geometry transform's math for gimp_add_effect's filters uses the OWNING LAYER's own extent
    and position, not the canvas's, even when the layer doesn't span the whole canvas. `width`/
    `height`/`x`/`y` are the new layer's size and position in document pixels; `name` labels it
    (target it afterward via `effect`'s own `layer` argument)."""
    img = _image(args)
    width, height = int(lib.require(args, 'width')), int(lib.require(args, 'height'))
    x, y = int(lib.require(args, 'x')), int(lib.require(args, 'y'))
    name = args.get('name', 'Offset')
    layer = Gimp.Layer.new(
        img, name, width, height, Gimp.ImageType.RGB_IMAGE, 100.0, Gimp.LayerMode.NORMAL
    )
    img.insert_layer(layer, None, 0)
    layer.fill(Gimp.FillType.WHITE)
    layer.set_offsets(x, y)
    _drop_proxies(img.get_id())
    return {'layer': layer.get_name(), 'width': layer.get_width(), 'height': layer.get_height()}


def op_test_ledger_dump(args):
    """The editmamei-filters ledger's own filter names, read directly via `_ledger_get` -- NOT
    through `op_list_filters`, which also reports "readback" (foreign, unledgered) filters found
    by walking the layer's live filter stack. A test proving "no phantom filter was ledgered"
    needs to see the ledger's OWN contents specifically: `op_list_filters` reporting zero filters
    is also what a bare `layer.get_filters()` returning empty would produce, which doesn't by
    itself rule out a stray ledger record for a filter that no longer exists."""
    filters, _unknown = _ledger_get(_image(args))
    return {'names': sorted(filters.keys())}


_TEST_IMAGE_BASE_TYPES = {
    'rgb': Gimp.ImageBaseType.RGB,
    'gray': Gimp.ImageBaseType.GRAY,
    'indexed': Gimp.ImageBaseType.INDEXED,
}


def op_test_new_image(args):
    """A bare, empty image (no layers) of the given base type ('rgb'/'gray'/'indexed') -- a direct
    bridge-level fixture for tests that need a grayscale or indexed image to test against, with no
    tool-level indirection in the way."""
    base = args.get('base_type', 'rgb')
    if base not in _TEST_IMAGE_BASE_TYPES:
        raise ValueError('base_type must be one of %s' % sorted(_TEST_IMAGE_BASE_TYPES))
    img = Gimp.Image.new(8, 8, _TEST_IMAGE_BASE_TYPES[base])
    return {'image': img.get_id()}


def op_test_split_image(args):
    """A two-color image split at the horizontal midpoint (left `color_a`, right `color_b`, each a
    `#rrggbb` hex) -- a bridge-level fixture for color_range/magic_wand sample-point tests across
    base types no gimp_* tool can reach directly ('indexed' has no tool-level route in OR out at
    all: `gimp_create_document` only offers rgb/grayscale, `gimp_convert_image_mode` refuses an
    indexed source outright). Always painted in RGB first, then converted -- GIMP has no fill
    primitive that paints indexed pixels by an arbitrary RGB color directly, since a fill has to
    land on a palette entry that may not exist yet."""
    width, height = int(args.get('width', 64)), int(args.get('height', 64))
    base = args.get('base_type', 'rgb')
    if base not in _TEST_IMAGE_BASE_TYPES:
        raise ValueError('base_type must be one of %s' % sorted(_TEST_IMAGE_BASE_TYPES))
    color_a = Gegl.Color.new(lib.validate_hex_color('color_a', args.get('color_a', '#282828')))
    color_b = Gegl.Color.new(lib.validate_hex_color('color_b', args.get('color_b', '#dcdcdc')))
    half = width // 2
    img = Gimp.Image.new(width, height, Gimp.ImageBaseType.RGB)
    try:
        layer = Gimp.Layer.new(img, 'split', width, height, Gimp.ImageType.RGB_IMAGE, 100.0,
                               Gimp.LayerMode.NORMAL)
        img.insert_layer(layer, None, 0)
        Gimp.context_push()
        try:
            img.select_rectangle(Gimp.ChannelOps.REPLACE, 0, 0, half, height)
            Gimp.context_set_foreground(color_a)
            layer.edit_fill(Gimp.FillType.FOREGROUND)
            img.select_rectangle(Gimp.ChannelOps.REPLACE, half, 0, width - half, height)
            Gimp.context_set_foreground(color_b)
            layer.edit_fill(Gimp.FillType.FOREGROUND)
        finally:
            Gimp.context_pop()
        Gimp.Selection.none(img)
        if base == 'gray':
            img.convert_grayscale()
        elif base == 'indexed':
            img.convert_indexed(Gimp.ConvertDitherType.NONE, Gimp.ConvertPaletteType.GENERATE, 8,
                                False, False, '')
    except Exception:
        img.delete()
        raise
    return {'image': img.get_id(), 'width': width, 'height': height, 'half': half}


def op_test_gray_bytes_image_leak(args):
    """Exercises `_gray_bytes_image`'s own cleanup directly: forces the layer build that happens
    AFTER its temp image is created to fail, by swapping `Gimp.Layer.new` for a stub that raises
    (restored in `finally`). A corrupt-pixel-data approach was considered and rejected -- handing
    GEGL a wrong-length buffer risks a native crash instead of a clean Python exception, where this
    sabotages a call GIMP never reaches with bad data at all. Reports whether a new image was left
    open afterward."""
    before = {i.get_id() for i in Gimp.get_images()}
    real_layer_new = Gimp.Layer.new

    def _boom(*_a, **_kw):
        raise RuntimeError('forced failure for the leak test')

    Gimp.Layer.new = _boom
    try:
        raised = False
        try:
            _gray_bytes_image(bytes(64), 8, 8)
        except RuntimeError:
            raised = True
    finally:
        Gimp.Layer.new = real_layer_new
    after = {i.get_id() for i in Gimp.get_images()}
    return {'raised': raised, 'leaked_images': sorted(after - before)}


def op_test_build_no_alpha_gap_xcf(args):
    """A 64x64 RGB .xcf with two NO-ALPHA layers covering only part of the canvas (the top half,
    and the bottom-right quarter), leaving the bottom-left quarter uncovered by either -- for
    testing that `load_mask`'s own explicit black background layer (not GIMP's own flatten
    default) fills the gap a multi-layer, alpha-less source leaves uncovered. No gimp_* tool can
    build a layer with no alpha channel at all (`gimp_layer op=create` always adds one, verified
    live: `_LAYER_CAPABLE_BASE_TYPES` only offers RGBA/GRAYA)."""
    path = lib.require(args, 'path')
    img = Gimp.Image.new(64, 64, Gimp.ImageBaseType.RGB)
    try:
        top = Gimp.Layer.new(img, 'top-half', 64, 32, Gimp.ImageType.RGB_IMAGE, 100.0,
                             Gimp.LayerMode.NORMAL)
        img.insert_layer(top, None, 0)
        top.set_offsets(0, 0)
        top.fill(Gimp.FillType.WHITE)
        corner = Gimp.Layer.new(img, 'bottom-right', 32, 32, Gimp.ImageType.RGB_IMAGE, 100.0,
                                Gimp.LayerMode.NORMAL)
        img.insert_layer(corner, None, 1)
        corner.set_offsets(32, 32)
        corner.fill(Gimp.FillType.WHITE)
        if not Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, img, Gio.File.new_for_path(path), None):
            raise lib.OpError('gimp_op_failed', 'could not save the no-alpha-gap test fixture')
    finally:
        img.delete()
    return {'path': path}


def op_test_reorder_without_dropping_proxy(args):
    """Swaps the image's two topmost layers WITHOUT calling `_drop_proxies` -- deliberately
    bypasses the proxy-invalidation discipline every real structural op in ops.py follows, so a
    live test can confirm `_mirror_filters`'s own (name, is_group) structural guard actually
    fires against a stale, now-mismatched proxy instead of silently mis-rendering."""
    img = _image(args)
    layers = img.get_layers()
    if len(layers) < 2:
        raise ValueError('test_reorder_without_dropping_proxy needs at least 2 top-level layers')
    img.reorder_item(layers[1], None, 0)
    return {'reordered': [l.get_name() for l in img.get_layers()]}


def op_test_add_layer_mask(args):
    """Attach a REAL GIMP layer mask (`Gimp.Layer.create_mask` + `add_mask`) to the target layer
    and paint the LEFT HALF of it black (hidden), leaving the right half at the mask's own WHITE
    default (visible) -- the test probe for proving a layer's own mask transforms along with it
    through `Item.transform_*` (`gimp_transform_layer`), which no shipped gimp_* tool creates
    (`gimp_create_mask` builds an unrelated filter-confinement channel, not a real layer mask)."""
    img = _image(args)
    layer = _layer(img, args)
    mask = layer.create_mask(Gimp.AddMaskType.WHITE)
    layer.add_mask(mask)
    ok, ox, oy = layer.get_offsets()
    x0, y0 = (ox if ok else 0), (oy if ok else 0)
    w, h = layer.get_width(), layer.get_height()
    img.select_rectangle(Gimp.ChannelOps.REPLACE, x0, y0, w / 2.0, h)
    Gimp.context_push()
    try:
        Gimp.context_set_foreground(Gegl.Color.new('black'))
        mask.edit_fill(Gimp.FillType.FOREGROUND)
    finally:
        Gimp.context_pop()
    Gimp.Selection.none(img)
    _drop_proxies(img.get_id())
    return {'mask_id': mask.get_id()}


def op_test_layer_bounds(args):
    """A layer's own {x, y, width, height} directly -- `gimp_inspect what=layers` reports
    offsets but not width/height, so a live test that needs to read a layer's current bounds
    WITHOUT mutating anything (unlike every real gimp_transform_layer op) goes through this
    instead."""
    img = _image(args)
    layer = _layer(img, args)
    ok, x, y = layer.get_offsets()
    return {
        'x': x if ok else None, 'y': y if ok else None,
        'width': layer.get_width(), 'height': layer.get_height(),
    }


OPS.update({
    'test_proxy_filter_count': op_test_proxy_filter_count,
    'test_proxy_ids': op_test_proxy_ids,
    'test_metadata_tag': op_test_metadata_tag,
    'test_nest_groups': op_test_nest_groups,
    'select_mask': op_test_select_mask,
    'export_mask': op_test_export_mask,
    'test_select_rect': op_test_select_rect,
    'test_selection_empty': op_test_selection_empty,
    'test_wrap_in_group': op_test_wrap_in_group,
    'test_add_foreign_filter': op_test_add_foreign_filter,
    'test_add_text_layer': op_test_add_text_layer,
    'test_build_layer_tree': op_test_build_layer_tree,
    'test_all_layers_order': op_test_all_layers_order,
    'test_set_channels_deadline': op_test_set_channels_deadline,
    'test_new_image': op_test_new_image,
    'test_split_image': op_test_split_image,
    'test_reorder_without_dropping_proxy': op_test_reorder_without_dropping_proxy,
    'test_apply_raw_effect': op_test_apply_raw_effect,
    'test_mirror_unattachable': op_test_mirror_unattachable,
    'test_force_effect_update_failure': op_test_force_effect_update_failure,
    'test_add_offset_layer': op_test_add_offset_layer,
    'test_ledger_dump': op_test_ledger_dump,
    'test_gray_bytes_image_leak': op_test_gray_bytes_image_leak,
    'test_build_no_alpha_gap_xcf': op_test_build_no_alpha_gap_xcf,
    'test_add_layer_mask': op_test_add_layer_mask,
    'test_layer_bounds': op_test_layer_bounds,
})


def op_test_save_unstripped(args):
    """Saves the live image to `path` through plain file_save (no metadata stripping), so a
    fixture can carry the image's own metadata into a format the bridge's export refuses."""
    img = _image(args)
    ok = Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, img, Gio.File.new_for_path(args['path']), None)
    return {'ok': bool(ok)}


def op_test_set_orientation_tag(args):
    """Sets Exif.Image.Orientation on the live image's own metadata."""
    img = _image(args)
    md = img.get_metadata()
    md.try_set_tag_string('Exif.Image.Orientation', str(args['value']))
    img.set_metadata(md)
    return {'ok': True}


OPS['test_save_unstripped'] = op_test_save_unstripped
OPS['test_set_orientation_tag'] = op_test_set_orientation_tag


def op_test_set_text_markup(args):
    """Replaces a text layer's content with Pango `markup` (per-character styling, as GIMP's GUI
    stores it), so a live test can check how gimp_text treats a styled layer."""
    img = _image(args)
    layer = Gimp.Item.get_by_id(int(args['layer_id']))
    if layer is None or not layer.is_text_layer():
        raise ValueError('test_set_text_markup needs a text layer_id')
    layer.set_markup(args['markup'])
    return {'ok': bool(layer.get_markup()), 'image': img.get_id()}


OPS['test_set_text_markup'] = op_test_set_text_markup
