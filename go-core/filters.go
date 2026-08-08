package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// filterPrologue composes the opening every filter fragment shares: the context
// helper, the no-document guard, the auto-duplicate, and the check that what is
// left can take a filter at all.
//
// A fragment asks for this instead of carrying its own copy, so the guard exists
// once and a fragment cannot ship having forgotten a helper it needs in scope.
// Set trackRasterized when the fragment reports `wasRasterized` back to the
// caller; it declares the variable the fragment then reads. Set needsHelpers
// when the fragment makes any cTID/sTID call — forgetting that is a failure
// that only appears inside Photoshop, so the prologue owns it rather than
// leaving each fragment to remember.
func filterPrologue(opName string, applyToActiveLayer, trackRasterized, needsHelpers bool) string {
	rasterize := tpl[vault.FiltRast]
	if trackRasterized {
		rasterize = tpl[vault.FiltRastTrk]
	}
	helpers := ""
	if needsHelpers {
		helpers = helperFunctions()
	}
	return fmt.Sprintf(
		tpl[vault.FiltPro],
		getMinimalContextInfo(),
		helpers,
		duplicateForOp(opName, applyToActiveLayer),
		rasterize,
	)
}

// applyGaussianBlur — the one filter that reports whether it had to rasterize.
func applyGaussianBlur(radius float64, applyToActiveLayer bool) string {
	return fmt.Sprintf(
		tpl[vault.GBlur],
		filterPrologue("Gaussian Blur", applyToActiveLayer, true, false),
		jsNum(radius),
		jsNum(radius),
	)
}

// applyUnsharpMask — op name "Sharpen". amount/radius/threshold appear in the
// call and again in the result.
func applyUnsharpMask(amount, radius, threshold float64, applyToActiveLayer bool) string {
	a, r, t := jsNum(amount), jsNum(radius), jsNum(threshold)
	return fmt.Sprintf(
		tpl[vault.USharp],
		filterPrologue("Sharpen", applyToActiveLayer, false, false),
		a, r, t, // applyUnSharpMask(amount, radius, threshold)
		a, r, t, // result amount/radius/threshold
	)
}

// noiseDistributionSet is the closed allowlist for the raw `NoiseDistribution.<x>`
// enum slot below — the registry rejects anything else before it can interpolate
// a caller string as a bare JS identifier (the Go core is the
// trust boundary, so it can't lean on the TS schema enum alone).
var noiseDistributionSet = map[string]bool{"UNIFORM": true, "GAUSSIAN": true}

// applyAddNoise — op name "Noise". distribution interpolates raw into
// `NoiseDistribution.<dist>` AND jsLit-quoted into the result. The caller value
// MUST be validated against noiseDistributionSet first (done in registry.build).
func applyAddNoise(amount float64, distribution string, monochromatic, applyToActiveLayer bool) string {
	amt, mono := jsNum(amount), jsBool(monochromatic)
	return fmt.Sprintf(
		tpl[vault.ANoise],
		filterPrologue("Noise", applyToActiveLayer, false, false),
		distribution, // NoiseDistribution.<raw>
		amt, mono,    // applyAddNoise(amount, distEnum, monochromatic)
		amt, jsLit(distribution), mono, // result amount/distribution/monochromatic
	)
}

// applyMotionBlur — op name "Motion Blur". angle/radius in call and result.
func applyMotionBlur(angle, radius float64, applyToActiveLayer bool) string {
	ang, rad := jsNum(angle), jsNum(radius)
	return fmt.Sprintf(
		tpl[vault.MBlur],
		filterPrologue("Motion Blur", applyToActiveLayer, false, false),
		ang, rad, // applyMotionBlur(angle, radius)
		ang, rad, // result angle/radius
	)
}

// lensIrisMap maps the user-facing iris-shape name to the PS Bokeh-enum charID
// (BeS3..BeS8 = 3..8 polygon sides). The registry validates against this; the
// emitter assumes a valid key (the golden only exercises valid shapes).
var lensIrisMap = map[string]string{
	"triangle": "BeS3",
	"square":   "BeS4",
	"pentagon": "BeS5",
	"hexagon":  "BeS6",
	"heptagon": "BeS7",
	"octagon":  "BeS8",
}

