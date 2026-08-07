package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// createTextLayer. Slots: 1=parentPathHelper, 2=getContextInfo body,
		// 3=text(jsLit), 4=x(jsNum), 5=y(jsNum), 6=fontSize(jsNum), 7=text(jsLit),
		// 8=x, 9=y, 10=fontSize (result). Phase 4: doc.artLayers.add() is DOM and
		// does NOT nest inside an active group (measured live) — parent_path is
		// reported for consistency/observability, no hoist needed.
		vault.CreateText: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var textLayer = doc.artLayers.add();
    textLayer.kind = LayerKind.TEXT;
    textLayer.textItem.contents = %s;
    textLayer.textItem.position = [%s, %s];
    textLayer.textItem.size = %s;

    var result = {
      created: true,
      layerName: textLayer.name,
      text: %s,
      position: { x: %s, y: %s },
      fontSize: %s,
      parent_path: __parentPathOf(doc, textLayer),
      context: getContextInfo()
    };
    return result;
  `,

		// setTextFont. Slots: 1=fontName(jsLit), 2=optional size-assignment line
		// (built by the emitter; empty when no fontSize given).
		//
		// NOTE: the TS source emits a comment block around the size read-back
		// that contains literal backtick characters (escaped in the TS template
		// literal). Go raw strings cannot contain backticks, so that comment is
		// reproduced here with plain punctuation. Comments are behaviorally inert
		// (the golden normalizer drops them); the executable code is verbatim.
		vault.SetFont: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var layer = app.activeDocument.activeLayer;
    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }

    var requested = %s;
    var resolvedPS = null;
    var matchedBy = null;

    for (var i = 0; i < app.fonts.length; i++) {
      if (app.fonts[i].postScriptName === requested) {
        resolvedPS = app.fonts[i].postScriptName;
        matchedBy = 'postScriptName';
        break;
      }
    }
    if (resolvedPS === null) {
      var familyFallback = null;
      for (var j = 0; j < app.fonts.length; j++) {
        var f = app.fonts[j];
        if (f.family === requested) {
          var s = f.style;
          if (s === 'Regular' || s === 'Roman' || s === 'Book') {
            resolvedPS = f.postScriptName;
            matchedBy = 'family+regular';
            break;
          }
          if (familyFallback === null) familyFallback = f.postScriptName;
        }
      }
      if (resolvedPS === null && familyFallback !== null) {
        resolvedPS = familyFallback;
        matchedBy = 'family';
      }
    }
    if (resolvedPS === null) {
      for (var k = 0; k < app.fonts.length; k++) {
        if (app.fonts[k].name === requested) {
          resolvedPS = app.fonts[k].postScriptName;
          matchedBy = 'name';
          break;
        }
      }
    }

    if (resolvedPS === null) {
      // Build a recoverable error: list fuzzy-matching families first (so the
      // LLM can pick a near-miss like 'HelveticaLTStd' when 'Helvetica' was
      // requested), then a sample of installed families. Without this list
      // the LLM has to guess font names blindly — the 2026-06-06 demo
      // session burned a tool call on "Helvetica" then went silent on
      // text-styling because it couldn't recover.
      var reqLower = String(requested).toLowerCase();
      var seenFamilies = {};
      var fuzzy = [];
      var all = [];
      for (var fi = 0; fi < app.fonts.length; fi++) {
        var fam = app.fonts[fi].family;
        if (seenFamilies[fam]) continue;
        seenFamilies[fam] = true;
        all.push(fam);
        if (String(fam).toLowerCase().indexOf(reqLower) >= 0 && fuzzy.length < 20) {
          fuzzy.push(fam);
        }
      }
      all.sort();
      var msg = 'Font not found: ' + requested +
        '. textItem.font wants the PostScript name (e.g. "ArialMT" not "Arial"); family name also accepted if installed.';
      if (fuzzy.length > 0) {
        msg += ' Families containing "' + requested + '": ' + fuzzy.join(', ') + '.';
      } else {
        var sample = all.slice(0, 30);
        msg += ' No installed family contains "' + requested + '". Sample of installed families: ' + sample.join(', ');
        if (all.length > sample.length) {
          msg += ' (' + (all.length - sample.length) + ' more)';
        }
        msg += '.';
      }
      throw new Error(msg);
    }

    layer.textItem.font = resolvedPS;
    %s

    // layer.textItem.size returns an ExtendScript UnitValue host object,
    // not a number. The __mcpJsonEncode walker treats host objects as
    // plain objects and enumerates own properties; UnitValue has none
    // that hasOwnProperty acknowledges, so it serializes as {}. That
    // fails the outputSchema size: { type: 'number' } check, which
    // Claude Desktop surfaces as a red "Failed to call tool" toast even
    // though Photoshop completed the work. .as('pt') returns a Number
    // (the wrapper preamble has already pinned TypeUnits.POINTS, so this
    // is the same point value PS uses internally). v0.7.2 fix.
    var sizeAsPt;
    try { sizeAsPt = layer.textItem.size.as('pt'); }
    catch (e) { sizeAsPt = parseFloat(String(layer.textItem.size)) || 0; }

    return {
      requested: requested,
      font: layer.textItem.font,
      size: sizeAsPt,
      matched_by: matchedBy
    };
  `,

		// setTextColor. Slots: 1=red, 2=green, 3=blue (assign), 4=red, 5=green,
		// 6=blue (result string).
		vault.SetTextClr: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var layer = app.activeDocument.activeLayer;

    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }

    var color = new SolidColor();
    color.rgb.red = %s;
    color.rgb.green = %s;
    color.rgb.blue = %s;
    layer.textItem.color = color;

    return {
      color: 'RGB(' + %s + ', ' + %s + ', ' + %s + ')'
    };
  `,

		// setTextAlignment. Slots: 1=alignment (raw enum name), 2=alignment(jsLit).
		vault.SetTextAlgn: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var layer = app.activeDocument.activeLayer;

    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }

    layer.textItem.justification = Justification.%s; // enum allow-listed in setTextAlignment (Go)

    return {
      alignment: %s
    };
  `,

		// updateTextContent. Slots: 1=newText(jsLit).
		vault.UpdateText: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var layer = app.activeDocument.activeLayer;

    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }

    layer.textItem.contents = %s;

    return {
      text: layer.textItem.contents
    };
  `,
	})
}
