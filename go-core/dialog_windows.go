//go:build windows

package main

import (
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// Everything here is stdlib `syscall` against user32.dll. No cgo, no module
// dependency — the binary cross-compiles with CGO_ENABLED=0 like every other
// target, and go.mod stays at zero requires.
var (
	user32                = syscall.NewLazyDLL("user32.dll")
	procEnumWindows       = user32.NewProc("EnumWindows")
	procEnumChildWindows  = user32.NewProc("EnumChildWindows")
	procGetWindowThreadPID = user32.NewProc("GetWindowThreadProcessId")
	procGetWindowTextW    = user32.NewProc("GetWindowTextW")
	procGetClassNameW     = user32.NewProc("GetClassNameW")
	procIsWindowVisible   = user32.NewProc("IsWindowVisible")
	procIsWindowEnabled   = user32.NewProc("IsWindowEnabled")
	procIsWindow          = user32.NewProc("IsWindow")
	procGetWindow         = user32.NewProc("GetWindow")
	procGetDlgCtrlID      = user32.NewProc("GetDlgCtrlID")
	procGetWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	procSendMessageTimeoutW = user32.NewProc("SendMessageTimeoutW")
)

const (
	gwOwner         = 4
	gwlStyle        = -16
	gwlExStyle      = -20
	wsExDlgModal    = 0x00000001
	wsExToolWindow  = 0x00000080
	bsTypeMask      = 0x0F
	bsPushButton    = 0
	bsDefPushButton = 1
	bsGroupBox      = 7
	bsUserButton    = 8
	bsOwnerDraw     = 11
	bmClick         = 0x00F5
	smtoAbortIfHung = 0x0002

	// The main application window's class. Photoshop names it literally.
	// Matching on this is what lets `clear` be PROVEN rather than inferred
	// from an empty enumeration — a dead or wrong PID enumerates zero windows,
	// which must report `unknown`, not `clear`.
	photoshopMainClass = "Photoshop"
)

func winText(proc *syscall.LazyProc, h uintptr) string {
	buf := make([]uint16, 512)
	n, _, _ := proc.Call(h, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:n])
}

func winTitle(h uintptr) string { return winText(procGetWindowTextW, h) }
func winClass(h uintptr) string { return winText(procGetClassNameW, h) }

func winPID(h uintptr) int {
	var pid uint32
	procGetWindowThreadPID.Call(h, uintptr(unsafe.Pointer(&pid)))
	return int(pid)
}

func winVisible(h uintptr) bool { r, _, _ := procIsWindowVisible.Call(h); return r != 0 }
func winEnabled(h uintptr) bool { r, _, _ := procIsWindowEnabled.Call(h); return r != 0 }
func winExists(h uintptr) bool  { r, _, _ := procIsWindow.Call(h); return r != 0 }

func winOwner(h uintptr) uintptr { r, _, _ := procGetWindow.Call(h, gwOwner); return r }
func winCtrlID(h uintptr) int32  { r, _, _ := procGetDlgCtrlID.Call(h); return int32(r) }

func winLong(h uintptr, index int) uint64 {
	r, _, _ := procGetWindowLongPtrW.Call(h, uintptr(index))
	return uint64(r)
}

func topLevelWindows(pids []int) (matched []uintptr) {
	want := make(map[int]bool, len(pids))
	for _, p := range pids {
		want[p] = true
	}
	cb := syscall.NewCallback(func(h uintptr, _ uintptr) uintptr {
		if want[winPID(h)] {
			matched = append(matched, h)
		}
		return 1
	})
	procEnumWindows.Call(cb, 0)
	return
}

func childWindows(h uintptr) (kids []uintptr) {
	cb := syscall.NewCallback(func(c uintptr, _ uintptr) uintptr {
		kids = append(kids, c)
		return 1
	})
	procEnumChildWindows.Call(h, cb, 0)
	return
}

