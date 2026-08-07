package main

import (
	"strings"
	"testing"
)

// Gradient family (2026-08 gradient build) — body assertions through
// build(name, params), the artifact that actually ships (registry bridge
// included), plus the emitter error paths. Unit tests string-match only;
// live verification against real PS is the semantic check. The named-key
// assertions below exist because golden.json regens mechanically — a
// descriptor break plus a routine regen passes golden silently; these pins
// don't.

func TestAddGradientFillLayerDefaults(t *testing.T) {
	out, err := build("addGradientFillLayer", map[string]any{})
	if err != nil {
		t.Fatalf("addGradientFillLayer defaults: %v", err)
	}
	for _, want := range []string{
		// Mk + setd two-event shape (capture STEP-13: Angl lives on the setd,
		// never the create-time descriptor).
		`executeAction(charIDToTypeID('Mk  ')`,
		`executeAction(charIDToTypeID('setd')`,
		`putClass(stringIDToTypeID('contentLayer'))`,
		`putObject(charIDToTypeID('Usng'), stringIDToTypeID('contentLayer')`,
		`putEnumerated(stringIDToTypeID('contentLayer'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'))`,
		`putObject(charIDToTypeID('T   '), stringIDToTypeID('gradientLayer')`,
		`if (includeAngle) {`,
		`putUnitDouble(charIDToTypeID('Angl'), charIDToTypeID('#Ang'), __angle)`,
		`var __angle = 90;`,
		// The Grdn gradient-object payload (capture-pinned keys).
		`putObject(charIDToTypeID('Grad'), charIDToTypeID('Grdn'), __buildGradObj())`,
		`putEnumerated(charIDToTypeID('GrdF'), charIDToTypeID('GrdF'), charIDToTypeID('CstS'))`,
		`putDouble(charIDToTypeID('Intr'), 4096)`,
		`putList(charIDToTypeID('Clrs'), colorStops)`,
		`putList(charIDToTypeID('Trns'), opacityStops)`,
		`makeColorStop(0, 50, 0, 0, 0)`,
		`makeColorStop(4096, 50, 255, 255, 255)`,
		`makeOpacityStop(0, 50, 100)`,
		`makeOpacityStop(4096, 50, 100)`,
		// gradientLayer member keys.
		`putBoolean(charIDToTypeID('Dthr'), true)`,
		`stringIDToTypeID('gradientsInterpolationMethod'), stringIDToTypeID('gradientInterpolationMethodType'), charIDToTypeID('Smoo')`,
		`charIDToTypeID('GrdT'), charIDToTypeID("Lnr ")`,
		`putBoolean(charIDToTypeID('Algn'), false)`,
		`charIDToTypeID('Scl '), charIDToTypeID('#Prc'), 100`,
		`putObject(charIDToTypeID('Ofst'), charIDToTypeID('Pnt ')`,
		// Placement + context contract.
		`var __intoActiveGroup = false;`,
		`fill_type: 'gradient'`,
		`__hoistFromActiveGroupIfNeeded`,
		`__parentPathOf`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("addGradientFillLayer defaults missing %q", want)
		}
	}
	if strings.Contains(out, "Rvrs") {
		t.Error("addGradientFillLayer defaults must omit Rvrs (PS omits it at the false default)")
	}
	if strings.Contains(out, "noisePreSeed") {
		t.Error("addGradientFillLayer must not emit noisePreSeed (deliberately omitted — see fragment comment)")
	}
}

