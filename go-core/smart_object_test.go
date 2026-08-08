package main

import (
	"regexp"
	"strings"
	"testing"

	"editmamei-core/internal/vault"
)

// Smart-filter family (m4a STEP-03/04/05/07 + a live structural probe on PS
// 27.2.0, 2026-08-08). Body assertions go through build(name, params) — the
// artifact that actually ships, registry bridge included. Unit tests string-match
// only; live verification against real Photoshop is the semantic check.
//
// These named-key pins exist for the same reason the gradient ones do: golden.json
// regenerates mechanically, so a descriptor break plus a routine regen passes
// golden silently. A wrong key here is a silent no-op inside Photoshop.

// Every write addresses the filter as a 1-based filterFX INDEX reference on the
// target layer. Getting this reference wrong doesn't fail — it hits the wrong
// filter, or throws PS's unusable generic error.
const filterFXIndexRef = `r.putIndex(stringIDToTypeID('filterFX'), index);`

func TestListSmartFiltersReadsThroughSmartObjectCompound(t *testing.T) {
	out, err := build("listSmartFilters", map[string]any{})
	if err != nil {
		t.Fatalf("listSmartFilters: %v", err)
	}
	for _, want := range []string{
		// The read/write asymmetry: filterFX is nested under the layer's
		// smartObject compound on READ, never a top-level layer key. Reading it
		// the way the write path addresses it returns nothing.
		`ld.getObjectValue(soKey)`,
		`so.getList(fxKey)`,
		`stringIDToTypeID('smartObject')`,
		`stringIDToTypeID('filterFX')`,
		// Per-entry keys, measured off a live two-filter stack.
		`stringIDToTypeID('enabled')`,
		`stringIDToTypeID('opacity')`,
		`stringIDToTypeID('mode')`,
		`stringIDToTypeID('filterID')`,
		`e.getClass(fltrKey)`,
		// 1-based indices out, so op=list's numbers are the write ops' numbers.
		`index: i + 1,`,
		// Distinguishes "not a Smart Object" from "Smart Object, empty stack".
		`if (!ld.hasKey(soKey)) return null;`,
		`is_smart_object: filters !== null,`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("listSmartFilters missing %q", want)
		}
	}
}

func TestSetSmartFilterVisibilityDescriptor(t *testing.T) {
	out, err := build("setSmartFilterVisibility", map[string]any{
		"index": float64(2), "enabled": false,
	})
	if err != nil {
		t.Fatalf("setSmartFilterVisibility: %v", err)
	}
	for _, want := range []string{
		`var index = 2;`,
		`var enabled = false;`,
		filterFXIndexRef,
		// Hd /Shw  — note the trailing spaces; charIDs are 4 chars and 'Hd' alone
		// is a different (nonexistent) event.
		`charIDToTypeID(enabled ? 'Shw ' : 'Hd  ')`,
		// Validate before asking Photoshop, so a bad index names the real problem.
		`__sfTarget(index);`,
		// Report Photoshop's state after the write, not the requested state.
		`var after = __sfRead();`,
		`enabled: entry.enabled,`,
		`requested_enabled: enabled,`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("setSmartFilterVisibility missing %q", want)
		}
	}
}

func TestSetSmartFilterBlendDescriptor(t *testing.T) {
	out, err := build("setSmartFilterBlend", map[string]any{
		"index": float64(1), "opacity": float64(70), "blendMode": "SCREEN",
	})
	if err != nil {
		t.Fatalf("setSmartFilterBlend: %v", err)
	}
	// setSmartFilterBlend is allowlisted out of the empty-params slot-arity sweep
	// (it refuses an empty param map by design), so it is arity-checked HERE
	// instead — fully populated, asserting Sprintf emitted no format-verb error.
	if strings.Contains(out, "%!") {
		t.Errorf("slot-arity mismatch in setSmartFilterBlend:\n%s", out)
	}
	for _, want := range []string{
		filterFXIndexRef,
		`executeAction(charIDToTypeID('setd')`,
		// blendOptions nests inside a filterFX wrapper object (STEP-04).
		`bo.putUnitDouble(charIDToTypeID('Opct'), charIDToTypeID('#Prc'), 70);`,
		`bo.putEnumerated(charIDToTypeID('Md  '), charIDToTypeID('BlnM'), stringIDToTypeID(__sfAmMode("SCREEN")));`,
		`fx.putObject(stringIDToTypeID('blendOptions'), stringIDToTypeID('blendOptions'), bo);`,
		`d.putObject(stringIDToTypeID('filterFX'), stringIDToTypeID('filterFX'), fx);`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("setSmartFilterBlend missing %q", want)
		}
	}
}

// A key omitted from blendOptions leaves that property alone in Photoshop, which
// is the whole reason the blocks are conditional: emitting a defaulted opacity
// would silently reset an opacity the caller never mentioned.
func TestSetSmartFilterBlendEmitsOnlySuppliedKeys(t *testing.T) {
	opacityOnly, err := build("setSmartFilterBlend", map[string]any{
		"index": float64(1), "opacity": float64(40),
	})
	if err != nil {
		t.Fatalf("opacity-only: %v", err)
	}
	if !strings.Contains(opacityOnly, `charIDToTypeID('Opct')`) {
		t.Error("opacity-only should emit the Opct key")
	}
	if strings.Contains(opacityOnly, `charIDToTypeID('Md  ')`) {
		t.Error("opacity-only must NOT emit a mode key — it would reset the blend mode")
	}

	modeOnly, err := build("setSmartFilterBlend", map[string]any{
		"index": float64(1), "blendMode": "MULTIPLY",
	})
	if err != nil {
		t.Fatalf("mode-only: %v", err)
	}
	if !strings.Contains(modeOnly, `__sfAmMode("MULTIPLY")`) {
		t.Error("mode-only should emit the mode key")
	}
	if strings.Contains(modeOnly, `charIDToTypeID('Opct')`) {
		t.Error("mode-only must NOT emit an opacity key — it would reset the opacity")
	}
}