// applyLensBlur — AM Bokh. The pre-audit emission was forum-lore fiction; this
// matches the 2026-06-03 capture (charID Bk* family, BeS* enums).
func applyLensBlur(radius float64, irisShape string, irisBladeCurvature, irisRotation, specularBrightness, specularThreshold, noiseAmount float64, noiseDistribution string, noiseMonochromatic bool, depthSource string, focalDistance float64, invertDepth, applyToActiveLayer bool) string {
	irisCharID := lensIrisMap[irisShape]
	noiseDistCharID := "BeNu"
	if noiseDistribution == "gaussian" {
		noiseDistCharID = "BeNg"
	}
	rad := jsNum(radius)
	bld, rot := jsNum(irisBladeCurvature), jsNum(irisRotation)
	sb, st := jsNum(specularBrightness), jsNum(specularThreshold)
	na := jsNum(noiseAmount)
	fd := jsNum(focalDistance)
	mono, inv := jsBool(noiseMonochromatic), jsBool(invertDepth)
	return fmt.Sprintf(
		tpl[vault.LensBlur],
		filterPrologue("Lens Blur", applyToActiveLayer, false, true),
		fd, inv, // BkDp / BkDs
		irisCharID, rad, bld, rot, // iris group
		sb, st, // specular group
		na, noiseDistCharID, mono, // noise group
		// result
		rad, jsLit(irisShape), bld, rot, sb, st,
		na, jsLit(noiseDistribution), mono, jsLit(depthSource), fd, inv,
	)
}

// applySmartSharpen — modern detail-aware sharpening (smartSharpen event).
func applySmartSharpen(amount, radius, noiseReduction float64, removeMode string, motionAngle, shadowFade, shadowTonalWidth, shadowRadius, highlightFade, highlightTonalWidth, highlightRadius float64, applyToActiveLayer bool) string {
	blurCharID := "GsnB"
	if removeMode == "lensBlur" {
		blurCharID = "LnsB"
	} else if removeMode == "motionBlur" {
		blurCharID = "MtnB"
	}
	motionLine := ""
	if removeMode == "motionBlur" {
		motionLine = "ssDesc.putInteger(cTID('mtnA'), " + jsNum(motionAngle) + ");"
	}
	am, rd, nr := jsNum(amount), jsNum(radius), jsNum(noiseReduction)
	sf, stw, sr := jsNum(shadowFade), jsNum(shadowTonalWidth), jsNum(shadowRadius)
	hf, htw, hr := jsNum(highlightFade), jsNum(highlightTonalWidth), jsNum(highlightRadius)
	return fmt.Sprintf(
		tpl[vault.SmartShrp],
		filterPrologue("Smart Sharpen", applyToActiveLayer, false, true),
		am, rd, nr, blurCharID, motionLine,
		sf, stw, sr, // shadows tab
		hf, htw, hr, // highlights tab
		// result
		am, rd, nr, jsLit(removeMode), jsNum(motionAngle),
		sf, stw, sr, hf, htw, hr,
	)
}

// applyReduceNoise — denoise event. Composite channel always present;
// per-channel RGB entries appended when perChannel=true.
func applyReduceNoise(strength, preserveDetails, colorNoise, sharpenDetails float64, removeJpegArtifact, perChannel bool, redStrength, redPreserveDetails, greenStrength, greenPreserveDetails, blueStrength, bluePreserveDetails float64, applyToActiveLayer bool) string {
	perChannelBlock := ""
	if perChannel {
		ch := func(label, name string, amt, edge float64) string {
			v := name + "Desc"
			r := name + "Ref"
			return "// " + label + " channel.\n" +
				"    var " + v + " = new ActionDescriptor();\n" +
				"    var " + r + " = new ActionReference();\n" +
				"    " + r + ".putEnumerated(sTID('channel'), sTID('channel'), sTID('" + name + "'));\n" +
				"    " + v + ".putReference(sTID('channel'), " + r + ");\n" +
				"    " + v + ".putInteger(sTID('amount'), " + jsNum(amt) + ");\n" +
				"    " + v + ".putInteger(sTID('edgeFidelity'), " + jsNum(edge) + ");\n" +
				"    chList.putObject(sTID('channelDenoiseParams'), " + v + ");"
		}
		perChannelBlock = ch("Red", "red", redStrength, redPreserveDetails) + "\n\n    " +
			ch("Green", "green", greenStrength, greenPreserveDetails) + "\n\n    " +
			ch("Blue", "blue", blueStrength, bluePreserveDetails)
	}
	str, pd := jsNum(strength), jsNum(preserveDetails)
	cn, sd := jsNum(colorNoise), jsNum(sharpenDetails)
	rja := jsBool(removeJpegArtifact)
	return fmt.Sprintf(
		tpl[vault.RedNoise],
		filterPrologue("Reduce Noise", applyToActiveLayer, false, true),
		str, pd, // composite channel
		perChannelBlock,
		cn, sd, rja, // root keys
		// result
		str, pd, cn, sd, rja, jsBool(perChannel),
	)
}

