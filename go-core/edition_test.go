//go:build !pro

package main

import (
	"strings"
	"testing"
)

// Edition gate (CE half). A CE binary is compiled WITHOUT the `pro` tag, so
// proBuild is the registry_nonpro.go stub and build() falls through to the
// "unknown snippet" error for any Pro-tier name. This is the machine-checked
// guarantee that Pro snippet IP cannot be emitted by — or extracted from — the
// CE binary. The counterpart TestEditionGateProEmitsSnippets (edition_pro_test.go)
// asserts the inverse under `-tags pro`.
//
// The name set is parsed from registry_pro.go's switch (see
// edition_names_test.go) so every Pro snippet is covered automatically — the
// previous hand copy here silently pinned a 5-name subset.
func TestEditionGateCERejectsProSnippets(t *testing.T) {
	for _, name := range proSnippetNamesFromSource(t) {
		got, err := build(name, map[string]any{"sampleAllLayers": true, "selectionType": "replace"})
		if err == nil {
			t.Errorf("CE build(%q) returned no error — Pro IP leaked into the CE binary", name)
		} else if !strings.Contains(err.Error(), "unknown snippet") {
			t.Errorf("CE build(%q) error = %q, want it to contain 'unknown snippet'", name, err)
		}
		if got != "" {
			t.Errorf("CE build(%q) returned non-empty body (%d bytes)", name, len(got))
		}
	}
}
