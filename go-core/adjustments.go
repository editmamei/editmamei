package main

import (
	"fmt"
	"strings"

	"editmamei-core/internal/vault"
)

// adjustments family.

// Photo-filter preset name → PS internal stringID.
var photoFilterPresetMap = map[string]string{
	"warming_85":   "warmingFilter85",
	"warming_lba":  "warmingFilterLBA",
	"warming_81":   "warmingFilter81",
	"cooling_80":   "coolingFilter80",
	"cooling_lbb":  "coolingFilterLBB",
	"cooling_82":   "coolingFilter82",
	"red":          "red",
	"orange":       "orange",
	"yellow":       "yellow",
	"green":        "green",
	"cyan":         "cyan",
	"blue":         "blue",
	"violet":       "violet",
	"magenta":      "magenta",
	"sepia":        "sepia",
	"deep_red":     "deepRed",
	"deep_blue":    "deepBlue",
	"deep_emerald": "deepEmerald",
	"deep_yellow":  "deepYellow",
	"underwater":   "underwater",
}

// Selective-color family order — must mirror TS SC_FAMILY_MAP iteration order.
var scFamilyOrder = []string{"reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"}

// hexToRGBf parses a "#RRGGBB" hex color into float64 components (0–255).
func hexToRGBf(hex string) (r, g, b float64) {
	hex = strings.TrimPrefix(hex, "#")
	if len(hex) != 6 {
		return 0, 0, 0
	}
	parse := func(s string) float64 {
		var v uint64
		for _, c := range s {
			v <<= 4
			switch {
			case c >= '0' && c <= '9':
				v |= uint64(c - '0')
			case c >= 'a' && c <= 'f':
				v |= uint64(c-'a') + 10
			case c >= 'A' && c <= 'F':
				v |= uint64(c-'A') + 10
			default:
				return 0
			}
		}
		return float64(v)
	}
	return parse(hex[0:2]), parse(hex[2:4]), parse(hex[4:6])
}

