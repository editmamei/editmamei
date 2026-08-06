package main

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"editmamei-core/internal/vault"
)

// Gradient family (2026-08 gradient build): the gradient FILL LAYER
// (addGradientFillLayer) and the layer-mask linear fade (maskGradient).
// Descriptor ground truth: the 2026-06-20 gradient-fill-layer captures
// — see fragments_gradients.go.

// gradientTypeCharIDs maps the user-facing gradient_type enum onto the GrdT
// charID PS expects. Lnr/Rdl are capture-proven; the other three are the same
// enum family (live-verify each before relying on them).
var gradientTypeCharIDs = map[string]string{
	"linear":    "Lnr ",
	"radial":    "Rdl ",
	"angle":     "Angl",
	"reflected": "Rflc",
	"diamond":   "Dmnd",
}

type gradColorStop struct {
	r, g, b  float64
	loc      int
	midpoint int
}

type gradOpacityStop struct {
	opacity  float64
	loc      int
	midpoint int
}

// gradLocTo4096 converts a user-facing 0–100 location onto PS's 0–4096
// gradient axis, clamped.
func gradLocTo4096(loc float64) int {
	v := int(math.Round(loc * 40.96))
	if v < 0 {
		v = 0
	}
	if v > 4096 {
		v = 4096
	}
	return v
}

// gradMidpoint clamps a stop midpoint to PS's UI range (5–95).
func gradMidpoint(m float64) int {
	v := int(math.Round(m))
	if v < 5 {
		v = 5
	}
	if v > 95 {
		v = 95
	}
	return v
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func clampChannel(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return v
}

// clampPct clamps a percentage offset to Photoshop's ±100 range (mirrors the
// tool schema's bounds so go-core enforces the same contract).
func clampPct(v float64) float64 {
	if v < -100 {
		return -100
	}
	if v > 100 {
		return 100
	}
	return v
}

// parseGradColorStops reads the stops param ([{red,green,blue,location,
// midpoint}] with 0–100 locations), sorted by location. Missing/empty →
// black→white default. Malformed entries are ERRORS, not silently skipped —
// a caller who supplied stops must get the stops they asked for or a clear
// rejection, never the default under a "custom" label.
func parseGradColorStops(params map[string]any, key string) ([]gradColorStop, error) {
	var out []gradColorStop
	if v, ok := params[key]; ok {
		arr, ok := v.([]any)
		if !ok {
			return nil, fmt.Errorf("%s must be an array of stop objects", key)
		}
		for i, e := range arr {
			m, ok := e.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s[%d] must be a stop object {red,green,blue,location}", key, i)
			}
			loc, hasLoc := optNumParam(m, "location")
			if !hasLoc {
				return nil, fmt.Errorf("%s[%d] is missing required field: location (0-100)", key, i)
			}
			out = append(out, gradColorStop{
				r:        clampChannel(numParam(m, "red", 0)),
				g:        clampChannel(numParam(m, "green", 0)),
				b:        clampChannel(numParam(m, "blue", 0)),
				loc:      gradLocTo4096(loc),
				midpoint: gradMidpoint(numParam(m, "midpoint", 50)),
			})
		}
	}
	if len(out) == 0 {
		return []gradColorStop{
			{r: 0, g: 0, b: 0, loc: 0, midpoint: 50},
			{r: 255, g: 255, b: 255, loc: 4096, midpoint: 50},
		}, nil
	}
	if len(out) == 1 {
		return nil, fmt.Errorf("%s needs at least 2 stops (got 1)", key)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].loc < out[j].loc })
	return out, nil
}

// parseGradOpacityStops reads opacity_stops ([{opacity,location,midpoint}]).
// Missing/empty → fully opaque across the run. Same strictness as
// parseGradColorStops: malformed entries error.
func parseGradOpacityStops(params map[string]any, key string) ([]gradOpacityStop, error) {
	var out []gradOpacityStop
	if v, ok := params[key]; ok {
		arr, ok := v.([]any)
		if !ok {
			return nil, fmt.Errorf("%s must be an array of stop objects", key)
		}
		for i, e := range arr {
			m, ok := e.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s[%d] must be a stop object {opacity,location}", key, i)
			}
			loc, hasLoc := optNumParam(m, "location")
			if !hasLoc {
				return nil, fmt.Errorf("%s[%d] is missing required field: location (0-100)", key, i)
			}
			op, hasOp := optNumParam(m, "opacity")
			if !hasOp {
				return nil, fmt.Errorf("%s[%d] is missing required field: opacity (0-100)", key, i)
			}
			if op < 0 {
				op = 0
			}
			if op > 100 {
				op = 100
			}
			out = append(out, gradOpacityStop{
				opacity:  op,
				loc:      gradLocTo4096(loc),
				midpoint: gradMidpoint(numParam(m, "midpoint", 50)),
			})
		}
	}
	if len(out) == 0 {
		return []gradOpacityStop{
			{opacity: 100, loc: 0, midpoint: 50},
			{opacity: 100, loc: 4096, midpoint: 50},
		}, nil
	}
	if len(out) == 1 {
		return nil, fmt.Errorf("%s needs at least 2 stops (got 1)", key)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].loc < out[j].loc })
	return out, nil
}

