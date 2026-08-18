// Package vault holds the at-rest encryption key for the embedded snippet
// template blob, plus the opaque fragment keys shared between the build-time
// generator (cmd/buildtemplates) and the runtime decrypt path (secret.go).
//
// CE posture (R1.10): the key ships inside the binary and is RECOVERABLE — the
// bytes below are printable ASCII, so a `strings` dump surfaces the key itself,
// not just the ciphertext. That is accepted, not a defect: the protection is
// OBFUSCATION of the template bodies (extracting them still means finding this
// key and replicating the decrypt — real work, not file-browsing), NOT key
// secrecy. Don't (re)add a comment claiming the key is hidden or that `strings`
// only shows ciphertext; it isn't and it doesn't. PRO posture (later): this key
// is NOT embedded; it arrives with the activated license token and is injected
// at runtime. Same decrypt path, different key source.
package vault

// Key is the AES-256 key for the template blob. Dev/CE key — Phase 0.
// (32 bytes.) Pro builds will source this from the license instead of a
// compiled-in literal.
var Key = []byte{
	0x4d, 0x65, 0x64, 0x69, 0x61, 0x6d, 0x65, 0x69,
	0x2d, 0x63, 0x6f, 0x72, 0x65, 0x2d, 0x76, 0x30,
	0x2d, 0x70, 0x68, 0x61, 0x73, 0x65, 0x30, 0x2d,
	0x6b, 0x65, 0x79, 0x2d, 0x33, 0x32, 0x62, 0x21,
}