func TestAddGradientFillLayerCustom(t *testing.T) {
	out, err := build("addGradientFillLayer", map[string]any{
		"gradient_type": "radial",
		"angle":         0.0,
		"scale":         120.0,
		"reverse":       true,
		"dither":        false,
		"stops": []any{
			// Deliberately unsorted — the emitter must sort by location.
			map[string]any{"red": 255.0, "green": 128.0, "blue": 0.0, "location": 100.0, "midpoint": 60.0},
			map[string]any{"red": 10.0, "green": 20.0, "blue": 200.0, "location": 0.0},
		},
		"opacity_stops": []any{
			map[string]any{"opacity": 100.0, "location": 0.0},
			map[string]any{"opacity": 0.0, "location": 100.0},
		},
	})
	if err != nil {
		t.Fatalf("addGradientFillLayer custom: %v", err)
	}
	for _, want := range []string{
		`charIDToTypeID('GrdT'), charIDToTypeID("Rdl ")`,
		`putBoolean(charIDToTypeID('Rvrs'), true)`,
		`putBoolean(charIDToTypeID('Dthr'), false)`,
		`makeColorStop(0, 50, 10, 20, 200)`,
		`makeColorStop(4096, 60, 255, 128, 0)`,
		`makeOpacityStop(4096, 50, 0)`,
		`charIDToTypeID('Scl '), charIDToTypeID('#Prc'), 120`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("addGradientFillLayer custom missing %q", want)
		}
	}
	// Sorted: the location-0 stop line must precede the location-4096 line.
	if strings.Index(out, "makeColorStop(0, 50, 10, 20, 200)") > strings.Index(out, "makeColorStop(4096, 60, 255, 128, 0)") {
		t.Error("addGradientFillLayer must sort color stops by location")
	}
}

// Offsets are order-sensitive fmt slots — distinct X/Y values pin that a slot
// transposition can't ship silently (QA 2026-08 high finding).
func TestAddGradientFillLayerOffsets(t *testing.T) {
	out, err := build("addGradientFillLayer", map[string]any{
		"offset_x": 12.0,
		"offset_y": -8.0,
	})
	if err != nil {
		t.Fatalf("addGradientFillLayer offsets: %v", err)
	}
	if !strings.Contains(out, `putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Prc'), 12)`) {
		t.Error("offset_x=12 must land on the Hrzn key")
	}
	if !strings.Contains(out, `putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Prc'), -8)`) {
		t.Error("offset_y=-8 must land on the Vrtc key")
	}

	// Go-side clamp mirrors the schema's ±100 bounds.
	clamped, err := build("addGradientFillLayer", map[string]any{"offset_x": 250.0, "offset_y": -300.0})
	if err != nil {
		t.Fatalf("addGradientFillLayer clamped offsets: %v", err)
	}
	if !strings.Contains(clamped, `charIDToTypeID('Hrzn'), charIDToTypeID('#Prc'), 100`) ||
		!strings.Contains(clamped, `charIDToTypeID('Vrtc'), charIDToTypeID('#Prc'), -100`) {
		t.Error("offsets must clamp to ±100")
	}
}

// All five GrdT charIDs pinned — a typo in the unverified angle/reflected/
// diamond entries would otherwise ship undetected.
func TestAddGradientFillLayerTypeCharIDs(t *testing.T) {
	wantByType := map[string]string{
		"linear":    `charIDToTypeID('GrdT'), charIDToTypeID("Lnr ")`,
		"radial":    `charIDToTypeID('GrdT'), charIDToTypeID("Rdl ")`,
		"angle":     `charIDToTypeID('GrdT'), charIDToTypeID("Angl")`,
		"reflected": `charIDToTypeID('GrdT'), charIDToTypeID("Rflc")`,
		"diamond":   `charIDToTypeID('GrdT'), charIDToTypeID("Dmnd")`,
	}
	for gtype, want := range wantByType {
		out, err := build("addGradientFillLayer", map[string]any{"gradient_type": gtype})
		if err != nil {
			t.Fatalf("gradient_type %q: %v", gtype, err)
		}
		if !strings.Contains(out, want) {
			t.Errorf("gradient_type %q missing %q", gtype, want)
		}
	}
}

