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
    if _mask_name_in_use(img, name):
        raise ValueError(
            'mask %r is already used by an existing filter; delete that filter or use a '
            'different name' % name
        )
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
    src = img.get_selection() if channel in (None, 'selection') else _channel_by_name(img, channel)
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


OPS.update({
    'test_proxy_filter_count': op_test_proxy_filter_count,
    'test_metadata_tag': op_test_metadata_tag,
    'test_nest_groups': op_test_nest_groups,
    'select_mask': op_test_select_mask,
    'export_mask': op_test_export_mask,
    'test_select_rect': op_test_select_rect,
    'test_selection_empty': op_test_selection_empty,
    'test_wrap_in_group': op_test_wrap_in_group,
    'test_add_foreign_filter': op_test_add_foreign_filter,
    'test_add_text_layer': op_test_add_text_layer,
})
