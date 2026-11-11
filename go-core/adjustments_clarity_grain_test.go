package main

import (
	"strings"
	"testing"
)

// Clarity and Dehaze, and Grain: the two adjustment-layer types added in
// Photoshop 27.3. Ground truth: ScriptListener capture on PS 28.0.0 / Windows,
// 2026-11-11, replayed live. Photoshop stores out-of-range values unclamped
// (999 went in as 999), so the clamp here is the only range check there is.

func adjJSX(t *testing.T, adjType string, params map[string]any) string {
	t.Helper()
	out, err := addAdjustmentLayer(adjType, false, "", false, params, false, false, false)
	if err != nil {
		t.Fatalf("addAdjustmentLayer(%s) returned error: %v", adjType, err)
	}
	return out
}

func assertContainsAll(t *testing.T, label, out string, wants []string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("%s JSX missing %q", label, w)
		}
	}
}

func TestAddAdjustmentLayerClarityDehaze(t *testing.T) {
	out := adjJSX(t, "clarity_dehaze", map[string]any{"cd_clarity": 29.0, "cd_dehaze": -30.0})
	assertContainsAll(t, "clarity_dehaze", out, []string{
		`else if (adjType === 'clarity_dehaze') typeCharID = sTID('clarity');`,
		`typeDesc.putInteger(sTID('clarity'), 29);`,
		`typeDesc.putInteger(sTID('dehaze'), -30);`,
		`var wantCustom = true;`,
		`using.putObject(cTID('Type'), typeCharID, typeDesc);`,
	})
}

func TestAddAdjustmentLayerClarityDehazeClamps(t *testing.T) {
	out := adjJSX(t, "clarity_dehaze", map[string]any{"cd_clarity": 150.0, "cd_dehaze": -150.4})
	assertContainsAll(t, "clarity_dehaze clamp", out, []string{
		`typeDesc.putInteger(sTID('clarity'), 100);`,
		`typeDesc.putInteger(sTID('dehaze'), -100);`,
	})
}

func TestAddAdjustmentLayerGrain(t *testing.T) {
	out := adjJSX(t, "grain", map[string]any{
		"grain_amount": 58.0, "grain_size": 45.0, "grain_roughness": 81.0,
	})
	assertContainsAll(t, "grain", out, []string{
		`else if (adjType === 'grain') typeCharID = sTID('grainAdjustment');`,
		`typeDesc.putInteger(sTID('grainAmount'), 58);`,
		`typeDesc.putInteger(sTID('grainSize'), 45);`,
		`typeDesc.putInteger(sTID('grainRoughness'), 81);`,
	})
	if strings.Contains(out, "grainSeed") {
		t.Error("grain JSX should leave grainSeed to Photoshop")
	}
}

// With no values, Photoshop makes an invisible Grain layer (amount 0). The
// default must be visible, and every value must be explicit.
func TestAddAdjustmentLayerGrainDefaultsVisibleAndClamps(t *testing.T) {
	out := adjJSX(t, "grain", map[string]any{})
	assertContainsAll(t, "grain default", out, []string{
		`typeDesc.putInteger(sTID('grainAmount'), 25);`,
		`typeDesc.putInteger(sTID('grainSize'), 25);`,
		`typeDesc.putInteger(sTID('grainRoughness'), 50);`,
	})
	out = adjJSX(t, "grain", map[string]any{
		"grain_amount": 999.0, "grain_size": -5.0, "grain_roughness": 33.6,
	})
	assertContainsAll(t, "grain clamp", out, []string{
		`typeDesc.putInteger(sTID('grainAmount'), 100);`,
		`typeDesc.putInteger(sTID('grainSize'), 0);`,
		`typeDesc.putInteger(sTID('grainRoughness'), 34);`,
	})
}

// The DOM throws on layer.kind for these layers, so the verify step must go
// through __kindOf (defined by the script wrapper in src/api/photoshop-api.ts).
func TestAddAdjustmentLayerVerifiesKindThroughHelper(t *testing.T) {
	out := adjJSX(t, "grain", map[string]any{})
	assertContainsAll(t, "grain kind", out, []string{
		`var verifiedKind = String(__kindOf(newLayer));`,
		`else if (adjType === 'grain') expectedKind = 'LayerKind.GRAIN';`,
	})
	if strings.Contains(out, "newLayer.kind") {
		t.Error("adjustment JSX still reads newLayer.kind through the DOM")
	}
}
