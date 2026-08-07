package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// Shape layers (m4a Tier-3): ps_shape. A real vector shape (contentLayer) with
// geometry baked in ABSOLUTE document pixels. Ground truth: m4a STEP-29 (rectangle/
// rounded), STEP-31 (ellipse), STEP-33 (line). Coordinate-baking — the caller must
// supply document-pixel positions (aim via ps_get_preview's coordinate grid).
// Held at dev tier: the aiming primitive (coordinate grid) is still weak, so an
// un-aimable shape tool stays out of the shipped surface until that's solid.
//
// Polygon + custom shapes are intentionally NOT covered: polygon is a large
// derived-quad descriptor (keyOriginBoxCorners + poly-sides + redundant corner
// quads) that doesn't synthesize reliably, and custom is a named-preset reference.

// createShape emits the Mk contentLayer descriptor for shapeType in
// {rectangle, ellipse, line}. Geometry params not relevant to the chosen type are
// ignored by the fragment (it switches on __type). strokeWidth <= 0 disables the
// stroke. The slot order MUST match the fragment's var block. intoActiveGroup
// (Phase 4 layer-placement-bug fix) suppresses the default
// hoist-out-of-the-active-group behavior, keeping PS's native nesting.
func createShape(
	shapeType string,
	top, left, bottom, right, cornerRadius float64,
	startX, startY, endX, endY, weight float64,
	fillR, fillG, fillB float64,
	strokeWidth, strokeR, strokeG, strokeB float64,
	intoActiveGroup bool,
) string {
	return fmt.Sprintf(
		tpl[vault.CreateShape],
		parentPathHelper(), hoistFromActiveGroupHelper(), getContextInfo(),
		jsLit(shapeType),
		jsNum(top), jsNum(left), jsNum(bottom), jsNum(right), jsNum(cornerRadius),
		jsNum(startX), jsNum(startY), jsNum(endX), jsNum(endY), jsNum(weight),
		jsNum(fillR), jsNum(fillG), jsNum(fillB),
		jsNum(strokeWidth), jsNum(strokeR), jsNum(strokeG), jsNum(strokeB),
		jsBool(intoActiveGroup),
	)
}
