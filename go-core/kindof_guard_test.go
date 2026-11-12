package main

import (
	"strings"
	"testing"
)

// The context and prologue helpers are compiled into the Pro module too, and a
// Pro module can run on an older host whose script wrapper has no __kindOf. Every
// call they make must be guarded, or getContextInfo throws a ReferenceError there.
func TestSharedHelpersGuardKindOf(t *testing.T) {
	const guarded = "typeof __kindOf === 'function' ? __kindOf(layer) : layer.kind"
	for name, jsx := range map[string]string{
		"getContextInfo":                   getContextInfo(),
		"applyGaussianBlur (prologue)":     applyGaussianBlur(2, false, false),
		"applyGaussianBlur smart (prolog)": applyGaussianBlur(2, false, true),
	} {
		calls := strings.Count(jsx, "__kindOf(layer)")
		safe := strings.Count(jsx, guarded)
		if calls == 0 {
			t.Fatalf("%s: no __kindOf call found (did the helper change?)", name)
		}
		if calls != safe {
			t.Fatalf("%s: %d __kindOf calls, only %d guarded", name, calls, safe)
		}
	}
}