func TestAddGradientFillLayerErrors(t *testing.T) {
	if _, err := build("addGradientFillLayer", map[string]any{"gradient_type": "conical"}); err == nil {
		t.Error("unknown gradient_type must error")
	}
	if _, err := build("addGradientFillLayer", map[string]any{
		"stops": []any{map[string]any{"red": 0.0, "green": 0.0, "blue": 0.0, "location": 0.0}},
	}); err == nil {
		t.Error("a single color stop must error (a gradient needs two)")
	}
	if _, err := build("addGradientFillLayer", map[string]any{
		"opacity_stops": []any{map[string]any{"opacity": 50.0, "location": 0.0}},
	}); err == nil {
		t.Error("a single opacity stop must error")
	}
	if _, err := build("addGradientFillLayer", map[string]any{"stops": "not-an-array"}); err == nil {
		t.Error("non-array stops must error")
	}
	if _, err := build("addGradientFillLayer", map[string]any{
		"stops": []any{"black", "white"},
	}); err == nil {
		t.Error("non-object stop entries must error, not silently fall back to the default")
	}
	if _, err := build("addGradientFillLayer", map[string]any{
		"stops": []any{
			map[string]any{"red": 0.0, "green": 0.0, "blue": 0.0},
			map[string]any{"red": 255.0, "green": 255.0, "blue": 255.0, "location": 100.0},
		},
	}); err == nil {
		t.Error("a stop missing location must error (schema requires it; go-core enforces it)")
	}
	if _, err := build("addGradientFillLayer", map[string]any{
		"opacity_stops": []any{
			map[string]any{"location": 0.0},
			map[string]any{"opacity": 0.0, "location": 100.0},
		},
	}); err == nil {
		t.Error("an opacity stop missing opacity must error")
	}
}

func TestMaskGradientDefaults(t *testing.T) {
	out, err := build("maskGradient", map[string]any{})
	if err != nil {
		t.Fatalf("maskGradient defaults: %v", err)
	}
	for _, want := range []string{
		// hasUserMask probe + the macOS-strict-verified mask-ensure descriptor
		// (must stay stringID-verbatim per the createLayerMask capture — a
		// refactor to charIDs would pass every other test and break Mac).
		`sTID('hasUserMask')`,
		`putClass(sTID('new'), sTID('channel'))`,
		`putReference(sTID('at'), atRef)`,
		`putEnumerated(sTID('using'), sTID('userMaskEnabled'), sTID('revealAll'))`,
		`executeAction(sTID('make')`,
		// Mask-channel targeting + restore.
		`cTID('Chnl'), cTID('Chnl'), cTID('Msk ')`,
		`restoreCompositeChannel(doc);`,
		// The classic Grdn draw wrapper — unverified-lore keys pinned so a
		// refactor can't silently reshape them.
		`executeAction(cTID('Grdn')`,
		`putObject(cTID('From'), cTID('Pnt ')`,
		`putObject(cTID('T   '), cTID('Pnt ')`,
		`cTID('Type'), cTID('GrdT'), cTID('Lnr ')`,
		`putBoolean(cTID('UsMs'), false)`,
		`putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'))`,
		`putUnitDouble(cTID('Opct'), cTID('#Prc'), 100)`,
		`putObject(cTID('Grad'), cTID('Grdn'), grdDesc)`,
		`cTID('#Pxl')`,
		// Params + payload.
		`var __fadeTo = "bottom";`,
		`var __start = 0;`,
		`var __end = 1;`,
		`var __extent = "layer";`,
		`makeColorStop(0, 50, __g0, __g0, __g0)`,
		`var __g0 = 255;`,
		`var __g1 = 0;`,
		`Cannot add a mask gradient to the background layer`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("maskGradient defaults missing %q", want)
		}
	}
}

func TestMaskGradientErrors(t *testing.T) {
	if _, err := build("maskGradient", map[string]any{"fade_to": "diagonal"}); err == nil {
		t.Error("unknown fade_to must error")
	}
	if _, err := build("maskGradient", map[string]any{"extent": "selection"}); err == nil {
		t.Error("unknown extent must error")
	}
	if _, err := build("maskGradient", map[string]any{"start": 0.8, "end": 0.3}); err == nil {
		t.Error("end <= start must error")
	}
	if _, err := build("maskGradient", map[string]any{"start": 0.5, "end": 0.5}); err == nil {
		t.Error("end == start must error")
	}
}

// All four fade_to directions emit their branch (the math itself is live-
// verified; this pins that each direction reaches the script).
func TestMaskGradientDirections(t *testing.T) {
	for _, dir := range []string{"bottom", "top", "left", "right"} {
		out, err := build("maskGradient", map[string]any{"fade_to": dir})
		if err != nil {
			t.Fatalf("fade_to %q: %v", dir, err)
		}
		if !strings.Contains(out, `var __fadeTo = "`+dir+`";`) {
			t.Errorf("fade_to %q not interpolated", dir)
		}
	}
}

