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
      //
      // Match on the request's word parts, not the whole string: a guessed
      // PostScript name like "AcuminProWide-Black" is contained in no family,
      // but its parts (acumin, pro, wide, black) point straight at
      // "Acumin Pro Wide" Black. The 2026-10-20 poster recordings burned six
      // calls guessing names because the whole-string match found nothing.
      var reqParts = String(requested).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/);
      var words = [];
      for (var pi = 0; pi < reqParts.length; pi++) {
        if (reqParts[pi].length >= 3) words.push(reqParts[pi].toLowerCase());
      }
      // A short request ("Ar", "MS") has no part long enough to score on, so
      // match it whole, as a substring.
      if (words.length === 0 && String(requested).length > 0) {
        words.push(String(requested).toLowerCase());
      }
      var seenFamilies = {};
      var scored = [];
      var all = [];
      var fontList = app.fonts;
      for (var fi = 0; fi < fontList.length; fi++) {
        // Two property reads per font (each crosses into Photoshop's DOM); the
        // PostScript name already carries the style, e.g. AcuminProWide-Black.
        var fnt = fontList[fi];
        var fam = fnt.family;
        var psName = fnt.postScriptName;
        if (!seenFamilies[fam]) {
          seenFamilies[fam] = true;
          all.push(fam);
        }
        var hay = (fam + ' ' + psName).toLowerCase();
        var score = 0;
        // The first part is nearly always the family ("acumin"); it counts
        // double so common parts like "pro" or "black" can't outrank it.
        for (var wi = 0; wi < words.length; wi++) {
          if (hay.indexOf(words[wi]) >= 0) score += wi === 0 ? 2 : 1;
        }
        if (score > 0) scored.push({ score: score, family: fam, label: fam + ' = ' + psName });
      }
      scored.sort(function (a, b) {
        return b.score - a.score || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
      });
      // At most 3 styles per family, so one family with twenty weights can't
      // crowd out its siblings (Helvetica LT Std hiding Helvetica Neue).
      var fuzzy = [];
      var perFamily = {};
      for (var si = 0; si < scored.length && fuzzy.length < 15; si++) {
        if (scored[si].score < scored[0].score - 1) break;
        var sf = scored[si].family;
        perFamily[sf] = (perFamily[sf] || 0) + 1;
        if (perFamily[sf] > 3) continue;
        fuzzy.push(scored[si].label);
      }
      all.sort();
      var msg = 'Font not found: ' + requested +
        '. textItem.font wants the PostScript name (e.g. "ArialMT" not "Arial"); family name also accepted if installed.';
      if (fuzzy.length > 0) {
        msg += ' Closest installed fonts (family = PostScript name to pass): ' + fuzzy.join('; ') + '.';
      } else {
        var sample = all.slice(0, 30);
        msg += ' No installed font matches "' + requested + '". Sample of installed families: ' + sample.join(', ');
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
