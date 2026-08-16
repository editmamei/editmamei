package main

import "testing"

func TestCleanCaptionStripsBothAcceleratorMarkers(t *testing.T) {
	// Photoshop uses BOTH conventions in the same product: "&Preview" on a
	// filter dialog, "\x01Legacy" in Preferences. Captured live.
	cases := map[string]string{
		"&Preview":                          "Preview",
		"P&ostScript (72 points/inch)":      "PostScript (72 points/inch)",
		"Use \x01Legacy “New Document”":     "Use Legacy “New Document”",
		"S\x01kip Transform when Placing":   "Skip Transform when Placing",
		"Save && Close":                     "Save & Close", // && is a literal ampersand
		"  spaced   out  ":                  "spaced out",
	}
	for in, want := range cases {
		if got := cleanCaption(in); got != want {
			t.Errorf("cleanCaption(%q) = %q, want %q", in, got, want)
		}
	}
}

// The single most important behaviour in this file. A Photoshop progress
// window has exactly one push button ("Cancel") and no other interactive
// control — byte-for-byte the informational signature. If the progress check
// does not run FIRST, auto-clearing an "informational" dialog cancels a
// running operation.
func TestClassifyStakesProgressBeatsSingleButton(t *testing.T) {
	buttons := []Button{{ID: 6001, Caption: "Cancel"}}
	if got := classifyStakes(buttons, 0, true); got != StakesRunning {
		t.Fatalf("progress dialog classified %q, want %q — this would cancel a running operation", got, StakesRunning)
	}
	// Same shape without the progress bar IS informational.
	if got := classifyStakes(buttons, 0, false); got != StakesInformational {
		t.Errorf("one-button dialog classified %q, want %q", got, StakesInformational)
	}
}

func TestClassifyStakes(t *testing.T) {
	tests := []struct {
		name    string
		buttons []Button
		other   int
		want    string
	}{
		{
			// Live capture: ExtendScript alert. Note its lone OK is control 2,
			// not IDOK — which is why nothing here keys on the ID value.
			name:    "script alert, one button",
			buttons: []Button{{ID: 2, Caption: "OK"}},
			want:    StakesInformational,
		},
		{
			// Live capture: Gaussian Blur.
			name:    "filter dialog with a radius field",
			buttons: []Button{{ID: 1, Caption: "OK"}, {ID: 6243, Caption: "Cancel"}, {ID: 6244, Caption: "Preview"}},
			other:   1,
			want:    StakesDecision,
		},
		{
			// Live capture: the Action-error box. Continue/Stop is neither
			// OK/Cancel nor Yes/No, and which is correct depends entirely on
			// context — the case that must reach a caller who can see it.
			name:    "action error, continue or stop",
			buttons: []Button{{ID: 10, Caption: "Continue"}, {ID: 11, Caption: "Stop"}},
			want:    StakesDecision,
		},
		{
			name:    "yes/no pair implies a destructive choice",
			buttons: []Button{{ID: 6, Caption: "Yes"}, {ID: 7, Caption: "No"}},
			want:    StakesDataLoss,
		},
		{
			name:    "three-way save prompt",
			buttons: []Button{{ID: 6, Caption: "Save"}, {ID: 7, Caption: "Don't Save"}, {ID: 2, Caption: "Cancel"}},
			want:    StakesDataLoss,
		},
		{
			name:    "one button but an edit field is still a decision",
			buttons: []Button{{ID: 1, Caption: "OK"}},
			other:   1,
			want:    StakesDecision,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyStakes(tc.buttons, tc.other, false); got != tc.want {
				t.Errorf("classifyStakes = %q, want %q", got, tc.want)
			}
		})
	}
}

// Data-loss detection must not consult captions: the evidencing user runs a
// German Photoshop, where the same dialog reads Ja / Nein.
func TestImpliesDataLossIgnoresLanguage(t *testing.T) {
	german := []Button{{ID: 6, Caption: "Ja"}, {ID: 7, Caption: "Nein"}}
	if !impliesDataLoss(german) {
		t.Error("localized yes/no pair not detected as data-loss")
	}
	// A button merely CAPTIONED "Yes" without the standard ID is not enough
	// to claim data loss, and must not be.
	notStandard := []Button{{ID: 5001, Caption: "Yes"}, {ID: 5002, Caption: "No"}}
	if impliesDataLoss(notStandard) {
		t.Error("non-standard IDs should not be read as a yes/no decision")
	}
}

