package main

import (
	"errors"
	"fmt"

	"editmamei-core/internal/vault"
)

// errShortBlob is returned when the embedded template blob is too small to
// contain even a GCM nonce (corrupt build).
var errShortBlob = errors.New("template blob shorter than nonce size")

// Emitter helpers — the Go port of the shared _helpers.ts fragments. The JSX
// TEXT lives encrypted in templates.enc (decrypted into tpl at startup); these
// functions only assemble it, so no JSX appears as a literal in this package's
// compiled output.

// getMinimalContextInfo returns the slim-context helper function body.
func getMinimalContextInfo() string {
	return tpl[vault.MinCtx]
}

// getContextInfo returns the full-context helper function body, interpolated
// by snippets that change WHAT is active or WHAT exists. Prepended with the
// Phase 4 recursive layer counter (same pattern as restoreCompositeChannel +
// getSelectionInfo) so __countLayersRecursive is in scope wherever
// getContextInfo is — including getMetadata's result.document block.
func getContextInfo() string {
	return layerCountRecursiveHelper() + tpl[vault.Ctx]
}

// layerCountRecursiveHelper returns the __countLayersRecursive helper — a
// genuine recursive layer count (doc.layers.length is top-level only). See
// vault.LayerCountRecursive.
func layerCountRecursiveHelper() string {
	return tpl[vault.LayerCountRecursive]
}

// restoreCompositeChannel returns the composite-channel restoration helper.
func restoreCompositeChannel() string {
	return tpl[vault.RCC]
}

// getSelectionInfo returns the rich selection-info helper. The TS source
// defines it as `${restoreCompositeChannel}\nfunction getSelectionInfo(){…}`,
// so we prepend the RCC body to match the emitted text (whitespace between
// the two function defs is insignificant under the golden normalizer).
func getSelectionInfo() string {
	return restoreCompositeChannel() + tpl[vault.GSI]
}

// selectionTypeHelpers returns the map/has/save/combine selection helpers.
func selectionTypeHelpers() string {
	return tpl[vault.SelType]
}

// getPathInfo returns the path-inventory helper — the path analog of
// getSelectionInfo. Interpolated by the path-interchange snippets so the LLM can
// verify a path actually landed (count + per-path kind/subpath/anchor counts;
// the subpath count surfaces occlusion fragmentation a single silhouette may
// not show).
func getPathInfo() string {
	return tpl[vault.GPI]
}

// helperFunctions returns the cTID/sTID convenience wrappers — required by
// every snippet that calls cTID(...)/sTID(...).
func helperFunctions() string {
	return tpl[vault.HelperFns]
}

// bitsPerChannelHelper returns the BitsPerChannelType→int coercion helper.
func bitsPerChannelHelper() string {
	return tpl[vault.BitsPerCh]
}

// normNameHelper returns the dash/whitespace/case layer-name normalizer —
// required by every snippet that looks up a layer/group by name.
func normNameHelper() string {
	return tpl[vault.NormName]
}

// notFoundMessageHelper returns __notFoundMessage — the name-miss error builder
// that appends the available names, so a failed lookup tells the caller what to
// ask for next instead of only what was wrong. Required by every snippet that
// throws on a layer/group name miss.
func notFoundMessageHelper() string {
	return tpl[vault.NotFound]
}

// layerResolveHelpers returns the independent layer re-resolution helpers
// (captureLayerIdentity/resolveLayerFresh) — required by every ps_set_layer
// property setter so a write can be verified through a resolution path
// distinct from the proxy that performed the write. See vault.LayerResolve.
func layerResolveHelpers() string {
	return tpl[vault.LayerResolve]
}

// parentPathHelper returns the Phase 4 __parentPathOf helper — reports the
// containing-group name chain for a layer (or [] at the document root).
// Required by every layer-creation snippet's result payload.
func parentPathHelper() string {
	return tpl[vault.ParentPath]
}

// hoistFromActiveGroupHelper returns the Phase 4 __hoistFromActiveGroupIfNeeded
// helper — moves a just-created layer back out of the group that was active
// before the Mk call, unless into_active_group opted into the native nesting.
// Required by the AM Mk-based creators (createGroup, addFillLayer,
// layerViaCopy, createShape, addAdjustmentLayer).
func hoistFromActiveGroupHelper() string {
	return tpl[vault.HoistGroup]
}

// duplicateForOp returns the auto-duplicate-first fragment, or the
// apply-to-active branch when applyToActiveLayer is true.
func duplicateForOp(opName string, applyToActiveLayer bool) string {
	if applyToActiveLayer {
		return tpl[vault.DupActive]
	}
	return fmt.Sprintf(tpl[vault.DupCopy], jsLit(opName))
}
