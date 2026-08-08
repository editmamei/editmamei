package main

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Slot-arity guard (backlog G2 / review finding GC-1).
//
// A fragment body carries N `%s` placeholders; its emitter must pass exactly N
// args to fmt.Sprintf(tpl[...], ...). A mismatch makes Sprintf emit a `%!`
// format-verb error (`%!s(MISSING)` / `%!(EXTRA ...)`) straight into the live
// ExtendScript — and `go vet` CANNOT catch it, because the format string is a
// runtime map value (`tpl[vault.X]`), not a constant (see the sentinel below).
// Before this guard the only arity net was golden_test.go's ~130 fixed calls;
// snippets outside that set had none. This exercises EVERY build() case that is
// reachable with default params and asserts the emitted JSX carries no `%!`.

// snippetNamesFromBuild parses the case labels across every community
// registry*.go file (registry.go's dispatcher plus each per-family
// registry_<family>.go), excluding registry_pro.go/registry_nonpro.go and
// test files. After the Tier-3 S2 part 2 registry split, the case labels no
// longer live inside build() itself — they live in the per-family buildX
// functions build() dispatches to — so this scans all of them instead of
// brace-matching a single function body. A new case in any buildX function
// auto-joins this guard.
func snippetNamesFromBuild(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	caseRe := regexp.MustCompile(`(?m)^\s*case\s+(.+?):\s*$`)
	strRe := regexp.MustCompile(`"([^"]+)"`)
	var names []string
	for _, e := range entries {
		n := e.Name()
		if !strings.HasPrefix(n, "registry") || !strings.HasSuffix(n, ".go") {
			continue
		}
		if strings.HasSuffix(n, "_test.go") || n == "registry_pro.go" || n == "registry_nonpro.go" {
			continue
		}
		src, err := os.ReadFile(n)
		if err != nil {
			t.Fatalf("read %s: %v", n, err)
		}
		for _, m := range caseRe.FindAllStringSubmatch(string(src), -1) {
			for _, lbl := range strRe.FindAllStringSubmatch(m[1], -1) {
				names = append(names, lbl[1])
			}
		}
	}
	if len(names) == 0 {
		t.Fatal("found zero case labels across registry*.go — the parse is broken")
	}
	return names
}

func safeBuild(name string, params map[string]any) (out string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return build(name, params)
}

// arityNeedsParams: build() cases that can't reach their Sprintf with an empty
// param map — they require an enum mode, a required name/path, or structured
// input (e.g. the mode-dispatched filter families, addAdjustmentLayer, the path
// creators). Their arity is exercised where they appear in golden_test.go /
// golden_pro_test.go and by `npm run live-smoke`; the 100+ default-buildable
// snippets are hard-checked on every run below.
//
// This is a burn-down list (fails on a NEW unbuildable name AND on a stale one):
// a new snippet landing here is the prompt to give it a valid-param entry so it
// becomes actively arity-checked. Extending active coverage to these — the
// mode-dispatched filters especially — is the documented next increment.
var arityNeedsParams = []string{
	"addAdjustmentLayer",
	"addGuide",
	"applyBlurAdv",
	"applyBrushStroke",
	"applyDenoise",
	"applyDisplace",
	"applyDistort",
	"applyImage",
	"applyLensBlur",
	"applyOther",
	"applyRender",
	"applyStylize",
	"calculations",
	"convertImageMode",
	"createPathFromPoints",
	"createShape",
	"flipCanvas",
	"flipLayer",
	"modifySelectionEdge",
	"savePath",
	"selectColorPreset",
	"selectLuminanceRange",
	"selectPolygon",
	"setClippingPath",
	// Refuses an empty param map by design: a setd carrying an empty
	// blendOptions is a silent no-op in Photoshop, so the emitter requires at
	// least one of opacity/blendMode. Actively arity-checked instead by
	// smart_object_test.go, which builds it fully populated and asserts no `%!`.
	"setSmartFilterBlend",
	"setTextAlignment",
	"transformLayerMatrix",
	"warpLayer",
	"warpMesh",
}

func TestNoSlotArityMismatch(t *testing.T) {
	// Sentinel: prove the `%!` detector works AND that a NON-constant format is
	// the only thing go vet can't pre-check (exactly the emitters' situation).
	sentinelFmt := "%s %s"
	if !strings.Contains(fmt.Sprintf(sentinelFmt, "one-arg-only"), "%!") {
		t.Fatal("sentinel: a missing-arg Sprintf must contain %! for this guard to work")
	}

	allow := map[string]bool{}
	for _, n := range arityNeedsParams {
		allow[n] = true
	}

	names := snippetNamesFromBuild(t)
	checked := 0
	var unexpectedUnbuildable []string
	stillUnbuildable := map[string]bool{}

	for _, name := range names {
		out, err := safeBuild(name, map[string]any{})
		if err != nil && strings.Contains(err.Error(), "unknown snippet") {
			// Not a real dispatch name: a nested mode-switch label (e.g. "twirl",
			// "clouds") that the case-parser over-collected from inside build().
			// build()'s default rejected it, so it's never callable as a snippet
			// name — exclude it entirely (its owning family is arity-checked with
			// a valid mode via the allowlist path).
			continue
		}
		if err != nil {
			stillUnbuildable[name] = true
			if !allow[name] {
				unexpectedUnbuildable = append(unexpectedUnbuildable,
					fmt.Sprintf("%s (%s)", name, err.Error()))
			}
			continue
		}
		if strings.Contains(out, "%!") {
			t.Errorf("snippet %q emitted a Go format-verb error (slot-arity mismatch) — "+
				"the fragment's %%s count and the emitter's Sprintf arg count disagree:\n%s", name, out)
		}
		checked++
	}

	// A NEW snippet that can't build with defaults must be added to
	// arityNeedsParams consciously (and ideally given real param coverage).
	sort.Strings(unexpectedUnbuildable)
	if len(unexpectedUnbuildable) > 0 {
		t.Errorf("build() cases not reachable with empty params and not in arityNeedsParams — "+
			"add valid params so they're arity-checked, or add them to the allowlist with a reason:\n  %s",
			strings.Join(unexpectedUnbuildable, "\n  "))
	}

	// A STALE allowlist entry (now default-buildable, so actively checked) should
	// be pruned so the list tracks reality.
	var stale []string
	for _, n := range arityNeedsParams {
		if !stillUnbuildable[n] {
			stale = append(stale, n)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("arityNeedsParams entries that now build with empty params (prune them — they're "+
			"already hard-checked):\n  %s", strings.Join(stale, "\n  "))
	}

	// Anti-vacuous floor: a broken parse/build must not silently check nothing.
	if checked < 90 {
		t.Fatalf("only %d snippets were arity-checked — parse or build likely broken", checked)
	}
	t.Logf("slot-arity: hard-checked %d snippets clean; %d require params (allowlisted)", checked, len(arityNeedsParams))
}
