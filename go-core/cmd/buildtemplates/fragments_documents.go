package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// newDocument. Slots: 1=getContextInfo, 2=width, 3=height, 4=resolution,
		// 5=colorMode (raw enum).
		vault.NewDoc: `
    %s

    var doc = app.documents.add(
      UnitValue(%s, 'px'),
      UnitValue(%s, 'px'),
      %s,
      'New Document',
      %s // TODO: validator enforces enum
    );
    return { id: doc.id, name: doc.name, context: getContextInfo() };
  `,

		// placeImage. Slots: 1=helperFunctions, 2=getContextInfo, 3=filePath(jsLit),
		// 4=filePath(jsLit), 5=x, 6=y, 7=widthPercent conditional line,
		// 8=heightPercent conditional line, 9=filePath(jsLit), 10=x, 11=y.
		vault.PlaceImg: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }

    var imageFile = new File(%s);
    if (!imageFile.exists) {
      throw new Error('Image file not found: ' + %s);
    }

    // Place image using ActionDescriptor. Verified against
    // ScriptListener UI ground truth — 2026-06-03 AM Descriptor Audit
    // STEP 40, spec at src/spec/ps27/place/place-embedded.ts. Wdth/Hght
    // are optional unitDouble #Prc scale percentages; PS treats absent
    // keys as 100%% (native size).
    var desc = new ActionDescriptor();
    desc.putPath(cTID('null'), imageFile);
    desc.putEnumerated(cTID('FTcs'), cTID('QCSt'), cTID('Qcsa'));

    var offsetDesc = new ActionDescriptor();
    offsetDesc.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), %s);
    offsetDesc.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), %s);
    desc.putObject(cTID('Ofst'), cTID('Ofst'), offsetDesc);

    %s
    %s

    executeAction(cTID('Plc '), desc, DialogModes.NO);

    var layer = app.activeDocument.activeLayer;
    var result = {
      placed: true,
      layerName: layer.name,
      filePath: %s,
      position: { x: %s, y: %s },
      layerBounds: {
        width: layer.bounds[2].as('px') - layer.bounds[0].as('px'),
        height: layer.bounds[3].as('px') - layer.bounds[1].as('px')
      },
      context: getContextInfo()
    };
    return result;
  `,

		// closeDocument. Slots: 1=getContextInfo, 2=resolution block (sets `doc` —
		// either the active document or a name/id match), 3=save option (literal).
		vault.CloseDoc: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    %s
    var closedName = doc.name;
    doc.close(%s);

    // After close, app.activeDocument may be a different doc or undefined.
    // getContextInfo() safely returns { hasDocument: false } when nothing is open.
    return {
      closed: true,
      closedName: closedName,
      context: getContextInfo()
    };
  `,

		// listDocuments. Slots: 1=getContextInfo.
		//
		// Deliberately does NOT throw when nothing is open. Every other document
		// snippet opens with the "No document is open" guard, which is right for a
		// snippet that needs a document — but this one exists precisely to be
		// callable in that state. It is the read an agent makes to find out WHY a
		// previous call failed, and throwing the same error again would make the
		// recovery path as opaque as the failure.
		//
		// Per-field try/catch is load-bearing: `fullName` THROWS on a document that
		// has never been saved (PS raises "The document has not yet been saved."
		// rather than returning null), and one unsaved scratch document must not
		// take the whole listing down.
		vault.ListDocs: `
    %s

    var __mcpDocs = [];
    var __mcpActiveId = null;
    try { __mcpActiveId = app.activeDocument.id; } catch (eActive) {}

    for (var __mcpI = 0; __mcpI < app.documents.length; __mcpI++) {
      var __mcpD = app.documents[__mcpI];
      var __mcpPath = null;
      try { __mcpPath = __mcpD.fullName.fsName; } catch (ePath) {}
      var __mcpSaved = null;
      try { __mcpSaved = __mcpD.saved; } catch (eSaved) {}
      var __mcpW = null;
      var __mcpH = null;
      try { __mcpW = __mcpD.width.as('px'); __mcpH = __mcpD.height.as('px'); } catch (eDim) {}
      __mcpDocs.push({
        index: __mcpI,
        id: __mcpD.id,
        name: String(__mcpD.name),
        path: __mcpPath,
        saved: __mcpSaved,
        active: (__mcpActiveId !== null && __mcpD.id === __mcpActiveId),
        width_px: __mcpW,
        height_px: __mcpH
      });
    }

    return { count: __mcpDocs.length, documents: __mcpDocs, context: getContextInfo() };
  `,

		// activateDocument. Slots: 1=getContextInfo, 2=resolution block (sets `doc`).
		vault.ActivateDoc: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No documents are open in Photoshop');
    }
    %s
    app.activeDocument = doc;
    return {
      activated: true,
      id: doc.id,
      name: String(doc.name),
      context: getContextInfo()
    };
  `,

		// resizeImage. Slots: 1=getContextInfo, 2=width, 3=height.
		vault.ResizeImg: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    doc.resizeImage(
      UnitValue(%s, 'px'),
      UnitValue(%s, 'px'),
      null,
      ResampleMethod.BICUBIC
    );
    return {
      width: doc.width.as('px'),
      height: doc.height.as('px'),
      context: getContextInfo()
    };
  `,

		// cropDocument. Slots: 1=getContextInfo, 2=left, 3=top, 4=right, 5=bottom.
		vault.CropDoc: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var bounds = [%s, %s, %s, %s];
    doc.crop(bounds);

    return {
      cropped: true,
      newWidth: doc.width.as('px'),
      newHeight: doc.height.as('px'),
      context: getContextInfo()
    };
  `,

		// openDocumentPipeline. Slots: 1=getContextInfo, 2=bitsPerChannelHelper,
		// 3=isWindows(jsBool), 4=filePath(already-open compare), 5=filePath,
		// 6=filePath, 7=filePath, 8=suppressDialogs(literal), 9=filePath. (The
		// bits_per_channel comment had backtick chars in the TS source;
		// reproduced with plain punctuation — behaviorally inert.)
		//
		// ALREADY-OPEN GUARD (2026-07-31): app.open() on a path Photoshop already
		// has open does NOT activate it — PS opens a SECOND copy named "<name>-2"
		// with a fresh Background. An agent that re-opens a file it opened earlier
		// then edits the empty duplicate and silently loses its work (observed
		// live 2026-07-30). Scan app.documents first and activate the match on
		// fullName.fsName (NOT d.name, which would false-match an unrelated
		// same-named file), each read individually try/caught because fullName
		// THROWS on an unsaved document. Returns already_open:true so the caller
		// can tell the difference; `false` for a genuinely new open.
		//
		// Case handling differs from ProbeOpenDoc (2026-08-01, QA finding): that
		// sibling folds case only on Windows, which is wrong on the COMMON macOS
		// setup — default APFS is case-INSENSITIVE, so /p/A.jpg and /p/a.jpg are
		// one file and an OS-based guess misses the duplicate. Case sensitivity is
		// a property of the VOLUME, not the OS, so this emitter probes it (flip the
		// basename's case, ask whether it still resolves) instead of guessing.
		// Exact matches never reach the probe.
		//
		// EXISTS-CHECK GATE (2026-08-04): the on-disk check is gated on there
		// being no already-open match — when the scan matched, the file on disk
		// is not an input to the activation path. Scope, measured live on PS
		// 27.2.0 rather than assumed:
		//
		//   - It does NOT rescue a moved/deleted backing file, despite the
		//     obvious reading. Once the file stops resolving, doc.fullName THROWS
		//     "The document has not yet been saved." — PS drops the path
		//     association entirely, so the scan's per-document try/catch skips
		//     that document and there is no match for the gate to consult.
		//     Repro: open a file, delete it on disk, then read
		//     app.activeDocument.fullName. Do not re-derive the moved-file theory
		//     from the code shape — it was already investigated and ruled out.
		//   - The reachable case is the narrower one where the scan matched and
		//     the File(...).exists read still returns false — a permission or
		//     sandbox quirk, or a flaky network volume. Note this covers the
		//     EXACT-match path only: a case-differing match is itself gated on
		//     __mcpVolumeIsCaseInsensitive, whose probe is another .exists read,
		//     so it fails under the very conditions described here.
		//
		// (Kept out here rather than inside the raw string: fragment comments
		// ship in every emitted script across the COM/AppleScript boundary.)
		vault.OpenDoc: `
    %s
    %s

    var __mcpIsWindows = %s;

    // Separator folding is safe everywhere (macOS/Linux paths never contain
    // backslashes); CASE folding is not, so it is decided separately below.
    function __mcpNormSep(p) {
      return String(p).replace(/\\/g, '/');
    }

    // Is THIS volume case-insensitive? Windows/NTFS always is. Elsewhere it is
    // a property of the volume, not the OS: macOS ships case-INSENSITIVE APFS by
    // default (so /p/A.jpg and /p/a.jpg are one file, and skipping the fold
    // would miss the already-open document this guard exists to find), while
    // case-sensitive APFS variants and Linux are the opposite (where folding
    // would activate the WRONG document). Guessing from the OS gets one of those
    // two wrong, so probe the actual filesystem: flip the case of the target's
    // basename and ask whether it still resolves. Runs at most once, and only
    // when a case-differing candidate is actually in play — the exact-match path
    // never pays for it.
    var __mcpCaseFold = null;
    function __mcpVolumeIsCaseInsensitive(targetPath) {
      if (__mcpIsWindows) return true;
      if (__mcpCaseFold !== null) return __mcpCaseFold;
      __mcpCaseFold = false;
      try {
        var p = String(targetPath);
        var cut = p.lastIndexOf('/');
        var dir = cut >= 0 ? p.substring(0, cut + 1) : '';
        var base = cut >= 0 ? p.substring(cut + 1) : p;
        // Flip case so the probe path differs from the real one by case ALONE.
        var flipped = base.toUpperCase() === base ? base.toLowerCase() : base.toUpperCase();
        if (flipped !== base) {
          __mcpCaseFold = new File(dir + flipped).exists;
        }
      } catch (eProbe) {
        __mcpCaseFold = false; // unknown → the conservative (case-sensitive) read
      }
      return __mcpCaseFold;
    }

    var __mcpTargetPath = __mcpNormSep(%s);
    var __mcpAlready = null;
    var __mcpCaseCandidate = null;
    for (var __mcpJ = 0; __mcpJ < app.documents.length; __mcpJ++) {
      var __mcpOpenPath = null;
      // fullName THROWS on an unsaved/untitled document — guard each read or a
      // scratch doc aborts the whole scan.
      try { __mcpOpenPath = app.documents[__mcpJ].fullName.fsName; } catch (eFn) { continue; }
      if (!__mcpOpenPath) { continue; }
      var __mcpOpenNorm = __mcpNormSep(__mcpOpenPath);
      if (__mcpOpenNorm === __mcpTargetPath) {
        __mcpAlready = app.documents[__mcpJ];   // exact — correct on every volume
        break;
      }
      if (__mcpOpenNorm.toLowerCase() === __mcpTargetPath.toLowerCase()) {
        __mcpCaseCandidate = app.documents[__mcpJ]; // only if the volume folds case
      }
    }
    if (!__mcpAlready && __mcpCaseCandidate && __mcpVolumeIsCaseInsensitive(__mcpTargetPath)) {
      __mcpAlready = __mcpCaseCandidate;
    }

    var imageFile = new File(%s);
    // Required only when we are actually going to OPEN it; see the EXISTS-CHECK
    // GATE note on this fragment for the measured scope.
    if (!__mcpAlready && !imageFile.exists) {
      throw new Error('File not found: ' + %s);
    }

    var ext = %s.split('.').pop().toLowerCase();
    var rawExts = ['heic','heif','raw','cr2','cr3','nef','arw',
                   'orf','rw2','dng','raf','pef','srw'];
    var isRaw = false;
    for (var i = 0; i < rawExts.length; i++) {
      if (rawExts[i] === ext) { isRaw = true; break; }
    }

    var prevDialogs = app.displayDialogs;
    if (%s) {
      app.displayDialogs = DialogModes.NO;
    }

    try {
      var doc;
      var __mcpWasAlreadyOpen = false;
      if (__mcpAlready) {
        // Activate the existing document instead of opening a duplicate.
        // A FAILED activation must not be swallowed: reporting success while
        // app.activeDocument still points elsewhere means every following tool
        // call silently edits the wrong document. Throw so the caller sees it.
        try {
          app.activeDocument = __mcpAlready;
        } catch (eAct) {
          throw new Error(
            'The file is already open but could not be made active (' +
            (eAct && eAct.message ? eAct.message : String(eAct)) +
            '). Photoshop may have a modal dialog open — dismiss it and retry.'
          );
        }
        doc = __mcpAlready;
        __mcpWasAlreadyOpen = true;
      } else {
        doc = app.open(imageFile);
      }
      return {
        success: true,
        already_open: __mcpWasAlreadyOpen,
        document_name: doc.name,
        width_px: Math.round(doc.width.as('px')),
        height_px: Math.round(doc.height.as('px')),
        resolution: doc.resolution,
        color_mode: String(doc.mode),
        // doc.bitsPerChannel returns a BitsPerChannelType enum host object,
        // not a Number. Without coercion it serializes as {} and Claude
        // Desktop rejects the response (outputSchema says number). v0.7.2.
        bits_per_channel: getBitsPerChannelInt(doc),
        is_raw_source: isRaw,
        file_path: %s,
        context: getContextInfo()
      };
    } finally {
      app.displayDialogs = prevDialogs;
    }
  `,

		// probeOpenDocument (Phase 3b timeout re-probe). Runs ONLY on the
		// ps_open_document timeout path, after the cscript/osascript child has
		// already been killed — Photoshop is a SEPARATE process and may have kept
		// executing the open to completion (a large RAW file's first Camera Raw
		// engine init routinely exceeds the wrapper's budget). Walks
		// app.documents — never trusts app.activeDocument, which is frequently
		// NOT the just-opened document (an unrelated scratch doc can stay active
		// while the target sits at another index) — and matches each open
		// document's d.fullName.fsName (NOT d.name, which would false-succeed
		// against an unrelated already-open same-named file) against the
		// requested path. Reading fullName THROWS "The document has not yet been
		// saved." for an unsaved/untitled document, so each read is individually
		// try/caught — an unguarded loop would abort on the first untitled
		// scratch doc in app.documents. Paths are compared case-insensitively
		// with backslashes normalized to forward slashes so a forward-slash
		// caller path still matches PS's backslash fsName on Windows. On a match,
		// the found document is made active (mirrors app.open()'s normal
		// behavior, so tool calls after a re-probed success target the right
		// doc) before the shared context helper reads app.activeDocument.
		// Slots: 1=getContextInfo, 2=bitsPerChannelHelper, 3=isWindows (jsBool —
		// F6, 2026-07 QA review), 4=filePath (target, compared), 5=filePath
		// (extension check), 6=filePath (echoed on success).
		//
		// F6 — __mcpNormPath used to lowercase + normalize separators
		// unconditionally. On a case-sensitive volume (the macOS default is
		// case-insensitive HFS+/APFS, but case-sensitive APFS variants exist and
		// are a documented option) that folded `/p/A.jpg` onto an already-open
		// `/p/a.jpg`, made the WRONG document active, and reported the probe as
		// having succeeded — every subsequent edit would then land on the wrong
		// file. Case-folding
		// and backslash normalization are only correct on Windows (NTFS is
		// case-insensitive and Windows paths use backslashes); everywhere else
		// compare case-sensitively and don't touch separators (macOS/Linux paths
		// never contain backslashes). isWindows is resolved once at build() time
		// via runtime.GOOS by the probeOpenDocument emitter below — the shipped
		// per-platform binary only ever runs on the OS it was built for, so this
		// reflects the actual host Photoshop is running on, not a build-time
		// cross-compile target.
		vault.ProbeOpenDoc: `
    %s
    %s

    var __mcpIsWindows = %s;
    function __mcpNormPath(p) {
      var s = String(p);
      if (__mcpIsWindows) {
        return s.replace(/\\/g, '/').toLowerCase();
      }
      return s;
    }

    var __mcpTarget = __mcpNormPath(%s);
    var __mcpFound = null;
    for (var __mcpI = 0; __mcpI < app.documents.length; __mcpI++) {
      var __mcpPath = null;
      try { __mcpPath = app.documents[__mcpI].fullName.fsName; } catch (eFn) { continue; }
      if (__mcpPath && __mcpNormPath(__mcpPath) === __mcpTarget) {
        __mcpFound = app.documents[__mcpI];
        break;
      }
    }

    if (!__mcpFound) {
      return { success: false };
    }

    try { app.activeDocument = __mcpFound; } catch (eAct) {}
    var doc = __mcpFound;

    var ext = %s.split('.').pop().toLowerCase();
    var rawExts = ['heic','heif','raw','cr2','cr3','nef','arw',
                   'orf','rw2','dng','raf','pef','srw'];
    var isRaw = false;
    for (var i = 0; i < rawExts.length; i++) {
      if (rawExts[i] === ext) { isRaw = true; break; }
    }

    return {
      success: true,
      reprobed: true,
      document_name: doc.name,
      width_px: Math.round(doc.width.as('px')),
      height_px: Math.round(doc.height.as('px')),
      resolution: doc.resolution,
      color_mode: String(doc.mode),
      bits_per_channel: getBitsPerChannelInt(doc),
      is_raw_source: isRaw,
      file_path: %s,
      context: getContextInfo()
    };
  `,

		// savePsdAsCopy. Slots: 1=getContextInfo, 2=outputPath, 3=maximizeCompat,
		// 4=outputPath.
		vault.SavePsd: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var saveFile = new File(%s);
    if (!saveFile.parent.exists) saveFile.parent.create();

    var opts = new PhotoshopSaveOptions();
    opts.layers = true;
    opts.embedColorProfile = true;
    opts.maximizeCompatibility = %s;
    opts.annotations = true;
    opts.alphaChannels = true;
    opts.spotColors = true;

    // asCopy=true → working document keeps its original filename and
    // dirty state. Extension.LOWERCASE normalizes the .psd suffix.
    doc.saveAs(saveFile, opts, true, Extension.LOWERCASE);

    return {
      success: true,
      saved_to: %s,
      document_name: doc.name,
      layers: doc.layers.length,
      context: getContextInfo()
    };
  `,

		// exportJpegPipeline. Slots: 1=getContextInfo, 2=convertSrgb(jsBool),
		// 3=longEdge conditional block, 4=outputPath, 5=quality, 6=embedProfile,
		// 7=outputPath.
		vault.ExportJpg: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var orig = app.activeDocument;
    var dup = orig.duplicate(orig.name + ' __mcp_export_jpeg__');

    try {
      dup.flatten();

      if (%s) {
        dup.convertProfile('sRGB IEC61966-2.1', Intent.RELATIVECOLORIMETRIC, true, false);
      }

      %s

      var saveFile = new File(%s);
      if (!saveFile.parent.exists) saveFile.parent.create();

      var opts = new JPEGSaveOptions();
      opts.quality = %s;
      opts.embedColorProfile = %s;
      opts.formatOptions = FormatOptions.STANDARDBASELINE;
      opts.matte = MatteType.NONE;
      opts.scans = 3;

      dup.saveAs(saveFile, opts, true, Extension.LOWERCASE);

      var finalW = Math.round(dup.width.as('px'));
      var finalH = Math.round(dup.height.as('px'));

      // Close the duplicate before returning so the working doc is active
      // when getContextInfo() snapshots state.
      try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}

      return {
        success: true,
        exported_to: %s,
        width_px: finalW,
        height_px: finalH,
        quality: opts.quality,
        context: getContextInfo()
      };
    } catch (err) {
      try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
      throw err;
    }
  `,

		// exportPngPipeline. Slots: 1=getContextInfo, 2=transparentBg(jsBool, in
		// `if (!X)`), 3=longEdge conditional block, 4=outputPath, 5=compression,
		// 6=outputPath, 7=transparentBg(jsBool, result).
		vault.ExportPng: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var orig = app.activeDocument;
    var dup = orig.duplicate(orig.name + ' __mcp_export_png__');

    try {
      if (!%s) {
        // Convert any Background layer to a normal layer so the new white
        // fill can sit below it. Without this, PLACEAFTER a locked
        // Background lands underneath and is occluded by Background's own
        // color when flattening.
        try {
          var lastLayer = dup.layers[dup.layers.length - 1];
          if (lastLayer.isBackgroundLayer) {
            lastLayer.isBackgroundLayer = false;
          }
        } catch (e) {}

        var white = new SolidColor();
        white.rgb.red = 255;
        white.rgb.green = 255;
        white.rgb.blue = 255;

        var bgLayer = dup.artLayers.add();
        bgLayer.move(dup.layers[dup.layers.length - 1], ElementPlacement.PLACEAFTER);
        dup.activeLayer = bgLayer;
        dup.selection.selectAll();
        dup.selection.fill(white);
        dup.selection.deselect();
        dup.flatten();
      }

      %s

      var saveFile = new File(%s);
      if (!saveFile.parent.exists) saveFile.parent.create();

      var opts = new PNGSaveOptions();
      opts.compression = %s;
      opts.interlaced = false;

      dup.saveAs(saveFile, opts, true, Extension.LOWERCASE);

      var finalW = Math.round(dup.width.as('px'));
      var finalH = Math.round(dup.height.as('px'));

      try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}

      return {
        success: true,
        exported_to: %s,
        width_px: finalW,
        height_px: finalH,
        transparent: %s,
        context: getContextInfo()
      };
    } catch (err) {
      try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
      throw err;
    }
  `,

		// convertImageMode — Image > Mode. Uses the documented DOM changeMode rather
		// than AM CnvM: live testing showed the CnvM mode-class charIDs for RGB/CMYK
		// are wrong (only Grys/LbCl matched), whereas changeMode is reliable for all
		// modes. The grayscale "Discard color information?" prompt is suppressed by
		// the wrapper's displayDialogs=NO. Slots: 1=getContextInfo, 2=ChangeMode enum
		// (RGB/GRAYSCALE/CMYK/LAB), 3=mode(jsLit). A capture confirmed the op.
		// convertImageModeBitmap — Image > Mode > Bitmap (Halftone Screen) via AM CnvM
		// (the DOM HalftoneScreenShape enum doesn't exist in ExtendScript). Flattens +
		// converts to grayscale first (both required for bitmap). Slots: 1=getContextInfo,
		// 2=frequency, 3=angle, 4=shape charID, then result: 5=frequency, 6=angle,
		// 7=shape(jsLit). Ground truth confirmed via ScriptListener capture.
		vault.ConvertBitmp: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var __modeBefore = String(doc.mode);

    // Bitmap requires a flattened, grayscale image.
    if (doc.layers.length > 1) { doc.flatten(); }
    if (doc.mode !== DocumentMode.GRAYSCALE) { doc.changeMode(ChangeMode.GRAYSCALE); }

    var cmDesc = new ActionDescriptor();
    var bmDesc = new ActionDescriptor();
    bmDesc.putUnitDouble(charIDToTypeID('Rslt'), charIDToTypeID('#Rsl'), doc.resolution);
    bmDesc.putEnumerated(charIDToTypeID('Mthd'), charIDToTypeID('Mthd'), charIDToTypeID('HlfS'));
    bmDesc.putUnitDouble(charIDToTypeID('Frqn'), charIDToTypeID('#Rsl'), %s);
    bmDesc.putUnitDouble(charIDToTypeID('Angl'), charIDToTypeID('#Ang'), %s);
    bmDesc.putEnumerated(charIDToTypeID('Shp '), charIDToTypeID('Shp '), charIDToTypeID('%s'));
    cmDesc.putObject(charIDToTypeID('T   '), charIDToTypeID('BtmM'), bmDesc);
    executeAction(charIDToTypeID('CnvM'), cmDesc, DialogModes.NO);

    return {
      converted: true,
      requested_mode: 'bitmap',
      halftone: { frequency: %s, angle: %s, shape: %s },
      mode_before: __modeBefore,
      mode_after: String(app.activeDocument.mode),
      context: getContextInfo()
    };
  `,

		vault.ConvertMode: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var __modeBefore = String(doc.mode);

    doc.changeMode(ChangeMode.%s);

    return {
      converted: true,
      requested_mode: %s,
      mode_before: __modeBefore,
      mode_after: String(app.activeDocument.mode),
      context: getContextInfo()
    };
  `,
	})
}
