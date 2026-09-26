# Stdlib-only unit tests for lib.py: no GIMP, no numpy, no third-party
# dependency at all. Run directly with `python -m unittest test_lib.py` from
# this directory (a vitest wrapper does this automatically when a `python`/
# `python3` executable is available — see tests/backends/gimp/bridge-python.
# test.ts). NOT staged into dist/ (scripts/copy-gimp-bridge.ts stages only
# ops.py and lib.py) since it never runs in a shipped install.

import json
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


if __name__ == '__main__':
    unittest.main()
