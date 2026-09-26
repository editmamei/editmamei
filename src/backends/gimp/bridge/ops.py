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
    img = Gimp.Image.get_by_id(int(args['image']))
    if img is None or not img.is_valid():
        raise ValueError('no open image with id %s' % args['image'])
    return img


def _layer(img, args):
    name = args.get('layer')
    if name:
        layer = img.get_layer_by_name(name)
        if layer is None:
            raise ValueError('no layer named %r' % name)
        return layer
    selected = img.get_selected_layers()
    return selected[0] if selected else img.get_layers()[0]


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
    for layer in img.get_layers():
        for f in layer.get_filters():
            if f.get_id() == filter_id:
                if f.get_operation_name() != operation:
                    raise ValueError(
                        'filter %s is %s, not %s' % (filter_id, f.get_operation_name(), operation)
                    )
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
        for layer in proxy.get_layers():
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
    reopened document rendered R-B 25.4, a readback-mirrored proxy 10.6)."""
    filters, _unknown = _ledger_get(src_img)
    for src, dst in zip(src_img.get_layers(), dst_img.get_layers()):
        for f in reversed(src.get_filters()):  # get_filters() is top-first
            g = Gimp.DrawableFilter.new(dst, f.get_operation_name(), f.get_name())
            src_cfg, dst_cfg = f.get_config(), g.get_config()
            for p in src_cfg.list_properties():
                dst_cfg.set_property(p.name, src_cfg.get_property(p.name))
            rec = filters.get(f.get_name())
            mask = None
            if rec and rec['operation'] == f.get_operation_name():
                SETTERS[rec['operation']](dst_cfg, rec['params'])
                mask = rec['params'].get('mask')
            g.set_opacity(f.get_opacity())
            g.set_blend_mode(f.get_blend_mode())
            _append_masked(dst_img, dst, g, mask)
            g.set_visible(f.get_visible())


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


def _ledger_put(img, filters, unknown):
    """Persist filters/unknown as the ledger parasite. The merge (preserving
    any malformed/foreign record verbatim) and the decision whether writing
    is even safe (a newer-version or undecodable existing parasite) both
    live in `lib.merged_ledger_for_write` -- this function just reads the
    current parasite, calls it, and writes back whatever it returns, if
    anything. `None` means the write was skipped: the filter this call is
    for was still applied to the live image either way; only the persisted
    record is, and list_filters/preview/histogram fall back to readback for
    it exactly as they would for any other foreign filter."""
    existing = img.get_parasite(META)
    existing_raw = bytes(existing.get_data()) if existing else b''
    merged = lib.merged_ledger_for_write(existing_raw, filters, unknown)
    if merged is None:
        sys.stderr.write(
            'editmamei-filters parasite on image %d was not rewritten (see '
            'lib.merged_ledger_for_write); this filter still applied to the live image\n'
            % img.get_id()
        )
        return
    img.attach_parasite(Gimp.Parasite.new(META, Gimp.PARASITE_PERSISTENT, merged))


def _unique_name(img, base):
    taken = {f.get_name() for layer in img.get_layers() for f in layer.get_filters()}
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


SETTERS = {'gimp:curves': _set_curves, 'gimp:levels': _set_levels}


def _channel_by_name(img, name):
    for ch in img.get_channels():
        if ch.get_name() == name:
            return ch
    raise ValueError('no mask channel named %r (create one with select_mask)' % name)


def _append_masked(img, layer, f, mask):
    """Append f, confined to channel `mask` if given. A filter appended while a selection is
    active keeps that selection as its own mask, which persists after the selection is
    cleared and through XCF, so no extra layer or pixel copy is needed."""
    if mask:
        img.select_item(Gimp.ChannelOps.REPLACE, _channel_by_name(img, mask))
    try:
        layer.append_filter(f)
    finally:
        if mask:
            Gimp.Selection.none(img)


def _apply_filter(img, args, operation, params, default_name):
    """Create (or, with filter_id, update in place) a filter and record it in the ledger.
    A new filter may be confined to a mask channel (`mask`); a re-edit keeps the mask the
    filter was created with."""
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
    filters[f.get_name()] = {'operation': operation, 'params': params}
    _ledger_put(img, filters, unknown)
    return {'filter_id': f.get_id(), 'name': f.get_name(), 'mask': params['mask']}


# ---- operations -------------------------------------------------------------------------

def op_ping(args):
    major, minor, micro = lib.parse_gimp_version(Gimp.version())
    return {'major': major, 'minor': minor, 'micro': micro,
            'images': [i.get_id() for i in Gimp.get_images()]}


def op_open(args):
    path = args['path']
    if not os.path.exists(path):
        raise FileNotFoundError('no file at %s' % path)
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
    _proxy(img, 1024)  # build the default preview proxy now so the first preview is fast too
    return _describe(img)


def op_curves(args):
    """One gimp:curves filter per channel: a single filter carries one channel's curve
    (setting red then blue on one filter renders only blue)."""
    img = _image(args)
    points = [[float(x), float(y)] for x, y in args['points']]
    if len(points) < 2:
        raise ValueError('points needs at least two [x, y] pairs')
    params = {'channel': args.get('channel', 'value'), 'points': points}
    return _apply_filter(img, args, 'gimp:curves', params, 'Curves')


def op_levels(args):
    img = _image(args)
    params = {'channel': args.get('channel', 'value'),
              'in_low': float(args.get('in_low', 0)), 'in_high': float(args.get('in_high', 255)),
              'gamma': float(args.get('gamma', 1.0)),
              'out_low': float(args.get('out_low', 0)), 'out_high': float(args.get('out_high', 255))}
    return _apply_filter(img, args, 'gimp:levels', params, 'Levels')


def op_list_filters(args):
    """Bridge-applied filters report the ledger record (`source: editmamei`); anything else
    reports libgimp's readback (`source: readback`), which is lossy for per-channel curves."""
    img = _image(args)
    filters, _unknown = _ledger_get(img)
    out = []
    for layer in img.get_layers():
        for f in layer.get_filters():
            rec = filters.get(f.get_name())
            if rec and rec['operation'] == f.get_operation_name():
                params, source = rec['params'], 'editmamei'
            else:
                cfg, params, source = f.get_config(), {}, 'readback'
                for p in cfg.list_properties():
                    v = cfg.get_property(p.name)
                    if isinstance(v, Gimp.Curve):
                        v = _curve_points(v)
                    elif hasattr(v, 'value_nick'):
                        v = v.value_nick
                    params[p.name] = v
            out.append({'layer': layer.get_name(), 'filter_id': f.get_id(), 'name': f.get_name(),
                        'operation': f.get_operation_name(), 'visible': f.get_visible(),
                        'source': source, 'params': params})
    return {'filters': out}


