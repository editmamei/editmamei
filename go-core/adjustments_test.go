package main

import (
	"strings"
	"testing"
)

// The levels/curves post-Mk setd is the highest-value descriptor in this
// package and, until 2026-07-27, had NO go-side coverage at all.
//
// tests/spec/levels.test.ts and tests/spec/curves.test.ts assert the same
// fixes, but they assert against ExtendScriptSnippets — the legacy TS twin,
// which docs/engineering/am-descriptor-conventions.md marks test-only. The
// RUNTIME is templates.enc, generated
// from cmd/buildtemplates/fragments.go and emitted by addAdjustmentLayer
// below. golden_test.go's case table carries no addAdjustmentLayer entry, so
// the two sides are not pinned to each other either.
//
// That gap is not hypothetical. Targeting cTID('Lyr ') here instead of
// cTID('AdjL') shipped a ~2-month silent no-op: PS returns success, the
// values land on a pixel-less layer, and every offline gate stays green. The
// same commit that fixed it also found jsWantCustom force-false on the Go
// side while the TS twin was not — drift that survived precisely because
// nothing compared them.
//
// So these tests exist to fail when the runtime emitter regresses, whatever
// the TS twin says. Ground truth for every assertion, verified against a
// ScriptListener capture: JS-05-levels.log:108-142 and JS-04-curves.log:530-556.

func levelsJSX(t *testing.T) string {
	t.Helper()
	out, err := addAdjustmentLayer("levels", false, "", false, map[string]any{
		"black_point": 8.0,
		"white_point": 238.0,
		"gamma":       1.25,
	}, false, false, false)
	if err != nil {
		t.Fatalf("addAdjustmentLayer(levels) returned error: %v", err)
	}
	return out
}

func curvesJSX(t *testing.T) string {
	t.Helper()
	out, err := addAdjustmentLayer("curves", false, "", false, map[string]any{
		"curves_preset": "sCurveMedium",
	}, false, false, false)
	if err != nil {
		t.Fatalf("addAdjustmentLayer(curves) returned error: %v", err)
	}
	return out
}

// T1: the setd must target the ADJUSTMENT LAYER (AdjL), never the
// destructive pixel-bake descriptor (Lyr ). This is the whole bug.
func TestAddAdjustmentLayerLevelsSetdTargetsAdjL(t *testing.T) {
	out := levelsJSX(t)

	wants := []string{
		// The target class. The one assertion that matters most.
		`lvlSetdRef.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));`,
		// presetKindCustom on the setd's type descriptor — without it PS
		// accepts the event and keeps the preset values.
		`lvlsTypeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));`,
		// Chnl is putReference to the composite, NOT putEnumerated.
		`lvlsEntry.putReference(cTID('Chnl'), lvlChnlRef);`,
		`lvlChnlRef.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));`,
		// T object class + the values themselves.
		`lvlSetd.putObject(cTID('T   '), cTID('Lvls'), lvlsTypeDesc);`,
		`lvlInptList.putInteger(8);`,
		`lvlInptList.putInteger(238);`,
		`lvlsEntry.putList(cTID('Inpt'), lvlInptList);`,
		`lvlsEntry.putDouble(cTID('Gmm '), 1.25);`,
		`executeAction(cTID('setd'), lvlSetd, DialogModes.NO);`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("levels JSX missing %q", w)
		}
	}

	notWants := []string{
		// The regression. A silent revert to the bake target is invisible
		// to every other gate in this repo.
		`lvlSetdRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));`,
		// The pre-fix Chnl form.
		`lvlsEntry.putEnumerated(cTID('Chnl')`,
		// Legacy value shapes from the 2026-06-03 audit.
		`cTID('Wht '), 238`,
		`Math.round((1.25) * 100)`,
	}
	for _, nw := range notWants {
		if strings.Contains(out, nw) {
			t.Errorf("levels JSX unexpectedly contains %q", nw)
		}
	}
}