// radialMethodMap / radialQualityMap map user-facing names to PS charIDs for
// the RdlB descriptor (captured 2026-06-20). The registry validates the keys.
var radialMethodMap = map[string]string{
	"spin": "Spn ",
	"zoom": "Zm  ",
}
var radialQualityMap = map[string]string{
	"draft": "Drft",
	"good":  "Gd  ",
	"best":  "Bst ",
}

// applyRadialBlur — AM RdlB. No DOM method exists. center is normalized 0-1.
func applyRadialBlur(amount float64, method, quality string, centerX, centerY float64, applyToActiveLayer bool) string {
	m := radialMethodMap[method]
	q := radialQualityMap[quality]
	amt := jsNum(amount)
	cx, cy := jsNum(centerX), jsNum(centerY)
	return fmt.Sprintf(
		tpl[vault.RadialBlur],
		filterPrologue("Radial Blur", applyToActiveLayer, false, true),
		amt, m, q, cx, cy,
		// result
		amt, jsLit(method), jsLit(quality), cx, cy,
	)
}

// applyPixelate — AM ClrH (color halftone) / Msc (mosaic) / Crst (crystallize) /
// Pntl (pointillize) / Fct (facet) / Frgm (fragment). The mode-specific
// descriptor + result-detail line are built here and interpolated into the
// shared skeleton (same approach as applyReduceNoise's per-channel block).
// crystallize/pointillize/facet/fragment ground truth confirmed via
// ScriptListener capture (2026-06-29).
func applyPixelate(mode string, maxRadius, angle1, angle2, angle3, angle4, cellSize float64, applyToActiveLayer bool) string {
	var block, resultFields string
	switch mode {
	case "mosaic":
		cs := jsNum(cellSize)
		block = "var pxDesc = new ActionDescriptor();\n" +
			"    pxDesc.putUnitDouble(cTID('ClSz'), cTID('#Pxl'), " + cs + ");\n" +
			"    executeAction(cTID('Msc '), pxDesc, DialogModes.NO);"
		resultFields = "cell_size: " + cs + ","
	case "crystallize":
		// Crst: ClSz as putInteger (NOT unitDouble like mosaic) per capture.
		cs := jsNum(cellSize)
		block = "var pxDesc = new ActionDescriptor();\n" +
			"    pxDesc.putInteger(cTID('ClSz'), " + cs + ");\n" +
			"    executeAction(cTID('Crst'), pxDesc, DialogModes.NO);"
		resultFields = "cell_size: " + cs + ","
	case "pointillize":
		cs := jsNum(cellSize)
		block = "var pxDesc = new ActionDescriptor();\n" +
			"    pxDesc.putInteger(cTID('ClSz'), " + cs + ");\n" +
			"    executeAction(cTID('Pntl'), pxDesc, DialogModes.NO);"
		resultFields = "cell_size: " + cs + ","
	case "facet":
		// Parameterless — undefined descriptor, exactly as captured.
		block = "executeAction(cTID('Fct '), undefined, DialogModes.NO);"
		resultFields = ""
	case "fragment":
		block = "executeAction(cTID('Frgm'), undefined, DialogModes.NO);"
		resultFields = ""
	default: // color_halftone
		mr := jsNum(maxRadius)
		a1, a2, a3, a4 := jsNum(angle1), jsNum(angle2), jsNum(angle3), jsNum(angle4)
		block = "var pxDesc = new ActionDescriptor();\n" +
			"    pxDesc.putInteger(cTID('Rds '), " + mr + ");\n" +
			"    pxDesc.putInteger(cTID('Ang1'), " + a1 + ");\n" +
			"    pxDesc.putInteger(cTID('Ang2'), " + a2 + ");\n" +
			"    pxDesc.putInteger(cTID('Ang3'), " + a3 + ");\n" +
			"    pxDesc.putInteger(cTID('Ang4'), " + a4 + ");\n" +
			"    executeAction(cTID('ClrH'), pxDesc, DialogModes.NO);"
		resultFields = "max_radius: " + mr + ", angle_1: " + a1 + ", angle_2: " + a2 +
			", angle_3: " + a3 + ", angle_4: " + a4 + ","
	}
	return fmt.Sprintf(
		tpl[vault.Pixelate],
		filterPrologue("Pixelate", applyToActiveLayer, false, true),
		block,
		jsLit(mode),
		resultFields,
	)
}

