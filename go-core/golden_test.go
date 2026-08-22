package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
)

// Phase 0/1 golden gate: the Go port must reproduce the current TS snippet
// output under behavioral-equivalence comparison (Finding 2 in the migration
// doc).
//
// testdata/golden.json is captured from the TS ExtendScriptSnippets on the
// pre-migration tree (scripts/_golden-capture.mjs). Behavioral equivalence —
// not byte equivalence — is the bar: ExtendScript is whitespace-insensitive
// OUTSIDE string literals, so we collapse insignificant whitespace before
// comparing. Significant tokens (cTID/sTID, keys, put-types, numeric
// interpolations, structure) must match.
//
// normalize() is a mini lexer (mirrors the string/comment tracking in
// _helpers.ts's findLastTopLevelSeparator):
//   - OUTSIDE strings/comments: collapse every whitespace run to one space.
//   - INSIDE a string literal ('…' / "…"): preserve content VERBATIM, with
//     backslash-escape handling, so a real divergence in a literal's internal
//     spacing (significant to ExtendScript output) is NOT masked.
//   - Line (//…) and block (/*…*/) comments are dropped (behaviorally inert).
//     Crucially, an apostrophe inside a comment does NOT open a string literal
//     — that's the bug the naive whitespace-collapse couldn't handle and why
//     this upgrade was a prerequisite for porting setTextFont (whose comments
//     contain 'quoted' words).
//
// The `/` division-vs-comment ambiguity is handled the same way the TS helper
// handles it: `//` and `/*` only start comments when not inside a string, and
// our snippets never write `a/` immediately followed by `*` or `/` outside a
// string (division operators are always space-separated). Documented as
// acceptable in _helpers.ts.
//
// Regeneration: there is no sanctioned generator for testdata/golden.json
// beyond this test itself — the original capture script
// (scripts/_golden-capture.mjs) was deleted with the legacy TS twin, and a
// recent fragment change had to hand-splice entries via a throwaway harness
// (process debt). Set UPDATE_GOLDEN=1 to switch this test from compare mode
// to update mode: it rewrites testdata/golden.json from the CURRENT emitter
// output for every case in `cases` instead of checking it.
//
// UPDATE_GOLDEN mode guard (C12): for every PRE-EXISTING key whose
// regenerated output differs from the stored value, updateGolden compares
// normalize(old) vs normalize(new) — the same behavioral-equivalence bar
// TestGaussianBlurGolden itself checks against. A pure formatting/whitespace
// resync (normalize equal) is written silently, same as before. A genuine
// BEHAVIORAL difference (normalize NOT equal) is treated as a probable
// unintended regression, not an intentional resync, and fails the run
// listing the changed keys — unless UPDATE_GOLDEN_ALLOW_BEHAVIOR=1 is ALSO
// set, the explicit human acknowledgment that the behavior change is
// intended. And regardless of that gate, UPDATE_GOLDEN mode always ends the
// run with t.Fatalf — it rewrites the fixture but never "passes" — so a
// leftover UPDATE_GOLDEN in an environment (CI misconfig, a forgotten local
// export) can never produce a vacuous green run; the next invocation without
// UPDATE_GOLDEN is what actually verifies anything.
//
// updateGolden MERGES rather than replaces: testdata/golden.json also holds
// entries this file's `cases` table doesn't cover — older entries no test
// currently reads, and any fixture owned by a suite that does not compile in
// this tree. Every key already in the file that ISN'T one of this
// run's case keys is carried over byte-for-byte in its existing position;
// only keys present in `cases` get their value replaced with the current
// emitter output (and a case key not yet in the file is appended). A naive
// "write only what this function knows about" implementation would silently
// delete those other suites' fixtures — verified the hard way while
// building this (see the round-trip note below).
//
// The writer (updateGolden / marshalNoHTMLEscape below) reproduces the
// existing file's serialization byte-for-byte: original key order (not
// alphabetical — Go's encoding/json sorts map keys, so a plain map marshal
// would NOT round-trip), 2-space indent, one space after each colon, no
// trailing comma on the last entry, '<' / '>' / '&' and non-ASCII left
// unescaped (Go's default HTML-safe escaping is turned off to match), no
// trailing newline. That serialization-format stability is a required,
// verified property — before trusting a real regen, run
// `UPDATE_GOLDEN=1 go test -run TestGaussianBlurGolden ./...` TWICE in a
// row on an otherwise-unchanged tree and confirm the second run produces
// zero further `git diff` (idempotence proves the writer's format is
// stable). Note the FIRST run against a stale committed file can still
// show a real (non-format) diff for entries whose source text drifted
// since golden.json was last captured — comments/whitespace changed by a
// later refactor without a resync, tolerated silently by normalize()'s
// behavioral-equivalence bar until now. That's exactly the staleness this
// mechanism exists to fix, not a bug in the writer; a non-empty first-run
// diff should be inspected key-by-key (normalize() both sides) before
// committing, not assumed clean. When UPDATE_GOLDEN is unset, behavior is
// exactly today's compare mode.
func normalize(s string) string {
	var b strings.Builder
	var inStr byte // 0, '\'' or '"'
	inLine := false
	inBlock := false
	escape := false
	pendingSpace := false

	for i := 0; i < len(s); i++ {
		c := s[i]
		var next byte
		if i+1 < len(s) {
			next = s[i+1]
		}

		if inStr != 0 {
			if escape {
				b.WriteByte(c)
				escape = false
				continue
			}
			if c == '\\' {
				b.WriteByte(c)
				escape = true
				continue
			}
			b.WriteByte(c)
			if c == inStr {
				inStr = 0
			}
			continue
		}
		if inLine {
			if c == '\n' {
				inLine = false
				pendingSpace = true
			}
			continue
		}
		if inBlock {
			if c == '*' && next == '/' {
				inBlock = false
				i++
				pendingSpace = true
			}
			continue
		}

		// Outside strings and comments.
		if c == '/' && next == '/' {
			inLine = true
			i++
			continue
		}
		if c == '/' && next == '*' {
			inBlock = true
			i++
			continue
		}
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			pendingSpace = true
			continue
		}
		// Significant character.
		if pendingSpace {
			b.WriteByte(' ')
			pendingSpace = false
		}
		if c == '"' || c == '\'' {
			inStr = c
		}
		b.WriteByte(c)
	}
	return strings.TrimSpace(b.String())
}

