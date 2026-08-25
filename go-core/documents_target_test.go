package main

import (
	"strings"
	"testing"
)

// docTargetFrom guards a DESTRUCTIVE surface: ps_close_document resolves through
// it, so a selector that silently means the wrong thing closes the wrong
// document. None of these branches were reachable from a TS test, so they had no
// coverage at any layer.

func TestDocTargetFromRejectsBothSelectors(t *testing.T) {
	// The two can disagree — an id naming a different document than the name
	// does — and picking a winner would resolve that disagreement invisibly.
	_, err := docTargetFrom(map[string]any{"name": "a.psd", "id": 12.0}, false)
	if err == nil {
		t.Fatal("passing both name and id must be an error, not a silent precedence rule")
	}
	if !strings.Contains(err.Error(), "not both") {
		t.Errorf("error should say why: %v", err)
	}
}

func TestDocTargetFromRequiresSelectorWhenRequired(t *testing.T) {
	// activate has no sensible fallback: defaulting to the active document would
	// make "activate" a no-op that reports success.
	_, err := docTargetFrom(map[string]any{}, true)
	if err == nil {
		t.Fatal("a required selector must error when absent")
	}
}

func TestDocTargetFromAllowsEmptyWhenOptional(t *testing.T) {
	// close falls back to the active document, which is every pre-ps_document
	// caller's behaviour.
	target, err := docTargetFrom(map[string]any{}, false)
	if err != nil {
		t.Fatalf("an optional selector may be absent: %v", err)
	}
	if target.HasName || target.HasID {
		t.Error("absent selector must produce the zero DocTarget")
	}
}

func TestDocTargetFromTreatsEmptyNameAsAbsent(t *testing.T) {
	// The TS layer rejects an empty name before reaching here; this pins the Go
	// side's own behaviour so the two cannot drift into disagreeing about it.
	target, err := docTargetFrom(map[string]any{"name": ""}, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if target.HasName {
		t.Error("an empty name must not count as a target")
	}
}

func TestDocumentResolutionBlockZeroTargetIsTheActiveDocument(t *testing.T) {
	// Byte-identical to the pre-change inline statement: this is what keeps
	// existing ps_close_document callers unaffected.
	got := documentResolutionBlock(DocTarget{})
	if got != "var doc = app.activeDocument;" {
		t.Errorf("zero target must resolve to the active document, got: %q", got)
	}
}

func TestDocumentResolutionBlockRefusesAmbiguityAndIsAsciiOnly(t *testing.T) {
	block := documentResolutionBlock(DocTarget{Name: "a.psd", HasName: true})
	if !strings.Contains(block, "__mcpMatches.length > 1") {
		t.Error("a name match must check for ambiguity rather than taking the first hit")
	}
	if !strings.Contains(block, "target by id instead") {
		t.Error("the ambiguity error must tell the caller how to disambiguate")
	}
	// The emitted .jsx is written UTF-8 with no BOM and no #encoding directive,
	// so ExtendScript decodes it by the platform codepage — a non-ASCII byte
	// arrives as mojibake, and cscript flattens it to '?'.
	for i := 0; i < len(block); i++ {
		if block[i] > 127 {
			t.Fatalf("emitted JS must be ASCII-only; found byte %d at offset %d", block[i], i)
		}
	}
}

func TestDocumentResolutionBlockEscapesTheName(t *testing.T) {
	// A document name is user data reaching emitted JS source.
	block := documentResolutionBlock(DocTarget{Name: `a"; app.quit(); //`, HasName: true})
	if strings.Contains(block, `app.quit();`) && !strings.Contains(block, `\"`) {
		t.Error("the name must be emitted as an escaped string literal, not raw source")
	}
}