// Distort enum maps (user-facing name -> PS charID), captured 2026-06-20.
var rippleSizeMap = map[string]string{"small": "Sml ", "medium": "Mdm ", "large": "Lrg "}
var polarConvMap = map[string]string{"rect_to_polar": "RctP", "polar_to_rect": "PlrR"}
var waveTypeMap = map[string]string{"sine": "WvSn", "triangle": "WvTr", "square": "WvSq"}
var waveUndefMap = map[string]string{"repeat_edge": "RptE", "wrap_around": "WrpA"}

// applyDistort — AM Twrl / Rple / Plr / Wave. Mode-specific descriptor block +
// result-detail line are built here (same approach as applyPixelate). The
// registry validates mode + enum values before calling.
func applyDistort(mode string, p map[string]any, applyToActiveLayer bool) string {
	var block, resultFields string
	switch mode {
	case "twirl":
		ang := jsNum(numParam(p, "angle", 90))
		block = "var dsDesc = new ActionDescriptor();\n" +
			"    dsDesc.putInteger(cTID('Angl'), " + ang + ");\n" +
			"    executeAction(cTID('Twrl'), dsDesc, DialogModes.NO);"
		resultFields = "angle: " + ang + ","
	case "ripple":
		amt := jsNum(numParam(p, "amount", 100))
		size := strParam(p, "size", "medium")
		block = "var dsDesc = new ActionDescriptor();\n" +
			"    dsDesc.putInteger(cTID('Amnt'), " + amt + ");\n" +
			"    dsDesc.putEnumerated(cTID('RplS'), cTID('RplS'), cTID('" + rippleSizeMap[size] + "'));\n" +
			"    executeAction(cTID('Rple'), dsDesc, DialogModes.NO);"
		resultFields = "amount: " + amt + ", size: " + jsLit(size) + ","
	case "polar":
		conv := strParam(p, "conversion", "rect_to_polar")
		block = "var dsDesc = new ActionDescriptor();\n" +
			"    dsDesc.putEnumerated(cTID('Cnvr'), cTID('Cnvr'), cTID('" + polarConvMap[conv] + "'));\n" +
			"    executeAction(cTID('Plr '), dsDesc, DialogModes.NO);"
		resultFields = "conversion: " + jsLit(conv) + ","
	case "wave":
		wt := strParam(p, "waveType", "sine")
		ua := strParam(p, "undefinedAreas", "repeat_edge")
		g := jsNum(numParam(p, "generators", 5))
		wlmin := jsNum(numParam(p, "wavelengthMin", 10))
		wlmax := jsNum(numParam(p, "wavelengthMax", 120))
		ammin := jsNum(numParam(p, "amplitudeMin", 5))
		ammax := jsNum(numParam(p, "amplitudeMax", 35))
		sh := jsNum(numParam(p, "scaleHorizontal", 100))
		sv := jsNum(numParam(p, "scaleVertical", 100))
		rs := jsNum(numParam(p, "randomSeed", 12345))
		block = "var dsDesc = new ActionDescriptor();\n" +
			"    dsDesc.putEnumerated(cTID('Wvtp'), cTID('Wvtp'), cTID('" + waveTypeMap[wt] + "'));\n" +
			"    dsDesc.putInteger(cTID('NmbG'), " + g + ");\n" +
			"    dsDesc.putInteger(cTID('WLMn'), " + wlmin + ");\n" +
			"    dsDesc.putInteger(cTID('WLMx'), " + wlmax + ");\n" +
			"    dsDesc.putInteger(cTID('AmMn'), " + ammin + ");\n" +
			"    dsDesc.putInteger(cTID('AmMx'), " + ammax + ");\n" +
			"    dsDesc.putInteger(cTID('SclH'), " + sh + ");\n" +
			"    dsDesc.putInteger(cTID('SclV'), " + sv + ");\n" +
			"    dsDesc.putEnumerated(cTID('UndA'), cTID('UndA'), cTID('" + waveUndefMap[ua] + "'));\n" +
			"    dsDesc.putInteger(cTID('RndS'), " + rs + ");\n" +
			"    executeAction(cTID('Wave'), dsDesc, DialogModes.NO);"
		resultFields = "wave_type: " + jsLit(wt) + ", generators: " + g + ", wavelength_min: " + wlmin +
			", wavelength_max: " + wlmax + ", amplitude_min: " + ammin + ", amplitude_max: " + ammax +
			", scale_horizontal: " + sh + ", scale_vertical: " + sv + ", undefined_areas: " + jsLit(ua) +
			", random_seed: " + rs + ","
	// Later additions. Enum sub-options (spherize
	// horizontal/vertical, zigzag around-center/out-from-center) deferred —
	// only the captured default enum value is shipped; the rest need a capture.
	case "pinch":
		amt := jsNum(numParam(p, "amount", 50))
		block = "var dsDesc = new ActionDescriptor();\n" +
			"    dsDesc.putInteger(cTID('Amnt'), " + amt + ");\n" +
			"    executeAction(cTID('Pnch'), dsDesc, DialogModes.NO);"
		resultFields = "amount: " + amt + ","
	case "spherize":
		amt := jsNum(numParam(p, "amount", 100))
		block = "var dsDesc = new ActionDescriptor();\n" +
			"    dsDesc.putInteger(cTID('Amnt'), " + amt + ");\n" +
			"    dsDesc.putEnumerated(cTID('SphM'), cTID('SphM'), cTID('Nrml'));\n" +
			"    executeAction(cTID('Sphr'), dsDesc, DialogModes.NO);"
		resultFields = "amount: " + amt + ","
	case "zigzag":
		amt := jsNum(numParam(p, "amount", 10))
		ridges := jsNum(numParam(p, "ridges", 5))
		block = "var dsDesc = new ActionDescriptor();\n" +
			"    dsDesc.putInteger(cTID('Amnt'), " + amt + ");\n" +
			"    dsDesc.putInteger(cTID('NmbR'), " + ridges + ");\n" +
			"    dsDesc.putEnumerated(cTID('ZZTy'), cTID('ZZTy'), cTID('PndR'));\n" +
			"    executeAction(cTID('ZgZg'), dsDesc, DialogModes.NO);"
		resultFields = "amount: " + amt + ", ridges: " + ridges + ","
	}
	return fmt.Sprintf(
		tpl[vault.Distort],
		filterPrologue("Distort", applyToActiveLayer, false, true),
		block,
		jsLit(mode),
		resultFields,
	)
}

