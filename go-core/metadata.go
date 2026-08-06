package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// metadata family (Phase 1).

func pingState() string {
	return tpl[vault.PingState]
}

func getLayerTree() string {
	return tpl[vault.LayerTree]
}

// getHistogram returns the histogram for the named channel. An empty string or
// "composite" reads the composite (doc.histogram). "luminosity" synthesizes
// from the document's colour model. Any other value is treated as a named
// channel (case-insensitive).
func getHistogram(channel string) string {
	return fmt.Sprintf(tpl[vault.GetHistogram], getContextInfo(), jsLit(channel))
}

// renderHistoryStatePreview rewinds the document to historyIndex, renders a
// flattened JPEG, then restores the active history state in a finally block.
func renderHistoryStatePreview(historyIndex, maxDimension, quality float64, outputPath string) string {
	dim := jsNum(maxDimension)
	return fmt.Sprintf(
		tpl[vault.RenderHistPrv],
		jsNum(historyIndex), dim, dim, jsNum(quality), jsLit(outputPath),
	)
}

// getMetadata toggles its five blocks per the document/iptc/dom_exif flags
// (mirrors the TS opts object). bitsPerChannel + safe() are pulled in only
// when a block that needs them is present.
func getMetadata(document, iptc, domExif bool) string {
	bitsBlock := ""
	if document {
		bitsBlock = bitsPerChannelHelper()
	}
	safeBlock := ""
	if document || iptc {
		safeBlock = tpl[vault.MetaSafe]
	}
	docBlock := ""
	if document {
		docBlock = tpl[vault.MetaDoc]
	}
	iptcBlock := ""
	if iptc {
		iptcBlock = tpl[vault.MetaIptc]
	}
	exifBlock := ""
	if domExif {
		exifBlock = tpl[vault.MetaExif]
	}
	return fmt.Sprintf(
		tpl[vault.GetMeta],
		getContextInfo(),
		bitsBlock,
		safeBlock,
		docBlock,
		iptcBlock,
		exifBlock,
	)
}
