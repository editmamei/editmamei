package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// text-layer family (Phase 1). createTextLayer changes WHAT exists so it
// returns the full getContextInfo(); the other four are pure setters on the
// already-active text layer and carry no context (matching the TS sources).

func createTextLayer(text string, x, y, fontSize float64) string {
	t := jsLit(text)
	xs, ys, fs := jsNum(x), jsNum(y), jsNum(fontSize)
	return fmt.Sprintf(
		tpl[vault.CreateText],
		parentPathHelper(),
		getContextInfo(),
		t, xs, ys, fs, // contents / position / size
		t, xs, ys, fs, // result text / position / fontSize
	)
}

// setTextFont — fontSize is optional. When present the emitter injects the
// size-assignment line; when absent that slot is empty (mirrors the TS
// `${fontSize ? ... : ”}` conditional).
func setTextFont(fontName string, fontSize float64, hasFontSize bool) string {
	sizeAssign := ""
	if hasFontSize {
		sizeAssign = "layer.textItem.size = " + jsNum(fontSize) + ";"
	}
	return fmt.Sprintf(tpl[vault.SetFont], jsLit(fontName), sizeAssign)
}

func setTextColor(red, green, blue float64) string {
	r, g, b := jsNum(red), jsNum(green), jsNum(blue)
	return fmt.Sprintf(tpl[vault.SetTextClr], r, g, b, r, g, b)
}

// textAlignmentSet is the closed allowlist of legal ExtendScript `Justification`
// enum member names. Slot 1 of SetTextAlgn interpolates this value raw into
// `Justification.<NAME>` (a JS identifier, not a string literal), so it MUST be
// validated here before reaching the %s slot rather than relying on the TS
// validator upstream. Mirrors the `alignment` enum in src/tools/text-tools.ts.
var textAlignmentSet = map[string]bool{
	"LEFT": true, "CENTER": true, "RIGHT": true,
	"LEFTJUSTIFIED": true, "CENTERJUSTIFIED": true,
	"RIGHTJUSTIFIED": true, "FULLYJUSTIFIED": true,
}

// setTextAlignment — alignment interpolates raw into `Justification.<NAME>`
// (slot 1) and jsLit'd into the result (slot 2). Slot 1 can't be escaped (it's
// a JS identifier), so the value is allow-listed against the enum set first.
func setTextAlignment(alignment string) (string, error) {
	if !textAlignmentSet[alignment] {
		return "", fmt.Errorf("invalid text alignment: %q", alignment)
	}
	return fmt.Sprintf(tpl[vault.SetTextAlgn], alignment, jsLit(alignment)), nil
}

func updateTextContent(newText string) string {
	return fmt.Sprintf(tpl[vault.UpdateText], jsLit(newText))
}