// displace enum maps (user-facing -> PS charID), captured 2026-06-20.
var displaceMapMap = map[string]string{"stretch_to_fit": "StrF", "tile": "Tile"}
var displaceUndefMap = map[string]string{"repeat_edge": "RptE", "wrap_around": "WrpA"}

// applyDisplace — AM Dspl. The displacement-map file is carried in the
// descriptor (putPath DspF), so it runs headless. The registry validates enums
// + the required map path.
func applyDisplace(hScale, vScale float64, displacementMap, undefinedAreas, mapPath string, applyToActiveLayer bool) string {
	hs, vs := jsNum(hScale), jsNum(vScale)
	mp := jsLit(mapPath)
	return fmt.Sprintf(
		tpl[vault.Displace],
		filterPrologue("Displace", applyToActiveLayer, false, true),
		hs, vs, displaceMapMap[displacementMap], displaceUndefMap[undefinedAreas], mp,
		// result
		hs, vs, jsLit(displacementMap), jsLit(undefinedAreas), mp,
	)
}

// applyOilPaint — AM oilPaint (Stylize > Oil Paint). GPU-accelerated.
func applyOilPaint(stylization, cleanliness, brushScale, bristleDetail, lightDirection, shine float64, lightingOn, applyToActiveLayer bool) string {
	st, cl, bs := jsNum(stylization), jsNum(cleanliness), jsNum(brushScale)
	bd, ld, sh := jsNum(bristleDetail), jsNum(lightDirection), jsNum(shine)
	lo := jsBool(lightingOn)
	return fmt.Sprintf(
		tpl[vault.OilPaint],
		filterPrologue("Oil Paint", applyToActiveLayer, false, true),
		lo, st, cl, bs, bd, ld, sh,
		// result
		st, cl, bs, bd, ld, sh, lo,
	)
}