// gradColorStopLines renders the per-stop putObject lines for a colorStops
// stop-block slot (the host fragment defines makeColorStop + colorStops).
func gradColorStopLines(stops []gradColorStop) string {
	lines := make([]string, 0, len(stops))
	for _, s := range stops {
		lines = append(lines, fmt.Sprintf(tpl[vault.GradStopLine],
			jsNum(float64(s.loc)), jsNum(float64(s.midpoint)),
			jsNum(s.r), jsNum(s.g), jsNum(s.b)))
	}
	return strings.Join(lines, "\n")
}

// gradOpacityStopLines renders the per-stop lines for an opacityStops slot.
func gradOpacityStopLines(stops []gradOpacityStop) string {
	lines := make([]string, 0, len(stops))
	for _, s := range stops {
		lines = append(lines, fmt.Sprintf(tpl[vault.GradOpacStopLine],
			jsNum(float64(s.loc)), jsNum(float64(s.midpoint)), jsNum(s.opacity)))
	}
	return strings.Join(lines, "\n")
}

// addGradientFillLayer — Mk contentLayer / gradientLayer with custom stops.
// Creates a new layer → full getContextInfo; same hoist-out-of-active-group
// placement contract as addFillLayer.
func addGradientFillLayer(params map[string]any) (string, error) {
	gtype := strParam(params, "gradient_type", "linear")
	typeCharID, ok := gradientTypeCharIDs[gtype]
	if !ok {
		return "", fmt.Errorf("addGradientFillLayer: unknown gradient_type %q (linear/radial/angle/reflected/diamond)", gtype)
	}
	angle := numParam(params, "angle", 90)
	if angle < -180 {
		angle = -180
	}
	if angle > 180 {
		angle = 180
	}
	scale := numParam(params, "scale", 100)
	if scale < 10 {
		scale = 10
	}
	if scale > 150 {
		scale = 150
	}
	offX := clampPct(numParam(params, "offset_x", 0))
	offY := clampPct(numParam(params, "offset_y", 0))
	reverse := boolParam(params, "reverse", false)
	dither := boolParam(params, "dither", true)
	intoGroup := boolParam(params, "into_active_group", false)

	stops, err := parseGradColorStops(params, "stops")
	if err != nil {
		return "", fmt.Errorf("addGradientFillLayer: %w", err)
	}
	opStops, err := parseGradOpacityStops(params, "opacity_stops")
	if err != nil {
		return "", fmt.Errorf("addGradientFillLayer: %w", err)
	}

	reverseLine := ""
	if reverse {
		reverseLine = tpl[vault.GradRevLine]
	}

	return fmt.Sprintf(tpl[vault.AddGradFill],
		parentPathHelper(), hoistFromActiveGroupHelper(), getContextInfo(),
		jsNum(angle),
		gradColorStopLines(stops),
		gradOpacityStopLines(opStops),
		jsBool(dither),
		jsLit(typeCharID),
		reverseLine,
		jsNum(scale),
		jsNum(offX),
		jsNum(offY),
		jsBool(intoGroup),
		jsLit(gtype),
		jsNum(scale),
		jsBool(reverse),
		fmt.Sprintf("%d", len(stops)),
	), nil
}

// maskGradient — linear white→black fade drawn into the active layer's mask
// channel (created reveal-all first when absent). fade_to names the side that
// ends fully hidden; start/end are 0–1 fractions along that direction over
// the layer (default) or canvas extent. Replaces existing mask content.
func maskGradient(params map[string]any) (string, error) {
	fadeTo := strParam(params, "fade_to", "bottom")
	switch fadeTo {
	case "bottom", "top", "left", "right":
	default:
		return "", fmt.Errorf("maskGradient: unknown fade_to %q (bottom/top/left/right)", fadeTo)
	}
	start := clamp01(numParam(params, "start", 0))
	end := clamp01(numParam(params, "end", 1))
	if end <= start {
		return "", fmt.Errorf("maskGradient: end (%v) must be greater than start (%v)", end, start)
	}
	extent := strParam(params, "extent", "layer")
	switch extent {
	case "layer", "canvas":
	default:
		return "", fmt.Errorf("maskGradient: unknown extent %q (layer/canvas)", extent)
	}

	return fmt.Sprintf(tpl[vault.MaskGrad],
		helperFunctions(), restoreCompositeChannel(), getContextInfo(),
		jsLit(fadeTo), jsNum(start), jsNum(end), jsLit(extent),
		jsNum(255), jsNum(0),
	), nil
}
