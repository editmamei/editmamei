package main

import (
	"fmt"
	"strings"

	"editmamei-core/internal/vault"
)

var brushToolConstMap = map[string]string{
	"healing_brush":     "HEALINGBRUSH",
	"clone_stamp":       "CLONESTAMP",
	"burn":              "BURN",
	"dodge":             "DODGE",
	"blur":              "BLUR",
	"sharpen":           "SHARPEN",
	"smudge":            "SMUDGE",
	"brush":             "BRUSH",
	"pencil":            "PENCIL",
	"eraser":            "ERASER",
	"pattern_stamp":     "PATTERNSTAMP",
	"art_history_brush": "ARTHISTORYBRUSH",
	"history_brush":     "HISTORYBRUSH",
	"color_replacement": "COLORREPLACEMENTTOOL",
	"background_eraser": "BACKGROUNDERASER",
	"sponge":            "SPONGE",
}

// brushToolNameMap maps each tool to its app.currentTool NAME — the identifier
// the AM 'Strk' command's `Usng` class accepts via stringIDToTypeID (and the name
// we set active so per-tool options apply). Replaces the ToolType-enum path used
// by the dead PathItem.strokePath(). Live-verified 2026-06-26.
var brushToolNameMap = map[string]string{
	"healing_brush":     "healingBrushTool",
	"clone_stamp":       "cloneStampTool",
	"burn":              "burnInTool",
	"dodge":             "dodgeTool",
	"blur":              "blurTool",
	"sharpen":           "sharpenTool",
	"smudge":            "smudgeTool",
	"brush":             "paintbrushTool",
	"pencil":            "pencilTool",
	"eraser":            "eraserTool",
	"pattern_stamp":     "patternStampTool",
	"art_history_brush": "artHistoryBrushTool",
	"history_brush":     "historyBrushTool",
	"color_replacement": "colorReplacementTool",
	"background_eraser": "backgroundEraserTool",
	"sponge":            "spongeTool",
}

var sourceRequiringBrushTools = map[string]bool{
	"clone_stamp":   true,
	"healing_brush": true,
}

