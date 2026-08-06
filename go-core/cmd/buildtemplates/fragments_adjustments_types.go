package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// hue_saturation. Slots: hue, saturation, lightness (3 numeric %s).
		vault.AdjHSTd: `
      typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
      typeDesc.putBoolean(cTID('Clrz'), false);
      var hsAdjList = new ActionList();
      var hsEntry = new ActionDescriptor();
      hsEntry.putInteger(cTID('H   '), %s);
      hsEntry.putInteger(cTID('Strt'), %s);
      hsEntry.putInteger(cTID('Lght'), %s);
      // CRITICAL: modern PS uses Hst2 for master Hue/Sat. Hsrt is silently
      // ignored, which was the bug that made every adjustment layer no-op.
      hsAdjList.putObject(cTID('Hst2'), hsEntry);
      typeDesc.putList(cTID('Adjs'), hsAdjList);`,

		// brightness_contrast. Slots: brightness, contrast (2 numeric %s).
		vault.AdjBCTd: `
      typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
      typeDesc.putInteger(cTID('Brgh'), %s);
      typeDesc.putInteger(cTID('Cntr'), %s);
      typeDesc.putBoolean(sTID('useLegacy'), false);`,

		// black_and_white. Slots: reds, yellows, greens, cyans, blues, magentas,
		// useTint ("true"/"false"), tintBlock (al3t or "").
		vault.AdjBWTd: `
      typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
      typeDesc.putInteger(cTID('Rd  '), %s);
      typeDesc.putInteger(cTID('Yllw'), %s);
      typeDesc.putInteger(cTID('Grn '), %s);
      typeDesc.putInteger(cTID('Cyn '), %s);
      typeDesc.putInteger(cTID('Bl  '), %s);
      typeDesc.putInteger(cTID('Mgnt'), %s);
      typeDesc.putBoolean(sTID('useTint'), %s);
      %s`,

		// black_and_white tint sub-block. Slots: bwTintHue, bwTintSaturation (2 numeric).
		vault.AdjBWTint: `
      // Tint color: convert HSB → RGB via the standard 1978 Smith formula
      // so we can write an RGBColor object on the descriptor. Brightness
      // is fixed at 100 — the saturation slider does the visible work.
      (function () {
        var h = %s / 360;
        if (h < 0) h += 1;
        var s = %s / 100;
        var v = 1;
        var i = Math.floor(h * 6);
        var f = h * 6 - i;
        var p = v * (1 - s);
        var q = v * (1 - f * s);
        var t = v * (1 - (1 - f) * s);
        var r, g, b;
        if (i %% 6 === 0) { r = v; g = t; b = p; }
        else if (i %% 6 === 1) { r = q; g = v; b = p; }
        else if (i %% 6 === 2) { r = p; g = v; b = t; }
        else if (i %% 6 === 3) { r = p; g = q; b = v; }
        else if (i %% 6 === 4) { r = t; g = p; b = v; }
        else { r = v; g = p; b = q; }
        var tintColor = new ActionDescriptor();
        tintColor.putDouble(cTID('Rd  '), r * 255);
        tintColor.putDouble(cTID('Grn '), g * 255);
        tintColor.putDouble(cTID('Bl  '), b * 255);
        typeDesc.putObject(sTID('tintColor'), sTID('RGBColor'), tintColor);
      })();`,

		// color_balance. Slots: shdCR, shdMG, shdYB, mdtCR, mdtMG, mdtYB,
		// hghCR, hghMG, hghYB, preserveLuminosity (10 %s: 9 numeric + 1 bool).
		vault.AdjCBTd: `
      typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
      var shdList = new ActionList();
      shdList.putInteger(%s);
      shdList.putInteger(%s);
      shdList.putInteger(%s);
      typeDesc.putList(cTID('ShdL'), shdList);
      var mdtList = new ActionList();
      mdtList.putInteger(%s);
      mdtList.putInteger(%s);
      mdtList.putInteger(%s);
      typeDesc.putList(cTID('MdtL'), mdtList);
      var hghList = new ActionList();
      hghList.putInteger(%s);
      hghList.putInteger(%s);
      hghList.putInteger(%s);
      typeDesc.putList(cTID('HghL'), hghList);
      typeDesc.putBoolean(cTID('PrsL'), %s);`,

		// photo_filter outer. Slots: typeOrColorLine (%s), pfDensity (%s),
		// pfPreserveLuminosity ("true"/"false" %s).
		vault.AdjPFTd: `
      %s
      typeDesc.putInteger(cTID('Dnst'), %s);
      typeDesc.putBoolean(cTID('PrsL'), %s);`,

		// photo_filter preset line. Slot: pfPresetId (stringID literal).
		vault.AdjPFPset: `      typeDesc.putEnumerated(cTID('Fltr'), cTID('Fltr'), sTID(%s));`,

		// photo_filter custom-color block. Slots: r, g, b (3 numeric).
		vault.AdjPFClr: `
      var pfColorDesc = new ActionDescriptor();
      pfColorDesc.putDouble(cTID('Rd  '), %s);
      pfColorDesc.putDouble(cTID('Grn '), %s);
      pfColorDesc.putDouble(cTID('Bl  '), %s);
      typeDesc.putObject(cTID('Clr '), sTID('RGBColor'), pfColorDesc);`,

		// photo_filter fallback preset line. Slot: pfFallbackPreset (stringID literal).
		vault.AdjPFFb: `      typeDesc.putEnumerated(cTID('Fltr'), cTID('Fltr'), sTID(%s));`,

		// vibrance. Slots: vibVibrance, vibSaturation (2 numeric).
		vault.AdjVibTd: `
      typeDesc.putInteger(sTID('vibrance'), %s);
      typeDesc.putInteger(sTID('saturation'), %s);`,

		// channel_mixer — monochrome path. Slots: cmGrayR, cmGrayG, cmGrayB,
		// cmGrayKLine (al7k formatted or "").
		vault.AdjCMMono: `
      typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
      typeDesc.putBoolean(sTID('monochromatic'), true);
      var grayMix = new ActionDescriptor();
      grayMix.putUnitDouble(cTID('Rd  '), cTID('#Prc'), %s);
      grayMix.putUnitDouble(cTID('Grn '), cTID('#Prc'), %s);
      grayMix.putUnitDouble(cTID('Bl  '), cTID('#Prc'), %s);
      %s
      typeDesc.putObject(cTID('Gry '), cTID('ChMx'), grayMix);`,

		// channel_mixer mono constant line. Slot: cmGrayK value (1 numeric).
		vault.AdjCMMonoK: `      grayMix.putInteger(cTID('Cnst'), %s);`,

		// channel_mixer — color path. Slots (12):
		//   rR, rG, rB, rKLine,   gR, gG, gB, gKLine,   bR, bG, bB, bKLine.
		// Each *KLine is al7j formatted or "".
		vault.AdjCMClr: `
      typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
      typeDesc.putBoolean(sTID('monochromatic'), false);
      var rMix = new ActionDescriptor();
      rMix.putUnitDouble(cTID('Rd  '), cTID('#Prc'), %s);
      rMix.putUnitDouble(cTID('Grn '), cTID('#Prc'), %s);
      rMix.putUnitDouble(cTID('Bl  '), cTID('#Prc'), %s);
      %s
      typeDesc.putObject(cTID('Rd  '), cTID('ChMx'), rMix);

      var gMix = new ActionDescriptor();
      gMix.putUnitDouble(cTID('Rd  '), cTID('#Prc'), %s);
      gMix.putUnitDouble(cTID('Grn '), cTID('#Prc'), %s);
      gMix.putUnitDouble(cTID('Bl  '), cTID('#Prc'), %s);
      %s
      typeDesc.putObject(cTID('Grn '), cTID('ChMx'), gMix);

      var bMix = new ActionDescriptor();
      bMix.putUnitDouble(cTID('Rd  '), cTID('#Prc'), %s);
      bMix.putUnitDouble(cTID('Grn '), cTID('#Prc'), %s);
      bMix.putUnitDouble(cTID('Bl  '), cTID('#Prc'), %s);
      %s
      typeDesc.putObject(cTID('Bl  '), cTID('ChMx'), bMix);`,

		// channel_mixer color channel constant line. Slot: constant value (1 numeric).
		// Used for R, G, B channels independently.
		vault.AdjCMClrK: `      %sMix.putInteger(cTID('Cnst'), %s);`,

		// selective_color. Slots: scMethodEnum ("absolute"/"relative"), scEntriesJs.
		vault.AdjSCTd: `
      typeDesc.putEnumerated(
        sTID('Mthd'),
        sTID('correctionMethod'),
        sTID(%s)
      );
      var scList = new ActionList();
      var scEntries = [%s];
      for (var si = 0; si < scEntries.length; si++) {
        var sce = scEntries[si];
        var scEntry = new ActionDescriptor();
        scEntry.putEnumerated(cTID('Clrs'), cTID('Clrs'), sTID(sce.psId));
        scEntry.putUnitDouble(cTID('Cyn '), cTID('#Prc'), sce.c);
        scEntry.putUnitDouble(cTID('Mgnt'), cTID('#Prc'), sce.m);
        scEntry.putUnitDouble(cTID('Ylw '), cTID('#Prc'), sce.y);
        scEntry.putUnitDouble(cTID('Blck'), cTID('#Prc'), sce.k);
        scList.putObject(cTID('ClrC'), scEntry);
      }
      typeDesc.putList(cTID('ClrC'), scList);`,

		// gradient_map outer. Slots: dither ("true"/"false"), reverse ("true"/"false"),
		// gmName (jsLit of "editmamei_"+preset), colorStopsBlock.
		vault.AdjGMTd: `
      typeDesc.putBoolean(cTID('Dthr'), %s);
      typeDesc.putBoolean(cTID('Rvrs'), %s);
      var grdDesc = new ActionDescriptor();
      grdDesc.putString(cTID('Nm  '), %s);
      grdDesc.putEnumerated(sTID('gradientForm'), sTID('gradientForm'), sTID('customStops'));
      grdDesc.putDouble(sTID('interfaceIconFrameDimmed'), 4096);

      function makeColorStop(loc, midpoint, r, g, b) {
        var stop = new ActionDescriptor();
        var color = new ActionDescriptor();
        color.putDouble(cTID('Rd  '), r);
        color.putDouble(cTID('Grn '), g);
        color.putDouble(cTID('Bl  '), b);
        stop.putObject(cTID('Clr '), sTID('RGBColor'), color);
        stop.putEnumerated(cTID('Type'), cTID('Clry'), cTID('UsrS'));
        stop.putInteger(cTID('Lctn'), loc);
        stop.putInteger(cTID('Mdpn'), midpoint);
        return stop;
      }
      function makeOpacityStop(loc, midpoint, opacity) {
        var stop = new ActionDescriptor();
        stop.putUnitDouble(cTID('Opct'), cTID('#Prc'), opacity);
        stop.putInteger(cTID('Lctn'), loc);
        stop.putInteger(cTID('Mdpn'), midpoint);
        return stop;
      }

      var colorStops = new ActionList();
      %s
      grdDesc.putList(cTID('Clrs'), colorStops);

      var opacityStops = new ActionList();
      opacityStops.putObject(cTID('TrnS'), makeOpacityStop(0, 50, 100));
      opacityStops.putObject(cTID('TrnS'), makeOpacityStop(4096, 50, 100));
      grdDesc.putList(cTID('Trns'), opacityStops);

      typeDesc.putObject(cTID('Grad'), cTID('Grdn'), grdDesc);`,

		// gradient_map — black-to-white stops (no slots).
		vault.AdjGMBW: `
      // Default: black_to_white — canonical tonal-B&W gradient map.
      colorStops.putObject(cTID('Clrt'), makeColorStop(0, 50, 0, 0, 0));
      colorStops.putObject(cTID('Clrt'), makeColorStop(4096, 50, 255, 255, 255));`,

		// gradient_map — sepia stops (no slots).
		vault.AdjGMSepia: `
      // Sepia: deep brown → light cream.
      colorStops.putObject(cTID('Clrt'), makeColorStop(0, 50, 51, 25, 0));
      colorStops.putObject(cTID('Clrt'), makeColorStop(2048, 50, 153, 102, 51));
      colorStops.putObject(cTID('Clrt'), makeColorStop(4096, 50, 240, 220, 180));`,

		// gradient_map — tint stops. Slots: r, g, b (3 numeric).
		vault.AdjGMTint: `
      // Tint: black → user-supplied mid color → white.
      colorStops.putObject(cTID('Clrt'), makeColorStop(0, 50, 0, 0, 0));
      colorStops.putObject(cTID('Clrt'), makeColorStop(2048, 50, %s, %s, %s));
      colorStops.putObject(cTID('Clrt'), makeColorStop(4096, 50, 255, 255, 255));`,

		// exposure. Slots: exposure, offset, gammaCorrection (3 numeric).
		vault.AdjExpTd: `
      typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
      typeDesc.putDouble(sTID('exposure'), %s);
      typeDesc.putDouble(sTID('offset'), %s);
      typeDesc.putDouble(sTID('gammaCorrection'), %s);`,

		// color_lookup — 3DLUT path-resolution code. Slot: jsLit(clLutName).
		// After Mk, PS creates an empty Color Lookup layer; the setd with profile
		// data is blocked at the scripting level (see color_lookup limitation doc).
		vault.AdjCLTd: `
      // Color Lookup AdjL uses a two-step Mk + setd pattern.
      // This branch only does path resolution and stores resolvedLutPath.
      // typeDesc stays empty because PS's AdjL Mk for Color Lookup uses
      // putClass (no embedded descriptor) — see ScriptListener capture.
      var requestedLut = %s;
      var resolvedLutPath = null;

      var isAbsolute = (requestedLut.length > 1 && requestedLut.charAt(1) === ':') || requestedLut.charAt(0) === '/';

      if (isAbsolute) {
        resolvedLutPath = requestedLut;
      } else {
        var psPresetDir = new Folder(String(app.path) + '/Presets/3DLUTs');
        if (psPresetDir.exists) {
          var entries = psPresetDir.getFiles();
          var requestedBase = requestedLut.replace(/\.(cube|3dl|look|icc)$/i, '').toLowerCase();
          for (var li = 0; li < entries.length; li++) {
            var entry = entries[li];
            if (entry instanceof File) {
              // ExtendScript Folder.getFiles() returns URI-encoded names
              // (URI-encoded: spaces and parens become escapes); decodeURI restores the human
              // form so a literal leaf with spaces/parens matches.
              var entryName = decodeURI(entry.name);
              if (entryName === requestedLut) { resolvedLutPath = entry.fsName; break; }
              var entryBase = entryName.replace(/\.(cube|3dl|look|icc)$/i, '').toLowerCase();
              if (entryBase === requestedBase) { resolvedLutPath = entry.fsName; break; }
            }
          }
        }
      }

      if (resolvedLutPath === null) {
        throw new Error('Color Lookup: LUT not found: ' + requestedLut + '. Pass an absolute path, or a leaf name matching a file in ' + String(app.path) + '/Presets/3DLUTs/ (extension-agnostic match).');
      }`,

		// posterize. Slot: posLevels (1 numeric).
		vault.AdjPosTd: `
      typeDesc.putInteger(cTID('Lvls'), %s);`,

		// threshold. Slot: thrLevel (1 numeric).
		vault.AdjThrTd: `
      typeDesc.putInteger(cTID('Lvl '), %s);`,

		// levels/curves shared Mk typeDesc block (no slots). Mk always emits
		// presetKindDefault for these two types — the real values are applied
		// via the post-Mk setd below (AdjLvlPM / AdjCrvPM), which is what
		// customValuesApplied (wantCustom) actually reports on. Referenced from
		// the wantCustom=true branch so the Mk descriptor stays the same
		// regardless of which branch (!wantCustom vs wantCustom) fires.
		vault.AdjLvlCrvTd: `
      typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindDefault'));`,
	})
}