def _proxy_render(img, max_px):
    """A flattened, downscaled render of img with its live filters: the proxy plus mirrored
    filters. Caller deletes it."""
    dup = _proxy(img, max_px).duplicate()
    try:
        _mirror_filters(img, dup)
        dup.flatten()
    except Exception:
        dup.delete()
        raise
    return dup


def op_preview(args):
    img = _image(args)
    max_px = lib.validate_max_px(int(args.get('max_px', 1024)))
    dup = _proxy_render(img, max_px)
    try:
        Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, dup, Gio.File.new_for_path(args['out_path']), None)
        return {'path': args['out_path'], 'width': dup.get_width(), 'height': dup.get_height()}
    finally:
        dup.delete()


def op_histogram(args):
    """Stats for several channels from ONE render. Default: the 1024 px preview render
    (~0.3 s). exact=True: the full-resolution composite (~3.7 s for 24 MP with filters)."""
    img = _image(args)
    channels = args.get('channels') or list(lib.HIST_CHANNELS)
    bad = [c for c in channels if c not in lib.HIST_CHANNELS]
    if bad:
        raise ValueError('channels must be drawn from %s, got %s' % (list(lib.HIST_CHANNELS), bad))
    exact = bool(args.get('exact', False))
    if exact:
        dup, layer = _composite(img)
    else:
        dup = _proxy_render(img, 1024)
        layer = dup.get_layers()[0]
    try:
        w, h = dup.get_width(), dup.get_height()
        buf = layer.get_buffer()
        rect = Gegl.Rectangle.new(0, 0, w, h)
        rgb = buf.get(rect, 1.0, "R'G'B' u8", Gegl.AbyssPolicy.NONE) if set(channels) - {'luminance'} else None
        lum = buf.get(rect, 1.0, "Y' u8", Gegl.AbyssPolicy.NONE) if 'luminance' in channels else None
    finally:
        dup.delete()
    out = {}
    for ch in channels:
        out[ch] = lib.channel_stats(lum if ch == 'luminance' else rgb[('red', 'green', 'blue').index(ch)::3])
    return {'exact': exact, 'width': w, 'height': h, 'pixels': w * h, 'channels': out}