func TestGaussianBlurGolden(t *testing.T) {
	cases := []struct {
		key string
		got string
	}{
		{"applyGaussianBlur(2,false)", applyGaussianBlur(2, false, false)},
		// asSmartFilter=true — one DOM-method filter (measured live to apply
		// correctly to an un-rasterized Smart Object, see fragments_prologue.go)
		// and one Action-Manager filter (below, next to applyHighPass), pinning
		// that the smart-filter path (FiltRastSO/FiltKindSO) is reachable
		// through both filter families.
		{"applyGaussianBlur(2,false,true)", applyGaussianBlur(2, false, true)},
		{"applyGaussianBlur(5.5,true)", applyGaussianBlur(5.5, true, false)},
		{"applyUnsharpMask(80,1.2,3,false)", applyUnsharpMask(80, 1.2, 3, false, false)},
		{"applyUnsharpMask(85,1.8,3,true)", applyUnsharpMask(85, 1.8, 3, true, false)},
		{`applyAddNoise(14,"GAUSSIAN",true,false)`, applyAddNoise(14, "GAUSSIAN", true, false, false)},
		{"applyMotionBlur(45,20,false)", applyMotionBlur(45, 20, false, false)},
		{`applyLensBlur(15,"hexagon",5,45,10,200,8,"uniform",false,"none",0,false)`,
			applyLensBlur(15, "hexagon", 5, 45, 10, 200, 8, "uniform", false, "none", 0, false, false, false)},
		{`applyLensBlur(20,"octagon",0,0,0,255,12,"gaussian",true,"none",5,true,true)`,
			applyLensBlur(20, "octagon", 0, 0, 0, 255, 12, "gaussian", true, "none", 5, true, true, false)},
		{`applySmartSharpen(100,1.5,10,"gaussianBlur",0,20,50,30,10,50,30)`,
			applySmartSharpen(100, 1.5, 10, "gaussianBlur", 0, 20, 50, 30, 10, 50, 30, false, false)},
		{`applySmartSharpen(150,2,15,"motionBlur",45,0,50,30,0,50,30,true)`,
			applySmartSharpen(150, 2, 15, "motionBlur", 45, 0, 50, 30, 0, 50, 30, true, false)},
		{"applyReduceNoise(5,50,45,25,false,false,5,50,5,50,5,50)",
			applyReduceNoise(5, 50, 45, 25, false, false, 5, 50, 5, 50, 5, 50, false, false)},
		{"applyReduceNoise(8,60,50,30,true,true,6,40,6,40,9,30,true)",
			applyReduceNoise(8, 60, 50, 30, true, true, 6, 40, 6, 40, 9, 30, true, false)},
		{"applyHighPass(10)", applyHighPass(10, false, false)},
		{"applyHighPass(24,true)", applyHighPass(24, true, false)},
		{"applyHighPass(10,false,true)", applyHighPass(10, false, true)},
		{"applyShadowsHighlights(35,50,30,0,50,30,20,0)",
			applyShadowsHighlights(35, 50, 30, 0, 50, 30, 20, 0, 0.01, 0.01, false)},
		{"applyShadowsHighlights(50,60,40,25,55,35,30,10,0.02,0.05,true)",
			applyShadowsHighlights(50, 60, 40, 25, 55, 35, 30, 10, 0.02, 0.05, true)},
		{`applyColorLookup("Kodak 5218.cube")`, applyColorLookup("Kodak 5218.cube", false)},
		{`applyColorLookup("C:/luts/teal.3dl",true)`, applyColorLookup("C:/luts/teal.3dl", true)},
		{"applyEqualize()", applyEqualize(false)},
		{"applyEqualize(true)", applyEqualize(true)},
		{"setLayerOpacity(35)", setLayerOpacity(35)},
		{`setLayerBlendMode("MULTIPLY")`, mustSnippet(setLayerBlendMode("MULTIPLY"))},
		{"setLayerVisibility(false)", setLayerVisibility(false)},
		{"setLayerLocked(true)", setLayerLocked(true)},
		{`renameLayer("Hero Bloom")`, renameLayer("Hero Bloom")},
		{`createTextLayer("Hello World",120,240,36)`, createTextLayer("Hello World", 120, 240, 36)},
		{`setTextFont("ArialMT")`, setTextFont("ArialMT", 0, false)},
		{`setTextFont("Arial",18)`, setTextFont("Arial", 18, true)},
		{"setTextColor(255,128,0)", setTextColor(255, 128, 0)},
		{`setTextAlignment("CENTER")`, mustSnippet(setTextAlignment("CENTER"))},
		{`updateTextContent("Updated caption")`, updateTextContent("Updated caption")},
		{`selectRectangle(10,20,110,220,0,"replace")`, selectRectangle(10, 20, 110, 220, 0, "replace")},
		{`selectRectangle(0,0,50,50,8,"add")`, selectRectangle(0, 0, 50, 50, 8, "add")},
		{"featherSelection(12)", featherSelection(12)},
		{"selectAll()", selectAll()},
		{"deselect()", deselect()},
		{"invertSelection()", invertSelection()},
		{"getSelectionState()", getSelectionState()},
		{`selectColorRange(128,64,200,40,"replace")`, selectColorRange(128, 64, 200, 40, "replace")},
		{`selectColorRange(10,240,30,25,"add")`, selectColorRange(10, 240, 30, 25, "add")},
		{`magicWand(100,150,32,true,true,false,"replace")`, magicWand(100, 150, 32, true, true, false, "replace")},
		{`magicWand(50,60,16,false,true,true,"subtract")`, magicWand(50, 60, 16, false, true, true, "subtract")},
		{`getSelectionPreview("C:/overlay.jpg","C:/mask.jpg",800)`, getSelectionPreview("C:/overlay.jpg", "C:/mask.jpg", 800)},
		// Sensei selections - community tier (moved from golden_pro_test.go).
		{`selectSubject(true,"replace")`, selectSubject(true, "replace")},
		{`selectSubject(false,"add")`, selectSubject(false, "add")},
		{`selectSky(true,"replace")`, selectSky(true, "replace")},
		{`selectSky(false,"subtract")`, selectSky(false, "subtract")},
		// Native-AI additions (2026-08-15). replaceSky is covered here because it
		// refuses an empty param map (see arityNeedsParams), so these two rows are
		// its ONLY arity check: one at defaults, one with every tuning value set.
		{`selectFocusArea(4.07,false,"replace")`, selectFocusArea(4.07, false, "replace")},
		{`selectFocusArea(12.5,true,"add")`, selectFocusArea(12.5, true, "add")},
		{`replaceSky(defaults)`, replaceSky("C:/skies/a.jpg", "Sky A", "00000000-0000-0000-0000-000000000000", 0, 50, 0, 0, 35, 78, 70)},
		{`replaceSky(tuned)`, replaceSky("C:/skies/b.jpg", "Sky B", "11111111-2222-3333-4444-555555555555", -12, 80, 15, -20, 60, 40, 25)},
		{"newDocument(800,600)", newDocument(800, 600, 72, "NewDocumentMode.RGB")},
		{`placeImage("C:/img.png",10,20)`, placeImage("C:/img.png", 10, 20, 0, 0, false, false)},
		{`placeImage("C:/img.png",0,0,50,75)`, placeImage("C:/img.png", 0, 0, 50, 75, true, true)},
		{"closeDocument()", closeDocument(false)},
		{"closeDocument(true)", closeDocument(true)},
		{"resizeImage(800,600)", resizeImage(800, 600)},
		{"cropDocument(0,0,400,300)", cropDocument(0, 0, 400, 300)},
		// Pinned to the WINDOWS emitter explicitly, not the runtime.GOOS-derived
		// openDocumentPipeline: the already-open guard bakes `var __mcpIsWindows
		// = <bool>` into the output, so a GOOS-derived call makes this golden
		// pass only on Windows and fail on every macOS/Linux `go test`. Mirrors
		// probe_open_document_test.go, which parameterizes for the same reason.
		{`openDocumentPipeline("C:/photo.heic")`, openDocumentPipelineForPlatform("C:/photo.heic", true, true)},
		{`openDocumentPipeline("C:/photo.jpg",false)`, openDocumentPipelineForPlatform("C:/photo.jpg", false, true)},
		{`savePsdAsCopy("C:/out.psd",true)`, savePsdAsCopy("C:/out.psd", true)},
		{`exportJpegPipeline("C:/out.jpg",90,2048,true,true)`, exportJpegPipeline("C:/out.jpg", 90, 2048, true, true, true)},
		{`exportJpegPipeline("C:/out2.jpg",80)`, exportJpegPipeline("C:/out2.jpg", 80, 0, false, true, true)},
		{`exportPngPipeline("C:/out.png",true,1024,6)`, exportPngPipeline("C:/out.png", true, 1024, true, 6)},
		{`exportPngPipeline("C:/out2.png")`, exportPngPipeline("C:/out2.png", false, 0, false, 6)},
		{`deleteGroup("Shadows")`, deleteGroup("Shadows")},
		{"createClippingMask()", createClippingMask()},
		{"releaseClippingMask()", releaseClippingMask()},
		{`createGroup("Adjustments")`, createGroup("Adjustments", nil, false)},
		{`createGroup("Sky Stack",["Curves","Hue/Sat"])`, createGroup("Sky Stack", []string{"Curves", "Hue/Sat"}, false)},
		{`moveLayerToGroup("Curves 1","Sky Stack")`, moveLayerToGroup("Curves 1", "Sky Stack")},
		{`setGroupBlendMode("Sky Stack","MULTIPLY")`, setGroupBlendMode("Sky Stack", "MULTIPLY")},
		{`ungroup("Sky Stack")`, ungroup("Sky Stack")},
		{"newLayer()", newLayer("", false)},
		{`newLayer("Dodge")`, newLayer("Dodge", true)},
		{"deleteLayer()", deleteLayer("", false)},
		{`deleteLayer("Old Curves")`, deleteLayer("Old Curves", true)},
		// Non-ASCII name: pins the jsLit escaping end to end through a real
		// emitter, not just in the helper's own unit test. Photoshop names
		// layers itself in the UI language, so this is the ordinary case on a
		// German install, not an exotic one.
		{`deleteLayer("Farbfuellung 1" with u-umlaut)`, deleteLayer("Farbfüllung 1", true)},
		{"fillLayer(18,32,64)", fillLayer(18, 32, 64)},
		{"duplicateLayer()", duplicateLayer("", false)},
		{`duplicateLayer("Backup")`, duplicateLayer("Backup", true)},
		{"mergeVisibleLayers()", mergeVisibleLayers()},
		{"stampVisible()", stampVisible()},
		{"flattenImage()", flattenImage()},
		{`selectLayer("Background copy")`, selectLayer("Background copy")},
		{"rasterizeLayer()", rasterizeLayer()},
		{`addLayerStyle("drop_shadow",{"opacity":40,"angle":120,"distance":10,"spread":5,"size":14})`,
			addLayerStyle("drop_shadow", 0, 0, 0, 40, 120, 10, 5, 14, 3, "outside", 12, 0)},
		{`addLayerStyle("stroke",{"color":{"r":255,"g":0,"b":0},"opacity":100,"stroke_size":4,"stroke_position":"inside"})`,
			addLayerStyle("stroke", 255, 0, 0, 100, 90, 8, 0, 12, 4, "inside", 12, 0)},
		{`addLayerStyle("outer_glow",{"color":{"r":255,"g":255,"b":200},"opacity":60,"glow_size":20,"glow_spread":8,"stroke_position":"center"})`,
			addLayerStyle("outer_glow", 255, 255, 200, 60, 90, 8, 0, 12, 3, "center", 20, 8)},
		{"undo()", undo(1)},
		{"undo(3)", undo(3)},
		{"redo()", redo(1)},
		{"getHistoryStates()", getHistoryStates()},
		{"pingState()", pingState()},
		{"getLayerTree()", getLayerTree()},
		{"getMetadata()", getMetadata(true, true, true)},
		{`getMetadata({"document":true,"iptc":false,"dom_exif":true})`, getMetadata(true, false, true)},
		{`getMetadata({"document":true,"iptc":true,"dom_exif":false})`, getMetadata(true, true, false)},
		{"createLayerMask()", createLayerMask()},
		{"deleteLayerMask()", deleteLayerMask()},
		{"applyLayerMask()", applyLayerMask()},
		{"addGradientFillLayer(defaults)", mustSnippet(addGradientFillLayer(map[string]any{}))},
		{"addGradientFillLayer(radial,custom-stops)", mustSnippet(addGradientFillLayer(map[string]any{
			"gradient_type": "radial", "angle": 0.0, "scale": 120.0, "reverse": true, "dither": false,
			"stops": []any{
				map[string]any{"red": 10.0, "green": 20.0, "blue": 200.0, "location": 0.0},
				map[string]any{"red": 255.0, "green": 128.0, "blue": 0.0, "location": 100.0, "midpoint": 60.0},
			},
			"opacity_stops": []any{
				map[string]any{"opacity": 100.0, "location": 0.0},
				map[string]any{"opacity": 0.0, "location": 100.0},
			},
		}))},
		{"maskGradient(defaults)", mustSnippet(maskGradient(map[string]any{}))},
		{"maskGradient(top,partial,canvas)", mustSnippet(maskGradient(map[string]any{
			"fade_to": "top", "start": 0.25, "end": 0.9, "extent": "canvas",
		}))},
		{"maskGradient(left)", mustSnippet(maskGradient(map[string]any{"fade_to": "left"}))},
		{"maskGradient(right)", mustSnippet(maskGradient(map[string]any{"fade_to": "right"}))},
		{`moveLayerToPosition(,"TOP")`, moveLayerToPosition("", false, "TOP", "", false)},
		{`moveLayerToPosition("Base","ABOVE","Overlay")`, moveLayerToPosition("Base", true, "ABOVE", "Overlay", true)},
		{`moveLayerToPosition("Base","BELOW")`, moveLayerToPosition("Base", true, "BELOW", "", false)},
		// histogram
		{`getHistogram("")`, getHistogram("")},
		{`getHistogram("red")`, getHistogram("red")},
		// history-state preview
		{`renderHistoryStatePreview(0,"C:/out.jpg",1500,8)`, renderHistoryStatePreview(0, 1500, 8, "C:/out.jpg")},
		{`renderHistoryStatePreview(2,"C:/prev.jpg",800,6)`, renderHistoryStatePreview(2, 800, 6, "C:/prev.jpg")},
		// layer-transform (community tier)
		{`fitLayerToDocument(false)`, fitLayerToDocument(false)},
		{`fitLayerToDocument(true)`, fitLayerToDocument(true)},
		{`scaleLayer(150,false)`, scaleLayer(150, false)},
		{`scaleLayer(50)`, scaleLayer(50, true)},
		{`rotateLayer(90)`, rotateLayer(90)},
		{`moveLayer(10,20,"delta")`, moveLayer(10, 20, "delta", 0, 0, 0, 0)},
		{`moveLayer(0,0,"absolute",100,50)`, moveLayer(0, 0, "absolute", 100, 50, 0, 0)},
		{`moveLayer(0,0,"center",0,0,200,150)`, moveLayer(0, 0, "center", 0, 0, 200, 150)},
		// retouch (community tier)
		{`applyContentAwareFill(true,false,false,false,100,"normal",false)`,
			applyContentAwareFill(true, false, false, false, 100, "normal", false)},
		{`applyContentAwareFill(false,true,true,true,80,"multiply",true)`,
			applyContentAwareFill(false, true, true, true, 80, "multiply", true)},
		{`applyPatch(10,-20,5,5,5,false,false,true,false)`,
			applyPatch(10, -20, 5, 5, 5, false, false, true, false)},
		{`applyPatch(-15,30,7,3,6,true,true,false,true)`,
			applyPatch(-15, 30, 7, 3, 6, true, true, false, true)},
		{`applyContentAwareMove(40,10,4,5,5,false,false,true,false)`,
			applyContentAwareMove(40, 10, 4, 5, 5, false, false, true, false)},
		{`applyContentAwareMove(-25,-5,6,4,7,true,true,false,true)`,
			applyContentAwareMove(-25, -5, 6, 4, 7, true, true, false, true)},
	}

	if os.Getenv("UPDATE_GOLDEN") == "1" {
		updateGolden(t, cases)
		return
	}

	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	// Tolerate a UTF-8 BOM (bytes EF BB BF) — the capture pipeline (PowerShell
	// Out-File) can prepend one, which json.Unmarshal otherwise rejects.
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	var golden map[string]string
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("parse golden: %v", err)
	}

	for _, c := range cases {
		want, ok := golden[c.key]
		if !ok {
			t.Fatalf("golden missing key %q", c.key)
		}
		if normalize(c.got) != normalize(want) {
			t.Errorf("golden MISMATCH for %s\n--- got ---\n%s\n--- want ---\n%s",
				c.key, normalize(c.got), normalize(want))
		}
	}
}

