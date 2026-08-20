package main

import "testing"

// Build a probe record stream the way the AppleScript does, so the tests read
// as the wire format rather than as escape soup.
func axStream(status string, records ...string) string {
	out := "STATUS" + fieldSep + status
	for _, r := range records {
		out += recordSep + r
	}
	return out
}

func axField(parts ...string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += fieldSep
		}
		out += p
	}
	return out
}

// Every non-answer must be `unknown`. A macOS probe that cannot see is the
// exact situation where reporting `clear` would make a caller act on a lie —
// and unlike Windows, this backend has a whole extra failure mode (no
// Accessibility grant) that produces no dialog and no error in the UI.
func TestParseProbeNeverInventsClear(t *testing.T) {
	tests := map[string]string{
		"process missing":  axStream("noproc"),
		"no windows":       axStream("nowindow"),
		"garbage":          "not a record stream at all",
		"empty":            "",
		"unknown status":   axStream("somethingelse"),
		"truncated header": "STATUS",
	}
	for name, in := range tests {
		t.Run(name, func(t *testing.T) {
			r, ok := parseProbeOutput(in, 42)
			if ok {
				t.Fatalf("parse claimed a usable observation from %q", in)
			}
			if r.Status == StatusClear {
				t.Fatalf("parse reported %q — a probe that could not see must never report clear", StatusClear)
			}
			if r.Status != StatusUnknown {
				t.Errorf("status = %q, want %q", r.Status, StatusUnknown)
			}
			if r.Reason == "" {
				t.Error("unknown report carries no reason")
			}
		})
	}
}

func TestParseProbeClear(t *testing.T) {
	r, ok := parseProbeOutput(axStream("clear"), 77)
	if !ok {
		t.Fatal("clear should be a usable observation")
	}
	if r.Status != StatusClear {
		t.Errorf("status = %q, want %q", r.Status, StatusClear)
	}
	if r.OwnerPID != 77 {
		t.Errorf("ownerPid = %d, want 77", r.OwnerPID)
	}
}

func TestParseProbeFullDialog(t *testing.T) {
	in := axStream("dialog",
		axField("TITLE", "Adobe Photoshop"),
		axField("TEXT", "Save changes before closing?"),
		axField("PROGRESS", "0"),
		axField("OTHER", "2"),
		axField("DEPTH", "1"),
		axField("HANDLE", "3"),
		axField("BTN", "1", "1", "Save"),
		axField("BTN", "2", "0", "Don't Save"),
		axField("BTN", "3", "0", "Cancel"),
	)
	r, ok := parseProbeOutput(in, 99)
	if !ok {
		t.Fatal("a dialog record stream should parse")
	}
	if r.Status != StatusDialog {
		t.Fatalf("status = %q, want %q", r.Status, StatusDialog)
	}
	if r.Title != "Adobe Photoshop" {
		t.Errorf("title = %q", r.Title)
	}
	if r.Text != "Save changes before closing?" {
		t.Errorf("text = %q", r.Text)
	}
	if r.OtherControls != 2 || r.Depth != 1 {
		t.Errorf("otherControls = %d, depth = %d", r.OtherControls, r.Depth)
	}
	if len(r.Buttons) != 3 {
		t.Fatalf("buttons = %d, want 3", len(r.Buttons))
	}
	// The ID must carry the AppleScript index, because that is the click
	// address on this platform.
	for i, b := range r.Buttons {
		if b.ID != int32(i+1) {
			t.Errorf("button %d has ID %d, want the 1-based index %d", i, b.ID, i+1)
		}
	}
	if !r.Buttons[0].Default {
		t.Error("AXDefaultButton match did not mark the default button")
	}
	if r.Token == "" {
		t.Error("no token derived — a click could not be gated")
	}
}

