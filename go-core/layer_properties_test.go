package main

import (
	"strings"
	"testing"
)

// setLayerOpacityFull (fill_percent on ps_set_layer property=opacity) is a
// go-direct snippet — no TS twin exists, so it isn't covered by
// golden_test.go or the TS-side extendscript.test.ts suite. Phase 2
// (2026-07) write-verification: both fillOpacity (always) and opacity
// (when requested) are independently re-verified with one in-script retry
// and a hard error on persistent mismatch. This pins both branches so a
// refactor can't silently drop the verify/retry/error shape on the one
// property setter with no other automated coverage.
func TestSetLayerOpacityFullFillOnlyVerifiesFillOpacity(t *testing.T) {
	out := setLayerOpacityFull(0, false, 60)

	wants := []string{
		// Independent re-resolution, not the same proxy that wrote.
		`var __identity = __captureLayerIdentity(doc, layer);`,
		`function __quantizeOpacityPercent(percent)`,
		`var __requestedFill = 60;`,
		`var __expectedFill = __quantizeOpacityPercent(__requestedFill);`,
		`layer.fillOpacity = __requestedFill;`,
		`var __freshFill = __resolveLayerFreshOrActive(doc, __identity);`,
		`var __verifiedFill = (__actualFill === __expectedFill);`,
		// Retry once, then hard error on persistent mismatch.
		`if (!__verifiedFill) {`,
		`throw new Error('Layer fillOpacity write did not verify`,
		// No opacity requested: the branch must still declare the three
		// vars the shared return statement references, as a fresh read +
		// nulls (not a write+verify — opacity was never touched).
		`var __actualOpacity = Math.round(layer.opacity * 100) / 100;`,
		`var __requestedOpacity = null;`,
		`var __verifiedOpacity = null;`,
		`requested_fill_opacity: __requestedFill,`,
		`fill_opacity_verified: __verifiedFill,`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("setLayerOpacityFull(fill-only) output missing %q", w)
		}
	}
	// No opacity was requested — must not emit an opacity write/retry/throw.
	notWants := []string{
		`layer.opacity = __requestedOpacity;`,
		`Layer opacity write did not verify`,
	}
	for _, nw := range notWants {
		if strings.Contains(out, nw) {
			t.Errorf("setLayerOpacityFull(fill-only) output unexpectedly contains %q", nw)
		}
	}
}

func TestSetLayerOpacityFullBothVerifiesOpacityAndFillOpacity(t *testing.T) {
	out := setLayerOpacityFull(35, true, 60)

	wants := []string{
		// fillOpacity side (always present).
		`var __requestedFill = 60;`,
		`var __verifiedFill = (__actualFill === __expectedFill);`,
		// opacity side (present because hasOpacity=true), independently
		// re-verified through the same shared identity.
		`var __requestedOpacity = 35;`,
		`var __expectedOpacity = __quantizeOpacityPercent(__requestedOpacity);`,
		`layer.opacity = __requestedOpacity;`,
		`var __freshOp = __resolveLayerFreshOrActive(doc, __identity);`,
		`var __verifiedOpacity = (__actualOpacity === __expectedOpacity);`,
		`if (!__verifiedOpacity) {`,
		`throw new Error('Layer opacity write did not verify`,
		`requested_opacity: __requestedOpacity,`,
		`opacity_verified: __verifiedOpacity,`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("setLayerOpacityFull(both) output missing %q", w)
		}
	}
	// Exactly one retry gate + one error gate per property (2 each = 4 total).
	if got := strings.Count(out, `if (!__verifiedFill) {`); got != 2 {
		t.Errorf("expected 2 occurrences of the fillOpacity verify-gate, got %d", got)
	}
	if got := strings.Count(out, `if (!__verifiedOpacity) {`); got != 2 {
		t.Errorf("expected 2 occurrences of the opacity verify-gate, got %d", got)
	}
}