func TestAddAdjustmentLayerCurvesSetdTargetsAdjL(t *testing.T) {
	out := curvesJSX(t)

	wants := []string{
		`crvSetdRef.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));`,
		`crvTypeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));`,
		// Chnl needs putReference here too.
		`crvEntry.putReference(cTID('Chnl'), crvChnlRef);`,
		`crvChnlRef.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));`,
		// The T object class is Crvs. A 'Crv ' class makes PS reject the
		// event outright ("The command Set is not currently available"),
		// while 'Crv ' remains correct as the point-list KEY below.
		`crvSetd.putObject(cTID('T   '), cTID('Crvs'), crvTypeDesc);`,
		`crvEntry.putList(cTID('Crv '), pointList);`,
		`crvAdjList.putObject(cTID('CrvA'), crvEntry);`,
		`executeAction(cTID('setd'), crvSetd, DialogModes.NO);`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("curves JSX missing %q", w)
		}
	}

	notWants := []string{
		`crvSetdRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));`,
		// The T-object class that PS rejects.
		`crvSetd.putObject(cTID('T   '), cTID('Crv '), crvTypeDesc);`,
		`crvEntry.putEnumerated(cTID('Chnl')`,
	}
	for _, nw := range notWants {
		if strings.Contains(out, nw) {
			t.Errorf("curves JSX unexpectedly contains %q", nw)
		}
	}
}

// The default curves preset must route down the custom path. Before the fix
// this was the reason EVERY curves call produced an identity curve: the
// default preset took the broken branch, so the bug was not an edge case but
// the common case.
func TestAddAdjustmentLayerCurvesDefaultPresetEmitsTheSetd(t *testing.T) {
	out, err := addAdjustmentLayer("curves", false, "", false, map[string]any{}, false, false, false)
	if err != nil {
		t.Fatalf("addAdjustmentLayer(curves, no params) returned error: %v", err)
	}
	if !strings.Contains(out, `mark('apply_curves_setd');`) {
		t.Error("curves with default params must still emit the post-Mk setd block")
	}
	if !strings.Contains(out, `crvSetdRef.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));`) {
		t.Error("curves with default params must target AdjL")
	}
	// 'linear' is the one preset that means "no curve" and must NOT emit.
	linear, err := addAdjustmentLayer("curves", false, "", false, map[string]any{
		"curves_preset": "linear",
	}, false, false, false)
	if err != nil {
		t.Fatalf("addAdjustmentLayer(curves, linear) returned error: %v", err)
	}
	if strings.Contains(linear, `mark('apply_curves_setd');`) {
		t.Error("curves_preset=linear must not emit a setd block")
	}
}

// T2: the Mk descriptor must be byte-identical across the wantCustom
// branches. levels/curves route their values through the post-Mk setd, so
// their Mk typeDesc has to keep emitting presetKindDefault even though
// wantCustom is now honestly true. Delete the AdjLvlCrvTd lookup in
// adjustments.go and the Mk descriptor silently loses its presetKind key
// with nothing else failing.
func TestAddAdjustmentLayerLevelsCurvesMkKeepsPresetKindDefault(t *testing.T) {
	const presetDefault = `typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindDefault'));`

	for _, tc := range []struct {
		name string
		jsx  string
	}{
		{"levels", levelsJSX(t)},
		{"curves", curvesJSX(t)},
	} {
		if !strings.Contains(tc.jsx, presetDefault) {
			t.Errorf("%s Mk typeDesc missing the presetKindDefault line", tc.name)
		}
		// customValuesApplied reports on the post-Mk setd, so with real
		// values it must be honest — it was hardcoded false for both types
		// until 2026-07-27 and reported failure on a successful write.
		if !strings.Contains(tc.jsx, `var wantCustom = true;`) {
			t.Errorf("%s must report customValuesApplied honestly (wantCustom=true)", tc.name)
		}
	}
}