// The whole reason idScheme exists. On macOS an ID is a position, so a dialog
// with seven or more buttons has buttons numbered 6 and 7 — the values Windows
// uses for IDYES/IDNO. Reading those as a destructive choice would classify an
// ordinary dialog as data loss.
func TestParseProbeIndexIDsAreNotReadAsWindowsControlIDs(t *testing.T) {
	records := []string{
		axField("PROGRESS", "0"),
		axField("OTHER", "0"),
	}
	for i := 1; i <= 7; i++ {
		records = append(records, axField("BTN", string(rune('0'+i)), "0", "b"))
	}
	r, ok := parseProbeOutput(axStream("dialog", records...), 1)
	if !ok {
		t.Fatal("should parse")
	}
	if r.Stakes == StakesDataLoss {
		t.Errorf("stakes = %q — positional indices 6 and 7 were read as IDYES/IDNO", r.Stakes)
	}
	if r.Stakes != StakesDecision {
		t.Errorf("stakes = %q, want %q", r.Stakes, StakesDecision)
	}
}

// A progress dialog on macOS has the same one-button shape as a harmless
// notice, exactly as on Windows, and the same ordering rule has to hold.
func TestParseProbeProgressBeatsSingleButton(t *testing.T) {
	in := axStream("dialog",
		axField("PROGRESS", "1"),
		axField("OTHER", "0"),
		axField("BTN", "1", "0", "Cancel"),
	)
	r, _ := parseProbeOutput(in, 1)
	if r.Stakes != StakesRunning {
		t.Fatalf("stakes = %q, want %q — clicking this cancels a running operation", r.Stakes, StakesRunning)
	}
}

// Photoshop dialogs are localized. Nothing in the parse may depend on the
// caption text, and a non-ASCII caption must survive intact so a human can
// read it back.
func TestParseProbeKeepsNonASCIICaptions(t *testing.T) {
	in := axStream("dialog",
		axField("TITLE", "Adobe Photoshop"),
		axField("PROGRESS", "0"),
		axField("OTHER", "0"),
		axField("BTN", "1", "0", "Nicht sichern"),
		axField("BTN", "2", "0", "Abbrechen"),
	)
	r, _ := parseProbeOutput(in, 1)
	if len(r.Buttons) != 2 {
		t.Fatalf("buttons = %d, want 2", len(r.Buttons))
	}
	if r.Buttons[0].Caption != "Nicht sichern" {
		t.Errorf("caption = %q, want the German text preserved", r.Buttons[0].Caption)
	}
}

// A malformed BTN record must be skipped, not crash and not shift the
// remaining buttons' addresses.
func TestParseProbeSkipsMalformedButtons(t *testing.T) {
	in := axStream("dialog",
		axField("PROGRESS", "0"),
		axField("OTHER", "0"),
		axField("BTN", "1", "0", "OK"),
		axField("BTN", "notanumber", "0", "junk"),
		axField("BTN", "2"), // too few fields
		axField("BTN", "3", "0", "Cancel"),
	)
	r, ok := parseProbeOutput(in, 1)
	if !ok {
		t.Fatal("should still parse")
	}
	if len(r.Buttons) != 2 {
		t.Fatalf("buttons = %d, want 2 well-formed ones", len(r.Buttons))
	}
	if r.Buttons[1].ID != 3 {
		t.Errorf("surviving button ID = %d, want 3 — addresses must not be renumbered", r.Buttons[1].ID)
	}
}

func TestEscapeForAppleScript(t *testing.T) {
	tests := map[string]string{
		`Adobe Photoshop 2026`:      `Adobe Photoshop 2026`,
		`say "hi"`:                  `say \"hi\"`,
		`back\slash`:                `back\\slash`,
		"line\nbreak":               "line break",
		"carriage\rreturn":          "carriage return",
		`" & (do shell script "x")`: `\" & (do shell script \"x\")`,
	}
	for in, want := range tests {
		if got := escapeForAppleScript(in); got != want {
			t.Errorf("escape(%q) = %q, want %q", in, got, want)
		}
	}
}
