package main

import "editmamei-core/internal/vault"

// Shared snippet prologues.
//
// Every filter fragment used to open with its own copy of the same four steps:
// bring the context helper into scope, refuse to run without a document,
// duplicate the layer unless the caller opted out, and confirm what is left can
// actually take a filter. Fourteen copies of that in this family alone, and one
// hundred and thirty-four copies of the document guard across all of them.
//
// Duplication that large is not just noise. It is why a fix to the guard had to
// be applied fourteen times to land, and why a fragment that forgot to bring a
// helper into scope failed only in Photoshop, at runtime, with a message that
// named neither the fragment nor the helper — a defect that reached production
// and then recurred.
//
// A fragment now states what it needs and the emitter composes the opening for
// it. There is one copy to fix, and a fragment cannot forget a helper it never
// had to remember.
func init() {
	addFragments(map[string]string{
		// Slots: 1 = context helper body, 2 = the cTID/sTID helpers (empty for
		// fragments that use no Action Manager call), 3 = duplicate-for-op
		// fragment, 4 = rasterize block (see FiltRast / FiltRastTrk).
		//
		// Slot 2 is the one that used to bite. A fragment calling sTID without
		// bringing the helpers into scope compiles, ships, and then fails inside
		// Photoshop with "sTID is not a function" — naming neither the fragment
		// nor the helper. Asking the prologue for it means the fragment states
		// the need once and cannot forget it.
		vault.FiltPro: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    %s

    var layer = doc.activeLayer;
%s
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('This filter needs a pixel layer; the active layer is ' + layer.kind);
    }
  `,

		// Text and smart-object layers cannot take a filter directly. Where the
		// caller let us duplicate, this rasterizes the copy and the original
		// survives untouched.
		vault.FiltRast: `
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
`,

		// Same, but records whether rasterizing happened so the fragment can
		// report it back to the caller.
		vault.FiltRastTrk: `
    var wasRasterized = false;

    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
      wasRasterized = true;
    }
`,
	})
}
