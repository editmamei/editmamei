package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// retouch family — content-aware fill / patch / content-aware move. Community-
// tier (previously Pro, in retouch_pro.go).
// Ported verbatim from src/api/extendscript/filters.ts. All three prepend the shared
// getMinimalContextInfo + helperFunctions (cTID/sTID) and the duplicateForOp
// auto-duplicate fragment, then emit their AM descriptor.

func applyContentAwareFill(colorAdaptation, rotate, scale, mirror bool, opacity float64, blendMode string, applyToActiveLayer bool) string {
	ca, ro, sc, mi := jsBool(colorAdaptation), jsBool(rotate), jsBool(scale), jsBool(mirror)
	op := jsNum(opacity)
	// slots: ctx, helperFns, duplicateForOp, jsLit(blendMode),
	//        descriptor[ca,ro,sc,mi,op], result[ca,ro,sc,mi,op]
	return fmt.Sprintf(
		tpl[vault.RtCAF],
		getMinimalContextInfo(),
		helperFunctions(),
		duplicateForOp("Content-Aware Fill", applyToActiveLayer),
		jsLit(blendMode),
		ca, ro, sc, mi, op,
		ca, ro, sc, mi, op,
	)
}

func applyPatch(offsetX, offsetY, patchStructure, patchColor, healSmoothFactor float64, sampleAllLayers, transparent, useSource, applyToActiveLayer bool) string {
	ox, oy := jsNum(offsetX), jsNum(offsetY)
	ps, pc, hs := jsNum(patchStructure), jsNum(patchColor), jsNum(healSmoothFactor)
	sal, tr, us := jsBool(sampleAllLayers), jsBool(transparent), jsBool(useSource)
	// slots: ctx, helperFns, duplicateForOp,
	//        descriptor[ox,oy,tr,sal,ps,pc,hs,us], result[ox,oy,ps,pc,hs,sal,tr,us]
	return fmt.Sprintf(
		tpl[vault.RtPatch],
		getMinimalContextInfo(),
		helperFunctions(),
		duplicateForOp("Patch", applyToActiveLayer),
		ox, oy, tr, sal, ps, pc, hs, us,
		ox, oy, ps, pc, hs, sal, tr, us,
	)
}

func applyContentAwareMove(offsetX, offsetY, patchStructure, patchColor, healSmoothFactor float64, sampleAllLayers, transparent, reshuffle, applyToActiveLayer bool) string {
	ox, oy := jsNum(offsetX), jsNum(offsetY)
	ps, pc, hs := jsNum(patchStructure), jsNum(patchColor), jsNum(healSmoothFactor)
	sal, tr, rs := jsBool(sampleAllLayers), jsBool(transparent), jsBool(reshuffle)
	// slots: ctx, helperFns, duplicateForOp,
	//        descriptor[ox,oy,tr,rs,sal,ps,pc,hs], result[ox,oy,ps,pc,hs,sal,tr,rs]
	return fmt.Sprintf(
		tpl[vault.RtCAM],
		getMinimalContextInfo(),
		helperFunctions(),
		duplicateForOp("Content-Aware Move", applyToActiveLayer),
		ox, oy, tr, rs, sal, ps, pc, hs,
		ox, oy, ps, pc, hs, sal, tr, rs,
	)
}
