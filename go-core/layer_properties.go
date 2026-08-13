package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// layer-properties family (Phase 1: trivial single-assignment setters).
// selectLayer / rasterizeLayer (need getContextInfo + normNameHelper) and
// addLayerStyle (AM descriptors) are deferred to the AM-snippet pass.

// setLayerOpacity — Phase 2 (2026-07): the write is verified by re-resolving
// the layer through layerResolveHelpers() (a path independent of the proxy
// that wrote), with one in-script retry and a hard error on persistent
// mismatch. See vault.SetOpacity.
func setLayerOpacity(opacity float64) string {
	o := jsNum(opacity)
	return fmt.Sprintf(tpl[vault.SetOpacity], getMinimalContextInfo(), layerResolveHelpers(), o)
}

// setLayerOpacityFull — sets fillOpacity (the "Fill" slider) and optionally
// opacity in one call. Parallel to setLayerOpacity so the golden path is
// untouched (no TS twin exists for this snippet). Phase 2 (2026-07): both
// fillOpacity (always) and opacity (when present) are independently
// re-verified with a retry + hard error on persistent mismatch — see
// vault.SetFillOp. The no-opacity branch still declares
// __actualOpacity/__requestedOpacity/__verifiedOpacity (as a fresh read +
// nulls) so the fragment's single return statement can reference them
// uniformly regardless of which branch ran.
func setLayerOpacityFull(opacity float64, hasOpacity bool, fillOpacity float64) string {
	opacityBlock := `
    var __actualOpacity = Math.round(layer.opacity * 100) / 100;
    var __requestedOpacity = null;
    var __verifiedOpacity = null;`
	if hasOpacity {
		opacityBlock = fmt.Sprintf(`
    var __requestedOpacity = %s;
    var __expectedOpacity = __quantizeOpacityPercent(__requestedOpacity);
    layer.opacity = __requestedOpacity;
    var __freshOp = __resolveLayerFreshOrActive(doc, __identity);
    var __actualOpacity = __freshOp ? Math.round(__freshOp.opacity * 100) / 100 : undefined;
    var __verifiedOpacity = (__actualOpacity === __expectedOpacity);
    if (!__verifiedOpacity) {
      layer.opacity = __requestedOpacity;
      __freshOp = __resolveLayerFreshOrActive(doc, __identity);
      __actualOpacity = __freshOp ? Math.round(__freshOp.opacity * 100) / 100 : undefined;
      __verifiedOpacity = (__actualOpacity === __expectedOpacity);
    }
    if (!__verifiedOpacity) {
      throw new Error('Layer opacity write did not verify: requested ' + __requestedOpacity + ' (expected readback ' + __expectedOpacity + '), actual ' + __actualOpacity + ' (after 1 retry)');
    }`, jsNum(opacity))
	}
	return fmt.Sprintf(
		tpl[vault.SetFillOp],
		getMinimalContextInfo(), layerResolveHelpers(), opacityBlock, jsNum(fillOpacity),
	)
}

// layerBlendModeSet is the closed allowlist of legal ExtendScript `BlendMode`
// enum member names — the value interpolates raw into `BlendMode.<NAME>`, so it
// MUST be validated here (Go-side) before reaching the `%s` slot rather than
// relying on the TS validator upstream. Mirrors LAYER_BLEND_MODES in
// src/utils/blend-modes.ts (note "Color" is COLORBLEND, not COLOR).
var layerBlendModeSet = map[string]bool{
	"NORMAL": true, "DISSOLVE": true, "DARKEN": true, "MULTIPLY": true,
	"COLORBURN": true, "LINEARBURN": true, "DARKERCOLOR": true, "LIGHTEN": true,
	"SCREEN": true, "COLORDODGE": true, "LINEARDODGE": true, "LIGHTERCOLOR": true,
	"OVERLAY": true, "SOFTLIGHT": true, "HARDLIGHT": true, "VIVIDLIGHT": true,
	"LINEARLIGHT": true, "PINLIGHT": true, "HARDMIX": true, "DIFFERENCE": true,
	"EXCLUSION": true, "SUBTRACT": true, "DIVIDE": true, "HUE": true,
	"SATURATION": true, "COLORBLEND": true, "LUMINOSITY": true,
}