// addAdjustmentLayer creates a non-destructive adjustment layer. layerName /
// hasLayerName follow the same opt-string pattern as newLayer/deleteLayer.
// params carries all adjType-specific values extracted from the JSON body.
// intoActiveGroup (Phase 4 layer-placement-bug fix) suppresses the default
// hoist-out-of-the-active-group behavior, keeping PS's native nesting.
func addAdjustmentLayer(
	adjType string,
	clipToBelow bool,
	layerName string, hasLayerName bool,
	params map[string]any,
	maskFromSelection bool,
	maskInverted bool,
	intoActiveGroup bool,
) (string, error) {
	// ── param extraction ────────────────────────────────────────────────────

	num := func(k string, dflt float64) float64 { return numParam(params, k, dflt) }
	str := func(k string, dflt string) string { return strParam(params, k, dflt) }
	bol := func(k string, dflt bool) bool { return boolParam(params, k, dflt) }
	has := func(k string) bool { _, ok := params[k]; return ok }

	// Curves preset.
	curvesPreset := str("curves_preset", "sCurveMedium")
	type pt2 = [2]float64
	var curvePts []pt2
	switch curvesPreset {
	case "linear":
		curvePts = []pt2{{0, 0}, {255, 255}}
	case "sCurveLight":
		curvePts = []pt2{{0, 0}, {64, 55}, {192, 200}, {255, 255}}
	case "sCurveStrong":
		curvePts = []pt2{{0, 0}, {64, 40}, {192, 216}, {255, 255}}
	default:
		curvePts = []pt2{{0, 0}, {64, 48}, {192, 208}, {255, 255}}
	}

	// Levels.
	blackPoint := num("black_point", 0)
	whitePoint := num("white_point", 255)
	gamma := num("gamma", 1.0)

	// Hue/Saturation.
	hue := num("hue", 0)
	saturation := num("saturation", 0)
	lightness := num("lightness", 0)

	// Brightness/Contrast.
	brightness := num("brightness", 0)
	contrast := num("contrast", 0)

	// Black & White.
	bwReds := num("bw_reds", 40)
	bwYellows := num("bw_yellows", 60)
	bwGreens := num("bw_greens", 40)
	bwCyans := num("bw_cyans", 60)
	bwBlues := num("bw_blues", 20)
	bwMagentas := num("bw_magentas", 80)
	bwTint := bol("bw_tint", false)
	bwTintHue := num("bw_tint_hue", 220)
	bwTintSat := num("bw_tint_saturation", 25)

	// Color Balance.
	cbShdCR := num("cb_shadows_cyan_red", 0)
	cbShdMG := num("cb_shadows_magenta_green", 0)
	cbShdYB := num("cb_shadows_yellow_blue", 0)
	cbMdtCR := num("cb_midtones_cyan_red", 0)
	cbMdtMG := num("cb_midtones_magenta_green", 0)
	cbMdtYB := num("cb_midtones_yellow_blue", 0)
	cbHghCR := num("cb_highlights_cyan_red", 0)
	cbHghMG := num("cb_highlights_magenta_green", 0)
	cbHghYB := num("cb_highlights_yellow_blue", 0)
	cbPrsL := bol("cb_preserve_luminosity", true)

	// Photo Filter.
	pfPresetRaw := str("pf_preset", "")
	pfPresetId, _ := photoFilterPresetMap[pfPresetRaw]
	pfColorHex := str("pf_color_hex", "#EC8A00")
	pfDensity := num("pf_density", 25)
	pfPrsL := bol("pf_preserve_luminosity", true)

	// Vibrance.
	vibV := num("vib_vibrance", 0)
	vibS := num("vib_saturation", 0)

	// Channel Mixer.
	cmMono := bol("cm_monochrome", false)
	cmGR := num("cm_gray_from_r", 40)
	cmGG := num("cm_gray_from_g", 40)
	cmGB := num("cm_gray_from_b", 20)
	cmGK := num("cm_gray_constant", 0)
	cmRR := num("cm_r_from_r", 100)
	cmRG := num("cm_r_from_g", 0)
	cmRB := num("cm_r_from_b", 0)
	cmRK := num("cm_r_constant", 0)
	cmGfR := num("cm_g_from_r", 0)
	cmGfG := num("cm_g_from_g", 100)
	cmGfB := num("cm_g_from_b", 0)
	cmGfK := num("cm_g_constant", 0)
	cmBR := num("cm_b_from_r", 0)
	cmBG := num("cm_b_from_g", 0)
	cmBB := num("cm_b_from_b", 100)
	cmBK := num("cm_b_constant", 0)

	// Selective Color.
	scMethod := str("sc_method", "relative")
	var scColorsObj map[string]any
	if v, ok := params["sc_colors"]; ok {
		if m, ok := v.(map[string]any); ok {
			scColorsObj = m
		}
	}

	// Gradient Map.
	gmPreset := str("gm_preset", "black_to_white")
	gmTintHex := str("gm_tint_color_hex", "#5588CC")
	gmReverse := bol("gm_reverse", false)
	gmDither := bol("gm_dither", false)

	// Exposure.
	expExp := num("exp_exposure", 0)
	expOff := num("exp_offset", 0)
	expGamma := num("exp_gamma", 1.0)

	// Color Lookup.
	clLutType := str("cl_lut_type", "3dlut")
	clLutName := str("cl_lut_name", "")

	// Posterize / Threshold.
	posLevels := num("pos_levels", 4)
	thrLevel := num("thr_level", 128)

	// ── hasCustomValues ─────────────────────────────────────────────────────

	bwChanged := bwReds != 40 || bwYellows != 60 || bwGreens != 40 || bwCyans != 60 || bwBlues != 20 || bwMagentas != 80 || bwTint
	cbChanged := cbShdCR != 0 || cbShdMG != 0 || cbShdYB != 0 || cbMdtCR != 0 || cbMdtMG != 0 || cbMdtYB != 0 || cbHghCR != 0 || cbHghMG != 0 || cbHghYB != 0
	pfChanged := pfPresetId != "" || has("pf_color_hex") || has("pf_density") || has("pf_preserve_luminosity")
	vibChanged := vibV != 0 || vibS != 0
	cmChanged := cmMono || cmRR != 100 || cmGfG != 100 || cmBB != 100 || cmRG != 0 || cmRB != 0 || cmGfR != 0 || cmGfB != 0 || cmBR != 0 || cmBG != 0 || cmRK != 0 || cmGfK != 0 || cmBK != 0
	scChanged := len(scColorsObj) > 0
	expChanged := expExp != 0 || expOff != 0 || expGamma != 1.0
	clChanged := clLutName != ""

	hasCustomValues := false
	switch adjType {
	case "hue_saturation":
		hasCustomValues = hue != 0 || saturation != 0 || lightness != 0
	case "brightness_contrast":
		hasCustomValues = brightness != 0 || contrast != 0
	case "curves":
		hasCustomValues = curvesPreset != "linear"
	case "levels":
		hasCustomValues = blackPoint != 0 || whitePoint != 255 || gamma != 1.0
	case "black_and_white":
		hasCustomValues = bwChanged
	case "color_balance":
		hasCustomValues = cbChanged
	case "photo_filter":
		hasCustomValues = pfChanged
	case "vibrance":
		hasCustomValues = vibChanged
	case "channel_mixer":
		hasCustomValues = cmChanged
	case "selective_color":
		hasCustomValues = scChanged
	case "gradient_map", "invert", "posterize", "threshold":
		hasCustomValues = true
	case "exposure":
		hasCustomValues = expChanged
	case "color_lookup":
		hasCustomValues = clChanged
	}

	// ── typeDesc building block ─────────────────────────────────────────────

	var typeDescBlock string
	if hasCustomValues {
		switch adjType {
		case "hue_saturation":
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjHSTd],
				jsNum(hue), jsNum(saturation), jsNum(lightness))

		case "brightness_contrast":
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjBCTd],
				jsNum(brightness), jsNum(contrast))

		case "black_and_white":
			tintBlock := ""
			if bwTint {
				tintBlock = fmt.Sprintf(tpl[vault.AdjBWTint], jsNum(bwTintHue), jsNum(bwTintSat))
			}
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjBWTd],
				jsNum(bwReds), jsNum(bwYellows), jsNum(bwGreens),
				jsNum(bwCyans), jsNum(bwBlues), jsNum(bwMagentas),
				jsBool(bwTint), tintBlock)

		case "color_balance":
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjCBTd],
				jsNum(cbShdCR), jsNum(cbShdMG), jsNum(cbShdYB),
				jsNum(cbMdtCR), jsNum(cbMdtMG), jsNum(cbMdtYB),
				jsNum(cbHghCR), jsNum(cbHghMG), jsNum(cbHghYB),
				jsBool(cbPrsL))

		case "photo_filter":
			var pfTypeLine string
			if pfPresetId != "" {
				pfTypeLine = fmt.Sprintf(tpl[vault.AdjPFPset], jsLit(pfPresetId))
			} else if has("pf_color_hex") {
				r, g, b := hexToRGBf(pfColorHex)
				pfTypeLine = fmt.Sprintf(tpl[vault.AdjPFClr], jsNum(r), jsNum(g), jsNum(b))
			} else {
				pfTypeLine = fmt.Sprintf(tpl[vault.AdjPFFb], jsLit("coolingFilter80"))
			}
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjPFTd], pfTypeLine, jsNum(pfDensity), jsBool(pfPrsL))

		case "vibrance":
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjVibTd], jsNum(vibV), jsNum(vibS))

		case "channel_mixer":
			if cmMono {
				kLine := ""
				if cmGK != 0 {
					kLine = fmt.Sprintf(tpl[vault.AdjCMMonoK], jsNum(cmGK))
				}
				typeDescBlock = fmt.Sprintf(tpl[vault.AdjCMMono],
					jsNum(cmGR), jsNum(cmGG), jsNum(cmGB), kLine)
			} else {
				rK, gK, bK := "", "", ""
				if cmRK != 0 {
					rK = fmt.Sprintf(tpl[vault.AdjCMClrK], "r", jsNum(cmRK))
				}
				if cmGfK != 0 {
					gK = fmt.Sprintf(tpl[vault.AdjCMClrK], "g", jsNum(cmGfK))
				}
				if cmBK != 0 {
					bK = fmt.Sprintf(tpl[vault.AdjCMClrK], "b", jsNum(cmBK))
				}
				typeDescBlock = fmt.Sprintf(tpl[vault.AdjCMClr],
					jsNum(cmRR), jsNum(cmRG), jsNum(cmRB), rK,
					jsNum(cmGfR), jsNum(cmGfG), jsNum(cmGfB), gK,
					jsNum(cmBR), jsNum(cmBG), jsNum(cmBB), bK)
			}

		case "selective_color":
			scEntriesJs := buildSCEntriesJs(scColorsObj)
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjSCTd],
				jsLit(scMethod), scEntriesJs)

		case "gradient_map":
			var colorStopsBlock string
			gmName := "editmamei_" + gmPreset
			// gm_stops (2026-08 gradient build): arbitrary color stops override
			// the preset. Same stop shape as addGradientFillLayer's `stops`
			// (locations 0–100 → 0–4096); the lines call the makeColorStop
			// helper the AdjGMTd fragment defines. Ground truth for the custom
			// list shape confirmed via ScriptListener capture.
			if raw, present := params["gm_stops"]; present {
				arr, ok := raw.([]any)
				if !ok {
					return "", fmt.Errorf("addAdjustmentLayer gradient_map: gm_stops must be an array of stop objects")
				}
				if len(arr) > 0 {
					gmStops, err := parseGradColorStops(params, "gm_stops")
					if err != nil {
						return "", fmt.Errorf("addAdjustmentLayer gradient_map: %v", err)
					}
					colorStopsBlock = gradColorStopLines(gmStops)
					gmName = "editmamei_custom"
				}
			}
			if colorStopsBlock == "" {
				switch gmPreset {
				case "sepia":
					colorStopsBlock = tpl[vault.AdjGMSepia]
				case "tint":
					r, g, b := hexToRGBf(gmTintHex)
					colorStopsBlock = fmt.Sprintf(tpl[vault.AdjGMTint], jsNum(r), jsNum(g), jsNum(b))
				default:
					colorStopsBlock = tpl[vault.AdjGMBW]
				}
			}
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjGMTd],
				jsBool(gmDither), jsBool(gmReverse),
				jsLit(gmName), colorStopsBlock)

		case "exposure":
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjExpTd],
				jsNum(expExp), jsNum(expOff), jsNum(expGamma))

		case "color_lookup":
			if clLutType != "3dlut" {
				return "", fmt.Errorf("addAdjustmentLayer color_lookup: unsupported cl_lut_type %q (only 3dlut verified)", clLutType)
			}
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjCLTd], jsLit(clLutName))

		case "posterize":
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjPosTd], jsNum(posLevels))

		case "threshold":
			typeDescBlock = fmt.Sprintf(tpl[vault.AdjThrTd], jsNum(thrLevel))

		case "invert":
			// Invert is parameter-free; typeDesc stays empty.
			// The putClass path below handles the Mk correctly.

		case "levels", "curves":
			// PS 27.x bug workaround: Mk always uses presetKindDefault for
			// these two types; the real values go in a post-Mk setd block
			// instead (AdjLvlPM / AdjCrvPM). wantCustom is no longer forced
			// false for these types (see below), so this typeDescBlock now
			// feeds the wantCustom=true "else" branch in the outer fragment
			// — it must emit the identical presetKindDefault line the
			// wantCustom=false "if" branch hardcodes, so the Mk descriptor
			// PS actually receives is unchanged either way.
			typeDescBlock = tpl[vault.AdjLvlCrvTd]
		}
	}

	// ── using.put* line ────────────────────────────────────────────────────

	var usingLine string
	if adjType == "color_lookup" || adjType == "invert" {
		usingLine = tpl[vault.AdjUsingClass]
	} else {
		usingLine = tpl[vault.AdjUsingObject]
	}

	// ── optional post-Mk blocks ────────────────────────────────────────────

	layerNameLine := ""
	if hasLayerName {
		layerNameLine = fmt.Sprintf("try { newLayer.name = %s; } catch (e) {}", jsLit(layerName))
	}

	colorLookupNote := ""
	if adjType == "color_lookup" {
		colorLookupNote = tpl[vault.AdjCLNote]
	}

	levelsPMBlock := ""
	if adjType == "levels" && hasCustomValues {
		levelsPMBlock = fmt.Sprintf(tpl[vault.AdjLvlPM],
			jsNum(blackPoint), jsNum(whitePoint), jsNum(gamma))
	}

	curvesPMBlock := ""
	if adjType == "curves" && hasCustomValues {
		parts := make([]string, len(curvePts))
		for i, p := range curvePts {
			parts[i] = fmt.Sprintf("{ h: %s, v: %s }", jsNum(p[0]), jsNum(p[1]))
		}
		curvesPMBlock = fmt.Sprintf(tpl[vault.AdjCrvPM], strings.Join(parts, ", "))
	}

	// customValuesApplied (the wantCustom var in the emitted JSX) now
	// honestly reflects hasCustomValues for every adjType, including
	// levels/curves. It used to be forced to "false" for those two types,
	// which made the returned flag report failure even when the post-Mk
	// setd above succeeded. The Mk descriptor stays byte-identical either
	// way — see the levels/curves typeDescBlock assignment above.
	jsWantCustom := jsBool(hasCustomValues)

	return fmt.Sprintf(
		tpl[vault.AdjLOuter],
		parentPathHelper(), hoistFromActiveGroupHelper(),
		helperFunctions(), getContextInfo(),
		jsLit(adjType),
		jsWantCustom,
		jsBool(maskFromSelection),
		jsBool(maskInverted),
		jsBool(intoActiveGroup),
		typeDescBlock,
		usingLine,
		layerNameLine,
		colorLookupNote,
		levelsPMBlock,
		curvesPMBlock,
		jsBool(clipToBelow),
		jsBool(clipToBelow),
	), nil
}

