package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// Vector-mask family (§2.4 of the roadmap; the path consumer that turns a real
// editable path into a layer's vector mask).
//
// Photoshop exposes NO DOM API for vector masks — they are AM-only, authored
// from the canonical "make vector mask" idiom. The 2026-06-24 live-smoke against
// PS 27.2.0 VERIFIED add (from_current_path) / delete / link / unlink; the
// reveal_all / hide_all empty-mask add variants were then pinned by the m4a
// STEP-23/24 ScriptListener capture and shipped (2026-06-29). enable / disable
// (vectorMaskEnabled) were pinned by m4a STEP-28. The tool is community tier.

// vmFillMap maps the empty-mask sources to their PS charID (m4a STEP-23/24).
var vmFillMap = map[string]string{"reveal_all": "RvlA", "hide_all": "HdAl"}

// addVectorMask — AM "make path At=vectorMask Usng=<...>". from_current_path
// seeds the mask from the active path (Usng=path reference); reveal_all/hide_all
// make an empty reveal/hide mask (Usng=enum vectorMaskEnabled RvlA/HdAl, no path
// needed) via the VMFill fragment. The registry validates the source.
func addVectorMask(source string) string {
	if fill, ok := vmFillMap[source]; ok {
		return fmt.Sprintf(tpl[vault.VMFill], getMinimalContextInfo(), jsLit(source), fill)
	}
	return fmt.Sprintf(tpl[vault.VMAdd], getMinimalContextInfo(), jsLit(source))
}

// deleteVectorMask — AM "delete" on the active layer's vectorMask channel.
// Verified live 2026-06-24 (PS 27.2.0).
func deleteVectorMask() string {
	return fmt.Sprintf(tpl[vault.VMDel], getMinimalContextInfo())
}

// setVectorMaskLink — AM "set" of the layer's vectorMaskLinked flag. Covers both
// link (true) and unlink (false). Verified live 2026-06-24 (PS 27.2.0).
func setVectorMaskLink(linked bool) string {
	return fmt.Sprintf(tpl[vault.VMLink], getMinimalContextInfo(), jsBool(linked))
}

// setVectorMaskEnabled — AM "set" of the layer's vectorMaskEnabled flag. Covers
// both enable (true) and disable (false). Ground truth: m4a STEP-28 (PS 27.x).
func setVectorMaskEnabled(enabled bool) string {
	return fmt.Sprintf(tpl[vault.VMEnable], getMinimalContextInfo(), jsBool(enabled))
}
