package main

import (
	"runtime"
	"strings"
	"testing"
)

// probeOpenDocument — Phase 3b post-timeout re-probe for ps_open_document. A
// new go-direct snippet (no TS twin -> no golden entry). These assertions pin
// the load-bearing tokens the incident's live-verified semantics depend on:
// walking app.documents (never app.activeDocument), a per-document try/catch
// around fullName.fsName (an unsaved doc throws reading it), a normalized
// case/separator-insensitive path compare, and a success:false fallback when
// the file genuinely isn't open. Live verification against real Photoshop is
// the acceptance test per the tier process; this pins the string shape.

func TestProbeOpenDocumentEmitter(t *testing.T) {
	out := probeOpenDocument(`E:\iCloudDrive\PhotosInbox\Owasco-26\IMG_9265.DNG`)

	wants := []string{
		"for (var __mcpI = 0; __mcpI < app.documents.length; __mcpI++)", // walks ALL open docs, not just the active one
		"app.documents[__mcpI].fullName.fsName",                         // matches on fullName, not d.name
		"catch (eFn) { continue; }",                                     // per-doc try/catch — an unsaved doc throws reading fullName
		"__mcpNormPath(__mcpPath) === __mcpTarget",                      // compares through the normalizer, not raw strings
		`replace(/\\/g, '/').toLowerCase()`,                             // case + separator normalization (2 literal backslashes)
		"return { success: false };",                                    // genuine not-found -> failure, never a false success
		"app.activeDocument = __mcpFound",                               // found doc made active (mirrors app.open())
		"success: true",
		"reprobed: true",
		`E:\\iCloudDrive\\PhotosInbox\\Owasco-26\\IMG_9265.DNG`, // jsLit-escaped echo of the target path (2 backslashes per separator)
		"context: getContextInfo()",
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("probeOpenDocument output missing %q\n--- got ---\n%s", w, out)
		}
	}

	// The probe must NOT locate the target via app.activeDocument — that's
	// the exact bug this fixes (an unrelated scratch doc can be active while
	// the just-opened doc sits at another app.documents index).
	if strings.Contains(out, "app.activeDocument.fullName") {
		t.Error("probeOpenDocument must not match against app.activeDocument's fullName")
	}
}

// F6 (2026-07 QA review) — __mcpNormPath's case-fold + separator
// normalization is only correct on Windows (NTFS case-insensitive,
// backslash paths); everywhere else it must compare case-sensitively and
// leave the string untouched, or `/p/A.jpg` would false-match an
// already-open `/p/a.jpg` on a case-sensitive volume, silently make the
// WRONG document active, and report success:true.
func TestProbeOpenDocumentNormalizationIsWindowsOnly(t *testing.T) {
	outWin := probeOpenDocumentForPlatform(`E:\Photos\IMG_1.DNG`, true)
	if !strings.Contains(outWin, `var __mcpIsWindows = true;`) {
		t.Error("probeOpenDocumentForPlatform(windows=true) must emit __mcpIsWindows = true")
	}
	if !strings.Contains(outWin, `.replace(/\\/g, '/').toLowerCase()`) {
		t.Error("Windows branch must still case-fold + normalize separators")
	}

	outMac := probeOpenDocumentForPlatform(`/Volumes/Photos/IMG_1.DNG`, false)
	if !strings.Contains(outMac, `var __mcpIsWindows = false;`) {
		t.Error("probeOpenDocumentForPlatform(windows=false) must emit __mcpIsWindows = false")
	}
	// The conditional structure must be present (guarding the fold), and the
	// non-Windows path must return the string as-is — not still fold it
	// unconditionally regardless of the flag.
	wants := []string{
		`if (__mcpIsWindows) {`,
		`return s.replace(/\\/g, '/').toLowerCase();`,
		`}
      return s;`,
	}
	for _, w := range wants {
		if !strings.Contains(outMac, w) {
			t.Errorf("probeOpenDocumentForPlatform output missing %q", w)
		}
	}
}

// probeOpenDocument (the production entry point registry.build() dispatches
// to) must resolve isWindows from the actual host OS via runtime.GOOS, not
// hardcode either branch — pinned by asserting it matches
// probeOpenDocumentForPlatform's own runtime.GOOS-derived output exactly.
func TestProbeOpenDocumentResolvesPlatformFromRuntimeGOOS(t *testing.T) {
	want := probeOpenDocumentForPlatform("E:/photo.DNG", runtime.GOOS == "windows")
	got := probeOpenDocument("E:/photo.DNG")
	if got != want {
		t.Error("probeOpenDocument must derive isWindows from runtime.GOOS (via probeOpenDocumentForPlatform), not a hardcoded value")
	}
}

func TestProbeOpenDocumentEscapesPath(t *testing.T) {
	// A path containing a quote must be jsLit-escaped, never interpolated raw
	// (the same injection guard every other emitter in this package follows).
	out := probeOpenDocument(`C:/a"b.jpg`)
	if strings.Contains(out, `__mcpNormPath("C:/a"b.jpg")`) {
		t.Error("filePath must be jsLit-escaped, not interpolated raw (injection guard)")
	}
	if !strings.Contains(out, `\"b.jpg`) {
		t.Error("expected the quote in the path to be escaped in the emitted JSX")
	}
}