func TestSetSmartFilterBlendRejectsBadInput(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]any
		want   string
	}{
		{"neither key", map[string]any{"index": float64(1)}, "at least one of"},
		{
			"unknown mode",
			map[string]any{"index": float64(1), "blendMode": "GLOW"},
			"invalid blend mode",
		},
		{
			"opacity over 100",
			map[string]any{"index": float64(1), "opacity": float64(140)},
			"opacity out of range",
		},
		{
			"negative opacity",
			map[string]any{"index": float64(1), "opacity": float64(-1)},
			"opacity out of range",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := build("setSmartFilterBlend", tc.params)
			if err == nil {
				t.Fatalf("expected an error for %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q should mention %q", err, tc.want)
			}
		})
	}
}

func TestRemoveSmartFilterDescriptor(t *testing.T) {
	out, err := build("removeSmartFilter", map[string]any{"index": float64(3)})
	if err != nil {
		t.Fatalf("removeSmartFilter: %v", err)
	}
	for _, want := range []string{
		`var index = 3;`,
		filterFXIndexRef,
		`executeAction(charIDToTypeID('Dlt ')`,
		// Identity is captured BEFORE the delete; afterwards it is unreadable.
		`var removed = before[index - 1];`,
		`remaining_count:`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("removeSmartFilter missing %q", want)
		}
	}
}

func TestGetSmartObjectInfoDescriptor(t *testing.T) {
	out, err := build("getSmartObjectInfo", map[string]any{})
	if err != nil {
		t.Fatalf("getSmartObjectInfo: %v", err)
	}
	for _, want := range []string{
		`stringIDToTypeID('linked')`,
		`stringIDToTypeID('fileReference')`,
		`stringIDToTypeID('documentID')`,
		`stringIDToTypeID('placed')`,
		`is_smart_object: false,`,
		`smart_filter_count:`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("getSmartObjectInfo missing %q", want)
		}
	}
}

// Every write op must range-check before touching Photoshop. PS answers an
// out-of-range index, a 0 index, and a non-Smart-Object layer with the same
// "General Photoshop error occurred" — measured, all three — so without this the
// caller cannot tell a typo from a wrong layer.
func TestEverySmartFilterWriteValidatesFirst(t *testing.T) {
	for _, snippet := range []string{
		"setSmartFilterVisibility", "setSmartFilterBlend", "removeSmartFilter",
	} {
		params := map[string]any{"index": float64(1), "enabled": true, "opacity": float64(50)}
		out, err := build(snippet, params)
		if err != nil {
			t.Fatalf("%s: %v", snippet, err)
		}
		if !strings.Contains(out, "__sfTarget(") {
			t.Errorf("%s does not call __sfTarget — a bad index would reach Photoshop", snippet)
		}
		for _, want := range []string{
			"is not a Smart Object",
			"has no Smart Filters yet",
			"No Smart Filter at index",
		} {
			if !strings.Contains(out, want) {
				t.Errorf("%s missing the %q guard message", snippet, want)
			}
		}
	}
}

// Derived-list invariant (PR-1). The blend-mode vocabulary now exists in three
// places: LAYER_BLEND_MODES (TS, the surface enum), layerBlendModeSet (Go, the
// validator), and __SF_MODES (the JS DOM-name -> Action-Manager-stringID table).
// This pins the two Go-reachable copies to each other; the TS copy is pinned to
// layerBlendModeSet by tests/integration/blend-mode-parity.test.ts. Adding a mode
// to one and not the others makes it either unvalidatable or untranslatable.
func TestSmartFilterBlendModeTableMatchesValidator(t *testing.T) {
	table := tpl[vault.SFGuard]
	start := strings.Index(table, "var __SF_MODES = {")
	if start < 0 {
		t.Fatal("__SF_MODES table not found in the SFGuard fragment")
	}
	end := strings.Index(table[start:], "};")
	if end < 0 {
		t.Fatal("__SF_MODES table is not terminated")
	}
	body := table[start : start+end]

	entryRe := regexp.MustCompile(`(\w+):\s*'([^']+)'`)
	found := map[string]string{}
	for _, m := range entryRe.FindAllStringSubmatch(body, -1) {
		found[m[1]] = m[2]
	}

	if len(found) != len(layerBlendModeSet) {
		t.Errorf("__SF_MODES has %d entries, layerBlendModeSet has %d",
			len(found), len(layerBlendModeSet))
	}
	for mode := range layerBlendModeSet {
		am, ok := found[mode]
		if !ok {
			t.Errorf("__SF_MODES is missing %q — set_blend would throw on a mode the validator accepts", mode)
			continue
		}
		if am == "" {
			t.Errorf("__SF_MODES maps %q to an empty Action-Manager id", mode)
		}
	}
	for mode := range found {
		if !layerBlendModeSet[mode] {
			t.Errorf("__SF_MODES has %q, which the validator would reject — unreachable entry", mode)
		}
	}
}