// Confirmed live: setting opacity on a Background
// layer makes Photoshop auto-promote it (renamed "Layer 0",
// isBackgroundLayer flips false) as a SIDE EFFECT of the write, which can
// change the layer's id/index-path between the pre-write identity capture
// and the post-write re-resolve — so a plain __resolveLayerFresh comes up
// empty even though the write genuinely landed, and the setter hard-errors
// a successful operation. __resolveLayerFreshOrActive fixes this by falling
// back to doc.activeLayer (which Photoshop keeps pointed at the promoted
// layer) when identity resolution yields nothing. This is a Go-only
// fragment (setLayerOpacityFull has no TS twin), so it needs its own
// coverage of the fallback wiring beyond the golden-pinned setters.
func TestSetLayerOpacityFullUsesFreshOrActiveFallback(t *testing.T) {
	out := setLayerOpacityFull(35, true, 60)

	// Both the fillOpacity branch (always present) and the opacity branch
	// (hasOpacity=true) must re-resolve through the fallback-aware helper,
	// never the bare __resolveLayerFresh.
	if strings.Contains(out, `= __resolveLayerFresh(doc, __identity)`) {
		t.Error("setLayerOpacityFull must not call the bare __resolveLayerFresh — use __resolveLayerFreshOrActive so an identity change (e.g. Background promotion) doesn't hard-error a landed write")
	}
	wants := []string{
		`var __freshFill = __resolveLayerFreshOrActive(doc, __identity);`,
		`var __freshOp = __resolveLayerFreshOrActive(doc, __identity);`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("setLayerOpacityFull output missing %q", w)
		}
	}
}

// The shared LayerResolve helper bundle (interpolated into every
// ps_set_layer setter) must define __resolveLayerFreshOrActive as a
// fall-back-to-doc.activeLayer wrapper around __resolveLayerFresh, not a
// replacement for it — the plain re-resolve is still tried first.
func TestLayerResolveHelpersDefineFreshOrActiveFallback(t *testing.T) {
	out := layerResolveHelpers()
	wants := []string{
		`function __resolveLayerFreshOrActive(doc, identity) {`,
		`var resolved = __resolveLayerFresh(doc, identity);`,
		`if (resolved) return resolved;`,
		`return __safeGet(function () { return doc.activeLayer; }, null);`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("layerResolveHelpers() output missing %q", w)
		}
	}
}

// F5 (2026-07 QA review) — setLayerVisibility's own-flag verification read
// (__readOwnVisible, an Action Manager call) must degrade to `verified:
// false` rather than let an exception escape as a hard error when identity
// resolved to SOME layer but the own-flag read itself failed (getContextInfo
// already guards the identical read the same way). A genuine value mismatch
// on a layer that DID resolve must still hard-error — only the unreadable
// case degrades.
func TestSetLayerVisibilityDegradesOnUnreadableVerification(t *testing.T) {
	out := setLayerVisibility(true)

	wants := []string{
		`function __safeReadOwnVisible(layerId) {`,
		`try { return __readOwnVisible(layerId); }`,
		`catch (eRead) { return undefined; }`,
		// The compare + retry now read through the safe wrapper, not the
		// throwing function directly.
		`var __actual = __fresh ? __safeReadOwnVisible(__fresh.id) : undefined;`,
		// Degrade-to-unverified branch: resolved a layer, but the read
		// failed (== undefined) — return unverified, don't throw.
		`if (!__verified && __fresh && __actual === undefined) {`,
		`verified: false,`,
		`verification_unreadable: true,`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("setLayerVisibility output missing %q", w)
		}
	}
}

// F7 (2026-07 QA review) — confirmed live: a non-ASCII layer name (e.g.
// containing accented letters or a middle dot) round-trips lossily through
// Photoshop's ExtendScript layer naming. The verification correctly detects
// the mismatch and still throws (the rename really did not do what was
// asked), but the error must name the non-ASCII cause explicitly instead of
// leaving the caller to guess from a generic "did not verify" message.
func TestRenameLayerExplainsNonAsciiMismatch(t *testing.T) {
	out := renameLayer(`Café · test`)

	wants := []string{
		`/[^\x00-\x7F]/.test(__requested)`,
		`non-ASCII characters`,
		`'Layer rename did not verify: requested '`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("renameLayer output missing %q", w)
		}
	}
	// Single throw expression (not split across intermediate statements) so
	// the base did-not-verify message is always thrown, with the non-ASCII
	// explanation appended conditionally — never replacing it.
	if !strings.Contains(out, `if (!__verified) {`) {
		t.Error("renameLayer must still hard-error on persistent mismatch")
	}
}
