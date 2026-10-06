# Stdlib-only unit tests for lib.py: no GIMP, no numpy, no third-party
# dependency at all. Run directly with `python -m unittest test_lib.py` from
# this directory (a vitest wrapper does this automatically when a `python`/
# `python3` executable is available — see tests/backends/gimp/bridge-python.
# test.ts). NOT staged into dist/ (scripts/copy-gimp-bridge.ts stages only
# ops.py and lib.py) since it never runs in a shipped install.

import contextlib
import importlib
import json
import math
import os
import tempfile
import unittest

import lib


class TestPgm(unittest.TestCase):
    def test_round_trip(self):
        data = bytes([0, 128, 255, 64, 32, 200])
        encoded = lib.write_pgm(3, 2, data)
        w, h, decoded = lib.read_pgm(encoded)
        self.assertEqual((w, h), (3, 2))
        self.assertEqual(decoded, data)

    def test_rejects_non_p5(self):
        with self.assertRaises(ValueError):
            lib.read_pgm(b'P2\n1 1\n255\n\x00')

    def test_rejects_truncated_data(self):
        with self.assertRaises(ValueError):
            lib.read_pgm(b'P5\n2 2\n255\n\x00')

    def test_rejects_empty_file(self):
        # Regression: b''.isspace() is False, so the old "scan until
        # whitespace" loop treated running off the end of an empty buffer as
        # "found another non-whitespace byte" and spun forever instead of
        # raising. Bounded by len(raw) now.
        with self.assertRaises(ValueError):
            lib.read_pgm(b'')

    def test_rejects_truncated_header(self):
        # Same infinite-loop hazard as the empty-file case, triggered partway
        # through the header instead of at byte 0.
        with self.assertRaises(ValueError):
            lib.read_pgm(b'P5\n2 2\n')

    def test_rejects_header_cut_off_mid_token(self):
        with self.assertRaises(ValueError):
            lib.read_pgm(b'P5\n2')


class TestChannelStats(unittest.TestCase):
    def test_uniform_channel(self):
        stats = lib.channel_stats(bytes([100] * 64))
        self.assertEqual(stats['mean'], 100)
        self.assertEqual(stats['median'], 100)
        self.assertEqual(stats['p1'], 100)
        self.assertEqual(stats['p99'], 100)
        self.assertEqual(len(stats['bins']), 256)
        self.assertEqual(stats['bins'][100], 64)

    def test_percentiles_on_a_ramp(self):
        # 0..255 once each: pct(p) is the smallest v with cumulative count
        # (v+1) >= p*256, so the exact values below follow directly from that
        # definition (not "roughly p*256" -- e.g. median is 127, not 128).
        stats = lib.channel_stats(bytes(range(256)))
        self.assertEqual(stats['mean'], 127.5)
        self.assertEqual(stats['median'], 127)
        self.assertEqual(stats['p1'], 2)
        self.assertEqual(stats['p5'], 12)
        self.assertEqual(stats['p95'], 243)
        self.assertEqual(stats['p99'], 253)


class TestLedger(unittest.TestCase):
    def test_absent_parasite_is_empty(self):
        filters, unknown, raw_filters = lib.parse_ledger('')
        self.assertEqual(filters, {})
        self.assertEqual(unknown, {})
        self.assertEqual(raw_filters, {})

    def test_unparsable_json_is_treated_as_absent(self):
        filters, unknown, raw_filters = lib.parse_ledger('{not json')
        self.assertEqual(filters, {})
        self.assertEqual(unknown, {})
        self.assertEqual(raw_filters, {})

    def test_non_dict_json_is_treated_as_absent(self):
        filters, unknown, raw_filters = lib.parse_ledger(json.dumps([1, 2, 3]))
        self.assertEqual(filters, {})
        self.assertEqual(unknown, {})
        self.assertEqual(raw_filters, {})

    def test_bare_map_is_v1_compatible(self):
        # The pre-versioning format: the parasite bytes ARE the filters map,
        # no wrapper. Files written before the ledger was versioned must
        # keep working.
        raw = json.dumps({'Curves': {'operation': 'gimp:curves', 'params': {'points': [[0, 0], [255, 255]]}}})
        filters, unknown, _raw_filters = lib.parse_ledger(raw)
        self.assertEqual(unknown, {})
        self.assertEqual(filters['Curves']['operation'], 'gimp:curves')

    def test_legacy_document_with_a_literal_v_key_stays_legacy_without_a_dict_filters_key(self):
        # Versioned vs. legacy is decided by SHAPE (int "v" AND dict
        # "filters"), not by the key "v" alone -- a legacy document that
        # happens to contain a filter literally named "v" must not be
        # misread as a versioned wrapper.
        raw = json.dumps({'v': {'operation': 'gimp:curves', 'params': {}}})
        filters, unknown, _raw_filters = lib.parse_ledger(raw)
        self.assertEqual(unknown, {})
        self.assertIn('v', filters)

    def test_v1_document_round_trips_and_keeps_unknown_top_level(self):
        filters_in = {'Curves': {'operation': 'gimp:curves', 'params': {'points': [[0, 0], [255, 255]]}}}
        raw = lib.serialize_ledger(filters_in, {'future_field': 'kept'})
        doc = json.loads(raw)
        self.assertEqual(doc['v'], lib.LEDGER_VERSION)
        self.assertEqual(doc['writer'], lib.LEDGER_WRITER)

        filters_out, unknown_out, raw_filters_out = lib.parse_ledger(raw)
        self.assertEqual(filters_out, filters_in)
        self.assertEqual(unknown_out, {'future_field': 'kept'})
        self.assertEqual(raw_filters_out, filters_in)

    def test_newer_version_falls_back_to_absent_filters_but_keeps_unknown_keys(self):
        raw = json.dumps({
            'v': lib.LEDGER_VERSION + 1,
            'writer': 'editmamei/9.9.9',
            'filters': {'Curves': {'operation': 'gimp:curves', 'params': {}}},
            'a_future_field': 'preserve me',
        })
        filters, unknown, _raw_filters = lib.parse_ledger(raw)
        # We don't understand this version's filter records, so every filter
        # falls back to readback rather than risk misinterpreting them.
        self.assertEqual(filters, {})
        self.assertEqual(unknown, {'a_future_field': 'preserve me'})

    def test_write_after_reading_a_newer_version_preserves_unknown_keys_only(self):
        raw = json.dumps({
            'v': lib.LEDGER_VERSION + 1,
            'filters': {'Curves': {'operation': 'gimp:curves', 'params': {}}},
            'kept': 'yes',
        })
        filters, unknown, _raw_filters = lib.parse_ledger(raw)
        filters['NewFilter'] = {'operation': 'gimp:levels', 'params': {}}
        rewritten = lib.serialize_ledger(filters, unknown)
        doc = json.loads(rewritten)
        self.assertEqual(doc['v'], lib.LEDGER_VERSION)
        self.assertEqual(doc['kept'], 'yes')
        self.assertEqual(list(doc['filters'].keys()), ['NewFilter'])

    def test_ledger_is_newer_version(self):
        older = json.dumps({'v': lib.LEDGER_VERSION, 'filters': {}})
        newer = json.dumps({'v': lib.LEDGER_VERSION + 1, 'filters': {}})
        legacy = json.dumps({'Curves': {'operation': 'gimp:curves', 'params': {}}})
        self.assertFalse(lib.ledger_is_newer_version(''))
        self.assertFalse(lib.ledger_is_newer_version(older))
        self.assertFalse(lib.ledger_is_newer_version(legacy))
        self.assertFalse(lib.ledger_is_newer_version('{not json'))
        self.assertTrue(lib.ledger_is_newer_version(newer))

    def test_malformed_filter_record_is_dropped_as_if_absent(self):
        raw = json.dumps({
            'v': 1,
            'filters': {
                'Good': {'operation': 'gimp:curves', 'params': {'points': []}},
                'MissingParams': {'operation': 'gimp:curves'},
                'ParamsNotADict': {'operation': 'gimp:curves', 'params': 'nope'},
                'OperationNotAString': {'operation': 3, 'params': {}},
                'NotADict': 'nope',
            },
        })
        filters, unknown, raw_filters = lib.parse_ledger(raw)
        self.assertEqual(list(filters.keys()), ['Good'])
        self.assertEqual(unknown, {})
        # The malformed records are dropped from the VALIDATED view, but
        # still present verbatim in raw_filters for a rewrite to preserve.
        self.assertEqual(
            set(raw_filters.keys()),
            {'Good', 'MissingParams', 'ParamsNotADict', 'OperationNotAString', 'NotADict'},
        )

    def test_malformed_record_in_a_legacy_bare_map_is_also_dropped(self):
        raw = json.dumps({
            'Good': {'operation': 'gimp:curves', 'params': {}},
            'Bad': {'operation': 'gimp:curves'},  # missing params
        })
        filters, _unknown, raw_filters = lib.parse_ledger(raw)
        self.assertEqual(list(filters.keys()), ['Good'])
        self.assertEqual(set(raw_filters.keys()), {'Good', 'Bad'})

    def test_non_utf8_bytes_are_treated_as_absent(self):
        raw = b'\xff\xfe\x00\x01 not valid utf-8'
        filters, unknown, raw_filters = lib.parse_ledger(raw)
        self.assertEqual(filters, {})
        self.assertEqual(unknown, {})
        self.assertEqual(raw_filters, {})
        self.assertFalse(lib.ledger_is_newer_version(raw))

    def test_bytes_input_is_equivalent_to_str_input(self):
        doc = {'v': 1, 'filters': {'Curves': {'operation': 'gimp:curves', 'params': {}}}}
        raw_str = json.dumps(doc)
        filters_from_str, unknown_from_str, raw_from_str = lib.parse_ledger(raw_str)
        filters_from_bytes, unknown_from_bytes, raw_from_bytes = lib.parse_ledger(raw_str.encode('utf-8'))
        self.assertEqual(filters_from_bytes, filters_from_str)
        self.assertEqual(unknown_from_bytes, unknown_from_str)
        self.assertEqual(raw_from_bytes, raw_from_str)

    def test_ledger_is_undecodable(self):
        valid_v1 = json.dumps({'v': 1, 'filters': {}})
        valid_legacy = json.dumps({'Curves': {'operation': 'gimp:curves', 'params': {}}})
        newer = json.dumps({'v': lib.LEDGER_VERSION + 1, 'filters': {}})
        non_utf8 = b'\xff\xfe\x00\x01 not valid utf-8'
        # Absent: nothing to lose, safe to write a fresh document over.
        self.assertFalse(lib.ledger_is_undecodable(''))
        self.assertFalse(lib.ledger_is_undecodable(None))
        # Well-formed, at any version this bridge does or doesn't recognize
        # every filter in: still fully decodable as a ledger document.
        self.assertFalse(lib.ledger_is_undecodable(valid_v1))
        self.assertFalse(lib.ledger_is_undecodable(valid_legacy))
        self.assertFalse(lib.ledger_is_undecodable(newer))
        # Genuinely unreadable: bytes that were never a ledger to begin with.
        self.assertTrue(lib.ledger_is_undecodable(non_utf8))
        self.assertTrue(lib.ledger_is_undecodable('{not json'))
        self.assertTrue(lib.ledger_is_undecodable(json.dumps([1, 2, 3])))


class TestMergedLedgerForWrite(unittest.TestCase):
    """`lib.merged_ledger_for_write` is the ONE place that owns both the
    merge and the should-rewrite decision for a ledger write -- these call
    it directly rather than re-implementing either piece of logic here."""

    def test_preserves_a_malformed_record_it_does_not_touch(self):
        # A foreign or malformed record sits alongside our own well-formed
        # one, and this bridge adds a DIFFERENT, new record. The rewrite
        # must not drop the one it never read or touched.
        raw = json.dumps({
            'v': 1,
            'filters': {
                'Good': {'operation': 'gimp:curves', 'params': {'points': []}},
                'Parasite': {'operation': 'gimp:curves'},  # missing params -- malformed
            },
        })
        filters, unknown, _raw_filters = lib.parse_ledger(raw)
        filters['NewFilter'] = {'operation': 'gimp:levels', 'params': {}}
        written = lib.merged_ledger_for_write(raw, filters, unknown)
        doc = json.loads(written.decode('utf-8'))
        self.assertEqual(doc['filters']['Parasite'], {'operation': 'gimp:curves'})
        self.assertEqual(doc['filters']['Good']['operation'], 'gimp:curves')
        self.assertEqual(doc['filters']['NewFilter']['operation'], 'gimp:levels')

    def test_own_entries_win_over_the_raw_record_on_a_shared_key(self):
        raw = json.dumps({
            'v': 1,
            'filters': {'Curves': {'operation': 'gimp:curves', 'params': {'points': [[0, 0]]}}},
        })
        filters, unknown, _raw_filters = lib.parse_ledger(raw)
        filters['Curves'] = {'operation': 'gimp:curves', 'params': {'points': [[1, 1]]}}
        written = lib.merged_ledger_for_write(raw, filters, unknown)
        doc = json.loads(written.decode('utf-8'))
        self.assertEqual(doc['filters']['Curves']['params']['points'], [[1, 1]])

    def test_returns_none_and_does_not_write_over_a_newer_version(self):
        raw = json.dumps({'v': lib.LEDGER_VERSION + 1, 'filters': {}, 'kept': 'yes'})
        self.assertIsNone(lib.merged_ledger_for_write(raw, {'New': {'operation': 'x', 'params': {}}}, {}))

    def test_returns_none_and_does_not_write_over_undecodable_bytes(self):
        raw = b'\xff\xfe\x00\x01 not valid utf-8'
        self.assertIsNone(lib.merged_ledger_for_write(raw, {'New': {'operation': 'x', 'params': {}}}, {}))

    def test_writes_a_fresh_document_when_the_parasite_is_absent(self):
        written = lib.merged_ledger_for_write('', {'New': {'operation': 'x', 'params': {}}}, {})
        doc = json.loads(written.decode('utf-8'))
        self.assertEqual(doc['filters'], {'New': {'operation': 'x', 'params': {}}})
        self.assertEqual(doc['v'], lib.LEDGER_VERSION)


class TestGimpVersion(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(lib.parse_gimp_version('3.2.6'), (3, 2, 6))

    def test_prerelease_suffix_takes_leading_ints(self):
        self.assertEqual(lib.parse_gimp_version('3.2.0-RC1'), (3, 2, 0))

    def test_short_version_defaults_missing_parts_to_zero(self):
        self.assertEqual(lib.parse_gimp_version('3'), (3, 0, 0))
        self.assertEqual(lib.parse_gimp_version('3.2'), (3, 2, 0))


class TestTransport(unittest.TestCase):
    def test_id_from_filename(self):
        self.assertEqual(lib.id_from_filename('/tmp/rpc/req-42.json'), 42)
        self.assertIsNone(lib.id_from_filename('/tmp/rpc/req-42.json.tmp'))
        self.assertIsNone(lib.id_from_filename('/tmp/rpc/resp-42.json'))
        self.assertIsNone(lib.id_from_filename('/tmp/rpc/req-abc.json'))

    def test_response_path_ignores_anything_in_the_request_and_derives_from_id(self):
        self.assertEqual(lib.response_path('/tmp/rpc', 7), os.path.join('/tmp/rpc', 'resp-7.json'))

    def test_list_requests_orders_by_id_and_skips_non_matching_names(self):
        with tempfile.TemporaryDirectory() as rpc:
            for name in ['req-10.json', 'req-2.json', 'req-1.json', 'req-x.json', 'resp-1.json', 'req-1.json.tmp']:
                open(os.path.join(rpc, name), 'w').close()
            self.assertEqual(lib.list_requests(rpc), ['req-1.json', 'req-2.json', 'req-10.json'])

    def test_read_request_parses_a_valid_file(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'req-1.json')
            with open(path, 'w', encoding='utf-8') as fh:
                json.dump({'id': 1, 'op': 'ping', 'args': {}}, fh)
            self.assertEqual(lib.read_request(path), {'id': 1, 'op': 'ping', 'args': {}})

    def test_read_request_raises_immediately_on_malformed_json_without_retrying(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'req-1.json')
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write('{not json')
            retries = []
            with self.assertRaises(json.JSONDecodeError):
                lib.read_request(path, on_retry=lambda exc, attempt: retries.append(attempt))
            self.assertEqual(retries, [])  # never retried a genuinely bad body

    def test_read_request_retries_on_os_error_then_succeeds(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'req-1.json')
            calls = {'n': 0}
            real_open = open

            def flaky_open(p, *a, **kw):
                if p == path and calls['n'] < 2:
                    calls['n'] += 1
                    raise PermissionError('simulated transient lock')
                return real_open(p, *a, **kw)

            with open(path, 'w', encoding='utf-8') as fh:
                json.dump({'id': 1, 'op': 'ping', 'args': {}}, fh)

            retries = []
            import builtins
            original = builtins.open
            builtins.open = flaky_open
            try:
                result = lib.read_request(path, delay_s=0, on_retry=lambda exc, attempt: retries.append(attempt))
            finally:
                builtins.open = original
            self.assertEqual(result, {'id': 1, 'op': 'ping', 'args': {}})
            self.assertEqual(retries, [0, 1])

    def test_read_request_gives_up_after_attempts_exhausted(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'req-1.json')  # never created
            with self.assertRaises(OSError):
                lib.read_request(path, attempts=2, delay_s=0)

    def test_write_response_normal(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'resp-1.json')
            lib.write_response(path, {'id': 1, 'ok': True, 'result': {'a': 1}})
            with open(path, encoding='utf-8') as fh:
                self.assertEqual(json.load(fh), {'id': 1, 'ok': True, 'result': {'a': 1}})

    def test_write_response_falls_back_when_result_is_not_serialisable(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'resp-1.json')
            lib.write_response(path, {'id': 1, 'ok': True, 'result': {1, 2, 3}})  # a set: not JSON-able
            with open(path, encoding='utf-8') as fh:
                resp = json.load(fh)
            self.assertEqual(resp['id'], 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'gimp_op_failed')
            self.assertIn('set', resp['error'])

    def test_write_response_falls_back_on_a_circular_reference(self):
        # json.dump raises ValueError (not TypeError) for a circular
        # reference -- the fallback must catch that too, not just the
        # not-JSON-able-type case above.
        circular = {}
        circular['self'] = circular
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'resp-1.json')
            lib.write_response(path, {'id': 1, 'ok': True, 'result': circular})
            with open(path, encoding='utf-8') as fh:
                resp = json.load(fh)
            self.assertEqual(resp['id'], 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'gimp_op_failed')

    def test_write_response_logs_and_returns_when_the_fallback_write_also_fails(self):
        # The directory itself is gone -- both the primary write AND the
        # fallback write fail. Must not raise: the caller (process_request,
        # serve()'s loop) would otherwise go down with it.
        path = os.path.join(tempfile.mkdtemp(), 'nested', 'resp-1.json')  # 'nested' does not exist
        lib.write_response(path, {'id': 1, 'ok': True, 'result': {1, 2, 3}})  # must not raise
        self.assertFalse(os.path.exists(path))

    def test_safe_remove_ignores_missing_file(self):
        lib.safe_remove('/does/not/exist/at/all.json')  # must not raise


class TestProcessLiveness(unittest.TestCase):
    def test_current_process_is_alive(self):
        self.assertTrue(lib.is_process_alive(os.getpid()))

    def test_a_pid_that_almost_certainly_does_not_exist_is_not_alive(self):
        self.assertFalse(lib.is_process_alive(999999999))


