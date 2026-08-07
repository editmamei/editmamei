package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// pingState. No slots (uses charIDToTypeID directly, no cTID helper).
		vault.PingState: `
    var setCount = 0;
    var setIdx = 1;
    while (true) {
      var setRef = new ActionReference();
      setRef.putIndex(charIDToTypeID('ASet'), setIdx);
      try { executeActionGet(setRef); } catch (e) { break; }
      setCount++;
      setIdx++;
      if (setIdx > 256) break;
    }

    var openDocs = [];
    for (var i = 0; i < app.documents.length; i++) {
      try { openDocs.push(String(app.documents[i].name)); } catch (e) {}
    }

    return {
      version: String(app.version),
      action_sets_count: setCount,
      open_documents: openDocs
    };
  `,

		// getLayerTree. No slots. (The instanceof-LayerSet comment carried backtick
		// chars in the TS source; reproduced here with plain punctuation —
		// behaviorally inert.)
		vault.LayerTree: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Use instanceof LayerSet for type discrimination — layer.typename
    // is unreliable on COM-bridged DOM objects in some PS versions and was
    // the root cause of an earlier hang. Every property access is wrapped
    // in safe() to ensure a single bad layer doesn't take down the walk.
    function safe(fn, fallback) {
      try { var v = fn(); return (v === undefined ? fallback : v); }
      catch (e) { return fallback; }
    }

    var MAX_DEPTH = 32;

    function describeLayer(layer, depth) {
      var entry = {
        name: safe(function() { return layer.name; }, '<unnamed>'),
        visible: safe(function() { return layer.visible; }, true),
        opacity: safe(function() { return layer.opacity; }, 100),
        blendMode: safe(function() { return String(layer.blendMode); }, 'NORMAL')
      };

      var isGroup = false;
      try { isGroup = (layer instanceof LayerSet); } catch (e) {}

      if (isGroup) {
        entry.kind = 'GROUP';
        entry.children = [];
        if (depth >= MAX_DEPTH) {
          entry.truncated = true;
          return entry;
        }
        var nChildren = safe(function() { return layer.layers.length; }, 0);
        for (var i = 0; i < nChildren; i++) {
          var child = safe(function() { return layer.layers[i]; }, null);
          if (child) entry.children.push(describeLayer(child, depth + 1));
        }
      } else {
        entry.kind = safe(function() { return String(layer.kind); }, 'NORMAL');
        entry.isBackgroundLayer = safe(function() { return layer.isBackgroundLayer; }, false);
        entry.clipped = safe(function() { return layer.grouped; }, false);
        var bounds = safe(function() { return layer.bounds; }, null);
        if (bounds) {
          entry.bounds = {
            left: safe(function() { return bounds[0].as('px'); }, 0),
            top: safe(function() { return bounds[1].as('px'); }, 0),
            right: safe(function() { return bounds[2].as('px'); }, 0),
            bottom: safe(function() { return bounds[3].as('px'); }, 0)
          };
        }
      }
      return entry;
    }

    var tree = [];
    var nTop = safe(function() { return doc.layers.length; }, 0);
    for (var i = 0; i < nTop; i++) {
      var top = safe(function() { return doc.layers[i]; }, null);
      if (top) tree.push(describeLayer(top, 0));
    }

    return {
      documentName: safe(function() { return doc.name; }, '<unknown>'),
      activeLayer: safe(function() { return doc.activeLayer ? doc.activeLayer.name : null; }, null),
      topLevelCount: nTop,
      tree: tree
    };
  `,

		// getMetadata outer. Slots: 1=getContextInfo, 2=bitsPerChannel block,
		// 3=safe() fn block, 4=result.document block, 5=result.iptc block,
		// 6=result.dom_exif block. The blocks are toggled by the emitter per
		// opts.document/iptc/dom_exif.
		vault.GetMeta: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }

    %s

    var doc = app.activeDocument;
    var result = { context: getContextInfo() };

    %s

    %s

    %s

    return result;
  `,

		// getMetadata — safe() fn block (null-and-undefined variant).
		vault.MetaSafe: `function safe(fn, fallback) {
      try { var v = fn(); return (v === undefined || v === null) ? fallback : v; }
      catch (e) { return fallback; }
    }`,

		// getMetadata — result.document block. total_layer_count relies on
		// __countLayersRecursive, in scope via the getContextInfo() slot above
		// (Phase 4 layer-count-mislabel fix — see vault.LayerCountRecursive).
		vault.MetaDoc: `result.document = {
      name: doc.name,
      full_path: safe(function () { return doc.fullName.fsName; }, null),
      width_px: doc.width.as('px'),
      height_px: doc.height.as('px'),
      resolution: doc.resolution,
      color_mode: String(doc.mode),
      bits_per_channel: getBitsPerChannelInt(doc) || null,
      pixel_aspect_ratio: safe(function () { return doc.pixelAspectRatio; }, 1),
      color_profile_name: safe(function () { return doc.colorProfileName; }, null),
      channels: safe(function () { return doc.componentChannels.length; }, null),
      saved: safe(function () { return doc.saved; }, false),
      layer_count: doc.layers.length,
      total_layer_count: __countLayersRecursive(doc.layers)
    };`,

		// getMetadata — result.iptc block.
		vault.MetaIptc: `var info = safe(function () { return doc.info; }, {});
    result.iptc = {
      title: safe(function () { return info.title; }, null),
      author: safe(function () { return info.author; }, null),
      caption: safe(function () { return info.caption; }, null),
      copyright_notice: safe(function () { return info.copyrightNotice; }, null),
      copyrighted: safe(function () { return info.copyrighted; }, null),
      date_created: safe(function () { return info.dateCreated; }, null),
      keywords: safe(function () {
        var k = info.keywords;
        return (k && k.length) ? k.join(', ') : null;
      }, null),
      city: safe(function () { return info.city; }, null),
      province_state: safe(function () { return info.provinceState; }, null),
      country: safe(function () { return info.country; }, null),
      credit: safe(function () { return info.credit; }, null),
      source: safe(function () { return info.source; }, null),
      urgency: safe(function () { return info.urgency; }, null)
    };`,

		// getMetadata — result.dom_exif block.
		vault.MetaExif: `// doc.info.exif is an array of [name, value] pairs PS already parsed
    // from the open document. Reading this avoids re-opening the source
    // file on disk, which fails when the filename contains '?' or other
    // characters that ENOENT on re-open. Falls back to {} on any error.
    var domExif = safe(function () {
      var raw = doc.info.exif;
      if (!raw || !raw.length) return {};
      var out = {};
      for (var i = 0; i < raw.length; i++) {
        var pair = raw[i];
        if (pair && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
      }
      return out;
    }, {});
    result.dom_exif = domExif;`,

		// -----------------------------------------------------------------------
		// getHistogram. Slots: 1=getContextInfo body, 2=jsLit(channel).
		// -----------------------------------------------------------------------
		vault.GetHistogram: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var chName = %s;
    var modeStr = String(doc.mode);

    var bins = null;
    var resolvedChannel = chName;

    // Collect doc.channels into a lowercased name→object map. Used by
    // the luminosity dispatch and the composite fallback.
    function collectNamedChannels(d) {
      var map = {};
      for (var i = 0; i < d.channels.length; i++) {
        map[String(d.channels[i].name).toLowerCase()] = d.channels[i];
      }
      return map;
    }

    // Recursively find the first pixel (NORMAL) layer in the tree. Used
    // by the composite fallback when doc.histogram throws — PS 27.x
    // returns "The requested property does not exist" when the active
    // layer is an adjustment / fill / shape layer. Switching active to
    // a pixel layer makes doc.histogram succeed.
    function findFirstPixelLayer(layers, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        var isNormal = false;
        try { isNormal = (l.kind === LayerKind.NORMAL); } catch (eK) {}
        if (isNormal) return l;
        var isGroup = false;
        try { isGroup = (l instanceof LayerSet); } catch (eG) {}
        if (isGroup) {
          try {
            var f = findFirstPixelLayer(l.layers, depth + 1);
            if (f) return f;
          } catch (eD) {}
        }
      }
      return null;
    }

    // Composite read with two fallbacks:
    //   1. doc.histogram (the documented path).
    //   2. save active layer → switch to a pixel layer → retry → restore.
    //   3. synthesize from per-channel R+G+B (or Lab Lightness, or Gray).
    // Returns { bins, source } so the caller can record which path landed.
    function readCompositeBins() {
      try {
        var b1 = doc.histogram;
        if (b1 && b1.length > 0) return { bins: b1, source: 'doc-histogram' };
      } catch (e1) { /* try fallback */ }

      var savedActive = doc.activeLayer;
      var pixelLayer = null;
      try { pixelLayer = doc.backgroundLayer; } catch (eB) {}
      if (!pixelLayer) pixelLayer = findFirstPixelLayer(doc.layers, 0);
      if (pixelLayer && pixelLayer !== savedActive) {
        var got = null;
        try {
          doc.activeLayer = pixelLayer;
          var b2 = doc.histogram;
          if (b2 && b2.length > 0) got = b2;
        } catch (e2) { /* fall through to synth */ }
        // Restore active layer regardless of success/failure.
        try { doc.activeLayer = savedActive; } catch (eR) {}
        if (got) return { bins: got, source: 'doc-histogram-after-active-switch' };
      }

      var named = collectNamedChannels(doc);
      if (named.lightness) {
        return { bins: named.lightness.histogram, source: 'lab-lightness' };
      }
      if (named.gray) {
        return { bins: named.gray.histogram, source: 'grayscale' };
      }
      if (named.red && named.green && named.blue) {
        var hR = named.red.histogram;
        var hG = named.green.histogram;
        var hB = named.blue.histogram;
        var nC = Math.min(hR.length, hG.length, hB.length);
        var synth = [];
        // Float bins (no rounding) so the downstream mean computation
        // sees the true total pixel count and the mean stays exact.
        for (var iC = 0; iC < nC; iC++) {
          synth[iC] = (hR[iC] + hG[iC] + hB[iC]) / 3;
        }
        return { bins: synth, source: 'rgb-channel-average' };
      }
      throw new Error('Composite histogram unavailable and no fallback channels available (mode: ' + modeStr + ')');
    }

    if (chName === 'composite' || chName === '') {
      var compRes = readCompositeBins();
      bins = compRes.bins;
      resolvedChannel = (compRes.source === 'doc-histogram')
        ? 'composite'
        : 'composite (' + compRes.source + ')';
    } else if (chName === 'luminosity') {
      // Document-mode dispatched:
      //   Lab       → Lightness channel (true luminance, exact)
      //   Grayscale → Gray channel (it IS luminosity, exact)
      //   RGB       → synthesize from R+G+B via Rec.709 weighted bin sums.
      //               APPROXIMATION: marginal weighted sum != true per-pixel
      //               luminosity histogram (channels are correlated in real
      //               images). The resulting MEAN is exact (linearity of
      //               expectation); stdev/median are approximations that
      //               are accurate enough for exposure judgment.
      var named = collectNamedChannels(doc);
      if (named.lightness) {
        bins = named.lightness.histogram;
        resolvedChannel = 'luminosity (Lab Lightness)';
      } else if (named.gray) {
        bins = named.gray.histogram;
        resolvedChannel = 'luminosity (Grayscale)';
      } else if (named.red && named.green && named.blue) {
        var bR = named.red.histogram;
        var bG = named.green.histogram;
        var bB = named.blue.histogram;
        var nB = Math.min(bR.length, bG.length, bB.length);
        var lum = [];
        // Rec.709 (sRGB → relative luminance) weights. Float bins (no
        // rounding) so the downstream mean stays exact under linearity
        // of expectation; stdev/median remain approximations because
        // channels are correlated in real images.
        var wR = 0.2126, wG = 0.7152, wB = 0.0722;
        for (var iL = 0; iL < nB; iL++) {
          lum[iL] = wR * bR[iL] + wG * bG[iL] + wB * bB[iL];
        }
        bins = lum;
        resolvedChannel = 'luminosity (Rec.709 approximation from RGB)';
      } else {
        throw new Error('Luminosity not available for mode ' + modeStr +
          ' (channels: ' + (function () { var n = []; for (var k in named) n.push(k); return n.join(', '); })() +
          '). Convert to RGB / Lab / Grayscale or use a per-channel read.');
      }
    } else {
      // Per-channel lookup. PS exposes channels as doc.channels with
      // .name like 'Red', 'Green', 'Blue', 'Gray', 'Alpha 1', etc.
      var wantLower = chName.toLowerCase();
      var matched = null;
      for (var i = 0; i < doc.channels.length; i++) {
        if (String(doc.channels[i].name).toLowerCase() === wantLower) {
          matched = doc.channels[i];
          resolvedChannel = String(doc.channels[i].name);
          break;
        }
      }
      if (!matched) {
        throw new Error('Channel not found: ' + chName + ' (have: ' +
          (function () {
            var names = [];
            for (var j = 0; j < doc.channels.length; j++) names.push(doc.channels[j].name);
            return names.join(', ');
          })() + ')');
      }
      try { bins = matched.histogram; } catch (e) {
        throw new Error('Channel histogram unavailable for ' + chName + ': ' + e.message);
      }
    }

    if (!bins || bins.length === 0) {
      throw new Error('Histogram returned no data');
    }

    // Summary statistics. PS doesn't expose these directly; compute from bins.
    var total = 0;
    var weightedSum = 0;
    for (var b = 0; b < bins.length; b++) {
      var c = bins[b];
      total += c;
      weightedSum += c * b;
    }
    var mean = total > 0 ? (weightedSum / total) : 0;

    // Standard deviation (single-pass variance).
    var sqDiffSum = 0;
    for (var b2 = 0; b2 < bins.length; b2++) {
      var diff = b2 - mean;
      sqDiffSum += bins[b2] * diff * diff;
    }
    var stdev = total > 0 ? Math.sqrt(sqDiffSum / total) : 0;

    // Median (50th percentile bin).
    var half = total / 2;
    var running = 0;
    var median = 0;
    for (var b3 = 0; b3 < bins.length; b3++) {
      running += bins[b3];
      if (running >= half) { median = b3; break; }
    }

    return {
      channel: resolvedChannel,
      bins: bins,
      bin_count: bins.length,
      total_pixels: total,
      mean: mean,
      stdev: stdev,
      median: median,
      context: getContextInfo()
    };
  `,

		// -----------------------------------------------------------------------
		// renderHistoryStatePreview. Slots (in order):
		//   1=jsNum(historyIndex), 2=jsNum(maxDimension) [if-check],
		//   3=jsNum(maxDimension) [scale calc], 4=jsNum(quality),
		//   5=jsLit(outputPath).
		// -----------------------------------------------------------------------
		vault.RenderHistPrv: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var orig = app.activeDocument;
    var savedState = orig.activeHistoryState;
    var targetIdx = %s;
    if (targetIdx < 0 || targetIdx >= orig.historyStates.length) {
      throw new Error('History state index out of bounds: ' + targetIdx + ' (have ' + orig.historyStates.length + ')');
    }
    var targetState = orig.historyStates[targetIdx];

    try {
      orig.activeHistoryState = targetState;

      var dup = orig.duplicate(orig.name + ' __mcp_history_preview__');
      try {
        dup.flatten();
        var w = dup.width.as('px');
        var h = dup.height.as('px');
        var longEdge = (w > h) ? w : h;
        if (longEdge > %s) {
          var scale = %s / longEdge;
          dup.resizeImage(
            UnitValue(Math.round(w * scale), 'px'),
            UnitValue(Math.round(h * scale), 'px'),
            null,
            ResampleMethod.BICUBIC
          );
        }
        var opts = new JPEGSaveOptions();
        opts.quality = %s;
        opts.embedColorProfile = true;
        opts.formatOptions = FormatOptions.STANDARDBASELINE;
        dup.saveAs(new File(%s), opts, true, Extension.LOWERCASE);
        var finalW = dup.width.as('px');
        var finalH = dup.height.as('px');
        dup.close(SaveOptions.DONOTSAVECHANGES);
        return 'OK ' + finalW + 'x' + finalH;
      } catch (e) {
        try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        throw e;
      }
    } finally {
      // CRITICAL: restore the user's history cursor even on failure so we
      // never leave the doc rewound to an old state.
      try { orig.activeHistoryState = savedState; } catch (e) {}
      try { app.activeDocument = orig; } catch (e) {}
    }
  `,
	})
}