// resolveDialog finds Photoshop's main window and any blocking dialog.
//
// DETECTION is a union of two tests, because neither alone covers Photoshop:
//
//   - The main window being DISABLED catches the `PSDialogBox` family (the
//     Action-error box), which carries no modal frame at all.
//   - A qualifying owned popup catches `PSFloatC` (Preferences, filter
//     dialogs) and `#32770` (ExtendScript alerts), which leave the main
//     window ENABLED.
//
// FINDING the popup to describe uses a deliberately WIDER rule than detection.
// An earlier version filtered candidates on WS_EX_DLGMODALFRAME — the same
// signal detection uses — and so could report "blocked" while finding nothing
// to read, because `PSDialogBox` does not carry that style. Caught on the
// first live run against the Action-error dialog.
//
// A candidate is: visible, owned, ENABLED, and not a tool window.
//   - `!toolWindow` excludes the floating contextual task bars (Pixel Layer
//     Bar, Start Bar), which are owned and visible like a dialog.
//   - `enabled` excludes Photoshop's OWL.ShadowView / OWL.FrameDrawer chrome,
//     which is visible and owned but always disabled.
//
// Modal-framed candidates sort first, so when a filter dialog and some other
// popup are both up we describe the one that is actually blocking.
func resolveDialog(pids []int) (mainHwnd uintptr, candidates []uintptr, foundMain bool) {
	windows := topLevelWindows(pids)
	for _, h := range windows {
		if winClass(h) == photoshopMainClass && winVisible(h) {
			mainHwnd = h
			foundMain = true
			break
		}
	}
	if !foundMain {
		return
	}
	for _, h := range windows {
		if h == mainHwnd || !winVisible(h) || winOwner(h) == 0 || !winEnabled(h) {
			continue
		}
		if winLong(h, gwlExStyle)&wsExToolWindow != 0 || isChromeClass(winClass(h)) {
			continue
		}
		// Modal-framed candidates first: when several popups qualify, describe
		// the one most likely to be the blocker.
		if winLong(h, gwlExStyle)&wsExDlgModal != 0 {
			candidates = append([]uintptr{h}, candidates...)
		} else {
			candidates = append(candidates, h)
		}
	}
	return
}

// isChromeClass names Photoshop's own decorative windows, which are owned,
// visible and enabled exactly like a dialog but contain nothing to read.
//
// A DENYLIST, not an allowlist, on purpose: an unrecognized window class then
// fails toward "this might be a dialog" rather than toward a confident `clear`.
// The residual noise a new chrome class would cause is filtered structurally by
// hasReadableContent below.
func isChromeClass(cls string) bool {
	switch cls {
	case "OWL.WindowGroup", "OWL.ShadowView", "OWL.FrameDrawer",
		"PSToolTip", "tooltips_class32", "DroverLord - Window Class":
		return true
	}
	return false
}

// describeDialog reads a popup's visible children into a Report.
func describeDialog(popup uintptr) Report {
	r := Report{Status: StatusDialog, Title: winTitle(popup)}
	var texts []string
	for _, c := range childWindows(popup) {
		if !winVisible(c) {
			continue // hidden panes of a tabbed dialog are not on screen
		}
		switch cls := winClass(c); {
		case cls == "Static":
			if t := strings.TrimSpace(winTitle(c)); t != "" {
				texts = append(texts, t)
			}
		case cls == "msctls_progress32":
			// An operation is RUNNING. Never auto-clear such a dialog: its
			// lone Cancel button otherwise looks exactly like a harmless
			// one-button notice.
			r.HasProgress = true
		case cls == "Button":
			style := winLong(c, gwlStyle) & bsTypeMask
			switch style {
			case bsPushButton, bsDefPushButton, bsOwnerDraw, bsUserButton:
				// BS_OWNERDRAW is NOT optional. Every button on a
				// Photoshop-drawn dialog uses it, so a filter accepting only
				// the standard push styles finds zero buttons on exactly the
				// dialogs that matter, while passing against a plain alert().
				r.Buttons = append(r.Buttons, Button{
					ID:      winCtrlID(c),
					Caption: winTitle(c),
					Default: style == bsDefPushButton,
				})
			case bsGroupBox:
				// Pure decoration.
			default:
				r.OtherControls++ // checkbox / radio / 3-state
			}
		case cls == "Edit", cls == "ComboBox", cls == "ListBox",
			cls == "msctls_trackbar32", cls == "SysTreeView32", cls == "SysListView32":
			r.OtherControls++
		}
	}
	r.Text = strings.Join(texts, " ")
	return r
}