// applyHighPass — single-radius highPass event.
func applyHighPass(radius float64, applyToActiveLayer bool) string {
	r := jsNum(radius)
	return fmt.Sprintf(
		tpl[vault.HighPass],
		filterPrologue("High Pass", applyToActiveLayer, false, true),
		r, r,
	)
}

// Stylize enum maps. wind method/direction +
// trace-contour edge are stable PS charIDs (captured Wnd/Left/Lwr; the rest are
// the documented siblings, live-verified before ship). The registry validates.
var windMethodMap = map[string]string{"wind": "Wnd ", "blast": "Blst", "stagger": "Stgr"}
var windDirMap = map[string]string{"left": "Left", "right": "Rght"}
var traceEdgeMap = map[string]string{"lower": "Lwr ", "upper": "Upr "}

// applyStylize — Filter > Stylize family. Mode-specific descriptor block built
// here, interpolated into the shared vault.FilterMulti skeleton. tiles fill is
// hardcoded to background (FlBc); its other fill options are deferred.
func applyStylize(mode string, p map[string]any, applyToActiveLayer bool) string {
	var block, resultFields string
	switch mode {
	case "emboss":
		ang := jsNum(numParam(p, "angle", 135))
		hgt := jsNum(numParam(p, "height", 3))
		amt := jsNum(numParam(p, "amount", 100))
		block = "var stDesc = new ActionDescriptor();\n" +
			"    stDesc.putInteger(cTID('Angl'), " + ang + ");\n" +
			"    stDesc.putInteger(cTID('Hght'), " + hgt + ");\n" +
			"    stDesc.putInteger(cTID('Amnt'), " + amt + ");\n" +
			"    executeAction(cTID('Embs'), stDesc, DialogModes.NO);"
		resultFields = "angle: " + ang + ", height: " + hgt + ", amount: " + amt + ","
	case "find_edges":
		block = "executeAction(cTID('FndE'), undefined, DialogModes.NO);"
	case "solarize":
		block = "executeAction(cTID('Slrz'), undefined, DialogModes.NO);"
	case "wind":
		method := strParam(p, "method", "wind")
		dir := strParam(p, "direction", "left")
		block = "var stDesc = new ActionDescriptor();\n" +
			"    stDesc.putEnumerated(cTID('WndM'), cTID('WndM'), cTID('" + windMethodMap[method] + "'));\n" +
			"    stDesc.putEnumerated(cTID('Drct'), cTID('Drct'), cTID('" + windDirMap[dir] + "'));\n" +
			"    executeAction(cTID('Wnd '), stDesc, DialogModes.NO);"
		resultFields = "method: " + jsLit(method) + ", direction: " + jsLit(dir) + ","
	case "trace_contour":
		lvl := jsNum(numParam(p, "level", 128))
		edge := strParam(p, "edge", "lower")
		block = "var stDesc = new ActionDescriptor();\n" +
			"    stDesc.putInteger(cTID('Lvl '), " + lvl + ");\n" +
			"    stDesc.putEnumerated(cTID('Edg '), cTID('CntE'), cTID('" + traceEdgeMap[edge] + "'));\n" +
			"    executeAction(cTID('TrcC'), stDesc, DialogModes.NO);"
		resultFields = "level: " + lvl + ", edge: " + jsLit(edge) + ","
	case "tiles":
		num := jsNum(numParam(p, "number", 10))
		off := jsNum(numParam(p, "offset", 10))
		block = "var stDesc = new ActionDescriptor();\n" +
			"    stDesc.putInteger(cTID('TlNm'), " + num + ");\n" +
			"    stDesc.putInteger(cTID('TlOf'), " + off + ");\n" +
			"    stDesc.putEnumerated(cTID('FlCl'), cTID('FlCl'), cTID('FlBc'));\n" +
			"    executeAction(cTID('Tls '), stDesc, DialogModes.NO);"
		resultFields = "number: " + num + ", offset: " + off + ","
	}
	return fmt.Sprintf(
		tpl[vault.FilterMulti],
		filterPrologue("Stylize", applyToActiveLayer, false, true),
		block,
		jsLit("Stylize"),
		jsLit(mode),
		resultFields,
	)
}

