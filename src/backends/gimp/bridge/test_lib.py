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
    def test_covers_every_adjust_operation(self):
        self.assertEqual(lib.ALLOWED_DESCRIBE_OPERATIONS, frozenset(lib.ADJUST_OPERATIONS.values()))


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
        self.assertEqual(set(lib.USER_FIELDS), set(lib.ADJUST_PARAM_BUILDERS))

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
    def test_every_user_facing_name_from_the_plan_is_present(self):
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


if __name__ == '__main__':
    unittest.main()