func applyBrushStroke(params map[string]any) (string, error) {
	tool := strParam(params, "tool", "")
	if tool == "" {
		return "", fmt.Errorf("applyBrushStroke: missing required field 'tool'")
	}
	toolConst, ok := brushToolConstMap[tool]
	if !ok {
		return "", fmt.Errorf("applyBrushStroke: unsupported tool %q", tool)
	}
	brushToolName := brushToolNameMap[tool] // app.currentTool name for the AM Strk Usng
	isSourceTool := sourceRequiringBrushTools[tool]

	pathRaw, _ := params["path"].([]any)
	if len(pathRaw) < 2 {
		return "", fmt.Errorf("applyBrushStroke: path requires at least 2 anchor points")
	}

	brushSize := numParam(params, "brush_size", 30)
	closed := boolParam(params, "closed", false)
	applyToActive := boolParam(params, "apply_to_active_layer", false)

	// optional foreground_color
	var fgR, fgG, fgB float64
	hasFgColor := false
	if fgMap, ok2 := params["foreground_color"].(map[string]any); ok2 {
		fgR = numParam(fgMap, "red", 0)
		fgG = numParam(fgMap, "green", 0)
		fgB = numParam(fgMap, "blue", 0)
		hasFgColor = true
	}

	// optional brush_preset
	brushPreset, hasBrushPreset := optStrParam(params, "brush_preset")

	// source_point (required for clone_stamp / healing_brush)
	var srcLayerExpr string
	var srcX, srcY float64
	hasSource := false
	if srcMap, ok2 := params["source_point"].(map[string]any); ok2 {
		srcX = numParam(srcMap, "x", 0)
		srcY = numParam(srcMap, "y", 0)
		if layerName, hasLN := optStrParam(srcMap, "layer_name"); hasLN {
			srcLayerExpr = jsLit(layerName)
		} else {
			srcLayerExpr = "doc.activeLayer.name"
		}
		hasSource = true
	} else if isSourceTool {
		return "", fmt.Errorf(
			"applyBrushStroke: tool %q requires source_point ({x, y, layer_name?})", tool,
		)
	}

	// optional dynamics overrides
	opacityPct, hasOpacity := optNumParam(params, "opacity_pct")
	flowPct, hasFlow := optNumParam(params, "flow_pct")
	hardnessPct, hasHardness := optNumParam(params, "hardness_pct")
	anyDynamics := hasOpacity || hasFlow || hasHardness

	// -- build conditional blocks --

	var dynSaveBlock string
	if anyDynamics {
		dynSaveBlock = tpl[vault.BrushDynSave]
	}

	var fgColorBlock string
	if hasFgColor {
		fgColorBlock = fmt.Sprintf(tpl[vault.BrushFgColor],
			jsNum(fgR), jsNum(fgG), jsNum(fgB),
		)
	}

	// Always select a brush PRESET before sizing. A computed preset (Soft Round)
	// must be the current brush for the Brsh.Trgt masterDiameter size set to take
	// on PS 2026 — without one it produces a 1px tip. When no preset is named we
	// default to "Soft Round" (the BrushPreset template's own fallback chain
	// guarantees a hit). This is the size-control gap-fill while the proper PS-2026
	// brush-size descriptor is ScriptListener-captured.
	presetName := brushPreset
	if !hasBrushPreset {
		presetName = "Soft Round"
	}
	presetBlock := fmt.Sprintf(tpl[vault.BrushPreset], jsLit(presetName))

	var cloneBlock string
	if isSourceTool && hasSource {
		cloneBlock = fmt.Sprintf(tpl[vault.BrushClone],
			srcLayerExpr, jsNum(srcX), jsNum(srcY),
		)
	}

	var dynMutateBlock string
	if anyDynamics {
		var opBlock, flBlock, hdBlock string
		if hasOpacity {
			opBlock = fmt.Sprintf(tpl[vault.BrushDynOp], jsNum(opacityPct))
		}
		if hasFlow {
			flBlock = fmt.Sprintf(tpl[vault.BrushDynFl], jsNum(flowPct))
		}
		if hasHardness {
			hdBlock = fmt.Sprintf(tpl[vault.BrushDynHd], jsNum(hardnessPct))
		}
		dynMutateBlock = fmt.Sprintf(tpl[vault.BrushDynWrite], opBlock, flBlock, hdBlock)
	}

	var dynRestoreBlock string
	if anyDynamics {
		dynRestoreBlock = tpl[vault.BrushDynRst]
	}

	// -- assemble per-anchor PathPointInfo constructions --
	// Adobe doc inversion: leftDirection = out handle, rightDirection = in handle.
	pointParts := make([]string, 0, len(pathRaw))
	pointArrayItems := make([]string, 0, len(pathRaw))
	for idx, pRaw := range pathRaw {
		p, ok2 := pRaw.(map[string]any)
		if !ok2 {
			return "", fmt.Errorf("applyBrushStroke: path[%d] is not an object", idx)
		}
		ax := numParam(p, "x", 0)
		ay := numParam(p, "y", 0)

		inArr, _ := p["in"].([]any)
		outArr, _ := p["out"].([]any)
		hasIn := len(inArr) == 2
		hasOut := len(outArr) == 2

		kind := "CORNERPOINT"
		if hasIn && hasOut {
			kind = "SMOOTHPOINT"
		}

		var lx, ly, rx, ry float64
		if hasOut {
			lx, _ = outArr[0].(float64)
			ly, _ = outArr[1].(float64)
		} else {
			lx, ly = ax, ay
		}
		if hasIn {
			rx, _ = inArr[0].(float64)
			ry, _ = inArr[1].(float64)
		} else {
			rx, ry = ax, ay
		}

		iStr := fmt.Sprintf("%d", idx)
		pointPart := fmt.Sprintf(tpl[vault.BrushPoint],
			iStr, iStr, kind,
			iStr, jsNum(ax), jsNum(ay),
			iStr, jsNum(lx), jsNum(ly),
			iStr, jsNum(rx), jsNum(ry),
		)
		pointParts = append(pointParts, pointPart)
		pointArrayItems = append(pointArrayItems, fmt.Sprintf("__bw_p%d", idx))
	}
	pointConstructions := strings.Join(pointParts, "\n")
	pointArrayLiteral := strings.Join(pointArrayItems, ", ")

	return fmt.Sprintf(tpl[vault.BrushOuter],
		getContextInfo(), // 1: getContextInfo helper body
		duplicateForOp("Brush Stroke", applyToActive), // 2: duplicateForOp body
		dynSaveBlock,                      // 3: dynSaveBlock
		fgColorBlock,                      // 4: fgColorBlock
		presetBlock,                       // 5: presetBlock
		jsNum(brushSize),                  // 6: masterDiameter value
		cloneBlock,                        // 7: cloneBlock
		dynMutateBlock,                    // 8: dynMutateBlock
		pointConstructions,                // 9: pointConstructions
		jsBool(closed),                    // 10: sub.closed
		pointArrayLiteral,                 // 11: entireSubPath array
		brushToolName,                     // 12: app.currentTool name for the AM Strk Usng
		jsLit(tool),                       // 13: tool name in return
		toolConst,                         // 14: ToolType.<CONST> in tool_type string
		jsNum(brushSize),                  // 15: brush_size in return
		jsBool(isSourceTool && hasSource), // 16: clone_source_set
		jsNum(float64(len(pathRaw))),      // 17: anchors count
		jsBool(closed),                    // 18: closed in return
		dynRestoreBlock,                   // 19: dynRestoreBlock
	), nil
}
