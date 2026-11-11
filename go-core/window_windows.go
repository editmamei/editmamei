//go:build windows

package main

// Win32 half of window.go, with the standard library's syscall package only.
// Every call targets Photoshop's own process: windows are matched by owning PID
// and executable name, and keys are sent only after the foreground window is
// confirmed to belong to Photoshop.

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procEnumWindows              = user32.NewProc("EnumWindows")
	procEnumChildWindows         = user32.NewProc("EnumChildWindows")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procIsIconic                 = user32.NewProc("IsIconic")
	procGetClassNameW            = user32.NewProc("GetClassNameW")
	procGetWindowTextW           = user32.NewProc("GetWindowTextW")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procPrintWindow              = user32.NewProc("PrintWindow")
	procGetDC                    = user32.NewProc("GetDC")
	procReleaseDC                = user32.NewProc("ReleaseDC")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procSendInput                = user32.NewProc("SendInput")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procSetDpiAwarenessContext   = user32.NewProc("SetProcessDpiAwarenessContext")

	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
	procDeleteDC           = gdi32.NewProc("DeleteDC")

	procOpenProcess                = kernel32.NewProc("OpenProcess")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	procCloseHandle                = kernel32.NewProc("CloseHandle")
)

const (
	pwRenderFullContent       = 2
	bmClick                   = 0x00F5
	inputKeyboard             = 1
	keyeventfKeyUp            = 0x0002
	vkF24                     = 0x87
	vkN                       = 0x4E
	vkEscape                  = 0x1B
	processQueryLimitedInfo   = 0x1000
	dpiPerMonitorAwareV2      = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (HANDLE)-4
	relightDiscardPrompt      = "discard the relight layer"
	photoshopExecutable       = "photoshop.exe"
	photoshopDialogClass      = "PSDialogBox"
	photoshopMainWindowClass  = "Photoshop"
	foregroundConfirmAttempts = 20
)

// keyInput is Win32 INPUT with a KEYBDINPUT, laid out for 64-bit Windows
// (40 bytes: type, padding, then the union at offset 8).
type keyInput struct {
	typ   uint32
	_     uint32
	vk    uint16
	scan  uint16
	flags uint32
	time  uint32
	_     uint32
	extra uintptr
	_     [8]byte
}

type winRect struct{ left, top, right, bottom int32 }

type bitmapInfoHeader struct {
	size          uint32
	width         int32
	height        int32
	planes        uint16
	bitCount      uint16
	compression   uint32
	sizeImage     uint32
	xPelsPerMeter int32
	yPelsPerMeter int32
	clrUsed       uint32
	clrImportant  uint32
}

// --- enumeration (one callback each, created once: Windows callbacks are a
// limited resource) ---

var (
	enumMu       sync.Mutex
	enumFound    []uintptr
	enumCallback = syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		enumFound = append(enumFound, hwnd)
		return 1
	})
)

func topLevelWindows() []uintptr {
	enumMu.Lock()
	defer enumMu.Unlock()
	enumFound = nil
	procEnumWindows.Call(enumCallback, 0)
	return append([]uintptr(nil), enumFound...)
}

func childWindows(parent uintptr) []uintptr {
	enumMu.Lock()
	defer enumMu.Unlock()
	enumFound = nil
	procEnumChildWindows.Call(parent, enumCallback, 0)
	return append([]uintptr(nil), enumFound...)
}

func windowPID(hwnd uintptr) uint32 {
	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid
}

func className(hwnd uintptr) string {
	buf := make([]uint16, 256)
	n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf[:n])
}

func windowText(hwnd uintptr) string {
	buf := make([]uint16, 512)
	n, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf[:n])
}

func visible(hwnd uintptr) bool {
	r, _, _ := procIsWindowVisible.Call(hwnd)
	return r != 0
}

func processImageName(pid uint32) string {
	h, _, _ := procOpenProcess.Call(processQueryLimitedInfo, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer procCloseHandle.Call(h)
	buf := make([]uint16, 1024)
	size := uint32(len(buf))
	r, _, _ := procQueryFullProcessImageNameW.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:size])
}

type winPhotoshop struct {
	hwnd      uintptr
	pid       uint32
	prevFront uintptr
	focused   bool
}

func openPhotoshopWindow() (psWindow, error) {
	// Physical pixels, so window rectangles and captures agree at any scaling.
	if procSetDpiAwarenessContext.Find() == nil {
		procSetDpiAwarenessContext.Call(dpiPerMonitorAwareV2)
	}
	var found []winPhotoshop
	pids := map[uint32]bool{}
	for _, h := range topLevelWindows() {
		if !visible(h) || className(h) != photoshopMainWindowClass {
			continue
		}
		pid := windowPID(h)
		if !strings.EqualFold(filepath.Base(processImageName(pid)), photoshopExecutable) {
			continue
		}
		found = append(found, winPhotoshop{hwnd: h, pid: pid})
		pids[pid] = true
	}
	switch {
	case len(found) == 0:
		return nil, errors.New("Photoshop's window wasn't found: is Photoshop open and not minimized?")
	case len(pids) > 1:
		return nil, errors.New("more than one Photoshop is running: close the others and try again")
	}
	w := found[0]
	return &w, nil
}