// mustSnippet unwraps an emitter that returns (string, error) for use in the
// golden table, where the inputs are known-valid (e.g. setLayerBlendMode,
// setTextAlignment, whose enum allow-list never trips on these fixtures). A
// non-nil error here means the fixture is wrong, so panicking is correct.
func mustSnippet(s string, err error) string {
	if err != nil {
		panic(err)
	}
	return s
}

// updateGolden rewrites testdata/golden.json, MERGING the current emitter
// output for every case in `cases` into the file's existing content: keys
// not covered by `cases` (e.g. golden_pro_test.go's pro-tier entries, or
// older entries no test currently reads) are carried over byte-for-byte in
// their existing position; a case key already in the file gets its value
// replaced in place; a case key not yet in the file is appended at the
// end. See the UPDATE_GOLDEN doc comment above TestGaussianBlurGolden for
// why the merge (not a wholesale rewrite), the behavioral-change gate, and
// the required round-trip verification before trusting a real regen.
//
// The actual merge computation is the pure, disk-free mergeGoldenJSON below
// — updateGolden is just its file-I/O + gate + forced-failure wrapper, kept
// thin so mergeGoldenJSON's merge-preservation and behavioral-change-
// detection properties are unit-testable against synthetic input without
// ever touching the real fixture (see TestMergeGoldenJSON* below).
func updateGolden(t *testing.T, cases []struct {
	key string
	got string
}) {
	t.Helper()

	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}

	merged, changedKeys, err := mergeGoldenJSON(raw, cases)
	if err != nil {
		t.Fatalf("merge golden: %v", err)
	}

	if len(changedKeys) > 0 && os.Getenv("UPDATE_GOLDEN_ALLOW_BEHAVIOR") != "1" {
		sort.Strings(changedKeys)
		t.Fatalf(
			"UPDATE_GOLDEN would change %d pre-existing key(s) BEHAVIORALLY (not just "+
				"whitespace/formatting) — this looks like an unintended snippet regression, not "+
				"an intentional resync, so nothing was written:\n  %s\nIf this IS an intended "+
				"behavior change, rerun with UPDATE_GOLDEN_ALLOW_BEHAVIOR=1 to acknowledge it "+
				"explicitly.",
			len(changedKeys), strings.Join(changedKeys, "\n  "),
		)
	}

	if err := os.WriteFile("testdata/golden.json", merged, 0o644); err != nil {
		t.Fatalf("write testdata/golden.json: %v", err)
	}

	// Never let UPDATE_GOLDEN produce a vacuous green run: a leftover env
	// var (CI misconfig, a forgotten local export) must not silently read
	// as "the golden matched" when this run never actually compared
	// anything — it regenerated the fixture instead. Force a failure
	// naming the required next step.
	t.Fatalf("golden regenerated — rerun without UPDATE_GOLDEN to verify")
}

