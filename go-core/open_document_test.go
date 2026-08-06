package main

import (
	"strings"
	"testing"
)

// openDocumentPipeline's already-open guard (2026-08-01).
//
// app.open() on a path Photoshop ALREADY has open does not activate it — PS
// opens a second copy named "<name>-2" with a fresh Background. An agent that
// re-opened its own file then edited the empty duplicate and silently stranded
// its work (observed live 2026-07-30). The emitter now scans app.documents and
// activates a match.
//
// The platform branch is exercised through openDocumentPipelineForPlatform so
// these assertions do not depend on the test host's own OS — same reason
// probe_open_document_test.go parameterizes its sibling.

func TestOpenDocumentPipelineActivatesAlreadyOpenDocument(t *testing.T) {
	js := openDocumentPipelineForPlatform("C:/photos/a.jpg", true, true)

	// Scans open documents rather than going straight to app.open().
	for _, want := range []string{
		"app.documents.length",
		"fullName.fsName",
		"__mcpAlready",
		"app.activeDocument = __mcpAlready",
		"already_open:",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("emitted script missing %q", want)
		}
	}

	// fullName THROWS on an unsaved/untitled document, so each read must be
	// individually guarded — an unguarded loop aborts on the first scratch doc.
	if !strings.Contains(js, "catch (eFn) { continue; }") {
		t.Error("fullName read is not individually try/caught — an untitled document would abort the scan")
	}

	// A failed activation must NOT report success: reporting already_open while
	// app.activeDocument points elsewhere means every later tool edits the wrong
	// document.
	if !strings.Contains(js, "could not be made active") {
		t.Error("activation failure is swallowed — it must throw, not report success")
	}

	// The duplicate-open path still exists for a genuinely new file.
	if !strings.Contains(js, "app.open(imageFile)") {
		t.Error("the normal open path was lost")
	}
}

// The on-disk existence check must be gated on there being NO already-open
// match (2026-08-04): when the scan already matched an open document, the file
// on disk is not an input to the activation path.
//
// Scope, measured live (PS 27.2.0) rather than assumed: this does NOT rescue a
// moved or deleted backing file. Once the file is gone, doc.fullName throws
// "The document has not yet been saved.", so the scan's per-document
// try/catch skips it and no match exists to gate on. The reachable case is the
// narrower one where the scan matched but new File(path).exists still reads
// false (permission/sandbox quirk, flaky network volume).
func TestOpenDocumentPipelineSkipsTheExistsCheckWhenAlreadyOpen(t *testing.T) {
	js := openDocumentPipelineForPlatform("C:/photos/a.jpg", true, true)

	if !strings.Contains(js, "if (!__mcpAlready && !imageFile.exists)") {
		t.Error("the exists check is not gated on the already-open scan — a matched open document is rejected because its backing file did not resolve on disk (NOT the moved-file case; see this function's doc comment)")
	}

	// The unguarded form must not come back: a missing file with no open match
	// is still a hard error, but it may not preempt the activation path.
	if strings.Contains(js, "if (!imageFile.exists)") {
		t.Error("the ungated exists check is still present — it would run before the already-open match is consulted")
	}

	// The scan must still be ordered BEFORE the check it now gates. Assert both
	// anchors are PRESENT first: strings.Index returns -1 when absent, and
	// -1 > positive is false, so deleting the scan outright would otherwise
	// satisfy the ordering comparison vacuously.
	scanAt := strings.Index(js, "__mcpAlready = __mcpCaseCandidate")
	checkAt := strings.Index(js, "imageFile.exists")
	if scanAt < 0 {
		t.Fatal("the already-open scan's case-candidate resolution is gone — nothing sets __mcpAlready for the gate to read")
	}
	if checkAt < 0 {
		t.Fatal("the exists check is gone entirely — a missing file with no open match must still be a hard error")
	}
	if scanAt > checkAt {
		t.Error("the already-open scan no longer completes before the exists check reads its result")
	}
}

func TestOpenDocumentPipelineCaseHandlingProbesTheVolume(t *testing.T) {
	// Case sensitivity is a property of the VOLUME, not the OS. An OS-based
	// guess is wrong either way round: default macOS APFS is case-INSENSITIVE
	// (so folding-only-on-Windows MISSES the already-open document and opens the
	// "-2" duplicate this guard exists to prevent), while case-sensitive APFS
	// and Linux are the opposite (folding would activate the WRONG document).
	// The emitter therefore probes the filesystem instead of guessing.
	for _, tc := range []struct {
		name      string
		path      string
		isWindows bool
	}{
		{"windows", "C:/photos/a.jpg", true},
		{"unix", "/photos/a.jpg", false},
	} {
		js := openDocumentPipelineForPlatform(tc.path, true, tc.isWindows)

		// An EXACT match is correct on every volume and must be taken first,
		// without ever consulting the probe.
		if !strings.Contains(js, "__mcpOpenNorm === __mcpTargetPath") {
			t.Errorf("%s: no exact-match comparison", tc.name)
		}
		// A case-differing candidate is held back and only accepted if the
		// volume actually folds case.
		for _, want := range []string{
			"__mcpCaseCandidate",
			"__mcpVolumeIsCaseInsensitive(__mcpTargetPath)",
			".exists", // the probe: does the case-flipped basename resolve?
		} {
			if !strings.Contains(js, want) {
				t.Errorf("%s: missing %q — case handling is not volume-probed", tc.name, want)
			}
		}
		// Separator folding IS safe everywhere (no backslashes in POSIX paths)
		// and must not be conflated with case folding.
		// NB: the emitted JS is `replace(/\\/g, '/')` — a regex matching ONE
		// literal backslash. Written here as a Go raw string so the two
		// characters are compared verbatim.
		if !strings.Contains(js, `replace(/\\/g, '/')`) {
			t.Errorf("%s: separator normalization missing", tc.name)
		}
		// An unknown/failed probe must fall back to the conservative
		// case-SENSITIVE reading rather than risk the wrong document.
		if !strings.Contains(js, "__mcpCaseFold = false; // unknown") {
			t.Errorf("%s: probe failure does not fall back conservatively", tc.name)
		}
	}

	// Windows still short-circuits the probe — NTFS is known case-insensitive,
	// so it costs no extra File.exists call there.
	win := openDocumentPipelineForPlatform("C:/photos/a.jpg", true, true)
	if !strings.Contains(win, "var __mcpIsWindows = true;") {
		t.Error("windows emitter did not set __mcpIsWindows = true")
	}
	if !strings.Contains(win, "if (__mcpIsWindows) return true;") {
		t.Error("windows does not short-circuit the volume probe")
	}
	unix := openDocumentPipelineForPlatform("/photos/a.jpg", true, false)
	if !strings.Contains(unix, "var __mcpIsWindows = false;") {
		t.Error("non-windows emitter did not set __mcpIsWindows = false")
	}
}

func TestOpenDocumentPipelineEscapesThePath(t *testing.T) {
	// Every path slot goes through jsLit — a quote in a filename must not break
	// out of the string literal into executable script.
	js := openDocumentPipelineForPlatform(`C:/photos/it's "x".jpg`, true, true)
	if strings.Contains(js, `C:/photos/it's "x".jpg`) {
		t.Error("raw unescaped path reached the emitted script")
	}
	if !strings.Contains(js, `\"x\"`) {
		t.Error("expected the embedded quotes to be escaped by jsLit")
	}
}
