package main

import (
	"os"
	"regexp"
	"testing"
)

// proSnippetNamesFromSource extracts the Pro dispatch names from
// registry_pro.go's `case "<name>":` labels — the single Go-side source of
// truth for what the Pro binary emits. Both edition-gate tests iterate this
// set (CE: every name must be rejected; pro: every name must build), and
// tests/modules/pro.test.ts parses the same file with the same pattern to pin
// the TS routing set (PRO_SNIPPET_NAMES). Parsing the switch rather than
// keeping test copies means a new `case` automatically joins every guard —
// the previous hand copies here had drifted to a 5-name and a 2-name subset
// (WO-2 stage B; the derived-list invariant).
//
// No build tag: compiled into BOTH the CE (`!pro`) and pro test variants.
func proSnippetNamesFromSource(t *testing.T) []string {
	t.Helper()
	src, err := os.ReadFile("registry_pro.go")
	if err != nil {
		t.Fatalf("cannot read registry_pro.go: %v", err)
	}
	re := regexp.MustCompile(`case\s+"([^"]+)"\s*:`)
	var names []string
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		names = append(names, m[1])
	}
	if len(names) == 0 {
		// Mirror the zero-yield guards elsewhere in this drift class: an empty
		// parse must fail the suite, not silently skip every assertion.
		t.Fatal("found zero proBuild case labels in registry_pro.go — the parse is broken")
	}
	return names
}