// mergeGoldenJSON computes the merged testdata/golden.json content (see
// updateGolden's doc comment for the merge semantics) from the raw existing
// file bytes and the current run's cases, WITHOUT touching disk. Returns the
// merged bytes plus the list of PRE-EXISTING keys whose value changed
// BEHAVIORALLY (normalize(old) != normalize(new)) — a purely
// formatting/whitespace resync of an existing key is not included, matching
// TestGaussianBlurGolden's own comparison bar.
func mergeGoldenJSON(raw []byte, cases []struct {
	key string
	got string
}) (merged []byte, changedKeys []string, err error) {
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})

	existingOrder, err := goldenKeyOrder(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("read golden key order: %w", err)
	}
	var existingVals map[string]string
	if err := json.Unmarshal(raw, &existingVals); err != nil {
		return nil, nil, fmt.Errorf("parse golden: %w", err)
	}

	updates := make(map[string]string, len(cases))
	var caseOrder []string
	for _, c := range cases {
		if _, dup := updates[c.key]; !dup {
			caseOrder = append(caseOrder, c.key)
		}
		updates[c.key] = c.got
	}

	seen := make(map[string]bool, len(existingOrder)+len(caseOrder))
	var lines []string
	appendEntry := func(key, val string) error {
		keyJSON, err := marshalNoHTMLEscape(key)
		if err != nil {
			return fmt.Errorf("marshal golden key %q: %w", key, err)
		}
		valJSON, err := marshalNoHTMLEscape(val)
		if err != nil {
			return fmt.Errorf("marshal golden value for %q: %w", key, err)
		}
		lines = append(lines, "  "+string(keyJSON)+": "+string(valJSON))
		return nil
	}
	for _, k := range existingOrder {
		v := existingVals[k]
		if nv, ok := updates[k]; ok {
			if normalize(nv) != normalize(v) {
				changedKeys = append(changedKeys, k)
			}
			v = nv
		}
		if err := appendEntry(k, v); err != nil {
			return nil, nil, err
		}
		seen[k] = true
	}
	for _, k := range caseOrder {
		if seen[k] {
			continue
		}
		if err := appendEntry(k, updates[k]); err != nil {
			return nil, nil, err
		}
		seen[k] = true
	}

	out := "{\n" + strings.Join(lines, ",\n") + "\n}"
	return []byte(out), changedKeys, nil
}

