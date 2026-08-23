package main

import (
	"bytes"
	"encoding/json"
	"fmt"
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
	return asciiEscape(out)
}

// asciiEscape rewrites every character outside printable ASCII as a \uXXXX
// escape.
//
// The emitted .jsx is written UTF-8 with no BOM and carries no `#encoding`
// directive, so ExtendScript decodes it by the platform codepage. A raw 'ü'
// therefore arrives mojibake and every comparison against it misses — the
// inbound half of the same transport problem __notFoundMessage solves on the
// way out. A \uXXXX escape is pure ASCII, survives any codepage, and the JS
// parser turns it back into the exact character.
//
// encoding/json escapes the control range but passes everything above ASCII
// through as raw UTF-8, so this only ever rewrites what it left alone — it
// cannot double-process an escape the encoder already wrote.
//
// Scope: this covers INTERPOLATED VALUES. A snippet's own source text can
// still carry raw non-ASCII, which this does not touch.
//
// Keep in lockstep with jsLit in src/utils/jsx.ts — both emit literals into
// the same scripts on different paths, and a divergence stays invisible until
// a non-ASCII name reaches one emitter and not the other. The two agree on all
// valid input; they differ only on malformed UTF-8 / lone surrogates, where
// encoding/json substitutes U+FFFD and the TS twin preserves the surrogate.
// jsx_test.go and tests/unit/jsx.test.ts carry the same case table.
func asciiEscape(s string) string {
	if isPrintableASCII(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r >= ' ' && r <= '~':
			b.WriteRune(r)
		case r > 0xFFFF:
			// Outside the BMP: JS string literals address UTF-16 code units,
			// so an astral rune is written as its surrogate pair and the
			// parser rejoins it. Matches what JSON.stringify emits in TS.
			v := r - 0x10000
			fmt.Fprintf(&b, "\\u%04x\\u%04x", 0xD800+(v>>10), 0xDC00+(v&0x3FF))
		default:
			fmt.Fprintf(&b, "\\u%04x", r)
		}
	}
	return b.String()
}

// isPrintableASCII reports whether s is entirely printable ASCII, letting the
// common case skip the rewrite and its allocation.
func isPrintableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < ' ' || s[i] > '~' {
			return false
		}
	}
	return true
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

// jsInt renders a JSX-safe integer literal. Kept separate from jsNum so an
// index or count can never pick up float formatting ("1e+06") on the way into a
// snippet; ints carry no non-finite case, so no coercion is needed.
func jsInt(v int) string {
	return strconv.Itoa(v)
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
