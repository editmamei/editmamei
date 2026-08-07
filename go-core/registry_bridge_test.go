package main

import (
	"strings"
	"testing"
)

// The TS->Go parameter-name bridge (registry.go's
// build(name, params)) was untested: every other test in this package calls
// the emitter functions (createGroup(...), probeOpenDocument(...), etc.)
// directly, and FakeSnippetClient (the TS-side test double) records only
// {name, params} without ever invoking the Go binary. Nothing exercised
// build()'s own params-map lookups — e.g. boolParam(params,
// "into_active_group", false) or strParam(params, "filePath", "") — so a
// typo on either side of that bridge (the map key registry.go reads vs. the
// key the TS handler writes) would silently degrade every affected tool to
// its default with every existing test green. These tests go through
// build(name, params) itself, not the emitters, for exactly the fields that
// bridge crosses: the five AM creators' into_active_group and
// probeOpenDocument's filePath.

func TestRegistryBuildBridgesIntoActiveGroup(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]any
	}{
		{"createGroup", map[string]any{"name": "edits"}},
		{"addFillLayer", map[string]any{"red": 255.0, "green": 0.0, "blue": 0.0}},
		{"addGradientFillLayer", map[string]any{}},
		{"layerViaCopy", map[string]any{}},
		{"createShape", map[string]any{"shapeType": "rectangle"}},
		{"addAdjustmentLayer", map[string]any{"type": "invert"}},
	}

	for _, c := range cases {
		// Default (into_active_group omitted) — registry.go's boolParam
		// default is false.
		outDefault, err := build(c.name, c.params)
		if err != nil {
			t.Fatalf("%s (default): %v", c.name, err)
		}
		if !strings.Contains(outDefault, `var __intoActiveGroup = false;`) {
			t.Errorf("%s via build(): omitting into_active_group must default to false, got:\n%s", c.name, outDefault)
		}

		// into_active_group:true passed through the registry's params map —
		// exercises boolParam(params, "into_active_group", false) reading the
		// EXACT key the TS handlers write (see e.g.
		// src/tools/group-tools.ts's createGroup snippet call).
		paramsTrue := map[string]any{}
		for k, v := range c.params {
			paramsTrue[k] = v
		}
		paramsTrue["into_active_group"] = true
		outTrue, err := build(c.name, paramsTrue)
		if err != nil {
			t.Fatalf("%s (into_active_group=true): %v", c.name, err)
		}
		if !strings.Contains(outTrue, `var __intoActiveGroup = true;`) {
			t.Errorf("%s via build(): into_active_group:true must reach the emitted script, got:\n%s", c.name, outTrue)
		}

		// The whole point: build()'s output must actually DIFFER between the
		// two calls. If the params-map key were mistyped on either side of
		// the bridge, both calls would silently produce the SAME (default)
		// output and this would catch it where a direct-emitter test can't.
		if outDefault == outTrue {
			t.Errorf("%s via build(): into_active_group:true produced IDENTICAL output to the default — the params bridge is not wiring the flag through", c.name)
		}
	}
}

func TestRegistryBuildBridgesProbeOpenDocumentFilePath(t *testing.T) {
	outDefault, err := build("probeOpenDocument", map[string]any{})
	if err != nil {
		t.Fatalf("probeOpenDocument (default): %v", err)
	}
	// strParam(params, "filePath", "") default is the empty string, jsLit-escaped.
	if !strings.Contains(outDefault, `__mcpNormPath("")`) {
		t.Errorf("probeOpenDocument via build(): omitting filePath must default to \"\", got:\n%s", outDefault)
	}

	const path = "E:/iCloudDrive/PhotosInbox/Owasco-26/IMG_9265.DNG"
	outWithPath, err := build("probeOpenDocument", map[string]any{"filePath": path})
	if err != nil {
		t.Fatalf("probeOpenDocument (filePath set): %v", err)
	}
	if !strings.Contains(outWithPath, path) {
		t.Errorf("probeOpenDocument via build(): the passed filePath must reach the emitted script, got:\n%s", outWithPath)
	}
	if outDefault == outWithPath {
		t.Error("probeOpenDocument via build(): passing filePath produced IDENTICAL output to the default — the params bridge is not wiring filePath through")
	}
}
