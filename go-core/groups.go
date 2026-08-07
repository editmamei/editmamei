package main

import (
	"fmt"
	"strings"

	"editmamei-core/internal/vault"
)

// group / clipping-mask family (Phase 1). All return full getContextInfo().
// The clipping-mask pair + createGroup/moveLayerToGroup need cTID/sTID or
// normName helpers.

func deleteGroup(name string) string {
	n := jsLit(name)
	return fmt.Sprintf(tpl[vault.DeleteGroup], getContextInfo(), normNameHelper(), n, n)
}

func createClippingMask() string {
	return fmt.Sprintf(tpl[vault.ClipMask], helperFunctions(), getContextInfo())
}

func releaseClippingMask() string {
	return fmt.Sprintf(tpl[vault.ReleaseClip], helperFunctions(), getContextInfo())
}

// createGroup — when layerNames is non-empty, the emitter builds the
// reverse-order move block (mirrors the TS `${layerNames && length > 0 ? …}`).
// intoActiveGroup (Phase 4 layer-placement-bug fix) suppresses the default
// hoist-out-of-the-active-group behavior, keeping PS's native nesting.
func createGroup(name string, layerNames []string, intoActiveGroup bool) string {
	moveBlock := ""
	if len(layerNames) > 0 {
		quoted := make([]string, len(layerNames))
		for i, n := range layerNames {
			quoted[i] = jsLit(n)
		}
		moveBlock = "var requested = [" + strings.Join(quoted, ", ") + "];\n" +
			"    // Move in reverse order so the first listed name ends up on top.\n" +
			"    for (var li = requested.length - 1; li >= 0; li--) {\n" +
			"      var lname = requested[li];\n" +
			"      var ltarget = findLayerByName(doc.layers, normName(lname));\n" +
			"      if (!ltarget) { notFound.push(lname); continue; }\n" +
			"      // Skip if the layer IS the group itself (can't move a group into itself).\n" +
			"      if (ltarget === newGroup) { notFound.push(lname); continue; }\n" +
			"      try {\n" +
			"        ltarget.move(newGroup, ElementPlacement.INSIDE);\n" +
			"        movedCount++;\n" +
			"      } catch (e) {\n" +
			"        notFound.push(lname);\n" +
			"      }\n" +
			"    }"
	}
	return fmt.Sprintf(
		tpl[vault.CreateGroup],
		parentPathHelper(),
		hoistFromActiveGroupHelper(),
		getContextInfo(),
		normNameHelper(),
		jsLit(name),
		jsBool(intoActiveGroup),
		moveBlock,
	)
}

func moveLayerToGroup(layerName, groupName string) string {
	ln, gn := jsLit(layerName), jsLit(groupName)
	return fmt.Sprintf(
		tpl[vault.MoveToGroup],
		getContextInfo(),
		normNameHelper(),
		ln, gn, ln, gn,
	)
}

func setGroupBlendMode(groupName, blendMode string) string {
	gn := jsLit(groupName)
	return fmt.Sprintf(tpl[vault.SetGroupMode], getContextInfo(), normNameHelper(), gn, gn, jsLit(blendMode))
}

func ungroup(groupName string) string {
	gn := jsLit(groupName)
	return fmt.Sprintf(tpl[vault.Ungroup], getContextInfo(), normNameHelper(), gn, gn)
}