// goldenKeyOrder walks the raw golden.json bytes with a streaming decoder
// to recover the file's ORIGINAL top-level key order — json.Unmarshal into
// a map[string]string loses it (Go maps have no order), and a fresh
// alphabetical sort would reorder the file on every regen.
func goldenKeyOrder(raw []byte) ([]string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("expected object start, got %v", tok)
	}
	var keys []string
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, fmt.Errorf("expected string key, got %v", keyTok)
		}
		keys = append(keys, key)
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil, err
		}
	}
	return keys, nil
}

// marshalNoHTMLEscape JSON-encodes a single string the way the original
// capture script (Node's JSON.stringify, via scripts/_golden-capture.mjs)
// did: '<' / '>' / '&' left literal. Go's json.Marshal HTML-escapes those
// by default; json.Encoder.SetEscapeHTML(false) turns that off. Encode
// appends a trailing newline after the value — trimmed here since callers
// splice the result inline.
func marshalNoHTMLEscape(s string) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// ─────────────────────────────────────────────────────────────────────────
// mergeGoldenJSON — C12 / Q7. Pure-function tests against synthetic input,
// so the merge-preservation and behavioral-change-detection properties are
// pinned without ever writing to the real testdata/golden.json.
// ─────────────────────────────────────────────────────────────────────────

