//go:build !pro

package main

// proBuild stub for CE builds. No Pro snippets are compiled in, so every name
// is reported unhandled and falls through to build()'s "unknown snippet"
// error. This is the machine-checked half of the edition gate: the CE binary
// cannot produce Pro snippet IP because the dispatch simply does not exist.
func proBuild(_ string, _ map[string]any) (string, bool, error) {
	return "", false, nil
}