// setLayerBlendMode — Phase 2 (2026-07): independent re-resolve + retry +
// hard error on persistent mismatch, same pattern as setLayerVisibility.
func setLayerBlendMode(blendMode string) (string, error) {
	// blendMode interpolates raw into `BlendMode.<NAME>` (a JS identifier, not a
	// string literal), so it can't be jsLit-escaped — validate against the
	// closed enum set instead, rejecting anything else before the %s slot.
	if !layerBlendModeSet[blendMode] {
		return "", fmt.Errorf("invalid blend mode: %q", blendMode)
	}
	return fmt.Sprintf(tpl[vault.SetBlend], getMinimalContextInfo(), layerResolveHelpers(), blendMode), nil
}

// setLayerVisibility — Phase 2 (2026-07): the write is verified by
// re-resolving the layer through layerResolveHelpers() (a path independent
// of the proxy that wrote — re-reading doc.activeLayer again proved
// nothing), with one in-script retry and a hard error on persistent
// mismatch. This is the fragment the silent-hide incident traced back to.
func setLayerVisibility(visible bool) string {
	return fmt.Sprintf(tpl[vault.SetVis], getMinimalContextInfo(), layerResolveHelpers(), jsBool(visible))
}

// setLayerLocked — Phase 2 (2026-07): same independent-verify + retry +
// hard-error pattern as setLayerVisibility.
func setLayerLocked(locked bool) string {
	return fmt.Sprintf(tpl[vault.SetLock], getMinimalContextInfo(), layerResolveHelpers(), jsBool(locked))
}

// renameLayer — Phase 2 (2026-07): same independent-verify + retry +
// hard-error pattern. Identity is captured via layer.id / index-path BEFORE
// the rename, since matching by name after the write would be circular.
func renameLayer(newName string) string {
	return fmt.Sprintf(tpl[vault.Rename], getMinimalContextInfo(), layerResolveHelpers(), jsLit(newName))
}

// selectLayer — find a layer by normalized name (recurses into groups) and
// make it active. Changes WHAT is active, so it returns full getContextInfo().
func selectLayer(name string) string {
	n := jsLit(name)
	return fmt.Sprintf(
		tpl[vault.SelectLayer],
		normNameHelper(),
		getContextInfo(),
		notFoundMessageHelper(),
		n, n,
	)
}

func rasterizeLayer() string {
	return fmt.Sprintf(tpl[vault.RasterizeLayer], getContextInfo())
}

// addLayerStyle — drop_shadow / stroke / outer_glow via setd Lefx. The
// emitter resolves strokePosEnum (the registry resolves the numeric defaults)
// and threads styleType/color/opacity through the descriptor's 27 slots.
func addLayerStyle(styleType string, cr, cg, cb, opacity, angle, distance, spread, size, strokeSize float64, strokePos string, glowSize, glowSpread float64) string {
	st := jsLit(styleType)
	crS, cgS, cbS := jsNum(cr), jsNum(cg), jsNum(cb)
	op := jsNum(opacity)
	// The later layer-style additions route to a SEPARATE fragment so the
	// migration golden for the original drop_shadow/stroke/outer_glow stays
	// frozen (golden_test.go).
	if styleType == "inner_shadow" || styleType == "inner_glow" || styleType == "color_overlay" {
		return fmt.Sprintf(
			tpl[vault.AddLayerStyle2],
			helperFunctions(), getContextInfo(),
			st, crS, cgS, cbS, op, // inner_shadow color + opacity
			jsNum(angle), jsNum(distance), jsNum(spread), jsNum(size),
			st, crS, cgS, cbS, op, // inner_glow color + opacity
			jsNum(glowSpread), jsNum(glowSize),
			st, crS, cgS, cbS, op, // color_overlay color + opacity
			st, // else (unknown)
			st, // result
		)
	}
	strokePosEnum := "OutF"
	if strokePos == "inside" {
		strokePosEnum = "InsF"
	} else if strokePos == "center" {
		strokePosEnum = "CtrF"
	}
	return fmt.Sprintf(
		tpl[vault.AddLayerStyle],
		helperFunctions(), getContextInfo(),
		st,                // drop_shadow if
		crS, cgS, cbS, op, // ds color + opacity
		jsNum(angle), jsNum(distance), jsNum(spread), jsNum(size),
		st, // stroke elif
		jsLit(strokePosEnum), op, jsNum(strokeSize), crS, cgS, cbS,
		st,                // outer_glow elif
		crS, cgS, cbS, op, // og color + opacity
		jsNum(glowSpread), jsNum(glowSize),
		st, // else (unknown)
		st, // result
	)
}
