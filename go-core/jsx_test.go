package main

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// Adversarial coverage for the JSX interpolation helpers (jsx.go). These are
// the security chokepoints: every caller-controlled string that lands in
// emitted ExtendScript routes through jsLit, so a break-out here is a script
// injection into the running Photoshop session. The tests assert that
// hostile inputs come back as inert, valid, quoted JS string literals that
// cannot escape their quotes — and that jsNum never emits a bare
// non-finite identifier.

// jsLit's contract is "JSON.stringify(String(value))": the output must be a
// valid JSON/JS string literal (parseable by encoding/json back to the exact
// input) that begins and ends with a double quote.

func assertInertLiteral(t *testing.T, in string) {
	t.Helper()
	out := jsLit(in)

	// 1. Must be wrapped in double quotes — never a bare token.
	if len(out) < 2 || out[0] != '"' || out[len(out)-1] != '"' {
		t.Fatalf("jsLit(%q) = %q: not a double-quoted literal", in, out)
	}

	// 2. Must round-trip back to the original string through a strict JSON
	//    parse. If a break-out char leaked unescaped, json.Unmarshal either
	//    fails or yields a different string.
	var back string
	if err := json.Unmarshal([]byte(out), &back); err != nil {
		t.Fatalf("jsLit(%q) = %q: not valid JSON literal: %v", in, out, err)
	}
	if back != in {
		t.Fatalf("jsLit(%q) round-tripped to %q, want %q", in, back, in)
	}

	// 3. The interior (literal minus the outer quotes) must contain no raw
	//    (unescaped) double quote — that is exactly the break-out vector.
	interior := out[1 : len(out)-1]
	for i := 0; i < len(interior); i++ {
		if interior[i] == '"' {
			// A quote is only legal if preceded by an odd run of backslashes.
			bs := 0
			for j := i - 1; j >= 0 && interior[j] == '\\'; j-- {
				bs++
			}
			if bs%2 == 0 {
				t.Fatalf("jsLit(%q) = %q: unescaped quote at %d (break-out)", in, out, i)
			}
		}
	}

	// 4. No literal newline or carriage return may survive — they'd terminate
	//    a line and could split the surrounding statement.
	if strings.ContainsAny(interior, "\n\r") {
		t.Fatalf("jsLit(%q) = %q: contains a raw newline/CR", in, out)
	}
}

func TestJsLitBreakOutAttempts(t *testing.T) {
	cases := []string{
		`a"); evil(("`,          // close-string + inject call
		`"`,                     // bare double quote
		`\`,                     // bare backslash
		`\"`,                    // escaped-quote sequence
		`\\"`,                   // backslash then quote
		"line1\nline2",          // embedded newline
		"tab\there",             // embedded tab
		"carriage\rreturn",      // embedded CR
		"</script>",             // HTML/script terminator
		"<!-- comment -->",      // HTML comment
		"a & b < c > d",         // raw &, <, > (must pass through, not HTML-escaped)
		"'; alert('x')",         // single-quote break-out
		"`${danger}`",           // template-literal injection
		"unicode: é中\U0001F600", // accented, CJK, emoji
		"null\x00byte",          // embedded NUL
		"",                      // empty string
		"plain layer name",      // benign control
		"Layer \"copy\" 2",      // benign embedded quotes
	}
	for _, in := range cases {
		assertInertLiteral(t, in)
	}
}

// jsLit must emit pure printable ASCII. The .jsx it feeds is written UTF-8
// with no BOM and no #encoding directive, so ExtendScript decodes it by the
// platform codepage: a raw 'ü' arrives mojibake and every comparison against
// it misses — which is what made deleting a German Photoshop's own
// 'Farbfüllung 1' fail. \uXXXX survives any codepage and the parser restores
// the exact character, so the round-trip assertion in assertInertLiteral is
// what proves the escape is lossless.
func TestJsLitEscapesNonASCII(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Farbfüllung 1", "\"Farbf\\u00fcllung 1\""},
		{"Ebene 1", "\"Ebene 1\""}, // benign control: untouched
		{"中", "\"\\u4e2d\""},
		{"\U0001F3A8", "\"\\ud83c\\udfa8\""}, // astral → surrogate pair
	}
	for _, c := range cases {
		if got := jsLit(c.in); got != c.want {
			t.Errorf("jsLit(%q) = %s, want %s", c.in, got, c.want)
		}
		assertInertLiteral(t, c.in)
	}
}