// buildSCEntriesJs serialises the sc_colors nested object into the JS array
// literal expected by the vault.AdjSCTd fragment — mirrors the TS scEntries
// computation (SC_FAMILY_MAP iteration in insertion order).
func buildSCEntriesJs(scColorsObj map[string]any) string {
	if len(scColorsObj) == 0 {
		return ""
	}
	var entries []string
	for _, family := range scFamilyOrder {
		raw, ok := scColorsObj[family]
		if !ok {
			continue
		}
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		c := numParam(entry, "cyan", 0)
		m := numParam(entry, "magenta", 0)
		y := numParam(entry, "yellow", 0)
		k := numParam(entry, "black", 0)
		if c == 0 && m == 0 && y == 0 && k == 0 {
			continue
		}
		entries = append(entries, fmt.Sprintf(
			"{ psId: %s, c: %s, m: %s, y: %s, k: %s }",
			jsLit(family), jsNum(c), jsNum(m), jsNum(y), jsNum(k),
		))
	}
	return strings.Join(entries, ", ")
}

func applyShadowsHighlights(shadowAmount, shadowWidth, shadowRadius, highlightAmount, highlightWidth, highlightRadius, colorCorrection, midtoneContrast, blackClip, whiteClip float64, applyToActiveLayer bool) string {
	sa, sw, sr := jsNum(shadowAmount), jsNum(shadowWidth), jsNum(shadowRadius)
	ha, hw, hr := jsNum(highlightAmount), jsNum(highlightWidth), jsNum(highlightRadius)
	cc, mc := jsNum(colorCorrection), jsNum(midtoneContrast)
	return fmt.Sprintf(
		tpl[vault.ShadowsHL],
		getMinimalContextInfo(),
		helperFunctions(),
		duplicateForOp("Shadows/Highlights", applyToActiveLayer),
		sa, sw, sr, // shadow tab
		ha, hw, hr, // highlight tab
		jsNum(blackClip), jsNum(whiteClip), mc, cc, // root keys
		// result
		sa, sw, sr, ha, hw, hr, cc, mc,
	)
}

// applyColorLookup — destructive 3DLUT bake via the colorLookup event. The
// LUT path-resolution + byte-read logic is internal; only lutName interpolates.
func applyColorLookup(lutName string, applyToActiveLayer bool) string {
	return fmt.Sprintf(
		tpl[vault.ColorLookup],
		getContextInfo(),
		helperFunctions(),
		duplicateForOp("Color Lookup", applyToActiveLayer),
		jsLit(lutName),
	)
}

// applyEqualize — parameter-free Eqlz bake.
func applyEqualize(applyToActiveLayer bool) string {
	return fmt.Sprintf(
		tpl[vault.Equalize],
		getContextInfo(),
		helperFunctions(),
		duplicateForOp("Equalize", applyToActiveLayer),
	)
}
