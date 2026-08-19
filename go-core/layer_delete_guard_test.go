package main

import (
	"strings"
	"testing"
)

// Guard: a NAMED delete must resolve to an art layer, never to a group.
//
// Photoshop's remove() on a LayerSet takes the whole subtree with it and still
// reports a plain success, so an over-matched name silently destroys layers
// the caller never named — and every later delete aimed at one of those
// children then fails as "not found", which is how this surfaced in the wild
// (a real session, 10 of 22 deletes failing). Deleting a group is
// ps_delete_group's job, which the tool description already says.
//
// testdata/golden.json is deliberately NOT the pin for this: it is a drift
// snapshot, not a correctness gate — remove the guard and the golden
// regenerates green. These assertions are what actually notice.
func TestDeleteLayerNamedRefusesGroups(t *testing.T) {
	snippet := deleteLayer("Old Curves", true)

	// The match must be conditioned on the candidate NOT being a group.
	if !contains(snippet, "nameMatches && !isGroup") {
		t.Error("named delete no longer filters groups out of the match")
	}
	// A group whose name matched is remembered so the error can say so rather
	// than claiming the name does not exist.
	if !contains(snippet, "groupNameMatch") {
		t.Error("named delete no longer tracks a group-name match for the error")
	}
	if !contains(snippet, "is a group, not an art layer") {
		t.Error("named delete no longer explains that the name resolved to a group")
	}
	// The phrase ERROR_CLASS_TABLE keys on (src/utils/session-log.ts). Losing
	// it silently reclassifies the failure.
	if !contains(snippet, "layer kind mismatch") {
		t.Error("group refusal lost the 'layer kind mismatch' phrase the error classifier keys on")
	}

	// The active-layer branch takes no name and must be unaffected.
	if contains(deleteLayer("", false), "groupNameMatch") {
		t.Error("the active-layer delete branch should not carry name-resolution code")
	}
}

// The same over-match existed in move-layer-to-group: it resolved the LAYER
// argument without excluding groups, so naming a layer could relocate an
// entire subtree. The pre-existing `layer === group` guard only caught the
// move-into-itself case.
func TestMoveLayerToGroupRefusesGroupsAsTheLayer(t *testing.T) {
	snippet := moveLayerToGroup("Sky", "Edits")

	if !contains(snippet, "nameMatches && !isGroup") {
		t.Error("move-to-group no longer filters groups out of the layer match")
	}
	if !contains(snippet, "is a group, not an art layer") {
		t.Error("move-to-group no longer explains that the layer name resolved to a group")
	}
	// findGroupByName must still match groups — that argument IS a group.
	if !contains(snippet, "wantedGroupNorm") {
		t.Error("move-to-group lost its group lookup")
	}
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
