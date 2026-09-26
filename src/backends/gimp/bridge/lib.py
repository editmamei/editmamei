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


def merged_ledger_for_write(raw, filters, unknown):
    """Compute the bytes to persist as the editmamei-filters parasite, or
    None if the write should be SKIPPED entirely -- the caller's filter still
    applied to the live image either way; only the persisted record is
    skipped in that case (the caller logs it, this function just decides).

    `raw` is the CURRENT parasite bytes, read fresh right before writing.
    `filters`/`unknown` are the caller's own updated view (e.g. `filters`
    with one new or edited record merged in) of what was read from this same
    `raw` a moment earlier, via `parse_ledger`.

    Returns None (skip the write) when:
    - `raw` is a newer version than this bridge understands
      (`ledger_is_newer_version`) -- writing would silently downgrade a
      future writer's document to this bridge's own schema.
    - `raw` isn't decodable as a ledger at all (`ledger_is_undecodable`) --
      writing would permanently destroy bytes that were never actually
      parsed in the first place.

    Otherwise, re-parses `raw` for its own `raw_filters_by_name` (which
    preserves a malformed or foreign record verbatim -- see `parse_ledger`)
    and returns the serialized ledger as UTF-8 bytes: those raw filters
    merged with `filters` (`filters` wins on a shared key, since it's the
    caller's own newer view), keeping `unknown` as the top-level passthrough
    fields. This is the ONE place that decides whether and how a rewrite
    happens -- callers (`ops.py`'s `_ledger_put`) just hand it bytes in and
    get bytes-or-None back, with no merge or skip logic of their own to keep
    in sync with this module's."""
    if ledger_is_newer_version(raw) or ledger_is_undecodable(raw):
        return None
    _valid, _existing_unknown, raw_filters = parse_ledger(raw)
    merged = dict(raw_filters)
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