// Opaque fragment keys. Deliberately neutral (no JSX/identifier substrings) so
// the key literals themselves — which DO appear in `strings` as ordinary Go
// string constants — don't tip any descriptor/helper names.
const (
	MinCtx       = "h0"  // getMinimalContextInfo helper body
	DupCopy      = "d1"  // duplicateForOp — auto-duplicate branch (has one %s slot)
	DupActive    = "d2"  // duplicateForOp — apply-to-active branch
	FiltPro      = "fp0" // shared filter prologue (guard + duplicate + layer + kind check)
	FiltRast     = "fp1" // filter prologue's rasterize block
	FiltRastTrk  = "fp2" // filter prologue's rasterize block, recording whether it fired
	FiltRastSO   = "fp3" // filter prologue's rasterize block, riding a Smart Object instead
	FiltKindNorm = "fp4" // filter prologue's kind guard — requires a pixel layer
	FiltKindSO   = "fp5" // filter prologue's kind guard — requires a Smart Object
	GBlur        = "f1"  // applyGaussianBlur skeleton
	USharp       = "f2"  // applyUnsharpMask skeleton
	ANoise       = "f3"  // applyAddNoise skeleton
	MBlur        = "f4"  // applyMotionBlur skeleton
	LensBlur     = "f5"  // applyLensBlur (AM Bokh)
	SmartShrp    = "f6"  // applySmartSharpen
	RedNoise     = "f7"  // applyReduceNoise
	HighPass     = "f8"  // applyHighPass
	RadialBlur   = "f9"  // applyRadialBlur (AM RdlB; spin/zoom + quality + center)
	Pixelate     = "f10" // applyPixelate (AM ClrH color-halftone / Msc mosaic)
	Distort      = "f11" // applyDistort (AM Twrl / Rple / Plr / Wave)
	OilPaint     = "f12" // applyOilPaint (AM oilPaint)
	Displace     = "f13" // applyDisplace (AM Dspl + map-file putPath)
	FilterMulti  = "f14" // shared multi-mode filter skeleton (stylize/render/other/denoise/blur); label + block built by the emitter

	// layer-properties — trivial single-assignment setters
	SetOpacity = "p1" // setLayerOpacity
	SetBlend   = "p2" // setLayerBlendMode
	SetVis     = "p3" // setLayerVisibility
	SetLock    = "p4" // setLayerLocked
	Rename     = "p5" // renameLayer
	SetFillOp  = "p6" // setLayerOpacityFull (fillOpacity + optional opacity)

	// Shared helper bodies (interpolated into snippet skeletons).
	Ctx     = "hctx" // getContextInfo (full context) helper body
	RCC     = "hrcc" // restoreCompositeChannel helper
	GSI     = "hgsi" // getSelectionInfo function (RCC prepended by emitter)
	SelType = "hsth" // selectionTypeHelpers (map/has/save/combine)

	// LayerResolve — independent layer re-resolution helpers (Phase 2
	// write-verification, 2026-07): captureLayerIdentity/resolveLayerFresh,
	// interpolated into the five ps_set_layer property setters + fillOpacity.
	LayerResolve = "hlr"

	// LayerCountRecursive — Phase 4 layer-count-mislabel fix (2026-07):
	// __countLayersRecursive(layers) walks every level (instanceof LayerSet,
	// not layer.typename) and counts every layer including groups
	// themselves, unlike doc.layers.length (top-level only). Prepended to
	// getContextInfo's output (same pattern as RCC/GSI) so total_layer_count
	// is available wherever getContextInfo is — including getMetadata's
	// result.document block, which reuses it. Mirrored byte-for-byte
	// (modulo whitespace/comments) in src/api/extendscript/_helpers.ts's
	// countLayersRecursiveHelper.
	LayerCountRecursive = "hlcr"

	// ParentPath / HoistGroup — Phase 4 layer-placement-bug fix (2026-07).
	// ParentPath reports where a newly-created layer actually landed
	// (recursive doc.layers walk, identity match — NOT layer.typename).
	// HoistGroup moves a just-created layer back out of the group that was
	// active before the Mk call (Photoshop's native "relative to current
	// target" nesting) unless into_active_group opted in. Interpolated into
	// every layer-creation snippet in the newLayer/createGroup/addFillLayer/
	// layerViaCopy/createShape/addAdjustmentLayer/duplicateLayer/
	// createTextLayer family. Mirrored byte-for-byte (modulo
	// whitespace/comments) in src/api/extendscript/_helpers.ts.
	ParentPath = "hpp"
	HoistGroup = "hhg"

	// text family
	CreateText  = "tx1" // createTextLayer
	SetFont     = "tx2" // setTextFont
	SetTextClr  = "tx3" // setTextColor
	SetTextAlgn = "tx4" // setTextAlignment
	UpdateText  = "tx5" // updateTextContent

	// selection family
	SelRect    = "s1"  // selectRectangle
	Feather    = "s2"  // featherSelection
	SelAll     = "s3"  // selectAll
	Deselect   = "s4"  // deselect
	InvertS    = "s5"  // invertSelection
	SelState   = "s6"  // getSelectionState
	ColorRange = "s7"  // selectColorRange
	MagicWand  = "s8"  // magicWand
	SelPreview = "s9"  // getSelectionPreview
	SaveSelCh  = "s10" // saveSelectionToChannel
	LoadSelCh  = "s11" // loadSelectionFromChannel
	LumRange   = "s12" // selectLuminanceRange (AM ClrR; Hghl/Shdw/Mdtn)
	RefineEdge = "s13" // refineEdge (AM smartBrushWorkspace; Select-and-Mask sliders)
	SelEllipse = "s14" // selectEllipse (AM setd Elps; AntA + optional baked Fthr)
	ModifySel  = "s15" // modifySelectionEdge (AM Expn/Cntc/Brdr/Smth)
	GrowSel    = "s16" // growSelection (AM Grow/Smlr; Tlrn + AntA)
	SelClrPre  = "s17" // selectColorPreset (AM ClrR Clrs enum; skinTone/OtOf)
	SelPolygon = "s18" // selectPolygon (AM setd Plgn; Pts list of Pnt Hrzn/Vrtc)
	XformSel   = "s19" // transformSelection (AM Trnf on fsel; scale/rotate/offset)
	ChanDup    = "s20" // duplicateChannel (DOM alpha-channel duplicate)
	ChanDel    = "s21" // deleteChannel (DOM channel.remove; alpha-only guard)

	// Native-AI family — Adobe's own inference exposed directly; we ship no
	// weights for any of it. selectSubject/selectSky sit at pro1/pro2 for
	// historical reasons (they predate the move to CE). Note focusMask is NOT
	// Sensei: it is a blur-estimation algorithm from PS CC 2014, grouped here
	// only because it is likewise Adobe's own inference rather than ours.
	//
	// Verification status, PS 27.2.0 / Windows. Delete this block at the tier
	// flip; it is here because both tools sit at dev and the gaps below are the
	// promotion gate.
	//   SelFocus — run end-to-end against live PS. 08-15: three parameter
	//              variants, both params confirmed to affect output. 08-16,
	//              after the retarget/deselect/restore work: a Curves adjustment
	//              layer returned the same 51.4% selection as the Background,
	//              and an unmeasurable layer produced the honest "selected
	//              nothing" error instead of a stale one. NOT yet run with a
	//              pre-existing selection in replace mode, which is the one path
	//              the unconditional stash newly touches.
	//   SkyRepl  — composited correctly against live PS on a sky-dominant image
	//              (08-16): the group and its four layers materialised and the
	//              supplied sky rendered. Caveat: that run used the build BEFORE
	//              the lighting-mode parameter was removed. The current body
	//              differs only by hardcoding a field Photoshop demonstrably
	//              ignores — 'Scrn' and 'Mltp' produced byte-identical renders —
	//              so the descriptor is functionally the same, but this exact
	//              body has not itself composited a sky.
	// Both: verified on Windows only. A macOS descriptor capture is owed before
	// promotion — Windows-lenient shapes have been macOS-strict-rejected before.
	SelFocus = "ai1" // focusMask (AM focusMask; depth-of-field selection, no coords)
	SkyRepl  = "ai2" // skyReplacement (AM skyReplacement; sky group + lighting layers)

	// more shared helpers
	HelperFns = "hfn"  // helperFunctions (cTID/sTID)
	BitsPerCh = "hbpc" // bitsPerChannelHelper
	NormName  = "hnn"  // normNameHelper (dash/whitespace/case normalizer)
	GPI       = "hgpi" // getPathInfo (path inventory: count + kind/subpath/anchor counts)
	NotFound  = "hnf"  // notFoundMessageHelper (name-miss error that lists the available names)

	// path-interchange family
	PathCreate  = "pa1" // createPathFromSelection (DOM makeWorkPath; clears selection)
	PathSave    = "pa2" // savePath (AM make named path from work path; verified live 2026-06-24)
	PathList    = "pa3" // listPaths (DOM pathItems iteration; read-only)
	PathDelete  = "pa4" // deletePath (DOM pathItem.remove)
	PathLoadSel = "pa5" // loadPathAsSelection (DOM PathItem.makeSelection)
	PathStroke  = "pa6" // strokePath (DOM PathItem.strokePath; auto-duplicate-first)
	PathFill    = "pa7" // fillPath (DOM PathItem.fillPath; auto-duplicate-first)
	PathClip    = "pa8" // setClippingPath (DOM PathItem.makeClippingPath)
	PathFromPts = "pa9" // createPathFromPoints (grounded pen: named path from a resolved polyline)

	// vector-mask family (AM; add/delete/link/unlink verified live 2026-06-24)
	VMAdd    = "vm1" // addVectorMask (Mk path At=vectorMask Usng=active path)
	VMDel    = "vm2" // deleteVectorMask (Dlt on vectorMask channel)
	VMLink   = "vm3" // setVectorMaskLink (setd vectorMaskLinked boolean)
	VMFill   = "vm4" // addVectorMaskFill (Mk path At=vectorMask Usng=enum RvlA/HdAl)
	VMEnable = "vm5" // setVectorMaskEnabled (setd vectorMaskEnabled boolean)

	// channel-compose family (AM AppI / Mk-Chnl-Using-Clcl).
	// Ground truth confirmed via ScriptListener capture.
	ApplyImage   = "ci1" // applyImage (AM AppI; composite source layer+channel onto active layer)
	Calculations = "ci2" // calculations (AM Mk Chnl Using Clcl; two sources → new alpha channel)

	// documents family
	NewDoc       = "doc1"  // newDocument
	PlaceImg     = "doc2"  // placeImage
	CloseDoc     = "doc3"  // closeDocument
	ResizeImg    = "doc4"  // resizeImage
	CropDoc      = "doc5"  // cropDocument
	OpenDoc      = "doc6"  // openDocumentPipeline
	SavePsd      = "doc7"  // savePsdAsCopy
	ExportJpg    = "doc8"  // exportJpegPipeline
	ExportPng    = "doc9"  // exportPngPipeline
	ConvertMode  = "doc10" // convertImageMode (DOM changeMode; grayscale/rgb/cmyk/lab)
	ConvertBitmp = "doc11" // convertImageModeBitmap (DOM BitmapConversionOptions halftone)
	ProbeOpenDoc = "doc12" // probeOpenDocument (Phase 3b post-timeout re-probe; walks app.documents, matches fullName.fsName)

	// groups family
	DeleteGroup  = "g1" // deleteGroup
	ClipMask     = "g2" // createClippingMask
	ReleaseClip  = "g3" // releaseClippingMask
	CreateGroup  = "g4" // createGroup
	MoveToGroup  = "g5" // moveLayerToGroup
	SetGroupMode = "g6" // setGroupBlendMode
	Ungroup      = "g7" // ungroup

	// layers family
	NewLayer       = "l1"  // newLayer
	DeleteLayer    = "l2"  // deleteLayer (outer)
	DelLayerNamed  = "l2a" // deleteLayer — named branch
	DelLayerActive = "l2b" // deleteLayer — active-layer branch
	FillLayer      = "l3"  // fillLayer
	DupLayer       = "l4"  // duplicateLayer
	MergeVis       = "l5"  // mergeVisibleLayers
	StampVis       = "l6"  // stampVisible
	FlattenImg     = "l7"  // flattenImage
	ConvertToSO    = "l8"  // convertToSmartObject
	LayerViaCopy   = "l9"  // layerViaCopy (CpTL on the active selection)
	BakeLayer      = "l10" // bakeLayer (hide-others + stamp clip group + restore)
	AddFillLayer   = "l11" // addFillLayer (Mk contentLayer; solid color for now)
	SONewViaCopy   = "l12" // newSmartObjectViaCopy (placedLayerMakeCopy; independent SO copy)
	CreateShape    = "l13" // createShape (Mk contentLayer; vector shape layer — rectangle/ellipse/line)
	AddGradFill    = "l14" // addGradientFillLayer (Mk contentLayer; gradientLayer w/ custom stops)

	// smart filters — the Smart-Object filter stack (m4a STEP-03/04/05/07).
	// Every write addresses one filter as a filterFX INDEX reference on the
	// target layer; the read walks the layer's smartObject compound instead
	// (the asymmetry is Photoshop's, not ours — see fragments_smartobject.go).
	SFGuard = "sf0" // shared smart-filter helpers (read/validate/reference/blend-mode table)
	SFList  = "sf1" // listSmartFilters (read: layer -> smartObject -> filterFX[])
	SFVis   = "sf2" // setSmartFilterVisibility (Hd /Shw  on a filterFX index ref)
	SFBlend = "sf3" // setSmartFilterBlend (setd filterFX.blendOptions)
	SFDel   = "sf4" // removeSmartFilter (Dlt  on a filterFX index ref)
	SOInfo  = "sf5" // getSmartObjectInfo (embedded/linked, source size, filter count)

	// gradients — shared stop-line building blocks (interpolated per stop into
	// the l14 / al9 stop-block slots; both call the makeColorStop/makeOpacityStop
	// helpers the host fragment defines)
	GradStopLine     = "gr1" // one colorStops.putObject(makeColorStop(...)) line
	GradOpacStopLine = "gr2" // one opacityStops.putObject(makeOpacityStop(...)) line
	GradRevLine      = "gr3" // conditional Rvrs=true line (omitted at the false default)

	// layer-properties (remaining)
	SelectLayer    = "lp1" // selectLayer
	RasterizeLayer = "lp2" // rasterizeLayer
	AddLayerStyle  = "lp3" // addLayerStyle
	AddLayerStyle2 = "lp4" // addLayerStyle later additions (inner_shadow/inner_glow/color_overlay)

	// history
	Undo       = "h1" // undo
	Redo       = "h2" // redo
	HistStates = "h3" // getHistoryStates

	// metadata
	PingState = "m1"  // pingState
	LayerTree = "m2"  // getLayerTree
	GetMeta   = "m3"  // getMetadata (outer)
	MetaSafe  = "m3a" // getMetadata — safe() fn block
	MetaDoc   = "m3b" // getMetadata — result.document block
	MetaIptc  = "m3c" // getMetadata — result.iptc block
	MetaExif  = "m3d" // getMetadata — result.dom_exif block

	// masks
	CreateMask = "mk1" // createLayerMask
	DeleteMask = "mk2" // deleteLayerMask
	ApplyMask  = "mk3" // applyLayerMask
	MaskGrad   = "mk4" // maskGradient (ensure mask + classic Grdn draw into the mask channel)

	// layer-transform (community subset)
	MoveToPos = "lt1" // moveLayerToPosition
	LtScaleXY = "lt2" // scaleLayerXY (non-uniform scale_x/scale_y)
	LtFlip    = "lt3" // flipLayer (AM Flip; horizontal/vertical)

	// M2 transform / warp / canvas / guides (dev-tier; raw-AM Trnf family).
	// Ground truth confirmed via ScriptListener capture.
	LtMatrix    = "lt4"  // transformLayerMatrix (AM Trnf; skew/free-numeric — conditional Skew obj)
	WarpPreset  = "lt5"  // warpLayer (AM Trnf → warp obj; style enum + bend/distort + computed bounds)
	CanvasRot   = "lt6"  // rotateCanvas (AM Rtte on Dcmn; arbitrary degrees)
	CanvasFlip  = "lt7"  // flipCanvas (AM Flip on Dcmn; horizontal/vertical)
	GuideAdd    = "lt8"  // addGuide (DOM doc.guides.add; orientation + position)
	GuideLayout = "lt9"  // addGuideLayout (AM newGuideLayout; colCount/rowCount)
	GuideClear  = "lt10" // clearGuides (AM clearAllGuides; zero-field)
	WarpMesh    = "lt11" // warpMesh (AM Trnf → quiltWarp custom mesh; pinned-edge grounded warp).

	// adjustments (smaller; addAdjustmentLayer comes in its own pass)
	ShadowsHL   = "a1" // applyShadowsHighlights
	ColorLookup = "a2" // applyColorLookup
	Equalize    = "a3" // applyEqualize

	// metadata — histogram + history-state preview
	GetHistogram  = "md4" // getHistogram
	RenderHistPrv = "md5" // renderHistoryStatePreview

	// addAdjustmentLayer — outer shell + per-type typeDesc building blocks
	AdjLOuter      = "al0"  // outer shell (helperFns, getCtx, scaffolding, Mk, return)
	AdjUsingClass  = "al0a" // using.putClass(cTID('Type'), typeCharID) — color_lookup/invert
	AdjUsingObject = "al0b" // using.putObject(cTID('Type'), typeCharID, typeDesc) — everything else
	AdjLvlPM       = "al15" // levels post-Mk setd (slots: blackPoint, whitePoint, gamma)
	AdjCrvPM       = "al16" // curves post-Mk setd (slots: curvePointsJs)
	AdjCLNote      = "al17" // color_lookup empty-layer note (static comment, no slots)
	// typeDesc building block per adjType
	AdjHSTd     = "al1"  // hue_saturation (slots: hue, sat, lightness)
	AdjBCTd     = "al2"  // brightness_contrast (slots: brightness, contrast)
	AdjBWTd     = "al3"  // black_and_white (slots: reds, yellows, greens, cyans, blues, magentas, tintBool, tintBlock)
	AdjBWTint   = "al3t" // BW tint sub-block (slots: bwTintHue, bwTintSaturation)
	AdjCBTd     = "al4"  // color_balance (slots: 9 CR/MG/YB values + preserveLuminosity)
	AdjPFTd     = "al5"  // photo_filter outer (slots: typeOrColorLine, pfDensity, pfPreserveLuminosity)
	AdjPFPset   = "al5p" // photo_filter preset line (slot: pfPresetId)
	AdjPFClr    = "al5c" // photo_filter custom-color block (slots: r, g, b)
	AdjPFFb     = "al5f" // photo_filter fallback-preset line (slot: pfFallbackPreset)
	AdjVibTd    = "al6"  // vibrance (slots: vibVibrance, vibSaturation)
	AdjCMMono   = "al7m" // channel_mixer monochrome (slots: R, G, B, constLine)
	AdjCMMonoK  = "al7k" // channel_mixer mono constant line (slot: cmGrayK value)
	AdjCMClr    = "al7c" // channel_mixer color (slots: rR,rG,rB,rK, gR,gG,gB,gK, bR,bG,bB,bK)
	AdjCMClrK   = "al7j" // channel_mixer color channel constant line (slot: channel-const value); used 3×
	AdjSCTd     = "al8"  // selective_color (slots: scMethodEnum, scEntriesJs)
	AdjGMTd     = "al9"  // gradient_map (slots: dither, reverse, gmName, colorStopsBlock)
	AdjGMBW     = "al9b" // gradient_map black-to-white stops (no slots)
	AdjGMSepia  = "al9s" // gradient_map sepia stops (no slots)
	AdjGMTint   = "al9t" // gradient_map tint stops (slots: r, g, b)
	AdjExpTd    = "al10" // exposure (slots: exposure, offset, gammaCorrection)
	AdjCLTd     = "al11" // color_lookup 3DLUT path-resolution (slot: lutName)
	AdjPosTd    = "al12" // posterize (slot: posLevels)
	AdjThrTd    = "al13" // threshold (slot: thrLevel)
	AdjLvlCrvTd = "al14" // levels/curves shared Mk typeDesc (static presetKindDefault line, no slots) — the post-Mk setd carries the real values; see AdjLvlPM/AdjCrvPM

	// applyBrushStroke — dev-tier; outer shell + conditional sub-blocks
	BrushOuter    = "br0"  // outer shell (slots: many)
	BrushFgColor  = "br1"  // foreground color setup block (slots: r, g, b)
	BrushPreset   = "br2"  // brush preset selection block (slot: jsLit(brush_preset))
	BrushSize     = "br3"  // brush size setd block (slot: brush_size)
	BrushClone    = "br4"  // clone source setd block (slots: sourceLayerExpr, srcX, srcY)
	BrushDynSave  = "br5"  // dynamics save block (no slots)
	BrushDynWrite = "br6"  // dynamics write-back block (no slots)
	BrushDynOp    = "br7"  // opacity mutation line (slot: opacity_pct)
	BrushDynFl    = "br8"  // flow mutation line (slot: flow_pct)
	BrushDynHd    = "br9"  // hardness mutation block (slot: hardness_pct)
	BrushDynRst   = "br10" // dynamics restore block (no slots)
	BrushPoint    = "br11" // one PathPointInfo construction (slots: i, i, kind, i, ax, ay, i, lx, ly, i, rx, ry)

	// Pro-tier snippet bodies (//go:build pro). The KEYS are opaque codes and
	// live here in the always-compiled vault — they are not IP. The FRAGMENT
	// BODIES they map to are defined only in the pro-tagged
	// cmd/buildtemplates/fragments_pro.go, so a CE-built templates.enc never
	// contains them and the CE binary's registry can't dispatch them.
	SelSubject = "pro1" // selectSubject (AM autoCutout + selectionTypeHelpers)
	SelSky     = "pro2" // selectSky (AM selectSky + selectionTypeHelpers)

	// layer-transform Pro family (move/rotate/scale/fit)
	LtFit   = "pro3" // fitLayerToDocument (getContextInfo + fit/fill)
	LtScale = "pro4" // scaleLayer (auto-promote bg + resize)
	LtRot   = "pro5" // rotateLayer (auto-promote bg + rotate)
	LtMove  = "pro6" // moveLayer shell (delta/absolute/center via inline block)

	// retouch Pro family (content-aware fill / patch / content-aware move)
	RtCAF   = "pro7" // applyContentAwareFill (AM Fl + blend-mode switch)
	RtPatch = "pro8" // applyPatch (AM patchSelection)
	RtCAM   = "pro9" // applyContentAwareMove (AM recomposeSelection)

	// action Pro family (list / play). executeCustomScript is NOT here — it
	// transforms user code (no IP) and lives in TS (src/api/custom-script.ts).
	ActList = "pro10" // listActions (getContextInfo + ASet/Actn iteration)
	ActPlay = "pro11" // playAction (app.doAction)

	// camera-raw Pro family (re-editable Camera Raw Smart Filter).
	// One fragment, three modes (apply / adjust_existing / read); the emitter
	// builds the per-slider put-block. Ground truth confirmed via
	// ScriptListener capture.
	CameraRaw = "pro12" // applyCameraRaw
)