class TestValidateMaxPx(unittest.TestCase):
    def test_allows_the_three_supported_sizes(self):
        for value in (512, 1024, 2048):
            self.assertEqual(lib.validate_max_px(value), value)

    def test_rejects_anything_else(self):
        for value in (0, -1, 256, 1000, 4096):
            with self.assertRaises(ValueError):
                lib.validate_max_px(value)


class TestProcessRequest(unittest.TestCase):
    """`lib.process_request` is the whole per-request pipeline `ops.py`'s
    serve() loop drives, with a fake `dispatch` standing in for the real
    OPS table -- no GIMP involved at all."""

    def _write_req(self, rpc, req_id, body):
        path = os.path.join(rpc, 'req-%d.json' % req_id)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(body, fh)
        return path

    def _read_resp(self, rpc, req_id):
        with open(os.path.join(rpc, 'resp-%d.json' % req_id), encoding='utf-8') as fh:
            return json.load(fh)

    def test_malformed_json_answers_invalid_argument_and_deletes_the_request(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'req-1.json')
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write('{not json')
            lib.process_request(path, rpc, lambda op, args: None)
            self.assertFalse(os.path.exists(path))
            resp = self._read_resp(rpc, 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'invalid_argument')

    def test_missing_op_answers_invalid_argument(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(rpc, 1, {'id': 1, 'args': {}})
            lib.process_request(path, rpc, lambda op, args: None)
            self.assertFalse(os.path.exists(path))
            resp = self._read_resp(rpc, 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'invalid_argument')

    def test_unknown_op_answers_invalid_argument(self):
        def dispatch(op, args):
            raise lib.OpError('invalid_argument', 'unknown op %r' % op)

        with tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(rpc, 1, {'id': 1, 'op': 'nope', 'args': {}})
            lib.process_request(path, rpc, dispatch)
            self.assertFalse(os.path.exists(path))
            resp = self._read_resp(rpc, 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'invalid_argument')

    def test_non_int_body_id_is_rejected(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(rpc, 1, {'id': '1', 'op': 'ping', 'args': {}})
            lib.process_request(path, rpc, lambda op, args: {'ok': True})
            self.assertFalse(os.path.exists(path))
            resp = self._read_resp(rpc, 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'invalid_argument')

    def test_float_body_id_is_rejected(self):
        # Regression: a non-int body id used to be handed straight to
        # response_path (which does `'resp-%d.json' % req_id`), raising
        # OUTSIDE any try/except -- the request was then never deleted and
        # serve() re-read (and re-failed on) it forever.
        with tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(rpc, 1, {'id': 1.5, 'op': 'ping', 'args': {}})
            lib.process_request(path, rpc, lambda op, args: {'ok': True})
            self.assertFalse(os.path.exists(path))
            resp = self._read_resp(rpc, 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'invalid_argument')

    def test_mismatched_body_id_is_rejected_and_answered_on_the_filename_id(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(rpc, 1, {'id': 2, 'op': 'ping', 'args': {}})
            lib.process_request(path, rpc, lambda op, args: {'ok': True})
            self.assertFalse(os.path.exists(path))
            resp = self._read_resp(rpc, 1)  # answered on 1 (the filename), never 2 (the body)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'invalid_argument')
            self.assertFalse(os.path.exists(os.path.join(rpc, 'resp-2.json')))

    def test_id_omitted_from_the_body_falls_back_to_the_filename_id(self):
        with tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(rpc, 3, {'op': 'ping', 'args': {}})
            lib.process_request(path, rpc, lambda op, args: {'ok': True})
            resp = self._read_resp(rpc, 3)
            self.assertTrue(resp['ok'])

    def test_op_that_raises_is_classified_and_the_request_is_still_deleted(self):
        def dispatch(op, args):
            raise ValueError('bad args')

        with tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(rpc, 1, {'id': 1, 'op': 'curves', 'args': {}})
            lib.process_request(path, rpc, dispatch)
            self.assertFalse(os.path.exists(path))
            resp = self._read_resp(rpc, 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'invalid_argument')
            self.assertIn('bad args', resp['error'])
            self.assertIn('trace', resp)

    def test_unserialisable_result_falls_back_and_the_request_is_still_deleted(self):
        def dispatch(op, args):
            return {1, 2, 3}  # a set: not JSON-able

        with tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(rpc, 1, {'id': 1, 'op': 'weird', 'args': {}})
            lib.process_request(path, rpc, dispatch)
            self.assertFalse(os.path.exists(path))
            resp = self._read_resp(rpc, 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'gimp_op_failed')

    def test_successful_dispatch_answers_ok_and_deletes_the_request(self):
        def dispatch(op, args):
            return {'echo': args}

        with tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(rpc, 1, {'id': 1, 'op': 'ping', 'args': {'x': 1}})
            lib.process_request(path, rpc, dispatch)
            self.assertFalse(os.path.exists(path))
            resp = self._read_resp(rpc, 1)
            self.assertTrue(resp['ok'])
            self.assertEqual(resp['result'], {'echo': {'x': 1}})

    def test_read_error_after_retries_exhausted_answers_gimp_op_failed(self):
        # The request file never exists at all -- read_request's internal
        # OSError retries run out and it re-raises the OSError. That's an
        # operational failure (a persistent lock/permission problem), not a
        # bad request body, so it must NOT be reported as invalid_argument.
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'req-1.json')  # never created
            lib.process_request(path, rpc, lambda op, args: None)
            resp = self._read_resp(rpc, 1)
            self.assertFalse(resp['ok'])
            self.assertEqual(resp['code'], 'gimp_op_failed')

    def test_refuses_to_delete_a_request_path_outside_rpc_dir(self):
        # req_path is always constructed from rpc_dir by list_requests() in
        # practice, but process_request accepts it as a bare argument -- this
        # is the guard against ever deleting outside the directory it's
        # confined to (e.g. a symlink planted in the rpc directory).
        with tempfile.TemporaryDirectory() as outside, tempfile.TemporaryDirectory() as rpc:
            path = self._write_req(outside, 1, {'id': 1, 'op': 'ping', 'args': {}})
            lib.process_request(path, rpc, lambda op, args: {'ok': True})
            self.assertTrue(os.path.exists(path))  # NOT deleted -- outside rpc_dir
            resp = self._read_resp(rpc, 1)  # the response still lands in rpc_dir, correctly
            self.assertTrue(resp['ok'])

    def test_is_within_returns_false_for_a_different_drive_path_on_windows(self):
        # os.path.commonpath raises ValueError (not just "doesn't match")
        # when the two paths don't even share a root -- e.g. different
        # drive letters on Windows. That must degrade to "not within",
        # same as any other can't-confirm-it's-inside case, not propagate.
        if os.name != 'nt':
            self.skipTest('drive-letter paths are Windows-specific')
        self.assertFalse(lib._is_within('D:\\some\\req-1.json', 'C:\\rpc'))

    def test_a_file_not_matching_the_naming_convention_is_still_deleted(self):
        # "The request file must be deleted on every path" includes this one
        # -- process_request has nothing safe to answer (no filename id) but
        # must not leave a file behind for anything to trip over later.
        with tempfile.TemporaryDirectory() as rpc:
            path = os.path.join(rpc, 'not-a-request.json')
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write('irrelevant')
            lib.process_request(path, rpc, lambda op, args: None)
            self.assertFalse(os.path.exists(path))


class TestRangeValidation(unittest.TestCase):
    def test_validate_range_accepts_bounds_inclusive(self):
        self.assertEqual(lib.validate_range('x', 0, 0, 100), 0.0)
        self.assertEqual(lib.validate_range('x', 100, 0, 100), 100.0)

    def test_validate_range_rejects_out_of_bounds_and_names_the_field(self):
        with self.assertRaisesRegex(ValueError, 'brightness'):
            lib.validate_range('brightness', 101, -100, 100)

    def test_validate_int_range_rejects_non_integral_bounds_violation(self):
        with self.assertRaises(ValueError):
            lib.validate_int_range('strength', 33, 1, 32)

    def test_validate_choice_rejects_unknown_value_and_lists_choices(self):
        with self.assertRaisesRegex(ValueError, 'range'):
            lib.validate_choice('range', 'nope', lib.TRANSFER_MODES)

    def test_pct_to_unit_maps_100_to_1(self):
        self.assertEqual(lib.pct_to_unit('x', 100), 1.0)
        self.assertEqual(lib.pct_to_unit('x', -100), -1.0)

    def test_degrees_to_unit_maps_180_to_1(self):
        self.assertEqual(lib.degrees_to_unit('hue', 180), 1.0)
        self.assertEqual(lib.degrees_to_unit('hue', -180), -1.0)


def _create_defaults(type_):
    return lib.ADJUST_CREATE_DEFAULTS[type_]


class TestAdjustParamBuilders(unittest.TestCase):
    """Every builder takes (args, defaults) -- the re-edit-merge contract `resolve_field`
    implements. These tests exercise the CREATE path (`defaults` = the type's own hardcoded
    creation defaults); `TestResolveFieldMerge` below covers the RE-EDIT (merge) path
    specifically."""

    def test_every_type_has_a_matching_operation(self):
        for type_ in lib.ADJUST_PARAM_BUILDERS:
            self.assertIn(type_, lib.ADJUST_OPERATIONS)

    def test_build_exposure_params_defaults(self):
        params = lib.build_exposure_params({}, _create_defaults('exposure'))
        self.assertEqual(params, {'exposure': 0.0, 'black-level': 0.0})

    def test_build_exposure_params_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            lib.build_exposure_params({'exposure': 11}, _create_defaults('exposure'))

    def test_build_brightness_contrast_params_converts_percent_to_unit(self):
        params = lib.build_brightness_contrast_params(
            {'brightness': 50, 'contrast': -25}, _create_defaults('brightness_contrast')
        )
        self.assertEqual(params, {'brightness': 0.5, 'contrast': -0.25})

    def test_build_hue_saturation_params_defaults_and_conversion(self):
        params = lib.build_hue_saturation_params(
            {'hue': 90, 'saturation': 50}, _create_defaults('hue_saturation')
        )
        self.assertEqual(params['range'], 'all')
        self.assertEqual(params['hue'], 0.5)
        self.assertEqual(params['saturation'], 0.5)
        self.assertEqual(params['lightness'], 0.0)

    def test_build_hue_saturation_params_rejects_bad_range(self):
        with self.assertRaises(ValueError):
            lib.build_hue_saturation_params({'range': 'purple'}, _create_defaults('hue_saturation'))

    def test_build_color_balance_params_defaults_to_midtones_preserving_luminosity(self):
        params = lib.build_color_balance_params({}, _create_defaults('color_balance'))
        self.assertEqual(params['range'], 'midtones')
        self.assertTrue(params['preserve-luminosity'])

    def test_build_color_temperature_params_field_mapping(self):
        params = lib.build_color_temperature_params(
            {'from_kelvin': 5000, 'to_kelvin': 7000}, _create_defaults('color_temperature')
        )
        self.assertEqual(params['original-temperature'], 5000.0)
        self.assertEqual(params['intended-temperature'], 7000.0)

    def test_build_shadows_highlights_params_has_every_property(self):
        params = lib.build_shadows_highlights_params(
            {'radius': 200}, _create_defaults('shadows_highlights')
        )
        self.assertEqual(
            set(params),
            {'shadows', 'highlights', 'whitepoint', 'radius', 'compress',
             'shadows-ccorrect', 'highlights-ccorrect'},
        )
        self.assertEqual(params['radius'], 200.0)

    def test_build_shadows_highlights_params_rejects_radius_out_of_range(self):
        with self.assertRaises(ValueError):
            lib.build_shadows_highlights_params(
                {'radius': 1501}, _create_defaults('shadows_highlights')
            )

    def test_build_saturation_params_default_is_no_op_scale(self):
        self.assertEqual(
            lib.build_saturation_params({}, _create_defaults('saturation')), {'scale': 1.0}
        )

    def test_build_vibrance_params_defaults(self):
        self.assertEqual(
            lib.build_vibrance_params({}, _create_defaults('vibrance')),
            {'vibrance': 0.0, 'saturation': 1.0},
        )

    def test_build_sharpen_params_field_mapping(self):
        params = lib.build_sharpen_params(
            {'radius': 5, 'amount': 1.0, 'threshold': 0.1}, _create_defaults('sharpen')
        )
        self.assertEqual(params, {'std-dev': 5.0, 'scale': 1.0, 'threshold': 0.1})

    def test_build_noise_reduction_params_rejects_zero(self):
        # GEGL's own iterations pspec allows 0; the user-facing "strength" floor is 1 --
        # 0 iterations is a no-op filter, which is never what a caller means to create.
        with self.assertRaises(ValueError):
            lib.build_noise_reduction_params({'strength': 0}, _create_defaults('noise_reduction'))

    def test_build_noise_reduction_params_default(self):
        self.assertEqual(
            lib.build_noise_reduction_params({}, _create_defaults('noise_reduction')),
            {'iterations': 4},
        )


def _effect_create_defaults(filter_type):
    return lib.EFFECT_CREATE_DEFAULTS[filter_type]


class TestEffectParamBuilders(unittest.TestCase):
    """gimp_add_effect's builders -- the EFFECT_* parallel tables to ADJUST_PARAM_BUILDERS
    tested above. Same (args, defaults) merge contract via resolve_field."""

    def test_every_filter_has_a_matching_operation(self):
        for filter_type in lib.EFFECT_PARAM_BUILDERS:
            self.assertIn(filter_type, lib.EFFECT_OPERATIONS)

    def test_build_vignette_params_defaults(self):
        params = lib.build_vignette_params({}, _effect_create_defaults('vignette'))
        self.assertEqual(params, {'radius': 2.0, 'softness': 1.0, 'gamma': 2.0, 'x': 0.5, 'y': 0.5})

    def test_build_vignette_params_maps_center_x_y_to_x_y(self):
        params = lib.build_vignette_params(
            {'center_x': 0.3, 'center_y': 0.7}, _effect_create_defaults('vignette')
        )
        self.assertEqual(params['x'], 0.3)
        self.assertEqual(params['y'], 0.7)

    def test_build_vignette_params_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            lib.build_vignette_params({'radius': 3.1}, _effect_create_defaults('vignette'))
        with self.assertRaises(ValueError):
            lib.build_vignette_params({'center_x': 1.1}, _effect_create_defaults('vignette'))

    def test_build_black_white_params_defaults(self):
        params = lib.build_black_white_params({}, _effect_create_defaults('black_white'))
        self.assertEqual(
            params, {'red': 0.333, 'green': 0.333, 'blue': 0.333, 'preserve-luminosity': False}
        )

    def test_build_black_white_params_field_mapping(self):
        params = lib.build_black_white_params(
            {'red_weight': 1.5, 'green_weight': 0.5, 'blue_weight': -1.0, 'preserve_luminosity': True},
            _effect_create_defaults('black_white'),
        )
        self.assertEqual(
            params, {'red': 1.5, 'green': 0.5, 'blue': -1.0, 'preserve-luminosity': True}
        )

    def test_build_black_white_params_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            lib.build_black_white_params({'red_weight': 5.1}, _effect_create_defaults('black_white'))

    def test_build_motion_blur_params_defaults(self):
        self.assertEqual(
            lib.build_motion_blur_params({}, _effect_create_defaults('motion_blur')),
            {'length': 10.0, 'angle': 0.0},
        )

    def test_build_motion_blur_params_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            lib.build_motion_blur_params({'length': 1001}, _effect_create_defaults('motion_blur'))
        with self.assertRaises(ValueError):
            lib.build_motion_blur_params({'angle': 181}, _effect_create_defaults('motion_blur'))

    def test_build_lens_blur_params_defaults(self):
        self.assertEqual(
            lib.build_lens_blur_params({}, _effect_create_defaults('lens_blur')),
            {'blur-radius': 25.0, 'highlight-factor': 0.0},
        )

    def test_build_lens_blur_params_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            lib.build_lens_blur_params({'radius': 151}, _effect_create_defaults('lens_blur'))

    def test_build_add_noise_params_defaults(self):
        params = lib.build_add_noise_params({}, _effect_create_defaults('add_noise'))
        self.assertEqual(
            params, {'red': 0.2, 'green': 0.2, 'blue': 0.2, 'alpha': 0.0, 'seed': 0}
        )

    def test_build_add_noise_params_one_amount_drives_all_three_channels(self):
        params = lib.build_add_noise_params(
            {'noise_amount': 0.6}, _effect_create_defaults('add_noise')
        )
        self.assertEqual(params['red'], 0.6)
        self.assertEqual(params['green'], 0.6)
        self.assertEqual(params['blue'], 0.6)

    def test_build_add_noise_params_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            lib.build_add_noise_params({'noise_amount': 1.1}, _effect_create_defaults('add_noise'))
        with self.assertRaises(ValueError):
            lib.build_add_noise_params({'seed': -1}, _effect_create_defaults('add_noise'))
        with self.assertRaises(ValueError):
            lib.build_add_noise_params({'seed': 4294967296}, _effect_create_defaults('add_noise'))

    def test_build_drop_shadow_params_defaults(self):
        params = lib.build_drop_shadow_params({}, _effect_create_defaults('drop_shadow'))
        self.assertEqual(params, {'x': 20.0, 'y': 20.0, 'radius': 10.0, 'opacity': 0.5})

    def test_build_drop_shadow_params_maps_offset_x_y_to_x_y(self):
        params = lib.build_drop_shadow_params(
            {'offset_x': -30, 'offset_y': 45}, _effect_create_defaults('drop_shadow')
        )
        self.assertEqual(params['x'], -30.0)
        self.assertEqual(params['y'], 45.0)

    def test_build_drop_shadow_params_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            lib.build_drop_shadow_params({'offset_x': 501}, _effect_create_defaults('drop_shadow'))
        with self.assertRaises(ValueError):
            lib.build_drop_shadow_params({'opacity': 1.1}, _effect_create_defaults('drop_shadow'))


class TestEffectResolveFieldMerge(unittest.TestCase):
    """The same re-edit-is-a-merge contract TestResolveFieldMerge pins for ADJUST_PARAM_BUILDERS,
    for EFFECT_PARAM_BUILDERS."""

    def test_every_filter_type_merges_every_field_it_has(self):
        for filter_type, builder in lib.EFFECT_PARAM_BUILDERS.items():
            defaults = lib.EFFECT_CREATE_DEFAULTS[filter_type]
            result = builder({}, defaults)
            self.assertEqual(result, defaults, 'filter=%s' % filter_type)

    def test_every_filter_type_merges_from_existing_params_that_differ_from_create_defaults(self):
        for filter_type, builder in lib.EFFECT_PARAM_BUILDERS.items():
            existing = {}
            for key, value in lib.EFFECT_CREATE_DEFAULTS[filter_type].items():
                if isinstance(value, bool):
                    existing[key] = not value
                elif isinstance(value, int) and not isinstance(value, bool):
                    existing[key] = value + 1
                elif isinstance(value, float):
                    # Stay inside every field's own validated range (e.g. vignette's 0..1 x/y,
                    # black_white's -5..5 weights) while still differing from the create default.
                    existing[key] = value * 0.5 + 0.01
                else:
                    existing[key] = str(value) + '_DIFFERENT'
            result = builder({}, existing)
            self.assertEqual(result, existing, 'filter=%s' % filter_type)

    def test_effect_create_defaults_cover_every_field_every_builder_produces(self):
        for filter_type, builder in lib.EFFECT_PARAM_BUILDERS.items():
            defaults = lib.EFFECT_CREATE_DEFAULTS[filter_type]
            produced = builder({}, defaults)
            self.assertEqual(set(produced), set(defaults), 'filter=%s' % filter_type)


class TestRegionToProxyPx(unittest.TestCase):
    def test_scales_and_rounds(self):
        region = {'x': 10, 'y': 20, 'width': 100, 'height': 50}
        self.assertEqual(lib.region_to_proxy_px(region, 0.5), (5, 10, 50, 25))

    def test_never_rounds_a_dimension_to_zero(self):
        region = {'x': 0, 'y': 0, 'width': 1, 'height': 1}
        x, y, w, h = lib.region_to_proxy_px(region, 0.1)
        self.assertGreaterEqual(w, 1)
        self.assertGreaterEqual(h, 1)


class TestRequire(unittest.TestCase):
    def test_present_and_not_none_is_returned(self):
        self.assertEqual(lib.require({'x': 5}, 'x'), 5)
        self.assertEqual(lib.require({'x': False}, 'x'), False)  # a legitimate falsy value

    def test_missing_key_raises_naming_the_field(self):
        with self.assertRaisesRegex(ValueError, 'left'):
            lib.require({}, 'left')

    def test_none_value_raises_naming_the_field(self):
        with self.assertRaisesRegex(ValueError, 'degrees'):
            lib.require({'degrees': None}, 'degrees')


class TestRequireBool(unittest.TestCase):
    def test_accepts_true_and_false(self):
        self.assertIs(lib.require_bool({'visible': True}, 'visible'), True)
        self.assertIs(lib.require_bool({'visible': False}, 'visible'), False)

    def test_rejects_the_string_false(self):
        # The regression this whole function exists to guard: `bool("false")` is `True` in
        # Python (any non-empty string is truthy), so a caller sending the STRING "false" must be
        # rejected, not silently coerced to True.
        with self.assertRaisesRegex(ValueError, 'visible'):
            lib.require_bool({'visible': 'false'}, 'visible')

    def test_rejects_the_integer_one(self):
        # 1/0 are common "boolean-ish" JSON values from other ecosystems, but Python's `bool` is
        # its own type distinct from `int` here -- `isinstance(1, bool)` is False, so this must
        # reject rather than silently accept 1 as True.
        with self.assertRaisesRegex(ValueError, 'visible'):
            lib.require_bool({'visible': 1}, 'visible')

    def test_rejects_none(self):
        # None is caught by `require` itself (missing/None both raise "is required"), before
        # the boolean-type check ever runs.
        with self.assertRaisesRegex(ValueError, 'visible'):
            lib.require_bool({'visible': None}, 'visible')

    def test_missing_key_raises_naming_the_field(self):
        with self.assertRaisesRegex(ValueError, 'visible'):
            lib.require_bool({}, 'visible')


class TestOptionalBool(unittest.TestCase):
    def test_accepts_true_and_false(self):
        self.assertIs(lib.optional_bool({'discard_hidden': True}, 'discard_hidden'), True)
        self.assertIs(lib.optional_bool({'discard_hidden': False}, 'discard_hidden'), False)

    def test_missing_key_returns_the_default(self):
        self.assertIs(lib.optional_bool({}, 'discard_hidden'), False)
        self.assertIs(lib.optional_bool({}, 'all', default=True), True)

    def test_none_returns_the_default(self):
        self.assertIs(lib.optional_bool({'discard_hidden': None}, 'discard_hidden'), False)

    def test_rejects_the_string_false(self):
        # The same regression require_bool guards against: `bool("false")` is `True` in Python,
        # so a caller sending the STRING "false" must be rejected, not silently coerced to True.
        with self.assertRaisesRegex(ValueError, 'discard_hidden'):
            lib.optional_bool({'discard_hidden': 'false'}, 'discard_hidden')

    def test_rejects_the_integer_one(self):
        with self.assertRaisesRegex(ValueError, 'all'):
            lib.optional_bool({'all': 1}, 'all')


class TestValidateRegion(unittest.TestCase):
    def test_accepts_a_region_entirely_within_bounds(self):
        region = {'x': 10, 'y': 10, 'width': 50, 'height': 50}
        self.assertEqual(lib.validate_region(region, 100, 100), (10, 10, 50, 50))

    def test_accepts_a_region_touching_the_far_edge_exactly(self):
        region = {'x': 50, 'y': 50, 'width': 50, 'height': 50}
        self.assertEqual(lib.validate_region(region, 100, 100), (50, 50, 50, 50))

    def test_rejects_negative_origin(self):
        with self.assertRaises(ValueError):
            lib.validate_region({'x': -1, 'y': 0, 'width': 10, 'height': 10}, 100, 100)

    def test_rejects_partly_outside_the_right_edge(self):
        with self.assertRaises(ValueError):
            lib.validate_region({'x': 90, 'y': 0, 'width': 20, 'height': 10}, 100, 100)

    def test_rejects_fully_outside(self):
        with self.assertRaises(ValueError):
            lib.validate_region({'x': 200, 'y': 200, 'width': 10, 'height': 10}, 100, 100)

    def test_rejects_non_positive_size(self):
        with self.assertRaises(ValueError):
            lib.validate_region({'x': 0, 'y': 0, 'width': 0, 'height': 10}, 100, 100)

    def test_missing_field_raises_naming_it(self):
        with self.assertRaisesRegex(ValueError, 'width'):
            lib.validate_region({'x': 0, 'y': 0, 'height': 10}, 100, 100)

    def test_op_crop_reuses_this_for_its_own_left_top_width_height_bounds_check(self):
        # `op_crop` in ops.py calls this exact function, mapping its own `left`/`top` onto
        # `x`/`y` -- `Image.crop` itself has no bounds check at all (it happily pads a rectangle
        # that's partly or fully outside the source image with blank space), so this is the ONLY
        # thing standing between a crop request and that silent, confusing result. A crop rect
        # that hangs off the right edge is exactly the shape of request `op_crop` must reject.
        with self.assertRaises(ValueError):
            lib.validate_region({'x': 90, 'y': 0, 'width': 50, 'height': 10}, 100, 100)


class TestValidateResizeDims(unittest.TestCase):
    def test_accepts_reasonable_dims(self):
        self.assertEqual(lib.validate_resize_dims(1920, 1080), (1920, 1080))

    def test_rejects_a_side_over_the_cap(self):
        with self.assertRaises(ValueError):
            lib.validate_resize_dims(lib.MAX_RESIZE_SIDE_PX + 1, 100)

    def test_accepts_a_side_exactly_at_the_cap_if_area_allows(self):
        # A single side at the cap with a tiny other side stays under the megapixel cap too.
        lib.validate_resize_dims(lib.MAX_RESIZE_SIDE_PX, 1)

    def test_rejects_area_over_the_megapixel_cap_even_with_both_sides_under_the_per_side_cap(self):
        side = int((lib.MAX_RESIZE_MEGAPIXELS * 1_000_000) ** 0.5) + 100
        with self.assertRaises(ValueError):
            lib.validate_resize_dims(side, side)

    def test_rejects_non_positive(self):
        with self.assertRaises(ValueError):
            lib.validate_resize_dims(0, 100)


class TestMegapixelCapEnv(unittest.TestCase):
    """EM_GIMP_MAX_MEGAPIXELS may only LOWER the 250 MP cap (and the 125/60 precision caps with it)."""

    @contextlib.contextmanager
    def _env(self, value):
        """Reload lib under the env value for the duration of the block, then restore it."""
        old = os.environ.get('EM_GIMP_MAX_MEGAPIXELS')
        try:
            if value is None:
                os.environ.pop('EM_GIMP_MAX_MEGAPIXELS', None)
            else:
                os.environ['EM_GIMP_MAX_MEGAPIXELS'] = value
            yield importlib.reload(lib)
        finally:
            if old is None:
                os.environ.pop('EM_GIMP_MAX_MEGAPIXELS', None)
            else:
                os.environ['EM_GIMP_MAX_MEGAPIXELS'] = old
            importlib.reload(lib)

    def test_unset_is_unchanged(self):
        with self._env(None) as m:
            self.assertEqual(m.MAX_RESIZE_MEGAPIXELS, 250)
            self.assertEqual(m.DOCUMENT_MEGAPIXEL_CAP, {'8': 250, '16': 125, '32': 60})

    def test_lowered_scales_precision_caps(self):
        with self._env('80') as m:
            self.assertEqual(m.MAX_RESIZE_MEGAPIXELS, 80)
            self.assertEqual(m.DOCUMENT_MEGAPIXEL_CAP, {'8': 80, '16': 40, '32': 20})
            with self.assertRaisesRegex(ValueError, 'at most 80 MP'):
                m.validate_resize_dims(10_000, 9_000)

    def test_fractional_value_reported_numerically(self):
        with self._env('12.5') as m:
            with self.assertRaisesRegex(ValueError, 'at most 3.125 MP'):
                m.validate_document_dims(3_000, 3_000, '32')

    def test_invalid_values_ignored(self):
        for bad in ('', 'abc', 'nan', 'inf', '-5', '0'):
            with self._env(bad) as m:
                self.assertEqual(m.MAX_RESIZE_MEGAPIXELS, 250, bad)
                self.assertEqual(m.DOCUMENT_MEGAPIXEL_CAP, {'8': 250, '16': 125, '32': 60}, bad)

    def test_env_only_ever_lowers_every_derived_cap(self):
        # 245 sits between 240 and 250: a plain cap/4 would put the 32-bit cap (61.25) above the
        # default 60, so each derived cap is clamped to its own default.
        with self._env('245') as m:
            self.assertEqual(m.MAX_RESIZE_MEGAPIXELS, 245)
            self.assertEqual(m.DOCUMENT_MEGAPIXEL_CAP, {'8': 245, '16': 122.5, '32': 60})
        for value in ('1', '24', '100', '239', '240', '245', '249'):
            with self._env(value) as m:
                for bucket, default in (('8', 250), ('16', 125), ('32', 60)):
                    self.assertLessEqual(m.DOCUMENT_MEGAPIXEL_CAP[bucket], default, (value, bucket))

    def test_raising_ignored(self):
        for big in ('250', '500', '100000'):
            with self._env(big) as m:
                self.assertEqual(m.MAX_RESIZE_MEGAPIXELS, 250, big)
                self.assertEqual(m.DOCUMENT_MEGAPIXEL_CAP['16'], 125, big)


class TestValidateLoadedMaskDims(unittest.TestCase):
    # A loaded mask image has no tool of its own -- load_mask reuses validate_resize_dims's own
    # DoS floor (checked once the file is decoded, since GdkPixbuf isn't bound in this
    # environment to peek at the header first) so a mask file can't bypass the same cap a direct
    # resize would hit.
    def test_accepts_reasonable_dims(self):
        self.assertEqual(lib.validate_loaded_mask_dims(1920, 1080), (1920, 1080))

    def test_rejects_a_side_over_the_cap(self):
        with self.assertRaises(ValueError):
            lib.validate_loaded_mask_dims(lib.MAX_RESIZE_SIDE_PX + 1, 100)

    def test_rejects_non_positive(self):
        with self.assertRaises(ValueError):
            lib.validate_loaded_mask_dims(0, 100)


class TestValidateDocumentDims(unittest.TestCase):
    def test_defaults_to_the_8_bit_cap(self):
        self.assertEqual(lib.validate_document_dims(1920, 1080), (1920, 1080))
        self.assertEqual(lib.DOCUMENT_MEGAPIXEL_CAP['8'], lib.MAX_RESIZE_MEGAPIXELS)

    def test_16_bit_cap_is_half_the_8_bit_cap(self):
        self.assertEqual(lib.DOCUMENT_MEGAPIXEL_CAP['16'], 125)
        over_16 = int((125 * 1_000_000) ** 0.5) + 100
        with self.assertRaises(ValueError):
            lib.validate_document_dims(over_16, over_16, '16')
        # The identical dims stay under the 8-bit cap -- the ceiling is precision-specific, not an
        # absolute size limit.
        lib.validate_document_dims(over_16, over_16, '8')

    def test_32_bit_cap_is_a_quarter_of_the_8_bit_cap(self):
        self.assertEqual(lib.DOCUMENT_MEGAPIXEL_CAP['32'], 60)
        over_32 = int((60 * 1_000_000) ** 0.5) + 100
        with self.assertRaises(ValueError):
            lib.validate_document_dims(over_32, over_32, '32')
        lib.validate_document_dims(over_32, over_32, '16')

    def test_rejects_a_side_over_the_shared_per_side_cap_regardless_of_precision(self):
        with self.assertRaises(ValueError):
            lib.validate_document_dims(lib.MAX_RESIZE_SIDE_PX + 1, 100, '32')

    def test_rejects_non_positive(self):
        with self.assertRaises(ValueError):
            lib.validate_document_dims(0, 100)

    def test_message_uses_the_right_article(self):
        with self.assertRaisesRegex(ValueError, r'^an 8-bit document'):
            lib.validate_document_dims(20000, 20000, '8')
        with self.assertRaisesRegex(ValueError, r'^a 16-bit document'):
            lib.validate_document_dims(20000, 20000, '16')


class TestValidateGroupTotalPixels(unittest.TestCase):
    def test_accepts_a_total_at_or_under_the_cap(self):
        lib.validate_group_total_pixels([(5000, 5000)] * 10, '8')

    def test_rejects_when_the_sum_exceeds_the_cap_though_each_layer_fits(self):
        sizes = [(9000, 9000)] * 4  # 81 MP each, 324 MP total
        for size in sizes:
            lib.validate_document_dims(*size, precision='8')
        with self.assertRaisesRegex(ValueError, 'total'):
            lib.validate_group_total_pixels(sizes, '8')

    def test_cap_is_precision_aware(self):
        sizes = [(5000, 5000)] * 3  # 75 MP
        lib.validate_group_total_pixels(sizes, '16')
        with self.assertRaises(ValueError):
            lib.validate_group_total_pixels(sizes, '32')


class TestValidateCanvasFill(unittest.TestCase):
    def test_accepts_every_layer_fill(self):
        for value in lib.LAYER_FILLS:
            self.assertEqual(lib.validate_canvas_fill(value), value)

    def test_accepts_a_hex_color(self):
        self.assertEqual(lib.validate_canvas_fill('#336699'), '#336699')
        self.assertEqual(lib.validate_canvas_fill('#FFFFFF'), '#FFFFFF')

    def test_rejects_a_malformed_hex_color(self):
        for bad in ('#369', '336699', '#gggggg', '#3366990', '', '#336699\n', ' #336699'):
            with self.assertRaises(ValueError):
                lib.validate_canvas_fill(bad)

    def test_rejects_an_unknown_word(self):
        with self.assertRaises(ValueError):
            lib.validate_canvas_fill('red')


class TestCanvasAnchorOffset(unittest.TestCase):
    def test_top_left_pins_the_old_content_at_the_origin(self):
        self.assertEqual(lib.canvas_anchor_offset('top_left', 100, 50, 200, 150), (0, 0))

    def test_bottom_right_puts_all_the_growth_before_the_old_content(self):
        self.assertEqual(lib.canvas_anchor_offset('bottom_right', 100, 50, 200, 150), (100, 100))

    def test_center_splits_the_growth_evenly(self):
        self.assertEqual(lib.canvas_anchor_offset('center', 100, 50, 200, 150), (50, 50))

    def test_center_floors_an_odd_split(self):
        # 100 -> 203 is 103px of growth; center's 0.5 fraction gives exactly 51.5 -- floor() picks
        # 51 (round() would pick 52 here, since Python's round() is round-half-TO-EVEN: 52 is the
        # nearer even integer to 51.5) -- pinned as a literal so a future round()/floor() swap
        # would be caught by an exact-value regression, not just the general property test below.
        self.assertEqual(lib.canvas_anchor_offset('center', 100, 100, 203, 100), (51, 0))

    def test_every_named_anchor_keeps_old_content_within_the_new_canvas(self):
        for anchor in lib.CANVAS_ANCHORS:
            ox, oy = lib.canvas_anchor_offset(anchor, 100, 50, 200, 150)
            self.assertTrue(0 <= ox <= 100, anchor)
            self.assertTrue(0 <= oy <= 100, anchor)

    def test_rejects_an_unknown_anchor(self):
        with self.assertRaises(ValueError):
            lib.canvas_anchor_offset('upper-leftish', 100, 50, 200, 150)

    def test_no_growth_is_always_zero_offset_regardless_of_anchor(self):
        for anchor in lib.CANVAS_ANCHORS:
            self.assertEqual(lib.canvas_anchor_offset(anchor, 100, 100, 100, 100), (0, 0))


class TestImageModes(unittest.TestCase):
    def test_is_rgb_and_grayscale_only(self):
        self.assertEqual(set(lib.IMAGE_MODES), {'rgb', 'grayscale'})


class TestValidateFeatherPx(unittest.TestCase):
    def test_accepts_zero_and_the_cap(self):
        self.assertEqual(lib.validate_feather_px(0), 0.0)
        self.assertEqual(lib.validate_feather_px(lib.MAX_FEATHER_PX), float(lib.MAX_FEATHER_PX))

    def test_rejects_over_the_cap(self):
        with self.assertRaises(ValueError):
            lib.validate_feather_px(lib.MAX_FEATHER_PX + 1)

    def test_rejects_negative(self):
        with self.assertRaises(ValueError):
            lib.validate_feather_px(-1)


class TestValidateHexColor(unittest.TestCase):
    def test_accepts_a_wellformed_hex_color(self):
        self.assertEqual(lib.validate_hex_color('color', '#c0392b'), '#c0392b')
        self.assertEqual(lib.validate_hex_color('color', '#FFFFFF'), '#FFFFFF')

    def test_rejects_a_short_or_unprefixed_or_non_hex_string(self):
        for bad in ('c0392b', '#fff', '#gggggg', '#12345', 'red', ''):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    lib.validate_hex_color('color', bad)

    def test_rejects_a_non_string(self):
        with self.assertRaises(ValueError):
            lib.validate_hex_color('color', None)
        with self.assertRaises(ValueError):
            lib.validate_hex_color('color', 123456)


class TestValidatePositivePx(unittest.TestCase):
    def test_accepts_a_positive_value_within_the_cap(self):
        self.assertEqual(lib.validate_positive_px('px', 4), 4)
        self.assertEqual(lib.validate_positive_px('px', lib.MAX_FEATHER_PX), lib.MAX_FEATHER_PX)

    def test_rounds_rather_than_truncates(self):
        self.assertEqual(lib.validate_positive_px('px', 4.6), 5)
        self.assertEqual(lib.validate_positive_px('px', 4.4), 4)

    def test_rounds_half_up_not_half_to_even(self):
        # Python's builtin round() is round-half-to-even (round(2.5) == 2); this must round
        # every .5 AWAY from zero instead, so 2.5 becomes 3.
        self.assertEqual(lib.validate_positive_px('px', 2.5), 3)
        self.assertEqual(lib.validate_positive_px('px', 0.5), 1)

    def test_rejects_a_value_that_rounds_to_zero(self):
        with self.assertRaises(ValueError):
            lib.validate_positive_px('px', 0.3)
        with self.assertRaises(ValueError):
            lib.validate_positive_px('px', 0.49)

    def test_rejects_zero_and_negative(self):
        with self.assertRaises(ValueError):
            lib.validate_positive_px('px', 0)
        with self.assertRaises(ValueError):
            lib.validate_positive_px('px', -1)

    def test_rejects_over_the_cap(self):
        with self.assertRaises(ValueError):
            lib.validate_positive_px('px', lib.MAX_FEATHER_PX + 1)


class TestComputeMaskPasteRect(unittest.TestCase):
    """`op_load_mask`'s crop/slice math, pulled out pure so every off-canvas case is checked
    without needing a real GIMP image."""

    def test_whole_image_target_is_the_full_canvas(self):
        self.assertEqual(lib.compute_mask_paste_rect(0, 0, 64, 64, 64, 64), (0, 0, 64, 64))

    def test_a_layer_fully_inside_the_canvas_is_unclipped(self):
        self.assertEqual(lib.compute_mask_paste_rect(5, 8, 20, 10, 64, 64), (5, 8, 25, 18))

    def test_a_layer_with_a_negative_offset_is_clipped_at_the_origin(self):
        self.assertEqual(lib.compute_mask_paste_rect(-10, -4, 20, 10, 64, 64), (0, 0, 10, 6))

    def test_a_layer_hanging_off_the_right_and_bottom_is_clipped_at_the_far_edge(self):
        self.assertEqual(lib.compute_mask_paste_rect(50, 60, 20, 10, 64, 64), (50, 60, 64, 64))

    def test_a_layer_entirely_off_canvas_to_the_left_yields_an_empty_rect(self):
        x0, y0, x1, y1 = lib.compute_mask_paste_rect(-30, 0, 20, 10, 64, 64)
        self.assertTrue(x1 <= x0 or y1 <= y0)


class TestEffectiveMorphologyPx(unittest.TestCase):
    """The expand/contract/border cap shrinks above MORPHOLOGY_BASELINE_MP -- live-measured
    numbers (ops.py's `op_modify_mask` comment) showed the flat 150px cap taking ~73.5s at ~100MP
    and timing out a whole GIMP session past ~217MP, both far past gimp_modify_selection's 45s
    budget."""

    def test_at_or_below_the_baseline_keeps_the_full_cap(self):
        # 6016x4000 ~= 24.06MP, the live-measured baseline itself.
        self.assertEqual(lib.effective_morphology_px(6016, 4000), lib.MAX_MORPHOLOGY_PX)
        self.assertEqual(lib.effective_morphology_px(100, 100), lib.MAX_MORPHOLOGY_PX)

    def test_shrinks_for_a_document_above_the_baseline(self):
        # ~100MP (14000x7143) -- measured live at the scaled cap: ~11.8s, comfortably under budget.
        self.assertEqual(lib.effective_morphology_px(14_000, 7_143), 36)

    def test_shrinks_further_for_the_largest_allowed_document(self):
        # ~216.8MP (30000x7228, this bridge's own MAX_RESIZE_SIDE_PX/MAX_RESIZE_MEGAPIXELS cap) --
        # measured live at the scaled cap: ~27.2s, still under gimp_modify_selection's 45s budget.
        self.assertEqual(lib.effective_morphology_px(30_000, 7_228), 17)

    def test_never_exceeds_the_flat_cap_or_drops_below_the_floor(self):
        self.assertLessEqual(lib.effective_morphology_px(1, 1), lib.MAX_MORPHOLOGY_PX)
        self.assertGreaterEqual(
            lib.effective_morphology_px(30_000, 30_000), lib.MIN_MORPHOLOGY_PX
        )

    def test_a_layer_entirely_off_canvas_past_the_bottom_yields_an_empty_rect(self):
        x0, y0, x1, y1 = lib.compute_mask_paste_rect(0, 100, 20, 10, 64, 64)
        self.assertTrue(x1 <= x0 or y1 <= y0)


class TestMergedLedgerForWriteRemoval(unittest.TestCase):
    def test_removed_name_stays_gone_even_though_raw_still_has_it(self):
        # The exact resurrection bug: `raw` (freshly re-read) still has "Curves" because nothing
        # has rewritten the parasite since it was created; `filters` (the caller's in-memory view)
        # has already dropped it. Without `removed`, a plain dict.update would let `raw`'s stale
        # copy survive the merge.
        raw = lib.serialize_ledger(
            {'Curves': {'operation': 'gimp:curves', 'params': {'points': [[0, 0], [255, 255]]}}}
        ).encode('utf-8')
        merged = lib.merged_ledger_for_write(raw, {}, {}, removed={'Curves'})
        filters, _unknown, _raw = lib.parse_ledger(merged)
        self.assertNotIn('Curves', filters)

    def test_removed_name_not_in_filters_or_raw_is_a_no_op(self):
        raw = lib.serialize_ledger({}).encode('utf-8')
        merged = lib.merged_ledger_for_write(raw, {}, {}, removed={'NeverExisted'})
        filters, _unknown, _raw = lib.parse_ledger(merged)
        self.assertEqual(filters, {})

    def test_removed_defaults_to_none_and_behaves_like_before(self):
        raw = lib.serialize_ledger(
            {'Curves': {'operation': 'gimp:curves', 'params': {}}}
        ).encode('utf-8')
        merged = lib.merged_ledger_for_write(raw, {}, {})
        filters, _unknown, _raw = lib.parse_ledger(merged)
        self.assertIn('Curves', filters)


class TestResolveFieldMerge(unittest.TestCase):
    """The re-edit-is-a-merge contract every generic adjust builder shares."""

    def test_uses_the_callers_value_when_present(self):
        result = lib.resolve_field({'brightness': 50}, 'brightness', {'brightness': 0.0}, 'brightness', float)
        self.assertEqual(result, 50.0)

    def test_falls_back_to_defaults_when_absent(self):
        result = lib.resolve_field({}, 'brightness', {'brightness': 0.7}, 'brightness', float)
        self.assertEqual(result, 0.7)

    def test_a_partial_re_edit_keeps_every_other_field(self):
        # The regression this whole class guards: re-editing ONLY contrast must not silently
        # reset brightness to the type's create-time default.
        existing = {'brightness': 0.4, 'contrast': 0.1}
        params = lib.build_brightness_contrast_params({'contrast': 50}, existing)
        self.assertEqual(params['brightness'], 0.4)
        self.assertEqual(params['contrast'], 0.5)

    def test_every_adjust_type_merges_every_field_it_has(self):
        for type_, builder in lib.ADJUST_PARAM_BUILDERS.items():
            defaults = lib.ADJUST_CREATE_DEFAULTS[type_]
            # Called with no args at all (a no-op re-edit): every field must come back exactly
            # as it was in `defaults`, proving the builder never substitutes its own hardcoded
            # default when a value it should be merging from is available.
            result = builder({}, defaults)
            self.assertEqual(result, defaults, 'type=%s' % type_)

    def test_every_adjust_type_merges_from_existing_params_that_differ_from_create_defaults(self):
        # Guards a gap `test_every_adjust_type_merges_every_field_it_has` can't catch: that test
        # calls each builder with `defaults` set to the type's OWN `ADJUST_CREATE_DEFAULTS`, so a
        # builder that silently ignored `defaults` and returned its own hardcoded default instead
        # would still pass -- the two happen to be equal in that case. Here `existing` is built to
        # differ from every type's create defaults in every field, the way a real re-edit's
        # existing ledger params would after the filter was actually adjusted away from its
        # creation-time values, so a builder that drops back to hardcoded defaults is caught.
        for type_, builder in lib.ADJUST_PARAM_BUILDERS.items():
            existing = {}
            for key, value in lib.ADJUST_CREATE_DEFAULTS[type_].items():
                if isinstance(value, bool):
                    existing[key] = not value
                elif isinstance(value, (int, float)):
                    existing[key] = value + 7
                else:
                    existing[key] = str(value) + '_DIFFERENT'
            result = builder({}, existing)
            self.assertEqual(result, existing, 'type=%s' % type_)

    def test_create_defaults_cover_every_field_every_builder_produces(self):
        for type_, builder in lib.ADJUST_PARAM_BUILDERS.items():
            defaults = lib.ADJUST_CREATE_DEFAULTS[type_]
            produced = builder({}, defaults)
            self.assertEqual(set(produced), set(defaults), 'type=%s' % type_)


class TestAllowedDescribeOperations(unittest.TestCase):
    def test_covers_every_adjust_and_filter_operation(self):
        self.assertEqual(
            lib.ALLOWED_DESCRIBE_OPERATIONS,
            frozenset(lib.ADJUST_OPERATIONS.values()) | frozenset(lib.EFFECT_OPERATIONS.values()),
        )


class TestStaleLedgerNames(unittest.TestCase):
    def test_a_record_with_no_matching_live_name_is_stale(self):
        filters = {'A': {}, 'B': {}}
        self.assertEqual(lib.stale_ledger_names(filters, ['B']), {'A'})

    def test_nothing_stale_when_every_record_has_a_live_match(self):
        filters = {'A': {}, 'B': {}}
        self.assertEqual(lib.stale_ledger_names(filters, ['A', 'B']), set())

    def test_empty_ledger_has_nothing_stale(self):
        self.assertEqual(lib.stale_ledger_names({}, ['A']), set())


class TestClassifyGeometryFilters(unittest.TestCase):
    """Pure logic behind rotate/flip/resize's masked-filter refusal: iterates LIVE filters (not
    the ledger alone), classifying each as masked / unmasked / unverifiable."""

    def test_a_live_filter_with_a_matching_masked_record_is_masked(self):
        filters = {'Curves': {'operation': 'gimp:curves', 'params': {'mask': 'M'}}}
        masked, unverifiable = lib.classify_geometry_filters(filters, [('Curves', 'gimp:curves')])
        self.assertEqual(masked, ['Curves'])
        self.assertEqual(unverifiable, [])

    def test_a_live_filter_with_a_matching_unmasked_record_is_neither(self):
        filters = {'Curves': {'operation': 'gimp:curves', 'params': {'mask': None}}}
        masked, unverifiable = lib.classify_geometry_filters(filters, [('Curves', 'gimp:curves')])
        self.assertEqual(masked, [])
        self.assertEqual(unverifiable, [])

    def test_a_live_filter_with_no_ledger_record_at_all_is_unverifiable(self):
        # The exact "ledger write was skipped" scenario (lib.merged_ledger_for_write returned
        # None): the filter genuinely exists and may or may not be masked, but nothing recorded
        # which, so it must be treated as possibly masked rather than assumed safe.
        masked, unverifiable = lib.classify_geometry_filters({}, [('Foreign', 'gimp:levels')])
        self.assertEqual(masked, [])
        self.assertEqual(unverifiable, ['Foreign'])

    def test_a_live_filter_whose_record_operation_does_not_match_is_unverifiable(self):
        # Same name, different operation -- e.g. a foreign filter re-using a name this bridge
        # once used for something else. The stale/mismatched record must not be trusted for a
        # DIFFERENT live filter that merely happens to share its name.
        filters = {'Reused': {'operation': 'gimp:levels', 'params': {'mask': None}}}
        masked, unverifiable = lib.classify_geometry_filters(filters, [('Reused', 'gimp:curves')])
        self.assertEqual(masked, [])
        self.assertEqual(unverifiable, ['Reused'])

    def test_a_stale_record_with_no_live_filter_at_all_is_simply_absent_from_the_result(self):
        # classify_geometry_filters only ever iterates LIVE filters -- a ledger record with no
        # live counterpart (the "stale" case `stale_ledger_names`/pruning handles) never appears
        # in either list, masked or unverifiable, and so can never block anything by itself.
        filters = {'Gone': {'operation': 'gimp:curves', 'params': {'mask': 'M'}}}
        masked, unverifiable = lib.classify_geometry_filters(filters, [])
        self.assertEqual(masked, [])
        self.assertEqual(unverifiable, [])

    def test_multiple_live_filters_are_each_classified_independently(self):
        filters = {
            'Masked': {'operation': 'gimp:curves', 'params': {'mask': 'M'}},
            'Unmasked': {'operation': 'gimp:levels', 'params': {'mask': None}},
        }
        live = [('Masked', 'gimp:curves'), ('Unmasked', 'gimp:levels'), ('Unknown', 'gegl:exposure')]
        masked, unverifiable = lib.classify_geometry_filters(filters, live)
        self.assertEqual(masked, ['Masked'])
        self.assertEqual(unverifiable, ['Unknown'])

    def test_a_name_seen_on_more_than_one_live_filter_is_unverifiable_even_if_unmasked(self):
        # The ledger's {name: record} shape can only ever answer for ONE of the two -- even
        # though the record itself says unmasked, a name lookup can't tell which live filter it
        # actually describes, so BOTH occurrences must be treated as possibly masked.
        filters = {'Dup': {'operation': 'gimp:curves', 'params': {'mask': None}}}
        live = [('Dup', 'gimp:curves'), ('Dup', 'gimp:curves')]
        masked, unverifiable = lib.classify_geometry_filters(filters, live)
        self.assertEqual(masked, [])
        self.assertEqual(unverifiable, ['Dup', 'Dup'])

    def test_a_duplicate_name_does_not_affect_classification_of_other_live_filters(self):
        filters = {
            'Dup': {'operation': 'gimp:curves', 'params': {'mask': 'M'}},
            'Fine': {'operation': 'gimp:levels', 'params': {'mask': None}},
        }
        live = [('Dup', 'gimp:curves'), ('Dup', 'gimp:curves'), ('Fine', 'gimp:levels')]
        masked, unverifiable = lib.classify_geometry_filters(filters, live)
        self.assertEqual(masked, [])  # Dup's own masked record is never consulted -- unverifiable wins
        self.assertEqual(unverifiable, ['Dup', 'Dup'])


class TestMetadataStripSettings(unittest.TestCase):
    def test_required_and_present_optional_options_are_switched_off(self):
        props = {'include-exif', 'include-xmp', 'include-iptc', 'include-thumbnail', 'quality'}
        self.assertEqual(
            lib.metadata_strip_settings('jpeg', props),
            ['include-exif', 'include-xmp', 'include-iptc', 'include-thumbnail'],
        )

    def test_absent_optional_options_are_skipped(self):
        self.assertEqual(
            lib.metadata_strip_settings('webp', {'include-exif', 'include-xmp'}),
            ['include-exif', 'include-xmp'],
        )

    def test_missing_required_option_fails_loudly(self):
        for missing in lib.METADATA_REQUIRED_OPTIONS:
            props = set(lib.METADATA_REQUIRED_OPTIONS) - {missing}
            with self.assertRaises(lib.OpError) as ctx:
                lib.metadata_strip_settings('png', props)
            self.assertEqual(ctx.exception.code, 'gimp_op_failed')
            self.assertIn(missing, str(ctx.exception))

    def test_geotiff_is_switched_off_for_tiff_only(self):
        props = {'include-exif', 'include-xmp', 'save-geotiff'}
        self.assertIn('save-geotiff', lib.metadata_strip_settings('tiff', props))
        self.assertNotIn('save-geotiff', lib.metadata_strip_settings('png', props))


# Known user-facing args per type, each field set to a non-default value -- what a model would
# send, and what `list` must hand back in the same names and units.
USER_ARGS_BY_TYPE = {
    'exposure': {'exposure': 1.25, 'black_level': 0.03},
    'brightness_contrast': {'brightness': 50, 'contrast': -20},
    'hue_saturation': {'range': 'red', 'hue': 33, 'saturation': 20, 'lightness': -7},
    'color_balance': {
        'range': 'shadows', 'cyan_red': 20, 'magenta_green': -15, 'yellow_blue': 7,
        'preserve_luminosity': False,
    },
    'color_temperature': {'from_kelvin': 5000, 'to_kelvin': 8000},
    'shadows_highlights': {
        'shadows': 40, 'highlights': -30, 'whitepoint': 1.5, 'radius': 60, 'compress': 35,
        'shadows_ccorrect': 80, 'highlights_ccorrect': 40,
    },
    'saturation': {'scale': 1.4},
    'vibrance': {'vibrance': 35, 'saturation': 1.1},
    'sharpen': {'radius': 2.5, 'amount': 0.8, 'threshold': 0.1},
    'noise_reduction': {'strength': 7},
    'gaussian_blur': {'radius': 4.0},
}


class TestUserParams(unittest.TestCase):
    """`list` reports a ledgered filter's params through `lib.user_params`: the inverse of each
    builder, so a model can pass a listed value straight back on a re-edit."""

    def test_every_generic_type_is_covered(self):
        self.assertEqual(set(USER_ARGS_BY_TYPE), set(lib.ADJUST_PARAM_BUILDERS))
        # USER_FIELDS is one shared dict covering BOTH families (gimp_add_adjustment's `adjust`
        # types and gimp_add_effect's `effect` types) -- `user_params` dispatches on `type_` alone,
        # with no notion of which bridge op a given type belongs to.
        self.assertEqual(
            set(lib.USER_FIELDS),
            set(lib.ADJUST_PARAM_BUILDERS) | set(lib.EFFECT_PARAM_BUILDERS),
        )

    def test_round_trip_reports_what_the_model_sent(self):
        for type_, user_args in USER_ARGS_BY_TYPE.items():
            with self.subTest(type_=type_):
                gegl = lib.ADJUST_PARAM_BUILDERS[type_](user_args, _create_defaults(type_))
                listed = lib.user_params(type_, gegl)
                self.assertEqual(listed, user_args)

    def test_listed_values_rebuild_the_identical_gegl_params(self):
        # The re-edit guarantee itself: feeding `list` output back in changes nothing.
        for type_, user_args in USER_ARGS_BY_TYPE.items():
            with self.subTest(type_=type_):
                builder = lib.ADJUST_PARAM_BUILDERS[type_]
                gegl = builder(user_args, _create_defaults(type_))
                rebuilt = builder(lib.user_params(type_, gegl), gegl)
                self.assertEqual(rebuilt, gegl)

    def test_no_gegl_key_leaks_into_the_listing(self):
        for type_, user_args in USER_ARGS_BY_TYPE.items():
            with self.subTest(type_=type_):
                gegl = lib.ADJUST_PARAM_BUILDERS[type_](user_args, _create_defaults(type_))
                for key in lib.user_params(type_, gegl):
                    self.assertNotIn('-', key)

    def test_mask_is_left_out(self):
        gegl = lib.build_exposure_params({'exposure': 1}, _create_defaults('exposure'))
        gegl['mask'] = 'Sky'
        self.assertNotIn('mask', lib.user_params('exposure', gegl))
        self.assertEqual(
            lib.user_params('curves', {'channel': 'red', 'points': [[0, 0], [255, 255]], 'mask': 'Sky'}),
            {'channel': 'red', 'points': [[0, 0], [255, 255]]},
        )

    def test_levels_passes_through(self):
        params = {
            'channel': 'value', 'in_low': 10.0, 'in_high': 240.0, 'gamma': 1.2,
            'out_low': 0.0, 'out_high': 255.0, 'mask': None,
        }
        listed = lib.user_params('levels', params)
        self.assertNotIn('mask', listed)
        self.assertEqual(listed['gamma'], 1.2)

    def test_operation_types_is_the_inverse_of_adjust_operations(self):
        for type_, operation in lib.ADJUST_OPERATIONS.items():
            self.assertEqual(lib.OPERATION_TYPES[operation], type_)


# Known user-facing args per gimp_add_effect effect, each field set to a non-default value --
# the same round-trip contract USER_ARGS_BY_TYPE pins for gimp_add_adjustment's types above.
EFFECT_USER_ARGS_BY_TYPE = {
    'vignette': {'radius': 1.5, 'softness': 0.5, 'gamma': 1.8, 'center_x': 0.4, 'center_y': 0.6},
    'black_white': {
        'red_weight': 0.6, 'green_weight': 1.2, 'blue_weight': 0.2, 'preserve_luminosity': True,
    },
    'motion_blur': {'length': 25.0, 'angle': 45.0},
    'lens_blur': {'radius': 15.0, 'highlight_factor': 0.3},
    'add_noise': {'noise_amount': 0.4, 'alpha': 0.1, 'seed': 42},
    'drop_shadow': {'offset_x': -10.0, 'offset_y': 15.0, 'radius': 8.0, 'opacity': 0.7},
}


class TestEffectUserParams(unittest.TestCase):
    """The `TestUserParams` round-trip contract above, for gimp_add_effect's EFFECT_* tables
    instead of gimp_add_adjustment's ADJUST_* ones."""

    def test_every_filter_type_is_covered(self):
        self.assertEqual(set(EFFECT_USER_ARGS_BY_TYPE), set(lib.EFFECT_PARAM_BUILDERS))

    def test_round_trip_reports_what_the_model_sent(self):
        for filter_type, user_args in EFFECT_USER_ARGS_BY_TYPE.items():
            with self.subTest(filter_type=filter_type):
                gegl = lib.EFFECT_PARAM_BUILDERS[filter_type](
                    user_args, _effect_create_defaults(filter_type)
                )
                listed = lib.user_params(filter_type, gegl)
                self.assertEqual(listed, user_args)

    def test_listed_values_rebuild_the_identical_gegl_params(self):
        for filter_type, user_args in EFFECT_USER_ARGS_BY_TYPE.items():
            with self.subTest(filter_type=filter_type):
                builder = lib.EFFECT_PARAM_BUILDERS[filter_type]
                gegl = builder(user_args, _effect_create_defaults(filter_type))
                rebuilt = builder(lib.user_params(filter_type, gegl), gegl)
                self.assertEqual(rebuilt, gegl)

    def test_no_gegl_key_leaks_into_the_listing(self):
        for filter_type, user_args in EFFECT_USER_ARGS_BY_TYPE.items():
            with self.subTest(filter_type=filter_type):
                gegl = lib.EFFECT_PARAM_BUILDERS[filter_type](
                    user_args, _effect_create_defaults(filter_type)
                )
                for key in lib.user_params(filter_type, gegl):
                    self.assertNotIn('-', key)

    def test_operation_types_covers_effect_operations_too(self):
        # OPERATION_TYPES is one shared map (ADJUST_OPERATIONS' inverse merged with
        # EFFECT_OPERATIONS' own) -- op_list_filters looks a foreign/legacy record's operation up
        # there regardless of which tool created it.
        for type_, operation in lib.EFFECT_OPERATIONS.items():
            self.assertEqual(lib.OPERATION_TYPES[operation], type_)


class TestSpatialScaleProps(unittest.TestCase):
    """Pins which EFFECT_OPERATIONS entries are (and are NOT) in SPATIAL_SCALE_PROPS -- the
    allow-list `_mirror_filters` scales by the proxy factor. A silent removal here would make a
    spatial effect's radius/length render wrong on the preview without any test noticing; a
    silent addition would scale a property that was never meant to be scaled."""

    def test_motion_blur_length_is_spatial(self):
        self.assertEqual(lib.SPATIAL_SCALE_PROPS['gegl:motion-blur-linear'], ('length',))

    def test_lens_blur_blur_radius_is_spatial(self):
        self.assertEqual(lib.SPATIAL_SCALE_PROPS['gegl:focus-blur'], ('blur-radius',))

    def test_drop_shadow_x_y_radius_are_spatial(self):
        self.assertEqual(lib.SPATIAL_SCALE_PROPS['gegl:dropshadow'], ('x', 'y', 'radius'))

    def test_vignette_and_mono_mixer_are_deliberately_absent(self):
        # vignette is proportional (not absolute pixels); mono-mixer is a per-pixel channel-weight
        # filter with no spatial extent at all -- neither needs proxy scaling.
        self.assertNotIn('gegl:vignette', lib.SPATIAL_SCALE_PROPS)
        self.assertNotIn('gegl:mono-mixer', lib.SPATIAL_SCALE_PROPS)

    def test_every_effect_operation_is_accounted_for(self):
        # Every EFFECT_OPERATIONS value is EITHER in SPATIAL_SCALE_PROPS (has an absolute-pixel
        # property that needs proxy scaling) OR explicitly known to be proportional/per-pixel --
        # closes off the silent-drift case where a new effect is added and nobody decides which
        # bucket it belongs in.
        proportional_or_per_pixel = {'gegl:vignette', 'gegl:mono-mixer', 'gegl:noise-rgb'}
        for operation in lib.EFFECT_OPERATIONS.values():
            self.assertTrue(
                operation in lib.SPATIAL_SCALE_PROPS or operation in proportional_or_per_pixel,
                'operation=%s is in neither SPATIAL_SCALE_PROPS nor the known-proportional set '
                '-- decide which it is and update this test' % operation,
            )


class TestGeometryTransformEffectParams(unittest.TestCase):
    """The pure geometry math ops.py's `_snapshot_effect_transform`/`_apply_planned_effect_
    transform` apply for gimp_transform_canvas (flip/rotate) and gimp_resize_image, scoped to the
    new effect filters only (vignette/motion_blur/drop_shadow have direction/position params;
    black_white/add_noise/lens_blur do not and must round-trip unchanged, except lens_blur's own
    radius under resize, covered separately below)."""

    # ---- gimp_add_adjustment filters (and any other operation not in this table) must round-trip
    # through flip/rotate/resize completely untouched: `_snapshot_effect_transform`'s own
    # `new_params == params` check is what decides whether a filter needs a live re-apply and a
    # ledger rewrite, so rounding an untouched value would wrongly trigger both on every single
    # flip/rotate/resize regardless of what it actually did. hue_saturation's own `hue` (stored as
    # degrees/180) is a real example of a value non-terminating enough in binary to shift in its
    # 9th-10th decimal place under a naive whole-dict round, which is already enough for `==` to
    # call it "changed".

    def test_flip_leaves_hue_saturation_completely_untouched_at_10_over_180(self):
        params = {'range': 'all', 'hue': lib.degrees_to_unit('hue', 10), 'saturation': 0.2, 'lightness': 0.0}
        self.assertEqual(params['hue'], 10 / 180)  # the exact non-terminating value under test
        result = lib.flip_effect_params('gimp:hue-saturation', params, 'horizontal')
        self.assertEqual(result, params)
        self.assertIs(result, params)  # not even a copy -- this operation has nothing to say here

    def test_flip_leaves_hue_saturation_completely_untouched_at_a_second_non_terminating_value(self):
        params = {'range': 'red', 'hue': lib.degrees_to_unit('hue', 100), 'saturation': 0.5, 'lightness': -0.2}
        self.assertEqual(params['hue'], 100 / 180)
        result = lib.flip_effect_params('gimp:hue-saturation', params, 'vertical')
        self.assertEqual(result, params)
        self.assertIs(result, params)

    def test_rotate_leaves_hue_saturation_completely_untouched(self):
        params = {'range': 'all', 'hue': lib.degrees_to_unit('hue', 10), 'saturation': 0.2, 'lightness': 0.0}
        result = lib.rotate_effect_params('gimp:hue-saturation', params, 90.0, 200, 200)
        self.assertEqual(result, params)
        self.assertIs(result, params)

    def test_resize_leaves_hue_saturation_completely_untouched(self):
        params = {'range': 'all', 'hue': lib.degrees_to_unit('hue', 100), 'saturation': 0.2, 'lightness': 0.0}
        result = lib.resize_effect_params('gimp:hue-saturation', params, 2.0, 3.0)
        self.assertEqual(result, params)
        self.assertIs(result, params)

    def test_wrap_angle_normalizes_into_the_validated_range(self):
        self.assertEqual(lib._wrap_angle_deg(0.0), 0.0)
        self.assertEqual(lib._wrap_angle_deg(180.0), 180.0)
        self.assertEqual(lib._wrap_angle_deg(-180.0), 180.0)
        self.assertEqual(lib._wrap_angle_deg(270.0), -90.0)
        self.assertEqual(lib._wrap_angle_deg(-270.0), 90.0)
        self.assertEqual(lib._wrap_angle_deg(360.0), 0.0)

    def test_is_right_angle_degrees_accepts_every_multiple_of_90_either_sign(self):
        for degrees in (0.0, 90.0, 180.0, 270.0, 360.0, -90.0, -180.0, -270.0, 450.0):
            self.assertTrue(lib.is_right_angle_degrees(degrees), degrees)

    def test_is_right_angle_degrees_rejects_everything_else(self):
        for degrees in (1.0, 45.0, 89.0, 91.0, 15.0, -1.0, 179.99):
            self.assertFalse(lib.is_right_angle_degrees(degrees), degrees)

    def test_is_right_angle_degrees_tolerance(self):
        self.assertTrue(lib.is_right_angle_degrees(90.0000001))
        self.assertFalse(lib.is_right_angle_degrees(90.01))

    def test_dims_after_right_angle_rotation_swaps_at_90_and_270(self):
        self.assertEqual(lib._dims_after_right_angle_rotation(200, 100, 90.0), (100, 200))
        self.assertEqual(lib._dims_after_right_angle_rotation(200, 100, 270.0), (100, 200))
        self.assertEqual(lib._dims_after_right_angle_rotation(200, 100, -90.0), (100, 200))

    def test_dims_after_right_angle_rotation_unchanged_at_0_and_180(self):
        self.assertEqual(lib._dims_after_right_angle_rotation(200, 100, 0.0), (200, 100))
        self.assertEqual(lib._dims_after_right_angle_rotation(200, 100, 180.0), (200, 100))
        self.assertEqual(lib._dims_after_right_angle_rotation(200, 100, -180.0), (200, 100))

    def test_flip_horizontal_mirrors_vignette_center_x_only(self):
        params = {'radius': 1.2, 'softness': 0.8, 'gamma': 2.0, 'x': 0.3, 'y': 0.7}
        result = lib.flip_effect_params('gegl:vignette', params, 'horizontal')
        self.assertEqual(result['x'], 0.7)
        self.assertEqual(result['y'], 0.7)  # unchanged
        self.assertEqual(result['radius'], 1.2)  # unchanged

    def test_flip_vertical_mirrors_vignette_center_y_only(self):
        params = {'radius': 1.2, 'softness': 0.8, 'gamma': 2.0, 'x': 0.3, 'y': 0.7}
        result = lib.flip_effect_params('gegl:vignette', params, 'vertical')
        self.assertEqual(result['x'], 0.3)  # unchanged
        self.assertAlmostEqual(result['y'], 0.3, places=9)

    def test_flip_does_not_mutate_the_input_params(self):
        params = {'radius': 1.2, 'softness': 0.8, 'gamma': 2.0, 'x': 0.3, 'y': 0.7}
        lib.flip_effect_params('gegl:vignette', params, 'horizontal')
        self.assertEqual(params['x'], 0.3)

    def test_flip_horizontal_mirrors_motion_blur_angle(self):
        # angle=0 (a horizontal streak) becomes 180 under a horizontal flip, NOT 0 -- but still a
        # purely horizontal streak either way: a motion blur's direction is symmetric mod 180
        # degrees (blurring "toward 0" and "toward 180" render identically), so 180 is the
        # correct new value even though the flip doesn't return the SAME number.
        self.assertEqual(
            lib.flip_effect_params('gegl:motion-blur-linear', {'length': 10.0, 'angle': 0.0}, 'horizontal')['angle'],
            180.0,
        )
        self.assertAlmostEqual(
            lib.flip_effect_params('gegl:motion-blur-linear', {'length': 10.0, 'angle': 30.0}, 'horizontal')['angle'],
            150.0,
        )

    def test_flip_vertical_mirrors_motion_blur_angle(self):
        self.assertAlmostEqual(
            lib.flip_effect_params('gegl:motion-blur-linear', {'length': 10.0, 'angle': 30.0}, 'vertical')['angle'],
            -30.0,
        )

    def test_flip_mirrors_drop_shadow_offset(self):
        params = {'x': 20.0, 'y': 15.0, 'radius': 5.0, 'opacity': 0.5}
        h = lib.flip_effect_params('gegl:dropshadow', params, 'horizontal')
        self.assertEqual(h['x'], -20.0)
        self.assertEqual(h['y'], 15.0)
        v = lib.flip_effect_params('gegl:dropshadow', params, 'vertical')
        self.assertEqual(v['x'], 20.0)
        self.assertEqual(v['y'], -15.0)

    def test_flip_leaves_non_directional_effects_unchanged(self):
        for operation, params in (
            ('gegl:mono-mixer', {'red': 0.3, 'green': 0.3, 'blue': 0.3, 'preserve-luminosity': False}),
            ('gegl:noise-rgb', {'red': 0.2, 'green': 0.2, 'blue': 0.2, 'alpha': 0.0, 'seed': 5}),
            ('gegl:focus-blur', {'blur-radius': 20.0, 'highlight-factor': 0.5}),
        ):
            self.assertEqual(lib.flip_effect_params(operation, params, 'horizontal'), params)
            self.assertEqual(lib.flip_effect_params(operation, params, 'vertical'), params)

    def test_rotate_point_fraction_90_degrees_same_canvas_size(self):
        # A point at the right-center edge (1.0, 0.5) of a square canvas, rotated 90 degrees
        # clockwise (op_rotate's own convention), lands at the bottom-center edge (0.5, 1.0).
        x, y = lib.rotate_point_fraction(1.0, 0.5, 90.0, 200, 200, 200, 200)
        self.assertAlmostEqual(x, 0.5, places=6)
        self.assertAlmostEqual(y, 1.0, places=6)

    def test_rotate_point_fraction_90_degrees_with_expand_swapping_dimensions(self):
        # A 200x100 extent rotated 90 degrees becomes 100x200. The point at the original
        # right-center edge (1.0, 0.5) is the absolute point (200, 50) -- 100px along +x from the
        # old center (100, 50), 0 along y. Rotating that (100, 0) offset 90 degrees clockwise
        # gives (0, 100) relative to the NEW center (50, 100) of the 100x200 extent, i.e. absolute
        # point (50, 200) -- fraction (0.5, 1.0): the bottom-center edge of the new extent, not
        # its dead center.
        x, y = lib.rotate_point_fraction(1.0, 0.5, 90.0, 200, 100, 100, 200)
        self.assertAlmostEqual(x, 0.5, places=6)
        self.assertAlmostEqual(y, 1.0, places=6)

    def test_rotate_point_fraction_360_is_identity(self):
        x, y = lib.rotate_point_fraction(0.25, 0.75, 360.0, 300, 200, 300, 200)
        self.assertAlmostEqual(x, 0.25, places=6)
        self.assertAlmostEqual(y, 0.75, places=6)

    def test_rotate_effect_params_vignette_uses_the_owning_layers_own_dimensions(self):
        # Same-size layer (square, no swap): matches rotate_point_fraction directly.
        params = {'radius': 1.2, 'softness': 0.8, 'gamma': 2.0, 'x': 1.0, 'y': 0.5}
        result = lib.rotate_effect_params('gegl:vignette', params, 90.0, 200, 200)
        self.assertAlmostEqual(result['x'], 0.5, places=6)
        self.assertAlmostEqual(result['y'], 1.0, places=6)

    def test_rotate_effect_params_vignette_uses_the_layers_own_extent_not_the_canvas(self):
        # A 200x100 LAYER (not necessarily the whole canvas) rotated 90 degrees: its own extent
        # swaps to 100x200 regardless of what the canvas does, and center_x/center_y are fractions
        # of THAT layer's own extent -- see build_vignette_params. Same numbers as
        # test_rotate_point_fraction_90_degrees_with_expand_swapping_dimensions above, but through
        # the two-argument (layer_width, layer_height) signature rotate_effect_params exposes.
        params = {'radius': 1.2, 'softness': 0.8, 'gamma': 2.0, 'x': 1.0, 'y': 0.5}
        result = lib.rotate_effect_params('gegl:vignette', params, 90.0, 200, 100)
        self.assertAlmostEqual(result['x'], 0.5, places=6)
        self.assertAlmostEqual(result['y'], 1.0, places=6)

    def test_rotate_effect_params_motion_blur_adds_degrees_to_angle(self):
        result = lib.rotate_effect_params(
            'gegl:motion-blur-linear', {'length': 10.0, 'angle': 20.0}, 90.0, 200, 200
        )
        self.assertAlmostEqual(result['angle'], 110.0, places=6)
        # length (an isotropic, non-directional magnitude) is untouched by rotation.
        self.assertEqual(result['length'], 10.0)

    def test_rotate_effect_params_motion_blur_30_plus_90_is_120_not_60(self):
        # A regression pin for the additive (not subtractive) convention: angle + degrees, never
        # degrees - angle -- the latter would give 90 - 30 = 60, a real but wrong-signed answer
        # this test exists specifically to rule out.
        result = lib.rotate_effect_params(
            'gegl:motion-blur-linear', {'length': 10.0, 'angle': 30.0}, 90.0, 200, 200
        )
        self.assertAlmostEqual(result['angle'], 120.0, places=6)

    def test_rotate_effect_params_drop_shadow_rotates_the_offset_vector(self):
        # An offset of (20, 0) -- straight right -- rotated 90 degrees clockwise becomes (0, 20)
        # -- straight down (matching the same (dx,dy) -> (-dy,dx)-at-90 convention op_rotate uses).
        result = lib.rotate_effect_params(
            'gegl:dropshadow', {'x': 20.0, 'y': 0.0, 'radius': 5.0, 'opacity': 0.5}, 90.0, 200, 200
        )
        self.assertAlmostEqual(result['x'], 0.0, places=6)
        self.assertAlmostEqual(result['y'], 20.0, places=6)

    def test_rotate_leaves_non_directional_effects_unchanged(self):
        for operation, params in (
            ('gegl:mono-mixer', {'red': 0.3, 'green': 0.3, 'blue': 0.3, 'preserve-luminosity': False}),
            ('gegl:noise-rgb', {'red': 0.2, 'green': 0.2, 'blue': 0.2, 'alpha': 0.0, 'seed': 5}),
            ('gegl:focus-blur', {'blur-radius': 20.0, 'highlight-factor': 0.5}),
        ):
            self.assertEqual(lib.rotate_effect_params(operation, params, 90.0, 200, 200), params)

    # ---- exact right-angle trig: 180/270/-90/360, plus edge values that must round-trip exactly

    def test_right_angle_cos_sin_is_exact_at_every_canonical_step(self):
        self.assertEqual(lib._right_angle_cos_sin(0.0), (1.0, 0.0))
        self.assertEqual(lib._right_angle_cos_sin(90.0), (0.0, 1.0))
        self.assertEqual(lib._right_angle_cos_sin(180.0), (-1.0, 0.0))
        self.assertEqual(lib._right_angle_cos_sin(270.0), (0.0, -1.0))
        self.assertEqual(lib._right_angle_cos_sin(-90.0), (0.0, -1.0))
        self.assertEqual(lib._right_angle_cos_sin(360.0), (1.0, 0.0))
        # Tolerance-fuzzy input (still accepted by is_right_angle_degrees) snaps to the exact step.
        self.assertEqual(lib._right_angle_cos_sin(90.0000003), (0.0, 1.0))

    def test_rotate_effect_params_vignette_at_180_270_minus90_360(self):
        # center (0.2, 0.7) on a 200x200 (square, no dimension swap needed to reason about).
        for degrees, expected in (
            (180.0, (0.8, 0.3)),
            (270.0, (0.7, 0.8)),
            (-90.0, (0.7, 0.8)),
            (360.0, (0.2, 0.7)),
        ):
            with self.subTest(degrees=degrees):
                result = lib.rotate_effect_params(
                    'gegl:vignette', {'radius': 1.0, 'softness': 0.5, 'gamma': 2.0, 'x': 0.2, 'y': 0.7},
                    degrees, 200, 200,
                )
                self.assertAlmostEqual(result['x'], expected[0], places=9)
                self.assertAlmostEqual(result['y'], expected[1], places=9)

    def test_rotate_effect_params_vignette_edge_values_are_exact_not_a_hair_off(self):
        # A center exactly AT an extent's edge (0.0 or 1.0) must land back exactly on an edge --
        # not 1e-17 off it -- at every right angle, including the ones (90/270) where raw
        # math.cos/sin would otherwise leak a tiny nonzero.
        for degrees in (90.0, 180.0, 270.0, -90.0, 360.0):
            with self.subTest(degrees=degrees):
                result = lib.rotate_effect_params(
                    'gegl:vignette', {'radius': 1.0, 'softness': 0.5, 'gamma': 2.0, 'x': 0.0, 'y': 0.5},
                    degrees, 200, 200,
                )
                self.assertIn(result['x'], (0.0, 0.5, 1.0))
                self.assertIn(result['y'], (0.0, 0.5, 1.0))
                # Never refused -- an edge value must stay comfortably within 0.0..1.0.
                lib.validate_effect_transform('rotate', 'gegl:vignette', 'Vignette', result)

    def test_rotate_effect_params_motion_blur_at_180_270_minus90_360(self):
        for degrees, expected in ((180.0, -150.0), (270.0, -60.0), (-90.0, -60.0), (360.0, 30.0)):
            with self.subTest(degrees=degrees):
                result = lib.rotate_effect_params(
                    'gegl:motion-blur-linear', {'length': 10.0, 'angle': 30.0}, degrees, 200, 200
                )
                self.assertAlmostEqual(result['angle'], expected, places=9)

    def test_rotate_effect_params_drop_shadow_at_180_270_minus90_360(self):
        for degrees, expected in (
            (180.0, (-20.0, 0.0)),
            (270.0, (0.0, -20.0)),
            (-90.0, (0.0, -20.0)),
            (360.0, (20.0, 0.0)),
        ):
            with self.subTest(degrees=degrees):
                result = lib.rotate_effect_params(
                    'gegl:dropshadow', {'x': 20.0, 'y': 0.0, 'radius': 5.0, 'opacity': 0.5},
                    degrees, 200, 200,
                )
                self.assertAlmostEqual(result['x'], expected[0], places=9)
                self.assertAlmostEqual(result['y'], expected[1], places=9)

    def test_rotate_effect_params_drop_shadow_edge_offsets_are_exact_and_not_refused(self):
        # +/-500 is the schema's own bound (build_drop_shadow_params' offset_x/offset_y) -- a
        # right-angle rotation of an offset already AT that bound must land back exactly on it,
        # never a hair over (which raw trig noise could otherwise push out of range).
        for degrees in (90.0, 180.0, 270.0, -90.0, 360.0):
            with self.subTest(degrees=degrees):
                result = lib.rotate_effect_params(
                    'gegl:dropshadow', {'x': 500.0, 'y': -500.0, 'radius': 5.0, 'opacity': 0.5},
                    degrees, 200, 200,
                )
                self.assertIn(result['x'], (500.0, -500.0, 0.0))
                self.assertIn(result['y'], (500.0, -500.0, 0.0))
                lib.validate_effect_transform('rotate', 'gegl:dropshadow', 'Drop Shadow', result)

    def test_resize_scales_motion_blur_length_under_uniform_scale(self):
        # Uniform scale (scale_x == scale_y): the anisotropic formula degenerates to plain
        # isotropic scaling, angle unchanged, regardless of the blur's own direction.
        result = lib.resize_effect_params('gegl:motion-blur-linear', {'length': 10.0, 'angle': 5.0}, 2.0, 2.0)
        self.assertAlmostEqual(result['length'], 20.0, places=6)
        self.assertAlmostEqual(result['angle'], 5.0, places=6)

    def test_resize_scales_motion_blur_anisotropically_horizontal_and_vertical(self):
        # A purely horizontal blur (angle=0) only "feels" the x-axis scale; a purely vertical one
        # (angle=90) only feels the y-axis scale -- the two extremes of the anisotropic formula,
        # each reducing to a simple single-axis scale.
        horizontal = lib.resize_effect_params(
            'gegl:motion-blur-linear', {'length': 10.0, 'angle': 0.0}, 3.0, 1.0
        )
        self.assertAlmostEqual(horizontal['length'], 30.0, places=6)
        self.assertAlmostEqual(horizontal['angle'], 0.0, places=6)
        vertical = lib.resize_effect_params(
            'gegl:motion-blur-linear', {'length': 10.0, 'angle': 90.0}, 3.0, 1.0
        )
        self.assertAlmostEqual(vertical['length'], 10.0, places=6)
        self.assertAlmostEqual(vertical['angle'], 90.0, places=6)

    def test_resize_scales_motion_blur_anisotropically_at_an_oblique_angle(self):
        # angle=45, scale_x=2, scale_y=0.5: direction vector (cos45, sin45) scales to
        # (2*cos45, 0.5*sin45) -- length' = hypot(2*cos45, 0.5*sin45) * 10, angle' =
        # atan2(0.5*sin45, 2*cos45). Computed independently here (not by re-deriving the same
        # formula) to catch a transcription error in the implementation itself.
        theta = math.radians(45.0)
        vx, vy = 2.0 * math.cos(theta), 0.5 * math.sin(theta)
        expected_length = 10.0 * math.hypot(vx, vy)
        expected_angle = math.degrees(math.atan2(vy, vx))
        result = lib.resize_effect_params(
            'gegl:motion-blur-linear', {'length': 10.0, 'angle': 45.0}, 2.0, 0.5
        )
        self.assertAlmostEqual(result['length'], expected_length, places=6)
        self.assertAlmostEqual(result['angle'], expected_angle, places=6)

    def test_resize_scales_lens_blur_radius_isotropically(self):
        result = lib.resize_effect_params(
            'gegl:focus-blur', {'blur-radius': 20.0, 'highlight-factor': 0.5}, 3.0, 3.0
        )
        self.assertAlmostEqual(result['blur-radius'], 60.0, places=6)

    def test_resize_scales_drop_shadow_offsets_per_axis_and_radius_isotropically(self):
        result = lib.resize_effect_params(
            'gegl:dropshadow', {'x': 10.0, 'y': 20.0, 'radius': 5.0, 'opacity': 0.5}, 2.0, 4.0
        )
        self.assertAlmostEqual(result['x'], 20.0, places=6)
        self.assertAlmostEqual(result['y'], 80.0, places=6)
        # radius uses the geometric mean of the two axis scales (sqrt(2*4) = sqrt(8)).
        self.assertAlmostEqual(result['radius'], 5.0 * math.sqrt(8.0), places=6)

    def test_resize_uniform_scale_is_exact_for_drop_shadow_radius(self):
        result = lib.resize_effect_params(
            'gegl:dropshadow', {'x': 10.0, 'y': 10.0, 'radius': 5.0, 'opacity': 0.5}, 2.0, 2.0
        )
        self.assertAlmostEqual(result['radius'], 10.0, places=6)

    def test_resize_leaves_vignette_black_white_add_noise_unchanged(self):
        # Proportional (vignette) or purely per-pixel (black_white, add_noise) -- none of these
        # have an absolute-pixel property, so a resize must not touch any of them at all.
        for operation, params in (
            ('gegl:vignette', {'radius': 1.2, 'softness': 0.8, 'gamma': 2.0, 'x': 0.5, 'y': 0.5}),
            ('gegl:mono-mixer', {'red': 0.3, 'green': 0.3, 'blue': 0.3, 'preserve-luminosity': False}),
            ('gegl:noise-rgb', {'red': 0.2, 'green': 0.2, 'blue': 0.2, 'alpha': 0.0, 'seed': 5}),
        ):
            self.assertEqual(lib.resize_effect_params(operation, params, 2.0, 3.0), params)


class TestValidateEffectTransform(unittest.TestCase):
    """`validate_effect_transform` is the refuse-before-mutate gate `_snapshot_effect_transform`
    calls for every planned param change -- it must accept anything within the SAME bounds
    build_*_params enforces on create/re-edit, and refuse (naming the op, the FILTER, and the
    field in gimp_add_effect's OWN terms) anything outside them."""

    def test_accepts_in_range_vignette_coordinates(self):
        lib.validate_effect_transform(
            'rotate', 'gegl:vignette', 'Vignette', {'x': 0.0, 'y': 1.0}
        )  # no raise

    def test_refuses_out_of_range_motion_blur_length(self):
        with self.assertRaises(ValueError) as ctx:
            lib.validate_effect_transform(
                'resize', 'gegl:motion-blur-linear', 'Motion Blur',
                {'length': 1000.1, 'angle': 0.0},
            )
        message = str(ctx.exception)
        self.assertIn('resize', message)
        self.assertIn('Motion Blur', message)  # the FILTER's own name
        self.assertIn('length', message)  # the tool's field name (not "length" vs some GEGL name)

    def test_refuses_out_of_range_lens_blur_radius_naming_the_tools_field_name(self):
        # lens_blur's GEGL property is `blur-radius`; the tool's own field is `radius` -- the
        # message must say the latter, since that's what a caller actually typed.
        with self.assertRaises(ValueError) as ctx:
            lib.validate_effect_transform(
                'resize', 'gegl:focus-blur', 'Lens Blur', {'blur-radius': 150.1, 'highlight-factor': 0.0}
            )
        message = str(ctx.exception)
        self.assertIn('radius', message)
        self.assertNotIn('blur-radius', message)

    def test_refuses_out_of_range_drop_shadow_offset_naming_offset_x(self):
        # dropshadow's GEGL property is `x`; the tool's own field is `offset_x`.
        with self.assertRaises(ValueError) as ctx:
            lib.validate_effect_transform(
                'resize', 'gegl:dropshadow', 'Drop Shadow',
                {'x': 500.1, 'y': 0.0, 'radius': 5.0, 'opacity': 0.5},
            )
        message = str(ctx.exception)
        self.assertIn('offset_x', message)

    def test_refusal_message_never_says_bake(self):
        with self.assertRaises(ValueError) as ctx:
            lib.validate_effect_transform(
                'resize', 'gegl:motion-blur-linear', 'Motion Blur',
                {'length': 1000.1, 'angle': 0.0},
            )
        self.assertNotIn('bake', str(ctx.exception))
        self.assertIn('gimp_filter op=delete', str(ctx.exception))

    def test_refusal_message_shows_enough_precision_and_never_doubles_the_apostrophe(self):
        # The message must keep enough precision to show why the value is out of range (%.4g
        # would print 1000.1 as "1000"), and must not put a possessive "'s" right after a repr'd
        # name, which reads as a doubled apostrophe ("'Motion Blur''s").
        with self.assertRaises(ValueError) as ctx:
            lib.validate_effect_transform(
                'resize', 'gegl:motion-blur-linear', 'Motion Blur',
                {'length': 1000.1, 'angle': 0.0},
            )
        message = str(ctx.exception)
        self.assertIn('1000.1', message)
        self.assertNotIn("''s", message)

    def test_accepts_operations_with_no_bounds_table_entry(self):
        lib.validate_effect_transform('flip', 'gegl:mono-mixer', 'B&W', {'red': 99.0})  # no raise

    def test_ignores_fields_not_present_in_new_params(self):
        # rotate_effect_params never touches motion_blur's `length` -- validate_effect_transform
        # must not demand it be present to validate the fields that ARE there.
        lib.validate_effect_transform(
            'rotate', 'gegl:motion-blur-linear', 'Motion Blur', {'angle': 45.0}
        )


class TestEffectTransformBoundsMatchBuilders(unittest.TestCase):
    """EFFECT_TRANSFORM_BOUNDS is a table maintained SEPARATELY from the validate_range calls
    inside build_vignette_params/build_motion_blur_params/build_lens_blur_params/
    build_drop_shadow_params -- a real drift risk if one changes without the other. This pins
    that every entry's (lo, hi) is accepted by the matching builder at exactly lo/hi and refused
    just outside both ends."""

    BUILDER_AND_TYPE = {
        'gegl:vignette': ('vignette', lib.build_vignette_params),
        'gegl:motion-blur-linear': ('motion_blur', lib.build_motion_blur_params),
        'gegl:focus-blur': ('lens_blur', lib.build_lens_blur_params),
        'gegl:dropshadow': ('drop_shadow', lib.build_drop_shadow_params),
    }

    def test_every_bound_is_accepted_at_its_edges_and_refused_just_outside(self):
        for operation, props in lib.EFFECT_TRANSFORM_BOUNDS.items():
            type_, builder = self.BUILDER_AND_TYPE[operation]
            defaults = lib.EFFECT_CREATE_DEFAULTS[type_]
            for prop, (lo, hi) in props.items():
                user_field = lib.EFFECT_TRANSFORM_FIELD_NAMES[(operation, prop)]
                eps = max(abs(hi - lo), 1.0) * 1e-6
                with self.subTest(operation=operation, field=user_field, edge='lo'):
                    builder({user_field: lo}, defaults)  # must not raise
                with self.subTest(operation=operation, field=user_field, edge='hi'):
                    builder({user_field: hi}, defaults)  # must not raise
                with self.subTest(operation=operation, field=user_field, edge='lo-eps'):
                    with self.assertRaises(ValueError):
                        builder({user_field: lo - eps}, defaults)
                with self.subTest(operation=operation, field=user_field, edge='hi-eps'):
                    with self.assertRaises(ValueError):
                        builder({user_field: hi + eps}, defaults)


class TestJsonSafe(unittest.TestCase):
    def test_plain_values_pass_through(self):
        for v in (None, True, 3, 2.5, 'x'):
            self.assertIs(lib.json_safe(v), v)

    def test_foreign_objects_become_strings_so_the_listing_serialises(self):
        class GeglColorLike:
            def __str__(self):
                return '<Gegl.Color object>'

        value = {'value': GeglColorLike(), 'nested': [GeglColorLike(), 1], 'raw': b'\x00'}
        safe = lib.json_safe(value)
        self.assertEqual(safe['value'], '<Gegl.Color object>')
        self.assertEqual(safe['nested'], ['<Gegl.Color object>', 1])
        self.assertIsInstance(safe['raw'], str)
        json.dumps(safe)  # must not raise

    def test_non_finite_floats_become_strings(self):
        # json.dumps would write NaN/Infinity, which Node's JSON.parse rejects outright.
        safe = lib.json_safe({'a': float('nan'), 'b': float('inf'), 'c': [float('-inf')]})
        self.assertEqual(safe, {'a': 'nan', 'b': 'inf', 'c': ['-inf']})
        json.loads(json.dumps(safe, allow_nan=False))

    def test_values_with_more_than_six_decimals_round_trip_within_a_rounding_step(self):
        gegl = lib.build_brightness_contrast_params(
            {'brightness': 12.3456789}, _create_defaults('brightness_contrast')
        )
        listed = lib.user_params('brightness_contrast', gegl)
        self.assertEqual(listed['brightness'], 12.345679)
        rebuilt = lib.build_brightness_contrast_params(listed, gegl)
        self.assertAlmostEqual(rebuilt['brightness'], gegl['brightness'], places=7)


class TestValidateLevels(unittest.TestCase):
    def _params(self, **over):
        params = {'channel': 'value', 'in_low': 0.0, 'in_high': 255.0, 'gamma': 1.0,
                  'out_low': 0.0, 'out_high': 255.0}
        params.update(over)
        return params

    def test_accepts_a_normal_record(self):
        self.assertEqual(lib.validate_levels(self._params(gamma=2.2)), self._params(gamma=2.2))

    def test_rejects_gamma_outside_the_tool_bound(self):
        for gamma in (0.05, 10.5, -1):
            with self.assertRaises(ValueError):
                lib.validate_levels(self._params(gamma=gamma))

    def test_rejects_an_empty_or_inverted_input_range(self):
        for low, high in ((100.0, 100.0), (200.0, 50.0)):
            with self.assertRaises(ValueError):
                lib.validate_levels(self._params(in_low=low, in_high=high))


class TestGaussianBlur(unittest.TestCase):
    def test_one_radius_drives_both_axes(self):
        params = lib.build_gaussian_blur_params({'radius': 6}, _create_defaults('gaussian_blur'))
        self.assertEqual(params, {'std-dev-x': 6.0, 'std-dev-y': 6.0})

    def test_create_default_matches_gegl(self):
        # gegl:gaussian-blur's own std-dev-x/std-dev-y default, probed live on GIMP 3.2.6.
        params = lib.build_gaussian_blur_params({}, _create_defaults('gaussian_blur'))
        self.assertEqual(params, {'std-dev-x': 1.5, 'std-dev-y': 1.5})

    def test_rejects_out_of_range(self):
        for radius in (-1, 1501):
            with self.assertRaises(ValueError):
                lib.build_gaussian_blur_params({'radius': radius}, _create_defaults('gaussian_blur'))

    def test_is_spatial_on_the_proxy(self):
        self.assertEqual(lib.SPATIAL_SCALE_PROPS['gegl:gaussian-blur'], ('std-dev-x', 'std-dev-y'))
        self.assertIn('gegl:gaussian-blur', lib.ALLOWED_DESCRIBE_OPERATIONS)


class TestUniqueName(unittest.TestCase):
    def test_returns_base_when_free(self):
        self.assertEqual(lib.unique_name({'Other'}, 'Layer'), 'Layer')

    def test_suffixes_when_taken(self):
        self.assertEqual(lib.unique_name({'Layer'}, 'Layer'), 'Layer 2')

    def test_keeps_incrementing_past_multiple_collisions(self):
        self.assertEqual(lib.unique_name({'Layer', 'Layer 2', 'Layer 3'}, 'Layer'), 'Layer 4')

    def test_does_not_mutate_its_input(self):
        taken = {'Layer'}
        lib.unique_name(taken, 'Layer')
        self.assertEqual(taken, {'Layer'})

    def test_accepts_any_iterable_not_just_a_set(self):
        self.assertEqual(lib.unique_name(['Layer', 'Layer'], 'Layer'), 'Layer 2')


class TestLayerModes(unittest.TestCase):
    # gimp_layer op=set's blend-mode allow-list -- probed live (GIMP 3.2.6) and goldened via each
    # member's own .value_nick in lib.py's own LAYER_MODES comment.
    def test_every_supported_blend_mode_name_is_present(self):
        expected = {
            'normal', 'multiply', 'screen', 'overlay', 'soft_light', 'hard_light', 'darken',
            'lighten', 'difference', 'exclusion', 'addition', 'subtract', 'divide', 'dodge',
            'burn', 'hue', 'saturation', 'color', 'luminosity',
        }
        self.assertEqual(set(lib.LAYER_MODES), expected)

    def test_every_value_is_a_real_gimp_layermode_member_name(self):
        # gi-free: this only checks the shape (an UPPER_CASE identifier-looking string) that
        # ops.py's `getattr(Gimp.LayerMode, ...)` will resolve -- an actual GIMP round trip is the
        # live test's job.
        for name, member in lib.LAYER_MODES.items():
            self.assertTrue(member.isupper(), '%s -> %r should be upper-case' % (name, member))
            self.assertTrue(member.replace('_', '').isalpha(), '%s -> %r should be a bare identifier' % (name, member))

    def test_validate_layer_mode_accepts_every_listed_name(self):
        for name in lib.LAYER_MODES:
            self.assertEqual(lib.validate_layer_mode(name), name)

    def test_validate_layer_mode_rejects_a_raw_gimp_nick(self):
        # 'darken-only' is what ops.py's own value_nick readback would report -- this validator
        # only accepts the tool's own user-facing vocabulary, not the raw nick.
        with self.assertRaises(ValueError):
            lib.validate_layer_mode('darken-only')

    def test_validate_layer_mode_rejects_unknown(self):
        with self.assertRaises(ValueError):
            lib.validate_layer_mode('vivid-light')


class TestLayerFills(unittest.TestCase):
    def test_fills_are_the_three_documented_choices(self):
        self.assertEqual(set(lib.LAYER_FILLS), {'white', 'black', 'transparent'})


class TestRejectForeignFields(unittest.TestCase):
    """A field that belongs to a different type must be refused, not silently ignored."""

    def test_type_fields_is_exactly_what_each_builder_reads(self):
        # Run every real builder on an args dict that records each key it looks up. A key the
        # builder reads but type_fields lacks would be REFUSED for a legitimate call; a key
        # type_fields lists but the builder ignores would let a no-op filter through.
        class Recording(dict):
            def __init__(self, *a):
                super().__init__(*a)
                self.read = set()

            def get(self, key, default=None):
                self.read.add(key)
                return super().get(key, default)

            def __contains__(self, key):
                self.read.add(key)
                return super().__contains__(key)

            def __getitem__(self, key):
                self.read.add(key)
                return super().__getitem__(key)

        builders = [(t, b, lib.ADJUST_CREATE_DEFAULTS[t]) for t, b in lib.ADJUST_PARAM_BUILDERS.items()]
        builders += [(t, b, lib.EFFECT_CREATE_DEFAULTS[t]) for t, b in lib.EFFECT_PARAM_BUILDERS.items()]
        for type_, builder, defaults in builders:
            with self.subTest(type_=type_):
                args = Recording()
                builder(args, dict(defaults))
                self.assertEqual(args.read, set(lib.type_fields(type_)))

    def test_every_type_accepts_its_own_full_field_set(self):
        for type_, user_args in {**USER_ARGS_BY_TYPE, **EFFECT_USER_ARGS_BY_TYPE}.items():
            with self.subTest(type_=type_):
                lib.reject_foreign_fields(type_, dict(user_args, type=type_, image=1))

    def test_curves_and_levels_accept_their_own_fields(self):
        lib.reject_foreign_fields('curves', {'type': 'curves', 'channel': 'red', 'points': []})
        lib.reject_foreign_fields('levels', {'type': 'levels', 'gamma': 1.2, 'out_high': 240})

    def test_common_keys_are_always_allowed(self):
        lib.reject_foreign_fields('exposure', {
            'image': 1, 'type': 'exposure', 'layer': 'L', 'layer_id': 5, 'filter_id': 9,
            'mask': 'M', 'name': 'N', 'exposure': 1.0,
        })

    def test_a_field_from_another_type_is_refused_naming_the_real_fields(self):
        with self.assertRaises(ValueError) as ctx:
            lib.reject_foreign_fields('saturation', {'type': 'saturation', 'saturation': 1.3})
        self.assertIn(
            "type 'saturation' does not use field(s) saturation; its fields are: scale",
            str(ctx.exception),
        )

    def test_effect_types_refuse_adjustment_fields(self):
        with self.assertRaises(ValueError) as ctx:
            lib.reject_foreign_fields('vignette', {'type': 'vignette', 'exposure': 1, 'radius': 1})
        refused = str(ctx.exception).split(';')[0]
        self.assertIn('exposure', refused)
        self.assertNotIn('radius', refused)

    def test_none_values_are_treated_as_omitted(self):
        lib.reject_foreign_fields('saturation', {'type': 'saturation', 'scale': 2, 'hue': None})


class TestVisibleImageIds(unittest.TestCase):
    def test_drops_hidden_ids_and_keeps_order(self):
        self.assertEqual(lib.visible_image_ids([1, 8, 2, 9], [8, 9]), [1, 2])

    def test_no_hidden_ids_is_identity(self):
        self.assertEqual(lib.visible_image_ids([3, 4], []), [3, 4])


class TestExifOrientation(unittest.TestCase):
    # Pixel grid indexed [row][col]; the steps must turn the grid stored for each orientation
    # into the upright 2x3 picture [[a, b, c], [d, e, f]].
    UPRIGHT = [['a', 'b', 'c'], ['d', 'e', 'f']]

    @staticmethod
    def _stored(orientation):
        # What a camera writes for `UPRIGHT` under each EXIF orientation (the EXIF spec's
        # "0th row / 0th column" table), built from the spec's own definitions rather than lib.
        up = TestExifOrientation.UPRIGHT
        rows, cols = len(up), len(up[0])
        if orientation == 1:
            return [r[:] for r in up]
        if orientation == 2:
            return [r[::-1] for r in up]
        if orientation == 3:
            return [r[::-1] for r in up[::-1]]
        if orientation == 4:
            return up[::-1]
        # 5-8 swap the axes: stored has `cols` rows of `rows` pixels; stored row i is a visual
        # column and stored column j a visual row, per each orientation's own row/column sides.
        if orientation == 5:   # 0th row = visual left, 0th column = visual top
            return [[up[j][i] for j in range(rows)] for i in range(cols)]
        if orientation == 6:   # 0th row = visual right, 0th column = visual top
            return [[up[j][cols - 1 - i] for j in range(rows)] for i in range(cols)]
        if orientation == 7:   # 0th row = visual right, 0th column = visual bottom
            return [[up[rows - 1 - j][cols - 1 - i] for j in range(rows)] for i in range(cols)]
        if orientation == 8:   # 0th row = visual left, 0th column = visual bottom
            return [[up[rows - 1 - j][i] for j in range(rows)] for i in range(cols)]
        raise AssertionError(orientation)

    @staticmethod
    def _apply(grid, step):
        if step == 'flip_h':
            return [r[::-1] for r in grid]
        if step == 'flip_v':
            return grid[::-1]
        cw = {'cw90': 1, 'cw180': 2, 'cw270': 3}[step]
        for _ in range(cw):
            grid = [list(col) for col in zip(*grid[::-1])]
        return grid

    def test_every_orientation_steps_to_upright(self):
        for orientation in range(1, 9):
            grid = self._stored(orientation)
            for step in lib.exif_orientation_steps(orientation):
                grid = self._apply(grid, step)
            self.assertEqual(grid, self.UPRIGHT, 'orientation %d' % orientation)

    def test_normal_and_unknown_orientations_need_no_steps(self):
        self.assertEqual(lib.exif_orientation_steps(1), ())
        self.assertEqual(lib.exif_orientation_steps(None), ())
        self.assertEqual(lib.exif_orientation_steps(9), ())

    def test_parse_accepts_one_to_eight(self):
        for n in range(1, 9):
            self.assertEqual(lib.parse_exif_orientation(str(n)), n)
        self.assertEqual(lib.parse_exif_orientation(' 6 '), 6)
        self.assertEqual(lib.parse_exif_orientation(6), 6)

    def test_parse_ignores_a_broken_tag(self):
        for raw in (None, '', 'right, top', '0', '9', '-1', '6.5', object()):
            self.assertIsNone(lib.parse_exif_orientation(raw), repr(raw))

    def test_clear_drops_every_orientation_tag(self):
        class FakeMetadata:
            def __init__(self):
                self.tags = {tag: '6' for tag in lib.ORIENTATION_TAGS}

            def try_clear_tag(self, tag):
                return self.tags.pop(tag, None) is not None

        md = FakeMetadata()
        self.assertTrue(lib.clear_exif_orientation(md))
        self.assertEqual(md.tags, {})

    def test_read_and_clear_through_a_metadata_object(self):
        class FakeMetadata:
            def __init__(self, value):
                self.tags = {} if value is None else {lib.EXIF_ORIENTATION_TAG: value}

            def try_get_tag_string(self, tag):
                return self.tags.get(tag)

            def try_clear_tag(self, tag):
                return self.tags.pop(tag, None) is not None

        md = FakeMetadata('6')
        self.assertEqual(lib.read_exif_orientation(md), 6)
        self.assertTrue(lib.clear_exif_orientation(md))
        self.assertNotIn(lib.EXIF_ORIENTATION_TAG, md.tags)
        self.assertIsNone(lib.read_exif_orientation(md))
        self.assertIsNone(lib.read_exif_orientation(FakeMetadata(None)))
        self.assertIsNone(lib.read_exif_orientation(None))

    def test_read_and_clear_swallow_a_failing_metadata_object(self):
        class Broken:
            def try_get_tag_string(self, tag):
                raise RuntimeError('boom')

            def try_clear_tag(self, tag):
                raise RuntimeError('boom')

        self.assertIsNone(lib.read_exif_orientation(Broken()))
        self.assertFalse(lib.clear_exif_orientation(Broken()))
FONT_NAMES = [
    'Sans-serif', 'Sans-serif Bold', 'Serif', 'Arial Regular', 'Arial Bold', 'Arial Narrow',
    'Arial Black', 'Inter Regular', 'Inter Bold', 'Inter Bold Italic', 'Open Sans Regular',
    'Open Sans Bold', 'Playfair Display Regular', 'Playfair Display Black Italic', 'Bebas Neue',
    'Bahnschrift Light Condensed', 'Bahnschrift Regular', 'Consolas Italic', 'Zapfino Medium',
]


class TestResolveFont(unittest.TestCase):
    def test_exact_full_name_is_case_insensitive(self):
        self.assertEqual(lib.resolve_font('inter bold', FONT_NAMES), ('Inter Bold', 'name'))
        self.assertEqual(lib.resolve_font('OPEN SANS BOLD', FONT_NAMES), ('Open Sans Bold', 'name'))

    def test_family_with_a_space_resolves_to_its_regular_face(self):
        self.assertEqual(lib.resolve_font('Open Sans', FONT_NAMES), ('Open Sans Regular', 'family+regular'))
        self.assertEqual(lib.resolve_font('Playfair Display', FONT_NAMES),
                         ('Playfair Display Regular', 'family+regular'))

    def test_multi_word_style_names(self):
        self.assertEqual(lib.resolve_font('Playfair Display Black Italic', FONT_NAMES)[0],
                         'Playfair Display Black Italic')

    def test_family_without_a_regular_face_uses_the_shortest_face(self):
        name, how = lib.resolve_font('Consolas', FONT_NAMES)
        self.assertEqual((name, how), ('Consolas Italic', 'family'))
        name, how = lib.resolve_font('Zapfino', FONT_NAMES)
        self.assertEqual((name, how), ('Zapfino Medium', 'family+regular'))

    def test_family_prefers_regular_over_a_longer_style_name(self):
        self.assertEqual(lib.resolve_font('Arial', FONT_NAMES)[0], 'Arial Regular')
        self.assertEqual(lib.resolve_font('Bahnschrift', FONT_NAMES)[0], 'Bahnschrift Regular')

    def test_a_name_listed_bare_matches_itself(self):
        self.assertEqual(lib.resolve_font('Bebas Neue', FONT_NAMES), ('Bebas Neue', 'name'))
        self.assertEqual(lib.resolve_font('Serif', FONT_NAMES), ('Serif', 'name'))

    def test_style_word_order_and_punctuation_are_tolerated(self):
        self.assertEqual(lib.resolve_font('Inter Italic Bold', FONT_NAMES)[0], 'Inter Bold Italic')
        self.assertEqual(lib.resolve_font('Sans_serif', FONT_NAMES)[0], 'Sans-serif')

    def test_a_prefix_of_an_unrelated_name_is_not_a_family(self):
        with self.assertRaises(ValueError):
            lib.resolve_font('Open', FONT_NAMES)

    def test_a_miss_lists_up_to_eight_closest_names(self):
        with self.assertRaises(ValueError) as ctx:
            lib.resolve_font('Intr', FONT_NAMES)
        message = str(ctx.exception)
        self.assertIn("no installed font matches 'Intr'", message)
        self.assertIn('Closest installed names:', message)
        listed = message.split('Closest installed names: ')[1].split(', ')
        self.assertLessEqual(len(listed), 8)
        self.assertIn('Inter Regular', listed)

    def test_suggestions_cap_at_the_limit_and_come_from_installed_names(self):
        suggestions = lib.font_suggestions('Arial Condensed Bold', FONT_NAMES)
        self.assertLessEqual(len(suggestions), lib.FONT_SUGGESTION_LIMIT)
        self.assertTrue(all(s in FONT_NAMES for s in suggestions))
        self.assertIn('Arial Bold', suggestions)
        self.assertEqual(len(lib.font_suggestions('zzz', FONT_NAMES)), lib.FONT_SUGGESTION_LIMIT)

    def test_an_empty_font_list_is_reported(self):
        with self.assertRaises(ValueError) as ctx:
            lib.resolve_font('Inter', [])
        self.assertIn('no fonts are installed', str(ctx.exception))

    def test_blank_or_non_string_names_are_refused(self):
        for bad in ('', '   ', None, 5):
            with self.assertRaises(ValueError):
                lib.resolve_font(bad, FONT_NAMES)


class TestDefaultFontAndList(unittest.TestCase):
    def test_default_prefers_the_generic_sans(self):
        self.assertEqual(lib.pick_default_font(FONT_NAMES), 'Sans-serif')

    def test_default_falls_back_to_the_first_sorted_name(self):
        self.assertEqual(lib.pick_default_font(['Zed', 'alpha', 'Beta']), 'alpha')
        self.assertIsNone(lib.pick_default_font([]))

    def test_list_is_sorted_case_insensitively_and_filterable(self):
        page, total = lib.list_fonts(['b', 'A', 'c', 'B2'])
        self.assertEqual((page, total), (['A', 'b', 'B2', 'c'], 4))
        self.assertEqual(lib.list_fonts(['Inter Bold', 'Arial', 'inter regular'], 'INTER'),
                         (['Inter Bold', 'inter regular'], 2))

    def test_list_is_capped_but_total_counts_every_match(self):
        names = ['Font %04d' % i for i in range(lib.TEXT_FONT_LIST_CAP + 37)]
        page, total = lib.list_fonts(names)
        self.assertEqual(len(page), lib.TEXT_FONT_LIST_CAP)
        self.assertEqual(total, lib.TEXT_FONT_LIST_CAP + 37)


class TestTextValidation(unittest.TestCase):
    def test_alignment_mapping(self):
        self.assertEqual(lib.justification_nick('LEFT'), 'left')
        self.assertEqual(lib.justification_nick('CENTER'), 'center')
        self.assertEqual(lib.justification_nick('RIGHT'), 'right')
        self.assertEqual(lib.justification_nick('FULLYJUSTIFIED'), 'fill')

    def test_unsupported_alignments_are_refused_with_the_supported_list(self):
        for value in ('LEFTJUSTIFIED', 'CENTERJUSTIFIED', 'RIGHTJUSTIFIED'):
            with self.assertRaises(ValueError) as ctx:
                lib.justification_nick(value)
            self.assertIn('not supported by GIMP text layers', str(ctx.exception))
            self.assertIn('FULLYJUSTIFIED', str(ctx.exception))
        with self.assertRaises(ValueError):
            lib.justification_nick('diagonal')

    def test_alignment_name_round_trips_every_supported_value(self):
        for name, nick in lib.TEXT_ALIGNMENTS.items():
            self.assertEqual(lib.alignment_name(nick), name)
        self.assertIsNone(lib.alignment_name('nonsense'))

    def test_text_cap_is_2000_characters(self):
        self.assertEqual(lib.validate_text_content('a' * 2000), 'a' * 2000)
        with self.assertRaises(ValueError) as ctx:
            lib.validate_text_content('a' * 2001)
        self.assertIn('at most 2000 characters', str(ctx.exception))

    def test_text_must_be_a_non_empty_string(self):
        for bad in ('', None, 5):
            with self.assertRaises(ValueError):
                lib.validate_text_content(bad)

    def test_font_size_bounds(self):
        self.assertEqual(lib.validate_font_size_pt(1), 1.0)
        self.assertEqual(lib.validate_font_size_pt(1296), 1296.0)
        for bad in (0.5, 1297, True, 'big'):
            with self.assertRaises(ValueError):
                lib.validate_font_size_pt(bad)

    def test_rgb_all_or_nothing(self):
        self.assertIsNone(lib.validate_text_rgb({}))
        self.assertEqual(lib.validate_text_rgb({'red': 1, 'green': 2, 'blue': 3}), (1, 2, 3))
        with self.assertRaises(ValueError) as ctx:
            lib.validate_text_rgb({'red': 1})
        self.assertIn('missing: green, blue', str(ctx.exception))
        for bad in ({'red': 256, 'green': 0, 'blue': 0}, {'red': -1, 'green': 0, 'blue': 0},
                    {'red': 1.5, 'green': 0, 'blue': 0}, {'red': True, 'green': 0, 'blue': 0}):
            with self.assertRaises(ValueError):
                lib.validate_text_rgb(bad)

    def test_points_convert_through_the_image_resolution(self):
        self.assertAlmostEqual(lib.pt_to_px(24, 72), 24)
        self.assertAlmostEqual(lib.pt_to_px(24, 300), 100)
        self.assertAlmostEqual(lib.pt_to_px(24, None), 24)
        self.assertAlmostEqual(lib.pt_to_px(24, 0), 24)
        self.assertEqual(lib.px_to_pt(100, 300), 24.0)
        self.assertEqual(lib.unit_size_to_pt(100, True, 0.0, 300), 24.0)
        self.assertEqual(lib.unit_size_to_pt(24, False, 72.0, 300), 24.0)
        self.assertEqual(lib.unit_size_to_pt(1, False, 1.0, 300), 72.0)

    def test_srgb_conversion_round_trips_every_8_bit_value(self):
        for v in range(256):
            self.assertEqual(lib.linear_to_srgb_u8(lib.srgb_u8_to_linear(v)), v)
        self.assertAlmostEqual(lib.srgb_u8_to_linear(255), 1.0)
        self.assertEqual(lib.linear_to_srgb_u8(-1), 0)
        self.assertEqual(lib.linear_to_srgb_u8(2), 255)

    def test_rendered_size_past_the_cap_is_refused(self):
        lib.check_text_layer_size(2000, 500)
        with self.assertRaises(ValueError) as ctx:
            lib.check_text_layer_size(40000, 100)
        self.assertIn('past the size limit', str(ctx.exception))
        with self.assertRaises(ValueError):
            lib.check_text_layer_size(20000, 20000)


class TestTextEstimate(unittest.TestCase):
    def test_scales_the_probe_with_headroom(self):
        w, h = lib.estimate_text_extent(40, 10, 8, 80)
        self.assertEqual((w, h), (math.ceil(400 * lib.TEXT_ESTIMATE_MARGIN), math.ceil(100 * lib.TEXT_ESTIMATE_MARGIN)))

    def test_adds_unscaled_spacing_and_indent(self):
        base_w, base_h = lib.estimate_text_extent(40, 10, 8, 80, chars=5, lines=3)
        w, h = lib.estimate_text_extent(40, 10, 8, 80, chars=5, lines=3, letter_spacing=1000,
                                        line_spacing=1000, indent=50)
        self.assertEqual(w, base_w + 5 * 1000 + 50)
        self.assertEqual(h, base_h + 2 * 1000)

    def test_negative_spacing_never_shrinks_the_estimate(self):
        self.assertEqual(
            lib.estimate_text_extent(40, 10, 8, 80, chars=5, lines=3, letter_spacing=-50,
                                     line_spacing=-50, indent=-50),
            lib.estimate_text_extent(40, 10, 8, 80, chars=5, lines=3),
        )

    def test_an_empty_probe_estimates_at_least_one_pixel(self):
        self.assertEqual(lib.estimate_text_extent(0, 0, 8, 80), (1, 1))

    def test_estimated_refusal_has_its_own_wording(self):
        lib.check_estimated_text_size(2000, 500)
        with self.assertRaises(ValueError) as ctx:
            lib.check_estimated_text_size(40000, 40000)
        self.assertIn('would render as about 40000x40000', str(ctx.exception))

    def test_report_caps_the_text(self):
        self.assertEqual(lib.text_for_report('abc'), ('abc', 3, False))
        self.assertEqual(lib.text_for_report(None), ('', 0, False))
        long_text = 'x' * (lib.TEXT_REPORT_MAX_CHARS + 50)
        text, length, truncated = lib.text_for_report(long_text)
        self.assertEqual((len(text), length, truncated), (lib.TEXT_REPORT_MAX_CHARS, len(long_text), True))

    def test_font_miss_echo_is_bounded(self):
        with self.assertRaises(ValueError) as ctx:
            lib.resolve_font('q' * 5000, ['Inter', 'Roboto'])
        self.assertLess(len(str(ctx.exception)), 400)


class TestFitScaleFraction(unittest.TestCase):
    def test_fit_letterboxes_on_the_shorter_axis_ratio(self):
        # A 100x50 layer into a 200x200 canvas: width ratio 2.0, height ratio 4.0 -- fit takes
        # the smaller (2.0), leaving the result inside the canvas on both axes.
        self.assertEqual(lib.fit_scale_fraction(100, 50, 200, 200, 'fit'), 2.0)

    def test_fill_covers_on_the_larger_axis_ratio(self):
        self.assertEqual(lib.fit_scale_fraction(100, 50, 200, 200, 'fill'), 4.0)

    def test_fit_and_fill_agree_when_aspect_already_matches(self):
        self.assertEqual(lib.fit_scale_fraction(100, 100, 300, 300, 'fit'), 3.0)
        self.assertEqual(lib.fit_scale_fraction(100, 100, 300, 300, 'fill'), 3.0)

    def test_already_fitted_layer_scales_by_exactly_1_0(self):
        # The idempotency `op_transform_layer`'s `fit` relies on: re-fitting a layer already
        # sized to the canvas computes a no-op scale.
        self.assertEqual(lib.fit_scale_fraction(200, 200, 200, 200, 'fit'), 1.0)

    def test_rejects_an_unknown_mode(self):
        with self.assertRaises(ValueError):
            lib.fit_scale_fraction(100, 100, 200, 200, 'stretch')


class TestComposeLayerMatrix(unittest.TestCase):
    def test_identity_when_every_param_is_a_no_op(self):
        m = lib.compose_layer_matrix(50, 50, 100.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        self.assertEqual([round(c, 9) for c in m], [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0])

    def test_pure_offset_translates_every_point_by_the_same_amount(self):
        m = lib.compose_layer_matrix(50, 50, 100.0, 100.0, 0.0, 0.0, 0.0, 10.0, -5.0)
        x, y, w, h = lib.transformed_bounds(m, 0, 0, 100, 100)
        self.assertEqual((round(x, 6), round(y, 6), round(w, 6), round(h, 6)), (10.0, -5.0, 100.0, 100.0))

    def test_scale_grows_the_layer_around_its_own_center(self):
        # A 100x100 layer at (0,0), center (50,50), scaled 200%: doubles to 200x200, re-centered
        # on the SAME point (50,50) -- new top-left (-50,-50).
        m = lib.compose_layer_matrix(50, 50, 200.0, 200.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        x, y, w, h = lib.transformed_bounds(m, 0, 0, 100, 100)
        self.assertEqual((round(x, 6), round(y, 6), round(w, 6), round(h, 6)), (-50.0, -50.0, 200.0, 200.0))

    def test_rotate_90_about_center_swaps_width_and_height(self):
        m = lib.compose_layer_matrix(50, 25, 100.0, 100.0, 90.0, 0.0, 0.0, 0.0, 0.0)
        x, y, w, h = lib.transformed_bounds(m, 0, 0, 100, 50)
        self.assertEqual((round(w, 6), round(h, 6)), (50.0, 100.0))
        # Same center (50, 25) before and after.
        self.assertEqual((round(x + w / 2, 6), round(y + h / 2, 6)), (50.0, 25.0))

    def test_shear_leaves_a_point_at_the_center_fixed(self):
        # A shear's own fixed point is the center it's anchored at (translate-to-origin,
        # shear, translate-back) -- the center of the pre-transform rect maps to itself.
        cx, cy = 40.0, 60.0
        m = lib.compose_layer_matrix(cx, cy, 100.0, 100.0, 0.0, 30.0, 0.0, 0.0, 0.0)
        new_x = m[0] * cx + m[1] * cy + m[2]
        new_y = m[3] * cx + m[4] * cy + m[5]
        self.assertAlmostEqual(new_x, cx, places=9)
        self.assertAlmostEqual(new_y, cy, places=9)

    def test_positive_skew_h_slants_the_top_edge_right(self):
        cx, cy = 50.0, 50.0
        m = lib.compose_layer_matrix(cx, cy, 100.0, 100.0, 0.0, 45.0, 0.0, 0.0, 0.0)
        # A point 10px ABOVE center (smaller y): horizontal shear at 45 degrees (tan(45)=1)
        # moves it sideways toward +x by that same 10px, with y unchanged.
        px, py = cx, cy - 10.0
        new_x = m[0] * px + m[1] * py + m[2]
        new_y = m[3] * px + m[4] * py + m[5]
        self.assertAlmostEqual(new_x, cx + 10.0, places=6)
        self.assertAlmostEqual(new_y, cy - 10.0, places=6)

    def test_positive_skew_v_slants_the_left_edge_down(self):
        cx, cy = 50.0, 50.0
        m = lib.compose_layer_matrix(cx, cy, 100.0, 100.0, 0.0, 0.0, 45.0, 0.0, 0.0)
        # A point 10px LEFT of center (smaller x): vertical shear at 45 degrees moves it toward
        # +y (down) by that same 10px, with x unchanged.
        px, py = cx - 10.0, cy
        new_x = m[0] * px + m[1] * py + m[2]
        new_y = m[3] * px + m[4] * py + m[5]
        self.assertAlmostEqual(new_x, cx - 10.0, places=6)
        self.assertAlmostEqual(new_y, cy + 10.0, places=6)

    def test_h_45_v_45_determinant_stays_exactly_1_not_0(self):
        # Regression pin: the single combined-shear matrix [[1,-tan(h)],[-tan(v),1]] this used to
        # be built from has determinant 1 - tan(h)*tan(v), which is EXACTLY 0 at h=v=45 --
        # collapsing the whole rectangle to a line. Composed as two independent shears instead,
        # the determinant is exactly 1 for ANY h/v, so this must not raise.
        m = lib.compose_layer_matrix(50, 50, 100.0, 100.0, 0.0, 45.0, 45.0, 0.0, 0.0)
        det = m[0] * m[4] - m[1] * m[3]
        self.assertAlmostEqual(det, 1.0, places=9)

    def test_h_60_v_60_determinant_stays_exactly_1_not_negative(self):
        # Regression pin: the old single-matrix determinant 1 - tan(h)*tan(v) at h=v=60 is
        # 1 - 3 = -2 (tan(60) ~= 1.732) -- NEGATIVE, silently mirroring the layer instead of
        # shearing it. The two-shear composition keeps it at exactly 1 regardless.
        m = lib.compose_layer_matrix(50, 50, 100.0, 100.0, 0.0, 60.0, 60.0, 0.0, 0.0)
        det = m[0] * m[4] - m[1] * m[3]
        self.assertAlmostEqual(det, 1.0, places=9)

    def test_refuses_a_negative_scale_that_would_mirror_instead_of_transform(self):
        # Out of gimp_transform_layer's own schema range (1..10000%), but the pure function
        # itself must still refuse a composed matrix with a negative determinant on its own
        # terms, as defense in depth against ever silently mirroring a layer.
        with self.assertRaises(ValueError):
            lib.compose_layer_matrix(50, 50, -100.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    def test_refuses_a_near_zero_scale_that_would_collapse_to_a_line(self):
        with self.assertRaises(ValueError):
            lib.compose_layer_matrix(50, 50, 1e-9, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0)


class TestTransformedBounds(unittest.TestCase):
    def test_identity_matrix_leaves_bounds_unchanged(self):
        identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        self.assertEqual(lib.transformed_bounds(identity, 5, 10, 200, 100), (5, 10, 200, 100))

    def test_pure_scale_matrix_scales_the_bounds_from_the_origin(self):
        scale2x = [2.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0]
        self.assertEqual(lib.transformed_bounds(scale2x, 10, 10, 50, 20), (20, 20, 100, 40))


class TestCeilWithMargin(unittest.TestCase):
    def test_exact_integer_still_gets_the_one_pixel_margin(self):
        self.assertEqual(lib.ceil_with_margin(100.0), 101)

    def test_rounds_up_before_adding_the_margin(self):
        self.assertEqual(lib.ceil_with_margin(100.2), 102)

    def test_a_value_just_under_a_whole_number_rounds_up_to_it_first(self):
        self.assertEqual(lib.ceil_with_margin(99.9999), 101)


class TestValidateTransformedLayerSize(unittest.TestCase):
    def test_accepts_one_pixel_or_more(self):
        lib.validate_transformed_layer_size(1, 1)
        lib.validate_transformed_layer_size(400, 3)

    def test_rejects_a_zero_dimension_with_a_size_message(self):
        for w, h in ((0, 10), (10, 0), (0, 0)):
            with self.assertRaisesRegex(ValueError, 'shrink the layer to %dx%d px' % (w, h)):
                lib.validate_transformed_layer_size(w, h)


class TestTransformLayerPrecisionBucket(unittest.TestCase):
    def test_u8_variants_bucket_to_8(self):
        for nick in ('u8-linear', 'u8-non-linear', 'u8-perceptual'):
            self.assertEqual(lib.transform_layer_precision_bucket(nick), '8')

    def test_u16_and_half_variants_bucket_to_16(self):
        for nick in ('u16-non-linear', 'u16-perceptual', 'half-linear'):
            self.assertEqual(lib.transform_layer_precision_bucket(nick), '16')

    def test_u32_float_and_double_variants_bucket_to_32(self):
        for nick in ('u32-linear', 'float-non-linear', 'double-perceptual'):
            self.assertEqual(lib.transform_layer_precision_bucket(nick), '32')


class TestRejectForeignTransformFields(unittest.TestCase):
    def test_accepts_an_ops_own_fields(self):
        lib.reject_foreign_transform_fields('skew', {'skew_h_degrees': 10, 'skew_v_degrees': 5})
        lib.reject_foreign_transform_fields('free', {
            'scale_x_percent': 110, 'degrees': 5, 'offset_x': 1, 'offset_y': 2,
        })

    def test_common_keys_are_always_allowed(self):
        lib.reject_foreign_transform_fields('flip', {
            'image': 1, 'op': 'flip', 'layer': 'L', 'layer_id': 2, 'interpolation': 'cubic',
            'axis': 'horizontal',
        })

    def test_refuses_a_field_from_another_op(self):
        with self.assertRaises(ValueError) as ctx:
            lib.reject_foreign_transform_fields('scale', {'skew_h_degrees': 10})
        self.assertIn(
            "op 'scale' does not use field(s) skew_h_degrees; its fields are: "
            "scale_percent, scale_x_percent, scale_y_percent",
            str(ctx.exception),
        )

    def test_refuses_ps_style_flat_move_fields(self):
        # gimp_transform_layer's own move takes nested {x, y} objects (delta/absolute/
        # center_on); ps_transform_layer's flat delta_x/absolute_x names are foreign here.
        with self.assertRaises(ValueError) as ctx:
            lib.reject_foreign_transform_fields('move', {'delta_x': 5, 'delta_y': 5})
        self.assertIn('delta_x', str(ctx.exception))
        self.assertIn('delta_y', str(ctx.exception))

    def test_none_values_are_treated_as_omitted(self):
        lib.reject_foreign_transform_fields('rotate', {'degrees': 10, 'skew_h_degrees': None})


class TestMatchTransfer(unittest.TestCase):
    def test_strength_zero_is_identity(self):
        t = lib.match_transfer(200.0, 30.0, 80.0, 60.0, 0.0)
        self.assertEqual(t['gain'], 1.0)
        self.assertEqual(t['shift'], 0.0)
        self.assertEqual(lib.match_curve_points(200.0, t['gain'], t['shift']), [[0.0, 0.0], [255.0, 255.0]])

    def test_full_strength_matches_mean_and_std(self):
        t = lib.match_transfer(120.0, 40.0, 90.0, 60.0, 1.0)
        self.assertAlmostEqual(t['gain'], 1.5)
        self.assertAlmostEqual(t['mean_after'], 90.0)
        self.assertAlmostEqual(t['std_after'], 60.0)
        # the curve maps the source mean onto the reference mean
        pts = lib.match_curve_points(120.0, t['gain'], t['shift'])
        self.assertAlmostEqual(self._eval(pts, 120.0), 90.0, places=1)

    def test_partial_strength_moves_part_of_the_way(self):
        t = lib.match_transfer(200.0, 20.0, 100.0, 20.0, 0.7)
        self.assertAlmostEqual(t['shift'], -70.0)
        self.assertAlmostEqual(t['mean_after'], 130.0)
        self.assertEqual(t['gain'], 1.0)

    def test_gain_is_clamped(self):
        high = lib.match_transfer(100.0, 5.0, 100.0, 100.0, 1.0)
        low = lib.match_transfer(100.0, 100.0, 100.0, 5.0, 1.0)
        self.assertEqual(high['gain'], lib.MATCH_GAIN_MAX)
        self.assertEqual(low['gain'], lib.MATCH_GAIN_MIN)
        # the reported std follows the clamped gain, not the requested ratio
        self.assertAlmostEqual(high['std_after'], 10.0)

    def test_flat_source_or_reference_keeps_gain_one(self):
        self.assertEqual(lib.match_transfer(100.0, 0.0, 100.0, 50.0, 1.0)['gain'], 1.0)
        self.assertEqual(lib.match_transfer(100.0, 50.0, 100.0, 0.0, 1.0)['gain'], 1.0)

    @staticmethod
    def _eval(points, x):
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            if x0 <= x <= x1:
                return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
        raise AssertionError('x outside the curve')


class TestMatchCurvePoints(unittest.TestCase):
    def test_unclamped_line_is_two_points(self):
        pts = lib.match_curve_points(128.0, 0.5, 0.0)  # y = 0.5x + 64
        self.assertEqual(pts, [[0.0, 64.0], [255.0, 191.5]])

    def test_clamp_at_zero_adds_an_interior_knot(self):
        pts = lib.match_curve_points(220.0, 1.0, -98.0)  # y = x - 98
        self.assertEqual(pts[0], [0.0, 0.0])
        self.assertIn([98.0, 0.0], pts)
        self.assertEqual(pts[-1], [255.0, 157.0])

    def test_clamp_at_top_adds_an_interior_knot(self):
        pts = lib.match_curve_points(30.0, 2.0, 90.0)  # y = 2x + 30
        self.assertIn([97.5, 255.0], pts)
        self.assertEqual(pts[0], [0.0, 60.0])
        self.assertEqual(pts[-1], [255.0, 255.0])

    def test_both_clamps(self):
        pts = lib.match_curve_points(128.0, 2.0, 0.0)  # y = 2x - 128
        self.assertEqual(pts[0], [0.0, 0.0])
        self.assertIn([64.0, 0.0], pts)
        self.assertIn([191.5, 255.0], pts)
        self.assertEqual(pts[-1], [255.0, 255.0])

    def test_points_are_in_range_and_strictly_ascending(self):
        for mu in (10.0, 100.0, 240.0):
            for gain in (0.5, 1.0, 2.0):
                for shift in (-200.0, -40.0, 0.0, 40.0, 200.0):
                    pts = lib.match_curve_points(mu, gain, shift)
                    xs = [x for x, _y in pts]
                    self.assertEqual(xs, sorted(set(xs)), (mu, gain, shift))
                    self.assertEqual(xs[0], 0.0)
                    self.assertEqual(xs[-1], 255.0)
                    for x, y in pts:
                        self.assertTrue(0.0 <= x <= 255.0 and 0.0 <= y <= 255.0, (mu, gain, shift, pts))

    def test_helper_points_track_the_clamped_line(self):
        pts = lib.match_curve_points(220.0, 1.0, -98.0)
        for x, y in pts:
            self.assertAlmostEqual(y, max(0.0, min(255.0, x - 98.0)), places=1)


class TestMatchArgs(unittest.TestCase):
    def test_defaults(self):
        o = lib.validate_match_args({}, 1000, 600)
        self.assertEqual((o['match'], o['reference'], o['strength']), ('both', 'surround', 70.0))
        self.assertAlmostEqual(o['s'], 0.7)
        self.assertEqual(o['surround_px'], 120)
        self.assertEqual((o['edge_contract_px'], o['edge_feather_px']), (0, 0))

    def test_none_values_take_the_default(self):
        o = lib.validate_match_args({'match': None, 'strength': None, 'surround_px': None}, 100, 100)
        self.assertEqual((o['match'], o['strength'], o['surround_px']), ('both', 70.0, 16))

    def test_surround_default_is_clamped(self):
        self.assertEqual(lib.default_surround_px(50, 40), 16)
        self.assertEqual(lib.default_surround_px(1000, 800), 120)
        self.assertEqual(lib.default_surround_px(6000, 4000), 400)

    def test_rejects_out_of_range_and_unknown_values(self):
        for bad in (
            {'match': 'hue'}, {'reference': 'above'}, {'strength': 101}, {'strength': -1},
            {'surround_px': 0}, {'surround_px': 401}, {'edge_contract_px': 21},
            {'edge_feather_px': 51}, {'edge_feather_px': -1},
        ):
            with self.assertRaises(ValueError, msg=str(bad)):
                lib.validate_match_args(bad, 100, 100)


class TestMatchRoi(unittest.TestCase):
    def test_box_grown_by_pad(self):
        self.assertEqual(lib.match_roi(100, 100, 50, 40, 400, 300, 20), (80, 80, 90, 80))

    def test_clipped_to_the_canvas(self):
        self.assertEqual(lib.match_roi(-10, 5, 50, 40, 100, 100, 20), (0, 0, 60, 65))
        self.assertEqual(lib.match_roi(60, 60, 100, 100, 100, 100, 30), (30, 30, 70, 70))

    def test_layer_outside_the_canvas_has_no_roi(self):
        self.assertIsNone(lib.match_roi(120, 0, 10, 10, 100, 100, 50))
        self.assertIsNone(lib.match_roi(-60, 0, 50, 10, 100, 100, 50))



class TestMatchMeasuring(unittest.TestCase):
    def test_small_regions_are_measured_at_full_size(self):
        self.assertEqual(lib.match_measure_scale(2048, 1000), 1.0)
        self.assertEqual(lib.match_measure_scale(640, 480), 1.0)

    def test_large_regions_scale_the_long_side_to_the_cap(self):
        f = lib.match_measure_scale(6016, 4000)
        self.assertAlmostEqual(6016 * f, lib.MATCH_MEASURE_MAX_SIDE)
        self.assertAlmostEqual(lib.match_measure_scale(3000, 8000) * 8000, lib.MATCH_MEASURE_MAX_SIDE)

    def test_scaled_distances_and_counts(self):
        self.assertEqual(lib.match_scaled_px(400, 0.5), 200)
        self.assertEqual(lib.match_scaled_px(1, 0.1), 1)
        self.assertEqual(lib.match_scaled_px(0, 0.5), 0)
        self.assertEqual(lib.match_full_res_count(250, 0.5), 1000)
        self.assertEqual(lib.match_full_res_count(500, 1.0), 500)

    def test_histogram_scale_by_precision(self):
        self.assertEqual(lib.histogram_scale('u8-non-linear'), 1.0)
        for nick in ('u16-non-linear', 'half-non-linear', 'float-non-linear', 'u32-non-linear'):
            self.assertEqual(lib.histogram_scale(nick), 255.0, nick)

    def test_linear_precisions_are_told_apart(self):
        for nick in ('u8-linear', 'u16-linear', 'half-linear', 'float-linear', 'double-linear'):
            self.assertTrue(lib.is_linear_precision(nick), nick)
        for nick in ('u8-non-linear', 'u16-non-linear', 'float-non-linear', 'u8-perceptual', 'float-perceptual'):
            self.assertFalse(lib.is_linear_precision(nick), nick)


if __name__ == '__main__':
    unittest.main()