// applyRender — Filter > Render family. clouds/difference-
// clouds are parameterless (use the current FG/BG colors); fibers takes
// variance/strength/seed. Shares the FilterMulti skeleton.
func applyRender(mode string, p map[string]any, applyToActiveLayer bool) string {
	var block, resultFields string
	switch mode {
	case "clouds":
		block = "var rDesc = new ActionDescriptor();\n" +
			"    executeAction(cTID('Clds'), rDesc, DialogModes.NO);"
	case "difference_clouds":
		block = "var rDesc = new ActionDescriptor();\n" +
			"    executeAction(cTID('DfrC'), rDesc, DialogModes.NO);"
	case "fibers":
		v := jsNum(numParam(p, "variance", 16))
		s := jsNum(numParam(p, "strength", 4))
		seed := jsNum(numParam(p, "seed", 12345))
		block = "var rDesc = new ActionDescriptor();\n" +
			"    rDesc.putInteger(cTID('Vrnc'), " + v + ");\n" +
			"    rDesc.putInteger(cTID('Strg'), " + s + ");\n" +
			"    rDesc.putInteger(cTID('RndS'), " + seed + ");\n" +
			"    executeAction(cTID('Fbrs'), rDesc, DialogModes.NO);"
		resultFields = "variance: " + v + ", strength: " + s + ", seed: " + seed + ","
	}
	return fmt.Sprintf(
		tpl[vault.FilterMulti],
		filterPrologue("Render", applyToActiveLayer, false, true),
		block,
		jsLit("Render"),
		jsLit(mode),
		resultFields,
	)
}

// applyOther — Filter > Other family. maximum/minimum share
// Rds + preserveShape (roundness=Rndn charID / squareness=stringID — both
// captured); offset = Hrzn/Vrtc + fill hardcoded to wrap (Wrp), its other fill
// modes deferred. Shares the FilterMulti skeleton.
func applyOther(mode string, p map[string]any, applyToActiveLayer bool) string {
	var block, resultFields string
	switch mode {
	case "maximum", "minimum":
		rds := jsNum(numParam(p, "radius", 3))
		preserve := strParam(p, "preserve", "roundness")
		preserveVal := "cTID('Rndn')"
		if preserve == "squareness" {
			preserveVal = "sTID('squareness')"
		}
		ev := "Mxm "
		if mode == "minimum" {
			ev = "Mnm "
		}
		block = "var oDesc = new ActionDescriptor();\n" +
			"    oDesc.putUnitDouble(cTID('Rds '), cTID('#Pxl'), " + rds + ");\n" +
			"    oDesc.putEnumerated(sTID('preserveShape'), sTID('preserveShape'), " + preserveVal + ");\n" +
			"    executeAction(cTID('" + ev + "'), oDesc, DialogModes.NO);"
		resultFields = "radius: " + rds + ", preserve: " + jsLit(preserve) + ","
	case "offset":
		h := jsNum(numParam(p, "horizontal", 0))
		v := jsNum(numParam(p, "vertical", 0))
		block = "var oDesc = new ActionDescriptor();\n" +
			"    oDesc.putInteger(cTID('Hrzn'), " + h + ");\n" +
			"    oDesc.putInteger(cTID('Vrtc'), " + v + ");\n" +
			"    oDesc.putEnumerated(cTID('Fl  '), cTID('FlMd'), cTID('Wrp '));\n" +
			"    executeAction(cTID('Ofst'), oDesc, DialogModes.NO);"
		resultFields = "horizontal: " + h + ", vertical: " + v + ","
	}
	return fmt.Sprintf(
		tpl[vault.FilterMulti],
		filterPrologue("Other", applyToActiveLayer, false, true),
		block,
		jsLit("Other"),
		jsLit(mode),
		resultFields,
	)
}