func TestMakeTokenDetectsContentChangeOnRecycledHandle(t *testing.T) {
	a := makeToken(100, 0xABC, "Adobe Photoshop", []Button{{Caption: "OK"}})
	same := makeToken(100, 0xABC, "Adobe Photoshop", []Button{{Caption: "OK"}})
	if a != same {
		t.Fatal("token is not stable for identical input")
	}
	// Windows recycles HWNDs. Same handle + different content must not match,
	// or a click lands on a dialog that inherited the handle.
	recycled := makeToken(100, 0xABC, "Adobe Photoshop", []Button{{Caption: "Don't Save"}})
	if a == recycled {
		t.Error("token collided across different dialog content on the same handle")
	}
	if a == makeToken(101, 0xABC, "Adobe Photoshop", []Button{{Caption: "OK"}}) {
		t.Error("token collided across different PIDs")
	}
}

func TestNormalizeAppliesCapsAndIndexes(t *testing.T) {
	long := make([]rune, maxText+500)
	for i := range long {
		long[i] = 'x'
	}
	r := Report{
		Status:  StatusDialog,
		Title:   "&Adobe Photoshop",
		Text:    string(long),
		Buttons: []Button{{ID: 1, Caption: "&OK"}, {ID: 2, Caption: "&Cancel"}},
	}
	normalizeReport(&r, 42, 0xFEED)

	if r.Title != "Adobe Photoshop" {
		t.Errorf("title = %q, want accelerator stripped", r.Title)
	}
	if len([]rune(r.Text)) > maxText+1 { // +1 for the ellipsis
		t.Errorf("text not clamped: %d runes", len([]rune(r.Text)))
	}
	if r.Buttons[0].Index != 0 || r.Buttons[1].Index != 1 {
		t.Error("button indices not assigned in enumeration order")
	}
	if r.Buttons[1].Caption != "Cancel" {
		t.Errorf("button caption = %q, want accelerator stripped", r.Buttons[1].Caption)
	}
	if r.Token == "" {
		t.Error("normalize did not derive a token")
	}
	if r.OwnerPID != 42 {
		t.Errorf("ownerPid = %d, want 42", r.OwnerPID)
	}
}

func TestNormalizeCapsButtonCount(t *testing.T) {
	var many []Button
	for i := 0; i < maxButtons+5; i++ {
		many = append(many, Button{ID: int32(i), Caption: "b"})
	}
	r := Report{Buttons: many}
	normalizeReport(&r, 1, 1)
	if len(r.Buttons) != maxButtons {
		t.Errorf("buttons = %d, want capped at %d", len(r.Buttons), maxButtons)
	}
}

func TestParsePIDs(t *testing.T) {
	tests := map[string][]int{
		"123":          {123},
		"123,456":      {123, 456},
		" 456 , 123 ":  {123, 456}, // sorted, whitespace tolerated
		"":             nil,
		"0":            nil, // a zero pid is not a pid
		"abc":          nil,
		"123,abc,456":  {123, 456},
	}
	for in, want := range tests {
		got := parsePIDs(in)
		if len(got) != len(want) {
			t.Errorf("parsePIDs(%q) = %v, want %v", in, got, want)
			continue
		}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("parsePIDs(%q) = %v, want %v", in, got, want)
				break
			}
		}
	}
}

func TestUnknownIsNeverClear(t *testing.T) {
	// Guards the rule that a dead or wrong PID must not read as "no dialog".
	r := unknown("no-photoshop-window")
	if r.Status != StatusUnknown {
		t.Fatalf("status = %q, want %q", r.Status, StatusUnknown)
	}
	if r.Status == StatusClear {
		t.Fatal("unknown must never be clear")
	}
}
