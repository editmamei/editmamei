package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// Canvas + guide family (dev-tier, 2026-06-21). Document-level transforms
// (Rtte/Flip targeting Dcmn, not a layer) and guides. Ground truth confirmed
// via ScriptListener capture.

// rotateCanvas — AM Rtte on the document (Dcmn/Ordn/Frst). Arbitrary degrees
// incl. 90/180.
func rotateCanvas(degrees float64) string {
	d := jsNum(degrees)
	return fmt.Sprintf(tpl[vault.CanvasRot], d, d)
}

// canvasFlipMap maps the user-facing orientation to the Flip Axis/Ornt charID.
var canvasFlipMap = map[string]string{"horizontal": "Hrzn", "vertical": "Vrtc"}

// flipCanvas — AM Flip on the document (Dcmn/Ordn/Frst).
func flipCanvas(orientation string) string {
	return fmt.Sprintf(tpl[vault.CanvasFlip], canvasFlipMap[orientation], jsLit(orientation))
}

// guideDirectionMap maps orientation to the DOM Direction enum literal. A
// "vertical" guide runs top-to-bottom and is positioned by its x coordinate
// (Direction.VERTICAL); "horizontal" by its y coordinate.
var guideDirectionMap = map[string]string{
	"horizontal": "Direction.HORIZONTAL",
	"vertical":   "Direction.VERTICAL",
}

// addGuide — DOM doc.guides.add(direction, coordinate). The captured AM Mk path
// bakes a runtime document id + guide index into the descriptor; the DOM API is
// the robust coordinate-free equivalent (it exists, so prefer it — see
// docs/engineering/am-descriptor-conventions.md "DOM vs. AM").
func addGuide(orientation string, position float64) string {
	return fmt.Sprintf(
		tpl[vault.GuideAdd],
		guideDirectionMap[orientation],
		jsNum(position),
		jsLit(orientation),
		jsNum(position),
	)
}

// addGuideLayout — AM newGuideLayout (presetKindCustom + guideLayout obj with
// colCount/rowCount).
func addGuideLayout(columns, rows float64) string {
	c, r := jsNum(columns), jsNum(rows)
	return fmt.Sprintf(tpl[vault.GuideLayout], c, r, c, r)
}

// clearGuides — AM clearAllGuides (zero-field event).
func clearGuides() string {
	return tpl[vault.GuideClear]
}
