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
// children then fails as "not found", which makes the cause look like the
// symptom. Deleting a group is ps_delete_group's job.
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

// move-layer-to-group had the same over-match — it resolved the LAYER argument
// without preferring art layers, so tree order decided which of two same-named
// candidates moved, and naming a layer could relocate an entire subtree.
//
// The fix here is a PREFERENCE, not a refusal, and the difference matters:
// nesting a group inside a group is legitimate and this is the only tool that
// does it, so refusing groups outright (what deleteLayer correctly does) would
// delete a capability to fix an ambiguity. An art layer wins; a group is used
// only when no layer matches.
func TestMoveLayerToGroupPrefersArtLayersButStillNests(t *testing.T) {
	snippet := moveLayerToGroup("Sky", "Edits")

	if !contains(snippet, "nameMatches && !isGroup") {
		t.Error("move-to-group no longer prefers art layers for the layer argument")
	}
	if !contains(snippet, "groupFallback") {
		t.Error("move-to-group no longer keeps a group fallback")
	}
	if !contains(snippet, "if (!layer) layer = groupFallback;") {
		t.Error("move-to-group no longer falls back to a group, so nesting is broken")
	}
	// Refusing outright is deleteLayer's rule, not this one.
	if contains(snippet, "is a group, not an art layer") {
		t.Error("move-to-group must not refuse a group — that removes group nesting")
	}
	// The move-into-itself guard is only reachable because of the fallback.
	if !contains(snippet, "Cannot move a group into itself") {
		t.Error("move-to-group lost its move-into-itself guard")
	}
	// findGroupByName must still match groups — that argument IS a group.
	if !contains(snippet, "wantedGroupNorm") {
		t.Error("move-to-group lost its group lookup")
	}
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