// hasReadableContent is the structural test for "this is a dialog, not
// chrome": a real dialog names itself or offers a choice. Photoshop's frame
// and shadow windows have neither, and no style bit distinguishes them.
func hasReadableContent(r Report) bool {
	return r.Title != "" || len(r.Buttons) > 0
}

// findReadableDialog describes candidates in priority order and returns the
// first that actually carries content.
func findReadableDialog(candidates []uintptr) (Report, uintptr, int) {
	var depth int
	var best Report
	var bestHwnd uintptr
	for _, h := range candidates {
		r := describeDialog(h)
		if !hasReadableContent(r) {
			continue
		}
		depth++
		if bestHwnd == 0 {
			best, bestHwnd = r, h
		}
	}
	return best, bestHwnd, depth
}

func probeModal(pids []int, started time.Time) Report {
	if len(pids) == 0 {
		return unknown("no-pid")
	}
	mainHwnd, candidates, foundMain := resolveDialog(pids)
	if !foundMain {
		// No Photoshop main window for these PIDs. The process may have
		// exited or restarted under a new PID. Saying "clear" here would be
		// a confident lie, which is the one answer this must never give.
		return unknown("no-photoshop-window")
	}

	r, popup, depth := findReadableDialog(candidates)
	blockedByDisable := !winEnabled(mainHwnd)

	if popup == 0 && !blockedByDisable {
		return Report{
			Status:   StatusClear,
			OwnerPID: pids[0],
			ProbeMs:  time.Since(started).Milliseconds(),
		}
	}

	if popup != 0 {
		r.Depth = depth
		normalizeReport(&r, pids[0], popup)
	} else {
		// Blocked, but nothing readable. Report it as blocked anyway —
		// blocked-but-unreadable is a real state and must not read as fine.
		r = Report{Status: StatusDialog, Reason: "main-window-disabled-no-readable-dialog", Depth: 1}
		normalizeReport(&r, pids[0], mainHwnd)
	}
	r.ProbeMs = time.Since(started).Milliseconds()
	return r
}

// clickButton verifies the token still matches, clicks by control ID, then
// re-resolves to report what actually happened.
//
// Deliberately absent: any WM_CLOSE path. Posting WM_CLOSE to a Photoshop-drawn
// dialog destroys the window while leaving Photoshop's modal loop waiting on
// it, which wedges the scripting bridge until Photoshop is restarted. The
// window must be allowed to close itself in response to a real button press.
func clickButton(pids []int, token string, buttonID int32, started time.Time) Report {
	current := probeModal(pids, started)
	if current.Status != StatusDialog {
		return Report{Status: StatusStale, Reason: "no-dialog-to-click", ProbeMs: time.Since(started).Milliseconds()}
	}
	if current.Token != token {
		return Report{Status: StatusStale, Reason: "token-mismatch", Token: current.Token,
			Title: current.Title, Buttons: current.Buttons,
			ProbeMs: time.Since(started).Milliseconds()}
	}

	_, candidates, _ := resolveDialog(pids)
	_, popup, _ := findReadableDialog(candidates)
	if popup == 0 || !winExists(popup) {
		return Report{Status: StatusStale, Reason: "dialog-vanished"}
	}

	var target uintptr
	for _, c := range childWindows(popup) {
		if winVisible(c) && winClass(c) == "Button" && winCtrlID(c) == buttonID {
			target = c
			break
		}
	}
	if target == 0 {
		return Report{Status: StatusStale, Reason: "button-not-found"}
	}

	// SendMessageTimeout, never SendMessage: a plain send into a hung UI
	// thread blocks this process indefinitely, turning the recovery mechanism
	// into a second hang.
	var out uintptr
	procSendMessageTimeoutW.Call(target, bmClick, 0, 0, smtoAbortIfHung, 2000,
		uintptr(unsafe.Pointer(&out)))

	time.Sleep(150 * time.Millisecond) // let the dialog tear down
	after := probeModal(pids, started)
	switch {
	case after.Status == StatusClear:
		return Report{Status: StatusCleared, ProbeMs: time.Since(started).Milliseconds()}
	case after.Status == StatusDialog && after.Token != token:
		// The click opened ANOTHER dialog. Report and stop; never chain.
		after.Status = StatusReplaced
		return after
	case after.Status == StatusDialog:
		after.Status = StatusUnchanged
		return after
	default:
		return after
	}
}
