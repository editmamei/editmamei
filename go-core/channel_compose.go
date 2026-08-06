package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// Channel-compose family: Apply Image + Calculations. Both blend image
// sources via the AM Clcl ("calculation") object, sharing the channel+layer
// reference builder (__amSrcRef, defined inside each fragment). Ground truth
// confirmed via ScriptListener capture: the AppI event for Apply Image, Mk
// Chnl for Calculations.
//
// clcnBlendMap maps the snake_case blend names exposed by the tool to the AM
// Clcn enum charIDs. Mltp + Dfrn are capture-confirmed; the rest are
// the canonical layer-blend charIDs (Apply Image reuses them) plus Apply Image's
// own Add/Subtract. Every mode is live-verified against real PS before promotion —
// inferred charIDs are never shipped unverified (the descriptor-pitfall rule).
var clcnBlendMap = map[string]string{
	"normal":     "Nrml",
	"multiply":   "Mltp",
	"screen":     "Scrn",
	"overlay":    "Ovrl",
	"darken":     "Drkn",
	"lighten":    "Lghn",
	"soft_light": "SftL",
	"hard_light": "HrdL",
	"difference": "Dfrn",
	"exclusion":  "Xclu",
	"subtract":   "Sbtr",
	"add":        "Add ",
}

// srcChannelMap maps the enum channel names to their AM charID. "alpha" is handled
// separately (by-name reference), so it is intentionally absent here.
var srcChannelMap = map[string]string{
	"rgb":   "RGB ",
	"red":   "Rd  ",
	"green": "Grn ",
	"blue":  "Bl  ",
}

// jsLitOrNull renders a JSX string literal, or the bare literal `null` when empty,
// so the fragment's `if (name)` truthiness check selects by-name vs by-enum refs.
func jsLitOrNull(s string) string {
	if s == "" {
		return "null"
	}
	return jsLit(s)
}

// resolveSrcChannel maps a source-channel selection to (charID, alphaName). When
// the selection is "alpha" it returns ("", <named-channel>); otherwise the channel
// enum charID. allowRGB gates the composite "rgb" choice (valid for Apply Image,
// not for Calculations, whose result is a single channel).
func resolveSrcChannel(channel, alphaName string, allowRGB bool) (string, string, error) {
	if channel == "alpha" {
		if alphaName == "" {
			return "", "", fmt.Errorf("channel=alpha requires an alpha channel name")
		}
		return "", alphaName, nil
	}
	if channel == "rgb" && !allowRGB {
		return "", "", fmt.Errorf("channel %q is not valid here (Calculations works on single channels)", channel)
	}
	cid, ok := srcChannelMap[channel]
	if !ok {
		return "", "", fmt.Errorf("unsupported source channel %q", channel)
	}
	return cid, "", nil
}

// resolveSrcLayer maps a source-layer selection to the name passed to __amSrcRef:
// "merged" (or empty) → "" (the merged composite); anything else → that layer name.
func resolveSrcLayer(layer string) string {
	if layer == "merged" {
		return ""
	}
	return layer
}

// applyImage — AM AppI. chanCharID is the channel enum charID (ignored when
// chanAlphaName is non-empty, which selects an alpha channel by name); layerName
// empty = the merged composite. Destructive: the emitter prepends duplicateForOp.
func applyImage(chanCharID, chanAlphaName, layerName, blendCharID string, opacity float64, applyToActiveLayer bool) string {
	return fmt.Sprintf(
		tpl[vault.ApplyImage],
		getContextInfo(),
		duplicateForOp("Apply Image", applyToActiveLayer),
		jsLit(chanCharID),
		jsLitOrNull(chanAlphaName),
		jsLitOrNull(layerName),
		jsLit(blendCharID),
		jsNum(opacity),
	)
}

// calculations — AM Mk Chnl Using Clcl. Two sources (each channel + layer) blended
// into a new alpha channel. Same channel/layer reference conventions as applyImage.
func calculations(
	s1ChanCharID, s1AlphaName, s1LayerName,
	s2ChanCharID, s2AlphaName, s2LayerName,
	blendCharID string, opacity float64,
) string {
	return fmt.Sprintf(
		tpl[vault.Calculations],
		getMinimalContextInfo(),
		jsLit(s1ChanCharID),
		jsLitOrNull(s1AlphaName),
		jsLitOrNull(s1LayerName),
		jsLit(s2ChanCharID),
		jsLitOrNull(s2AlphaName),
		jsLitOrNull(s2LayerName),
		jsLit(blendCharID),
		jsNum(opacity),
	)
}