func (w *winPhotoshop) capture() (*frame, error) {
	if r, _, _ := procIsIconic.Call(w.hwnd); r != 0 {
		return nil, errors.New("Photoshop is minimized: restore its window and try again")
	}
	var wr winRect
	if r, _, _ := procGetWindowRect.Call(w.hwnd, uintptr(unsafe.Pointer(&wr))); r == 0 {
		return nil, errors.New("couldn't read Photoshop's window size")
	}
	width, height := int(wr.right-wr.left), int(wr.bottom-wr.top)
	if width <= 0 || height <= 0 || width > 16384 || height > 16384 {
		return nil, fmt.Errorf("unexpected Photoshop window size %dx%d", width, height)
	}

	screenDC, _, _ := procGetDC.Call(0)
	if screenDC == 0 {
		return nil, errors.New("couldn't get a device context")
	}
	defer procReleaseDC.Call(0, screenDC)
	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	if memDC == 0 {
		return nil, errors.New("couldn't create a device context")
	}
	defer procDeleteDC.Call(memDC)

	bih := bitmapInfoHeader{
		width:    int32(width),
		height:   -int32(height), // top-down
		planes:   1,
		bitCount: 32,
	}
	bih.size = uint32(unsafe.Sizeof(bih))
	// BITMAPINFO is the header plus one (unused for 32 bpp) color entry.
	bmi := struct {
		h      bitmapInfoHeader
		colors [1]uint32
	}{h: bih}
	var bits unsafe.Pointer
	hbm, _, _ := procCreateDIBSection.Call(memDC, uintptr(unsafe.Pointer(&bmi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if hbm == 0 || bits == nil {
		return nil, errors.New("couldn't allocate the capture bitmap")
	}
	defer procDeleteObject.Call(hbm)
	old, _, _ := procSelectObject.Call(memDC, hbm)
	defer procSelectObject.Call(memDC, old)

	if r, _, _ := procPrintWindow.Call(w.hwnd, memDC, pwRenderFullContent); r == 0 {
		return nil, errors.New("Windows couldn't capture Photoshop's window")
	}
	n := width * height * 4
	pix := make([]byte, n)
	copy(pix, unsafe.Slice((*byte)(bits), n))
	return &frame{w: width, h: height, pix: pix}, nil
}

func sendKeys(vks ...uint16) {
	inputs := make([]keyInput, 0, len(vks)*2)
	for _, vk := range vks {
		inputs = append(inputs,
			keyInput{typ: inputKeyboard, vk: vk},
			keyInput{typ: inputKeyboard, vk: vk, flags: keyeventfKeyUp},
		)
	}
	procSendInput.Call(uintptr(len(inputs)), uintptr(unsafe.Pointer(&inputs[0])), unsafe.Sizeof(inputs[0]))
}

func foregroundPID() uint32 {
	h, _, _ := procGetForegroundWindow.Call()
	if h == 0 {
		return 0
	}
	return windowPID(h)
}

// focus brings Photoshop to the foreground. Windows only lets the process that
// received the last input take the foreground, so F24 (a key no app binds) is
// tapped first. Alt would open menus.
func (w *winPhotoshop) focus() error {
	if !w.focused {
		w.prevFront, _, _ = procGetForegroundWindow.Call()
		w.focused = true
	}
	for i := 0; i < foregroundConfirmAttempts; i++ {
		if foregroundPID() == w.pid {
			return nil
		}
		sendKeys(vkF24)
		procSetForegroundWindow.Call(w.hwnd)
		time.Sleep(50 * time.Millisecond)
	}
	if foregroundPID() == w.pid {
		return nil
	}
	return errors.New("couldn't bring Photoshop to the front, so no key was sent")
}

func (w *winPhotoshop) pressKey(k psKey) error {
	var vk uint16
	switch k {
	case keyN:
		vk = vkN
	case keyEscape:
		vk = vkEscape
	default:
		return errors.New("unsupported key")
	}
	if err := w.focus(); err != nil {
		return err
	}
	// Re-check right before sending: the key must land in Photoshop.
	if foregroundPID() != w.pid {
		return errors.New("Photoshop lost the foreground, so no key was sent")
	}
	sendKeys(vk)
	return nil
}

func (w *winPhotoshop) clickRelightDiscard() (bool, error) {
	for _, h := range topLevelWindows() {
		if !visible(h) || windowPID(h) != w.pid || className(h) != photoshopDialogClass {
			continue
		}
		var discard uintptr
		prompt := false
		for _, c := range childWindows(h) {
			text := windowText(c)
			switch className(c) {
			case "Static":
				if strings.HasPrefix(strings.ToLower(strings.TrimSpace(text)), relightDiscardPrompt) {
					prompt = true
				}
			case "Button":
				if strings.EqualFold(strings.ReplaceAll(strings.TrimSpace(text), "&", ""), "Discard") {
					discard = c
				}
			}
		}
		if !prompt {
			continue
		}
		if discard == 0 {
			return true, errors.New("found Photoshop's discard dialog but not its Discard button")
		}
		procSendMessageW.Call(discard, bmClick, 0, 0)
		return true, nil
	}
	return false, nil
}

func (w *winPhotoshop) restoreFocus() {
	if !w.focused || w.prevFront == 0 || windowPID(w.prevFront) == w.pid {
		return
	}
	for i := 0; i < 5; i++ {
		sendKeys(vkF24)
		procSetForegroundWindow.Call(w.prevFront)
		time.Sleep(50 * time.Millisecond)
		if h, _, _ := procGetForegroundWindow.Call(); h == w.prevFront {
			return
		}
	}
}
