package main

import (
	"fmt"
	"runtime"

	"editmamei-core/internal/vault"
)

// documents family (Phase 1). All change WHAT exists / WHAT is active, so they
// return the full getContextInfo(). placeImage needs cTID/sTID; the open
// pipeline needs the bitsPerChannel coercion helper.

// longEdgeResizeBlock builds the optional downscale-to-long-edge fragment
// shared by the JPEG/PNG export pipelines (BICUBICSHARPER). Empty unless a
// positive longEdgePx was supplied (mirrors the TS
// `${longEdgePx !== undefined && longEdgePx > 0 ? ... : ”}` guard).
func longEdgeResizeBlock(longEdgePx float64, has bool) string {
	if !has || longEdgePx <= 0 {
		return ""
	}
	le := jsNum(longEdgePx)
	return "var w = dup.width.as('px');\n" +
		"      var h = dup.height.as('px');\n" +
		"      var longEdge = (w > h) ? w : h;\n" +
		"      if (longEdge > " + le + ") {\n" +
		"        var scale = " + le + " / longEdge;\n" +
		"        var newW = Math.round(w * scale);\n" +
		"        var newH = Math.round(h * scale);\n" +
		"        dup.resizeImage(UnitValue(newW, 'px'), UnitValue(newH, 'px'), null, ResampleMethod.BICUBICSHARPER);\n" +
		"      }"
}

// newDocumentModeSet is the closed allowlist for the raw NewDocumentMode enum
// expression interpolated below — the registry rejects anything else before it
// can land a caller string as JS source. The values are the
// full `NewDocumentMode.<X>` expressions the TS colorModeMap produces.
var newDocumentModeSet = map[string]bool{
	"NewDocumentMode.RGB":       true,
	"NewDocumentMode.CMYK":      true,
	"NewDocumentMode.GRAYSCALE": true,
}

func newDocument(width, height, resolution float64, colorMode string) string {
	return fmt.Sprintf(
		tpl[vault.NewDoc],
		getContextInfo(),
		jsNum(width), jsNum(height), jsNum(resolution),
		colorMode, // raw enum (allow-listed against newDocumentModeSet in registry.build)
	)
}

func placeImage(filePath string, x, y float64, widthPercent, heightPercent float64, hasWidth, hasHeight bool) string {
	fp := jsLit(filePath)
	xs, ys := jsNum(x), jsNum(y)
	wCond := ""
	if hasWidth {
		wCond = "desc.putUnitDouble(cTID('Wdth'), cTID('#Prc'), " + jsNum(widthPercent) + ");"
	}
	hCond := ""
	if hasHeight {
		hCond = "desc.putUnitDouble(cTID('Hght'), cTID('#Prc'), " + jsNum(heightPercent) + ");"
	}
	return fmt.Sprintf(
		tpl[vault.PlaceImg],
		helperFunctions(),
		getContextInfo(),
		fp, fp, xs, ys,
		wCond, hCond,
		fp, xs, ys,
	)
}

func closeDocument(save bool) string {
	opt := "SaveOptions.DONOTSAVECHANGES"
	if save {
		opt = "SaveOptions.SAVECHANGES"
	}
	return fmt.Sprintf(tpl[vault.CloseDoc], getContextInfo(), opt)
}

func resizeImage(width, height float64) string {
	return fmt.Sprintf(tpl[vault.ResizeImg], getContextInfo(), jsNum(width), jsNum(height))
}

func cropDocument(left, top, right, bottom float64) string {
	return fmt.Sprintf(
		tpl[vault.CropDoc],
		getContextInfo(),
		jsNum(left), jsNum(top), jsNum(right), jsNum(bottom),
	)
}

// convertModeMap maps a user-facing mode name to the DOM ChangeMode enum
// constant. (AM CnvM mode-class charIDs for RGB/CMYK proved wrong in live
// testing, so the snippet uses the documented DOM changeMode instead.) The
// registry validates the key.
var convertModeMap = map[string]string{
	"grayscale": "GRAYSCALE",
	"rgb":       "RGB",
	"cmyk":      "CMYK",
	"lab":       "LAB",
}

// convertImageMode — Image > Mode via DOM changeMode. Document-wide; returns
// the full post-conversion document context.
func convertImageMode(mode string) string {
	return fmt.Sprintf(
		tpl[vault.ConvertMode],
		getContextInfo(),
		convertModeMap[mode],
		jsLit(mode),
	)
}