// The shared stop-line builders (gr1/gr2) emit call sites into THREE
// independently-maintained fragments that each define the helper functions.
// Pin the signature in all three so a param reorder in one fragment can't
// silently mis-map values (QA 2026-08 med finding).
func TestMakeColorStopSignatureParity(t *testing.T) {
	const colorSig = "function makeColorStop(loc, midpoint, r, g, b)"
	const opacitySig = "function makeOpacityStop(loc, midpoint, opacity)"

	fill, err := build("addGradientFillLayer", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	mask, err := build("maskGradient", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	gm, err := build("addAdjustmentLayer", map[string]any{
		"type": "gradient_map",
		"gm_stops": []any{
			map[string]any{"red": 0.0, "green": 0.0, "blue": 0.0, "location": 0.0},
			map[string]any{"red": 255.0, "green": 255.0, "blue": 255.0, "location": 100.0},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, out := range map[string]string{"addGradientFillLayer": fill, "maskGradient": mask, "gradient_map": gm} {
		if !strings.Contains(out, colorSig) {
			t.Errorf("%s: makeColorStop signature drifted from %q", name, colorSig)
		}
		if !strings.Contains(out, opacitySig) {
			t.Errorf("%s: makeOpacityStop signature drifted from %q", name, opacitySig)
		}
	}
}

func TestGradientMapCustomStops(t *testing.T) {
	out, err := build("addAdjustmentLayer", map[string]any{
		"type": "gradient_map",
		"gm_stops": []any{
			map[string]any{"red": 20.0, "green": 40.0, "blue": 120.0, "location": 0.0},
			map[string]any{"red": 250.0, "green": 150.0, "blue": 50.0, "location": 100.0},
		},
	})
	if err != nil {
		t.Fatalf("gradient_map gm_stops: %v", err)
	}
	for _, want := range []string{
		`makeColorStop(0, 50, 20, 40, 120)`,
		`makeColorStop(4096, 50, 250, 150, 50)`,
		`editmamei_custom`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("gradient_map gm_stops missing %q", want)
		}
	}

	// Preset path unchanged when gm_stops is absent.
	outPreset, err := build("addAdjustmentLayer", map[string]any{"type": "gradient_map"})
	if err != nil {
		t.Fatalf("gradient_map preset: %v", err)
	}
	if !strings.Contains(outPreset, "editmamei_black_to_white") {
		t.Error("gradient_map without gm_stops must keep the preset name")
	}
	if strings.Contains(outPreset, "editmamei_custom") {
		t.Error("gradient_map without gm_stops must not use the custom name")
	}

	// gm_stops WINS over an explicit preset (the precedence branch users hit).
	outBoth, err := build("addAdjustmentLayer", map[string]any{
		"type":      "gradient_map",
		"gm_preset": "sepia",
		"gm_stops": []any{
			map[string]any{"red": 20.0, "green": 40.0, "blue": 120.0, "location": 0.0},
			map[string]any{"red": 250.0, "green": 150.0, "blue": 50.0, "location": 100.0},
		},
	})
	if err != nil {
		t.Fatalf("gradient_map gm_stops+preset: %v", err)
	}
	if !strings.Contains(outBoth, "editmamei_custom") || !strings.Contains(outBoth, "makeColorStop(0, 50, 20, 40, 120)") {
		t.Error("gm_stops must override gm_preset")
	}
	if strings.Contains(outBoth, "makeColorStop(0, 50, 51, 25, 0)") {
		t.Error("gm_stops+preset must not emit the sepia preset stops")
	}

	// A single custom stop errors; a non-array errors; a non-object entry
	// errors (must never silently ship the default under the custom name).
	if _, err := build("addAdjustmentLayer", map[string]any{
		"type":     "gradient_map",
		"gm_stops": []any{map[string]any{"red": 0.0, "green": 0.0, "blue": 0.0, "location": 0.0}},
	}); err == nil {
		t.Error("gradient_map with one gm_stop must error")
	}
	if _, err := build("addAdjustmentLayer", map[string]any{
		"type":     "gradient_map",
		"gm_stops": "black-to-white",
	}); err == nil {
		t.Error("gradient_map with non-array gm_stops must error")
	}
	if _, err := build("addAdjustmentLayer", map[string]any{
		"type":     "gradient_map",
		"gm_stops": []any{"black", "white"},
	}); err == nil {
		t.Error("gradient_map with non-object gm_stops entries must error")
	}
}
