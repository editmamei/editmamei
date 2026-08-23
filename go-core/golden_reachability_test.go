package main

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
)

// A golden fixture is only worth storing if THIS build can reproduce it.
//
// The snippets dispatched by proBuild sit behind the `pro` build tag, so a
// build from this repository resolves every one of them as an unknown snippet
// (registry_nonpro.go reports them all unhandled). A golden entry keyed on one
// of those names is therefore unreachable here: no test can compare it, and
// UPDATE_GOLDEN cannot refresh it, because the emitter that would produce the
// expected text does not exist in this tree. It is a fixture that can only
// ever go stale.
//
// This guard is the reason golden.json's key set is not simply whatever the
// last regeneration happened to write. It derives the excluded names rather
// than hand-listing them: proSnippetNamesFromSource (edition_names_test.go)
// parses registry_pro.go where that exists and falls back to
// pro-snippet-names.json here, so a new tag-gated snippet joins this
// assertion automatically.
func TestGoldenHasNoUnreachableSnippetFixtures(t *testing.T) {
	unreachable := proSnippetNamesFromSource(t)

	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatalf("read testdata/golden.json: %v", err)
	}
	var golden map[string]string
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("parse testdata/golden.json: %v", err)
	}
	if len(golden) == 0 {
		// Zero-yield guard, mirroring the drift-test convention elsewhere here:
		// an empty parse must fail rather than vacuously pass every assertion.
		t.Fatal("testdata/golden.json parsed to zero entries — the fixture or this parse is broken")
	}

	// A golden key is a rendered call: `snippetName(arg,...)` or `snippetName()`.
	// The emitter name is everything before the first '('.
	var offenders []string
	for key := range golden {
		name := key
		if i := strings.IndexByte(key, '('); i >= 0 {
			name = key[:i]
		}
		for _, bad := range unreachable {
			if name == bad {
				offenders = append(offenders, key)
				break
			}
		}
	}
	sort.Strings(offenders)

	if len(offenders) > 0 {
		t.Fatalf(
			"testdata/golden.json holds %d fixture(s) for snippet(s) this build cannot emit: %s\n"+
				"These names are dispatched only under `-tags pro`, so nothing in this tree can "+
				"regenerate or compare them. Remove the entries; the suites that do own them keep "+
				"their own fixtures.",
			len(offenders), strings.Join(offenders, ", "),
		)
	}
}