// TestMergeGoldenJSONPreservesUntouchedKeys pins the merge-preservation
// property (Q7): a key present in the existing file but NOT covered by the
// current run's `cases` — e.g. golden_pro_test.go's entries when this
// (non-pro) package runs UPDATE_GOLDEN — is carried over byte-for-byte, IN
// ITS ORIGINAL POSITION, not dropped and not reordered.
func TestMergeGoldenJSONPreservesUntouchedKeys(t *testing.T) {
	raw := []byte(`{
  "alpha": "one",
  "beta": "two",
  "gamma": "three"
}`)
	cases := []struct {
		key string
		got string
	}{
		{"beta", "TWO-UPDATED"},
		{"delta", "four"},
	}

	merged, changedKeys, err := mergeGoldenJSON(raw, cases)
	if err != nil {
		t.Fatalf("mergeGoldenJSON: %v", err)
	}

	var got map[string]string
	if err := json.Unmarshal(merged, &got); err != nil {
		t.Fatalf("parse merged output: %v", err)
	}

	// Untouched keys preserved with their original value, unchanged.
	if got["alpha"] != "one" {
		t.Errorf(`got["alpha"] = %q, want unchanged "one"`, got["alpha"])
	}
	if got["gamma"] != "three" {
		t.Errorf(`got["gamma"] = %q, want unchanged "three"`, got["gamma"])
	}
	// A case key already in the file gets its value replaced in place.
	if got["beta"] != "TWO-UPDATED" {
		t.Errorf(`got["beta"] = %q, want "TWO-UPDATED"`, got["beta"])
	}
	// A case key not yet in the file is appended.
	if got["delta"] != "four" {
		t.Errorf(`got["delta"] = %q, want "four"`, got["delta"])
	}

	// Position: untouched + updated existing keys keep their original
	// relative order (alpha, beta, gamma); the brand-new key is appended
	// after them, not interleaved.
	order, err := goldenKeyOrder(merged)
	if err != nil {
		t.Fatalf("goldenKeyOrder(merged): %v", err)
	}
	want := []string{"alpha", "beta", "gamma", "delta"}
	if len(order) != len(want) {
		t.Fatalf("key order = %v, want %v", order, want)
	}
	for i, k := range want {
		if order[i] != k {
			t.Errorf("key order[%d] = %q, want %q", i, order[i], k)
		}
	}

	// "beta"'s new value is behaviorally different from the old one — it
	// must be reported as a changed key.
	if len(changedKeys) != 1 || changedKeys[0] != "beta" {
		t.Errorf(`changedKeys = %v, want ["beta"]`, changedKeys)
	}
}

