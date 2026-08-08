package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// Smart-filter emitters. Every op addresses one filter on the ACTIVE layer by
// 1-based index — the same numbering op=list reports, so a caller can read an
// index and pass it straight back. See fragments_smartobject.go for the
// read/write asymmetry these are built on.
//
// Range validation deliberately lives in the snippet rather than here: the
// script has already read the filter list, so it can say "valid: 1-3" instead of
// guessing, and Photoshop's own answer to a bad index is an unusable "General
// Photoshop error occurred".

// smartFilterHelpers returns the shared read/validate/reference helpers plus the
// blend-mode table, which every smart-filter fragment needs in scope.
func smartFilterHelpers() string {
	return tpl[vault.SFGuard]
}

func listSmartFilters() string {
	return fmt.Sprintf(tpl[vault.SFList], smartFilterHelpers(), getContextInfo())
}

func setSmartFilterVisibility(index int, enabled bool) string {
	return fmt.Sprintf(
		tpl[vault.SFVis],
		smartFilterHelpers(), getContextInfo(), jsInt(index), jsBool(enabled),
	)
}

// setSmartFilterBlend writes only the blendOptions the caller actually supplied:
// a key left out of the descriptor leaves that property alone, so changing
// opacity cannot silently reset the mode. Verified live that a blendOptions-only
// setd preserves both the filter's own parameters and its siblings, which is why
// no read-modify-write of the filter body is needed here.
func setSmartFilterBlend(
	index int, opacity float64, hasOpacity bool, mode string, hasMode bool,
) (string, error) {
	if !hasOpacity && !hasMode {
		return "", fmt.Errorf("set_blend needs at least one of opacity or blend_mode")
	}

	opacityBlock := ""
	if hasOpacity {
		if opacity < 0 || opacity > 100 {
			return "", fmt.Errorf("opacity out of range: %v (expected 0-100)", opacity)
		}
		opacityBlock = fmt.Sprintf(
			"bo.putUnitDouble(charIDToTypeID('Opct'), charIDToTypeID('#Prc'), %s); __expectOpacity = %s;",
			jsNum(opacity), jsNum(opacity),
		)
	}

	modeBlock := ""
	if hasMode {
		// Validated against the same closed set the layer/group blend-mode setters
		// use, so the three tools accept exactly one vocabulary. The snippet's
		// __sfAmMode maps it to the Action-Manager stringID.
		if !layerBlendModeSet[mode] {
			return "", fmt.Errorf("invalid blend mode: %q", mode)
		}
		modeBlock = fmt.Sprintf(
			"bo.putEnumerated(charIDToTypeID('Md  '), charIDToTypeID('BlnM'), stringIDToTypeID(__sfAmMode(%s))); __expectMode = %s;",
			jsLit(mode), jsLit(mode),
		)
	}

	return fmt.Sprintf(
		tpl[vault.SFBlend],
		smartFilterHelpers(), getContextInfo(), jsInt(index), opacityBlock, modeBlock,
	), nil
}

func removeSmartFilter(index int) string {
	return fmt.Sprintf(tpl[vault.SFDel], smartFilterHelpers(), getContextInfo(), jsInt(index))
}

func getSmartObjectInfo() string {
	return fmt.Sprintf(tpl[vault.SOInfo], smartFilterHelpers(), getContextInfo())
}
