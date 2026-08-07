package main

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

// proSnippetNamesFromSource yields the Pro dispatch names the edition-gate
// tests iterate: in a CE binary every one must be REJECTED, and under `-tags
// pro` every one must build.
//
// The names have two possible sources, because this file compiles in two
// different repositories and only one of them can hold the authoritative one.
//
//	registry_pro.go        the switch itself — the single Go-side source of
//	                       truth for what a Pro binary emits. Present only in
//	                       the private repository, which is why parsing it is
//	                       preferred wherever it exists: a new `case` joins
//	                       every guard automatically.
//	pro-snippet-names.json a committed list, used here in the public tree where
//	                       registry_pro.go legitimately does not exist. Pinned
//	                       against the switch by a test in the private repo, so
//	                       the copy cannot drift unnoticed.
//
// Reading the file and calling its absence a skip would be worse than useless:
// the CE gate would report success while asserting nothing about the very
// thing it exists to prove. Both branches fail loudly when they come up empty.
//
// Note the names are not secret — they are the dispatch labels behind
// documented Pro tools. What stays private is the fragment bodies.
//
// No build tag: compiled into BOTH the CE (`!pro`) and pro test variants.
func proSnippetNamesFromSource(t *testing.T) []string {
	t.Helper()

	if src, err := os.ReadFile("registry_pro.go"); err == nil {
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

	raw, err := os.ReadFile("pro-snippet-names.json")
	if err != nil {
		t.Fatalf("neither registry_pro.go nor pro-snippet-names.json is readable: %v", err)
	}
	var names []string
	if err := json.Unmarshal(raw, &names); err != nil {
		t.Fatalf("pro-snippet-names.json is not a JSON string array: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("pro-snippet-names.json is empty — the CE edition gate would assert nothing")
	}
	return names
}
