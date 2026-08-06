package main

import "testing"

// Enum-rejection guards (audit M8/M9 + the QA follow-up). The Go core is the
// trust boundary: any slot that interpolates a caller string RAW into a JS
// identifier (BlendMode.<x>, Justification.<x>, NoiseDistribution.<x>, the
// NewDocumentMode.<x> expression) must be allow-listed HERE, not merely by the
// upstream TS schema. These pin the rejection path so a refactor that drops an
// allowlist fails the suite instead of silently reopening an injection break-out.

func TestSetLayerBlendModeRejectsInvalid(t *testing.T) {
	if _, err := setLayerBlendMode(`NORMAL; app.system("calc")`); err == nil {
		t.Fatal("setLayerBlendMode accepted an out-of-enum (break-out) value")
	}
	if _, err := setLayerBlendMode("MULTIPLY"); err != nil {
		t.Fatalf("setLayerBlendMode rejected a valid value: %v", err)
	}
}

func TestSetTextAlignmentRejectsInvalid(t *testing.T) {
	if _, err := setTextAlignment(`LEFT); evil((`); err == nil {
		t.Fatal("setTextAlignment accepted an out-of-enum (break-out) value")
	}
	if _, err := setTextAlignment("CENTER"); err != nil {
		t.Fatalf("setTextAlignment rejected a valid value: %v", err)
	}
}

func TestBuildRejectsInvalidNoiseDistribution(t *testing.T) {
	if _, err := build("applyAddNoise", map[string]any{"distribution": `UNIFORM); evil((`}); err == nil {
		t.Fatal("build(applyAddNoise) accepted an out-of-enum distribution")
	}
	if _, err := build("applyAddNoise", map[string]any{"distribution": "GAUSSIAN", "amount": 5.0}); err != nil {
		t.Fatalf("build(applyAddNoise) rejected a valid distribution: %v", err)
	}
}

func TestBuildRejectsInvalidNewDocumentMode(t *testing.T) {
	if _, err := build("newDocument", map[string]any{"colorMode": `NewDocumentMode.RGB; evil()`}); err == nil {
		t.Fatal("build(newDocument) accepted an out-of-enum colorMode")
	}
	if _, err := build("newDocument", map[string]any{
		"colorMode": "NewDocumentMode.RGB", "width": 100.0, "height": 100.0,
	}); err != nil {
		t.Fatalf("build(newDocument) rejected a valid colorMode: %v", err)
	}
}