// Belt and braces on the property the fix actually depends on: whatever the
// input, nothing outside printable ASCII may survive into the emitted literal.
func TestJsLitOutputIsAlwaysPrintableASCII(t *testing.T) {
	for _, in := range []string{
		"Farbfüllung 1", "é中\U0001F600", "a\u2028b", "naïve — dash", "\u007f",
	} {
		out := jsLit(in)
		for i := 0; i < len(out); i++ {
			if out[i] < ' ' || out[i] > '~' {
				t.Fatalf("jsLit(%q) = %q: byte %d (%#x) is outside printable ASCII", in, out, i, out[i])
			}
		}
	}
}

// Boundary cases for the ASCII escape, kept separate so each one names what it
// is guarding. DEL and the separators are the characters most likely to
// diverge from the TypeScript twin; the quote/backslash case proves the escape
// runs AFTER the JSON encoder and cannot double-process what it already did.
func TestJsLitEscapeBoundaries(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"DEL", "\u007f", "\"\\u007f\""},
		{"line separator", "\u2028", "\"\\u2028\""},
		{"paragraph separator", "\u2029", "\"\\u2029\""},
		{"highest code point", "\U0010FFFF", "\"\\udbff\\udfff\""},
		{"tilde stays raw", "~", "\"~\""},
		{"space stays raw", " ", "\" \""},
		{"already-escaped quote and backslash", "a\"b\\c", "\"a\\\"b\\\\c\""},
	}
	for _, c := range cases {
		if got := jsLit(c.in); got != c.want {
			t.Errorf("%s: jsLit(%q) = %s, want %s", c.name, c.in, got, c.want)
		}
		assertInertLiteral(t, c.in)
	}
}

// jsLit must NOT HTML-escape <, >, & — it mirrors JS JSON.stringify, which
// leaves them literal (the Go default would escape them and diverge from the
// TS output). Pin that explicitly.
func TestJsLitDoesNotHTMLEscape(t *testing.T) {
	out := jsLit("a & b < c > d")
	// Exact-equality pins it fully: the literal ampersand/lt/gt pass through
	// (Go's encoding/json default would emit unicode escapes for them);
	// SetEscapeHTML(false) is what keeps them literal and matches JS output.
	if out != `"a & b < c > d"` {
		t.Fatalf("jsLit HTML-escaped (want literal): got %q, want %q", out, `"a & b < c > d"`)
	}
}

// jsLit never returns the empty string (an empty value would be an unquoted,
// break-out-able blank slot). The empty-input case must still yield `""`.
func TestJsLitNeverEmpty(t *testing.T) {
	if got := jsLit(""); got != `""` {
		t.Fatalf("jsLit(\"\") = %q, want %q", got, `""`)
	}
}

// jsNum: strconv.FormatFloat renders NaN/Inf as the bare words NaN/+Inf/-Inf,
// which are NOT valid JS numeric literals. The guard must coerce any
// non-finite input to a finite literal so the emitted JSX never carries a bare
// identifier in a numeric slot.
func TestJsNumNonFinite(t *testing.T) {
	nonFinite := []float64{
		math.NaN(),
		math.Inf(1),
		math.Inf(-1),
	}
	for _, v := range nonFinite {
		out := jsNum(v)
		// Must not be any of the bare-identifier forms FormatFloat would emit.
		for _, bad := range []string{"NaN", "Inf", "+Inf", "-Inf", "Infinity", "+Infinity", "-Infinity"} {
			if out == bad {
				t.Fatalf("jsNum(%v) = %q: emitted bare non-finite identifier", v, out)
			}
		}
		// The coerced value must parse as a finite JS/JSON number.
		var n float64
		if err := json.Unmarshal([]byte(out), &n); err != nil {
			t.Fatalf("jsNum(%v) = %q: not a valid numeric literal: %v", v, out, err)
		}
		if math.IsNaN(n) || math.IsInf(n, 0) {
			t.Fatalf("jsNum(%v) = %q parsed back to a non-finite number", v, out)
		}
	}
}

func TestJsNumFinite(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{1, "1"},
		{-5, "-5"},
		{2.5, "2.5"},
		{100, "100"},
		{0.01, "0.01"},
	}
	for _, c := range cases {
		if got := jsNum(c.in); got != c.want {
			t.Errorf("jsNum(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestJsBool(t *testing.T) {
	if got := jsBool(true); got != "true" {
		t.Errorf("jsBool(true) = %q, want %q", got, "true")
	}
	if got := jsBool(false); got != "false" {
		t.Errorf("jsBool(false) = %q, want %q", got, "false")
	}
}