def op_export(args):
    """Writes path by extension: .xcf saves the live document, anything else exports a flattened copy.

    Flat exports flatten a duplicate first and save that. Handing the live document to
    file_save lets the exporter render the filters itself, which measured 9.3 s for a 24 MP
    JPEG with three curves; flatten (3.0 s) + save of the flat copy (1.0 s) gives the same pixels."""
    img = _image(args)
    path = args['path']
    if path.lower().endswith('.xcf'):
        Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, img, Gio.File.new_for_path(path), None)
    else:
        dup, _flat = _composite(img)
        try:
            Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, dup, Gio.File.new_for_path(path), None)
        finally:
            dup.delete()
    return {'path': path, 'bytes': os.path.getsize(path)}


def op_select_mask(args):
    """Load a mask (8-bit PGM at image size, >=128 = selected) into a named channel, which is
    saved in the XCF, and make it the active selection."""
    img = _image(args)
    with open(args['mask_path'], 'rb') as fh:
        raw = fh.read()
    w, h, data = lib.read_pgm(raw)
    if (w, h) != (img.get_width(), img.get_height()):
        raise ValueError('mask is %dx%d, image is %dx%d' % (w, h, img.get_width(), img.get_height()))
    name = args.get('name', 'Mask')
    for existing in img.get_channels():
        if existing.get_name() == name:
            img.remove_channel(existing)
    ch = Gimp.Channel.new(img, name, w, h, 50.0, Gegl.Color.new('red'))
    img.insert_channel(ch, None, 0)
    buf = ch.get_buffer()
    buf.set(Gegl.Rectangle.new(0, 0, w, h), 'Y u8', data)
    buf.flush()
    ch.update(0, 0, w, h)
    img.select_item(Gimp.ChannelOps.REPLACE, ch)
    _drop_proxies(img.get_id())  # proxies were cut before this channel existed
    selected = sum(1 for b in data if b >= 128)
    return {'channel': name, 'selected_pixels': selected, 'fraction': round(selected / len(data), 4)}


def op_select_none(args):
    Gimp.Selection.none(_image(args))
    return {'selection': 'none'}


def op_export_mask(args):
    """Write the active selection (default) or a named channel as an 8-bit PGM."""
    img = _image(args)
    src = img.get_selection() if args.get('channel') in (None, 'selection') else _channel_by_name(img, args['channel'])
    w, h = img.get_width(), img.get_height()
    data = src.get_buffer().get(Gegl.Rectangle.new(0, 0, w, h), 1.0, 'Y u8', Gegl.AbyssPolicy.NONE)
    with open(args['path'], 'wb') as fh:
        fh.write(lib.write_pgm(w, h, data))
    return {'path': args['path'], 'width': w, 'height': h}


def op_close(args):
    img = _image(args)
    _drop_proxies(img.get_id())
    img.delete()
    return {'closed': int(args['image'])}


OPS = {
    'ping': op_ping, 'open': op_open, 'curves': op_curves, 'levels': op_levels,
    'list_filters': op_list_filters, 'preview': op_preview, 'histogram': op_histogram,
    'export': op_export, 'close': op_close,
    'select_mask': op_select_mask, 'select_none': op_select_none, 'export_mask': op_export_mask,
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
