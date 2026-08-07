package main

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// Safe interpolation helpers — the Go port of src/utils/jsx.ts. Every value
// that lands in emitted JSX routes through one of these so a layer name with
// a quote/backslash can't break (or inject into) the running script.

// jsLit renders a value as a JSX-safe string literal, mirroring
// `JSON.stringify(String(value))`.
//
// HTML escaping is disabled (SetEscapeHTML(false)) so <, >, & pass through
// literally — matching JS JSON.stringify exactly. Go's encoding/json escapes
// those by default; without this a layer name like "A & B" would round-trip as
// "A & B" and diverge from the TS output for the same input.
func jsLit(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	// Encode of a Go string can never fail: json.Marshal only errors on
	// unsupported types (chan/func/complex), NaN/Inf floats, or cyclic
	// structures — none reachable from a plain string. The error is swallowed
	// deliberately; the empty-buffer fallback below guards against any future
	// surprise so a caller never gets an unquoted (break-out-able) value.
	_ = enc.Encode(s)
	// Encoder.Encode appends a trailing newline; strip it.
	out := strings.TrimRight(buf.String(), "\n")
	if out == "" {
		return `""`
	}
	return out
}

// jsNum renders a finite number the way JS String(n) would (shortest
// round-trip). FormatFloat with 'g'/-1 matches JS for the value ranges these
// snippets use (small radii, counts, percentages).
//
// Non-finite guard: strconv.FormatFloat emits NaN/+Inf/-Inf as the bare words
// "NaN"/"+Inf"/"-Inf", which are NOT valid JS numeric literals — interpolated
// into a snippet they'd be parsed as identifiers and throw at runtime (or, for
// "Infinity" lookalikes, silently misbehave). Emitters return a plain string
// with no error channel, so rather than thread an error through dozens of
// callers we coerce a non-finite input to the safe finite literal "0". A NaN
// only reaches here from a malformed caller (JSON numbers are always finite);
// "0" keeps the emitted JSX valid instead of letting an unquoted token break it.
func jsNum(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "0"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

// jsBool renders a JSX-safe boolean literal. The TS jsBool also coerced the
// string forms 'true'/'false'; here params arrive already typed as bool, so a
// direct render matches that path.
func jsBool(v bool) string {
	if v {
		return "true"
	}
	return "false"
}
