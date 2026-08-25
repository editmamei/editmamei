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

// DocTarget names ONE open document. The zero value (neither field set) means
// "whatever is active", which is every pre-existing caller's behaviour.
type DocTarget struct {
	Name    string
	HasName bool
	ID      float64
	HasID   bool
}

// documentResolutionBlock emits the JS that binds `doc`.
//
// Ambiguity is an ERROR, never a pick. Photoshop happily keeps two documents
// open under the same name (the same basename from different directories, or a
// duplicate), and silently choosing one would send every subsequent edit to a
// document the caller did not mean — the same class of bug the openDocument
// case-folding comment above records. A miss lists the open names for the same
// reason ps_* lookups list candidates: the recovery is usually obvious once you
// can see what IS there.
func documentResolutionBlock(t DocTarget) string {
	if !t.HasName && !t.HasID {
		return "var doc = app.activeDocument;"
	}
	byName := "false"
	target := "null"
	label := "'id ' + " + jsNum(t.ID)
	if t.HasName {
		byName = "true"
		target = jsLit(t.Name)
		label = "'name \"' + " + jsLit(t.Name) + " + '\"'"
	}
	return "" +
		"var __mcpByName = " + byName + ";\n" +
		"    var __mcpTargetName = " + target + ";\n" +
		"    var __mcpTargetId = " + jsNum(t.ID) + ";\n" +
		"    var __mcpMatches = [];\n" +
		"    var __mcpNames = [];\n" +
		"    for (var __mcpI = 0; __mcpI < app.documents.length; __mcpI++) {\n" +
		"      var __mcpD = app.documents[__mcpI];\n" +
		"      __mcpNames.push(String(__mcpD.name));\n" +
		"      if (__mcpByName) {\n" +
		"        if (String(__mcpD.name) === __mcpTargetName) { __mcpMatches.push(__mcpD); }\n" +
		"      } else if (__mcpD.id === __mcpTargetId) {\n" +
		"        __mcpMatches.push(__mcpD);\n" +
		"      }\n" +
		"    }\n" +
		"    if (__mcpMatches.length === 0) {\n" +
		"      throw new Error('No open document matches ' + " + label + " + '. Open documents: ' + __mcpNames.join(', '));\n" +
		"    }\n" +
		"    if (__mcpMatches.length > 1) {\n" +
		"      throw new Error(__mcpMatches.length + ' open documents share ' + " + label + " + ' — target by id instead. Open documents: ' + __mcpNames.join(', '));\n" +
		"    }\n" +
		"    var doc = __mcpMatches[0];"
}

// docTargetFrom reads the optional `name` / `id` selector. `required` is set by
// callers that cannot fall back to the active document.
//
// Supplying both is rejected rather than silently ranked. The two can disagree
// (an id that names a different document than the name does), and picking a
// winner would resolve that disagreement invisibly — the caller should say which
// one it means.
func docTargetFrom(params map[string]any, required bool) (DocTarget, error) {
	name, hasName := optStrParam(params, "name")
	id, hasID := optNumParam(params, "id")
	if hasName && name == "" {
		hasName = false
	}
	if hasName && hasID {
		return DocTarget{}, fmt.Errorf("pass either name or id, not both")
	}
	if required && !hasName && !hasID {
		return DocTarget{}, fmt.Errorf("a name or id is required")
	}
	return DocTarget{Name: name, HasName: hasName, ID: id, HasID: hasID}, nil
}

func listDocuments() string {
	return fmt.Sprintf(tpl[vault.ListDocs], getContextInfo())
}

func activateDocument(t DocTarget) string {
	return fmt.Sprintf(tpl[vault.ActivateDoc], getContextInfo(), documentResolutionBlock(t))
}

func closeDocument(save bool, t DocTarget) string {
	opt := "SaveOptions.DONOTSAVECHANGES"
	if save {
		opt = "SaveOptions.SAVECHANGES"
	}
	return fmt.Sprintf(tpl[vault.CloseDoc], getContextInfo(), documentResolutionBlock(t), opt)
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