// applyDenoise — Filter > Noise reduction family. median uses
// Rds as unitDouble #Pxl; dust_and_scratches uses Rds as putInteger + Thsh;
// despeckle is parameterless. Shares the FilterMulti skeleton.
func applyDenoise(mode string, p map[string]any, applyToActiveLayer bool) string {
	var block, resultFields string
	switch mode {
	case "median":
		rds := jsNum(numParam(p, "radius", 4))
		block = "var nDesc = new ActionDescriptor();\n" +
			"    nDesc.putUnitDouble(cTID('Rds '), cTID('#Pxl'), " + rds + ");\n" +
			"    executeAction(cTID('Mdn '), nDesc, DialogModes.NO);"
		resultFields = "radius: " + rds + ","
	case "dust_and_scratches":
		rds := jsNum(numParam(p, "radius", 3))
		thsh := jsNum(numParam(p, "threshold", 10))
		block = "var nDesc = new ActionDescriptor();\n" +
			"    nDesc.putInteger(cTID('Rds '), " + rds + ");\n" +
			"    nDesc.putInteger(cTID('Thsh'), " + thsh + ");\n" +
			"    executeAction(cTID('DstS'), nDesc, DialogModes.NO);"
		resultFields = "radius: " + rds + ", threshold: " + thsh + ","
	case "despeckle":
		block = "var nDesc = new ActionDescriptor();\n" +
			"    executeAction(cTID('Dspc'), nDesc, DialogModes.NO);"
	}
	return fmt.Sprintf(
		tpl[vault.FilterMulti],
		filterPrologue("Noise Reduction", applyToActiveLayer, false, true),
		block,
		jsLit("Denoise"),
		jsLit(mode),
		resultFields,
	)
}

// applyBlurAdv — the lesser Blur-menu filters. surfaceBlur/
// boxblur are stringID events; average is charID Avrg (parameterless). smart_blur
// + shape_blur deferred (mode/quality enums + custom-shape ref). FilterMulti.
func applyBlurAdv(mode string, p map[string]any, applyToActiveLayer bool) string {
	var block, resultFields string
	switch mode {
	case "surface_blur":
		rds := jsNum(numParam(p, "radius", 15))
		thsh := jsNum(numParam(p, "threshold", 20))
		block = "var bDesc = new ActionDescriptor();\n" +
			"    bDesc.putUnitDouble(cTID('Rds '), cTID('#Pxl'), " + rds + ");\n" +
			"    bDesc.putInteger(cTID('Thsh'), " + thsh + ");\n" +
			"    executeAction(sTID('surfaceBlur'), bDesc, DialogModes.NO);"
		resultFields = "radius: " + rds + ", threshold: " + thsh + ","
	case "box_blur":
		rds := jsNum(numParam(p, "radius", 12))
		block = "var bDesc = new ActionDescriptor();\n" +
			"    bDesc.putUnitDouble(cTID('Rds '), cTID('#Pxl'), " + rds + ");\n" +
			"    executeAction(sTID('boxblur'), bDesc, DialogModes.NO);"
		resultFields = "radius: " + rds + ","
	case "average":
		block = "var bDesc = new ActionDescriptor();\n" +
			"    executeAction(cTID('Avrg'), bDesc, DialogModes.NO);"
	}
	return fmt.Sprintf(
		tpl[vault.FilterMulti],
		filterPrologue("Blur", applyToActiveLayer, false, true),
		block,
		jsLit("Blur"),
		jsLit(mode),
		resultFields,
	)
}