// halftoneShapeMap maps the user-facing dot shape to the PS Shp charID (AM CnvM
// BtmM). The registry validates the key. (Diamond captured; rest are the
// standard PS halftone-shape charIDs, live-verified.)
var halftoneShapeMap = map[string]string{
	"round":   "Rnd ",
	"diamond": "Dmnd",
	"ellipse": "Ellp",
	"line":    "Ln  ",
	"square":  "Sqr ",
	"cross":   "Crs ",
}

// convertImageModeBitmap — Image > Mode > Bitmap (Halftone Screen) via AM CnvM.
func convertImageModeBitmap(frequency, angle float64, shape string) string {
	f, a := jsNum(frequency), jsNum(angle)
	return fmt.Sprintf(tpl[vault.ConvertBitmp], getContextInfo(), f, a, halftoneShapeMap[shape], f, a, jsLit(shape))
}

func openDocumentPipeline(filePath string, suppressDialogs bool) string {
	return openDocumentPipelineForPlatform(filePath, suppressDialogs, runtime.GOOS == "windows")
}

// openDocumentPipelineForPlatform is the platform-parameterized emitter behind
// openDocumentPipeline. Split out for the same reason as
// probeOpenDocumentForPlatform: the already-open guard folds case/separators
// ONLY on Windows, and tests must exercise both branches without depending on
// the test host's own OS. isWindows comes from runtime.GOOS at call time, which
// is correct because this runs inside the per-platform shipped binary on the
// same machine as Photoshop (see the F6 note on probeOpenDocument).
func openDocumentPipelineForPlatform(filePath string, suppressDialogs bool, isWindows bool) string {
	fp := jsLit(filePath)
	return fmt.Sprintf(
		tpl[vault.OpenDoc],
		getContextInfo(),
		bitsPerChannelHelper(),
		jsBool(isWindows),
		fp, fp, fp, fp,
		jsBool(suppressDialogs),
		fp,
	)
}

// probeOpenDocument — Phase 3b post-timeout re-probe emitter. See the
// fragments.go comment on vault.ProbeOpenDoc for the full rationale; this
// assembles the fragment (getContextInfo + bitsPerChannelHelper + whether
// the host OS is Windows + the target path, interpolated 3x: compared,
// extension-checked, echoed).
//
// F6 (2026-07 QA review): isWindows is resolved via runtime.GOOS, not a
// caller-supplied flag — this function runs INSIDE the shipped
// editmamei-core-<os>-<arch> binary, which only ever executes on the host
// OS it was built for (Photoshop drives the same machine this binary runs
// on), so runtime.GOOS at call time correctly reflects the real host.
func probeOpenDocument(filePath string) string {
	return probeOpenDocumentForPlatform(filePath, runtime.GOOS == "windows")
}

// probeOpenDocumentForPlatform is the platform-parameterized emitter behind
// probeOpenDocument — split out so tests can exercise both the
// Windows-normalizing and case-sensitive-elsewhere branches directly instead
// of depending on the test host's own OS.
func probeOpenDocumentForPlatform(filePath string, isWindows bool) string {
	fp := jsLit(filePath)
	return fmt.Sprintf(
		tpl[vault.ProbeOpenDoc],
		getContextInfo(), bitsPerChannelHelper(), jsBool(isWindows),
		fp, fp, fp,
	)
}

func savePsdAsCopy(outputPath string, maximizeCompat bool) string {
	op := jsLit(outputPath)
	return fmt.Sprintf(tpl[vault.SavePsd], getContextInfo(), op, jsBool(maximizeCompat), op)
}

func exportJpegPipeline(outputPath string, quality, longEdgePx float64, hasLongEdge, embedProfile, convertSrgb bool) string {
	op := jsLit(outputPath)
	return fmt.Sprintf(
		tpl[vault.ExportJpg],
		getContextInfo(),
		jsBool(convertSrgb),
		longEdgeResizeBlock(longEdgePx, hasLongEdge),
		op,
		jsNum(quality),
		jsBool(embedProfile),
		op,
	)
}

func exportPngPipeline(outputPath string, transparentBg bool, longEdgePx float64, hasLongEdge bool, compression float64) string {
	op := jsLit(outputPath)
	tb := jsBool(transparentBg)
	return fmt.Sprintf(
		tpl[vault.ExportPng],
		getContextInfo(),
		tb,
		longEdgeResizeBlock(longEdgePx, hasLongEdge),
		op,
		jsNum(compression),
		op,
		tb,
	)
}