// TestMergeGoldenJSONFormattingOnlyChangeNotFlagged pins the other half of
// the C12 gate: a pre-existing key whose regenerated value differs only in
// insignificant whitespace (normalize-equal, same as TestGaussianBlurGolden's
// own compare-mode bar) is NOT reported as a behavioral change — only a
// genuine semantic difference should force UPDATE_GOLDEN_ALLOW_BEHAVIOR.
func TestMergeGoldenJSONFormattingOnlyChangeNotFlagged(t *testing.T) {
	raw := []byte(`{
  "alpha": "foo(1,   2)"
}`)
	cases := []struct {
		key string
		got string
	}{
		// Same tokens in the same relative positions — only the RUN LENGTH
		// of the (insignificant, outside-string) whitespace between the
		// comma and "2" differs. normalize() collapses any whitespace run
		// to one space, so both sides normalize identically.
		{"alpha", "foo(1, 2)"},
	}

	_, changedKeys, err := mergeGoldenJSON(raw, cases)
	if err != nil {
		t.Fatalf("mergeGoldenJSON: %v", err)
	}
	if len(changedKeys) != 0 {
		t.Errorf("changedKeys = %v, want none (formatting-only difference)", changedKeys)
	}
}

// TestMergeGoldenJSONBehavioralChangeDetected is the mirror case: a
// pre-existing key whose regenerated value differs in a SIGNIFICANT token
// (not just whitespace) must be reported so updateGolden's gate can block it
// absent UPDATE_GOLDEN_ALLOW_BEHAVIOR=1.
func TestMergeGoldenJSONBehavioralChangeDetected(t *testing.T) {
	raw := []byte(`{
  "alpha": "foo(1,2)",
  "beta": "bar()"
}`)
	cases := []struct {
		key string
		got string
	}{
		{"alpha", "foo(1,3)"}, // token changed — behavioral
		{"beta", "bar()"},     // identical — not behavioral
	}

	_, changedKeys, err := mergeGoldenJSON(raw, cases)
	if err != nil {
		t.Fatalf("mergeGoldenJSON: %v", err)
	}
	if len(changedKeys) != 1 || changedKeys[0] != "alpha" {
		t.Errorf(`changedKeys = %v, want ["alpha"]`, changedKeys)
	}
}
