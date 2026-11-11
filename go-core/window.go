package main

// Photoshop window helpers for ps_relight's free preview.
//
// Photoshop's Relight panel (AM 'lightshop' run with DialogModes.ALL) shows a
// free low-resolution preview and only renders, and charges Adobe Firefly
// credits, on Done. While it is open Photoshop is modal and ExtendScript is
// blocked, so the preview is read from Photoshop's own window instead:
//
//	editmamei-core window capture
//	    Capture Photoshop's window, find the canvas, and print its crop rectangle
//	    and a 32x32 gray signature. Taken before the panel opens, as the baseline.
//	editmamei-core window relight-preview -crop x,y,w,h -baseline <hex> [-timeout-ms N]
//	    Poll captures until the canvas differs from the baseline and holds still,
//	    press N (hide the light markers), capture the canvas as a PNG, then close
//	    the panel: one Escape, then click Discard on Photoshop's
//	    "Discard the Relight layer?" dialog.
//	editmamei-core window cancel-relight
//	    Just the closing step (Escape, then Discard), for cleanup.
//
// Scope rules: only Photoshop's own window is captured (by its handle, never the
// desktop); only the canvas crop leaves this process; nothing is written to disk.
// The only keys ever sent are F24 (lets Photoshop take the foreground), N and
// Escape. Never Enter: in the Relight panel Enter can mean Done, which renders.
//
// The OS-specific half lives in window_windows.go / window_other.go; this file
// holds the pure logic so it is unit-testable on every platform.

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

// frame is a captured window: top-down, 4 bytes per pixel in B, G, R, X order
// (the layout of a 32-bit Windows DIB).
type frame struct {
	w, h int
	pix  []byte
}

func (f *frame) rgb(x, y int) (r, g, b int) {
	i := (y*f.w + x) * 4
	return int(f.pix[i+2]), int(f.pix[i+1]), int(f.pix[i])
}

type rect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// psKey is the closed set of keys this package may send. There is
// deliberately no Enter.
type psKey int

const (
	keyN psKey = iota
	keyEscape
)

// psWindow is Photoshop's main window on the host OS.
type psWindow interface {
	capture() (*frame, error)
	// pressKey brings Photoshop to the foreground and sends one key, or sends
	// nothing and errors when Photoshop could not be confirmed in front.
	pressKey(k psKey) error
	// clickRelightDiscard clicks Discard on Photoshop's "Discard the Relight
	// layer?" dialog. found is false when no such dialog is up.
	clickRelightDiscard() (found bool, err error)
	// restoreFocus gives the foreground back to the window that had it.
	restoreFocus()
}

var errWindowUnsupported = errors.New("the Relight preview is only available on Windows for now")

// --- canvas detection -------------------------------------------------------

const (
	pasteboardMinRun = 10 // identical neutral pixels that make a pasteboard run
	colorTolerance   = 3  // per channel, when matching the pasteboard color
	minCanvasSide    = 48
	canvasInset      = 2
	// aspectTolerance: how far the found rectangle's shape may be from the
	// document's (screen pixels round the canvas size).
	aspectTolerance = 0.03
)

// settleFrames is how many successive steady captures, each already different
// from the baseline, count as the preview having settled. Live on 2026-11-11 the
// preview arrived in one step with the panel, about 4.5 s after the script began.
const settleFrames = 2

func neutral(r, g, b int) bool {
	hi, lo := max(r, g, b), min(r, g, b)
	return hi-lo <= 2
}

func near(r1, g1, b1, r2, g2, b2, tol int) bool {
	return abs(r1-r2) <= tol && abs(g1-g2) <= tol && abs(b1-b2) <= tol
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

type rgbColor struct{ r, g, b int }

// firstRun walks from (x, y) in steps (dx, dy) and returns the start of the first
// run of pasteboardMinRun identical neutral pixels, with its color.
func firstRun(f *frame, x, y, dx, dy int) (int, int, rgbColor, bool) {
	runX, runY, n := x, y, 0
	var c rgbColor
	for x >= 0 && y >= 0 && x < f.w && y < f.h {
		r, g, b := f.rgb(x, y)
		if neutral(r, g, b) && n > 0 && near(r, g, b, c.r, c.g, c.b, 1) {
			n++
			if n >= pasteboardMinRun {
				return runX, runY, c, true
			}
		} else if neutral(r, g, b) {
			runX, runY, n, c = x, y, 1, rgbColor{r, g, b}
		} else {
			n = 0
		}
		x += dx
		y += dy
	}
	return 0, 0, rgbColor{}, false
}

// edgeToward walks from (x, y) in steps (dx, dy) and returns the last pixel
// before the pasteboard color begins. ok is false when the window edge comes
// first: the canvas fills that direction, or something that isn't pasteboard
// (a scrollbar, a panel) sits there.
func edgeToward(f *frame, x, y, dx, dy int, pb rgbColor) (int, bool) {
	px, py := x, y
	for x >= 0 && y >= 0 && x < f.w && y < f.h {
		r, g, b := f.rgb(x, y)
		if near(r, g, b, pb.r, pb.g, pb.b, colorTolerance) {
			if dx != 0 {
				return px, true
			}
			return py, true
		}
		px, py = x, y
		x += dx
		y += dy
	}
	return 0, false
}

// runExtent measures the pasteboard run through (x, y) along one axis, for the
// case where the canvas fills that axis: the run's ends are the canvas's ends.
func runExtent(f *frame, x, y, dx, dy int, pb rgbColor) (int, int) {
	inside := func(x, y int) bool {
		if x < 0 || y < 0 || x >= f.w || y >= f.h {
			return false
		}
		r, g, b := f.rgb(x, y)
		return near(r, g, b, pb.r, pb.g, pb.b, colorTolerance)
	}
	lx, ly := x, y
	for inside(lx-dx, ly-dy) {
		lx, ly = lx-dx, ly-dy
	}
	hx, hy := x, y
	for inside(hx+dx, hy+dy) {
		hx, hy = hx+dx, hy+dy
	}
	if dx != 0 {
		return lx, hx
	}
	return ly, hy
}

// findCanvas locates the document canvas in a capture of Photoshop's window.
// It starts at the window's center (inside the canvas when the photo is fit to
// the view) and looks outward for Photoshop's pasteboard: a flat neutral gray.
// Each canvas edge is the last pixel before the pasteboard. When the canvas fills
// one axis (no pasteboard on that axis), the pasteboard band on the other axis
// spans exactly the canvas, so its ends are used.
//
// Panels and toolbars are flat neutral grays too, so every gray found is tried
// as the pasteboard, and the rectangle whose shape matches the document (aspect
// = width/height, from Photoshop) wins. Without an aspect, a gray found on two
// opposite sides is taken.
func findCanvas(f *frame, aspect float64) (rect, error) {
	if f == nil || f.w < minCanvasSide || f.h < minCanvasSide {
		return rect{}, errors.New("the Photoshop window capture is empty")
	}
	cx, cy := f.w/2, f.h/2
	type probe struct{ dx, dy int }
	dirs := []probe{{-1, 0}, {1, 0}, {0, -1}, {0, 1}}
	colors := make([]*rgbColor, 4)
	var candidates []rgbColor
	for i, d := range dirs {
		if _, _, c, ok := firstRun(f, cx, cy, d.dx, d.dy); ok {
			cc := c
			colors[i] = &cc
			seen := false
			for _, k := range candidates {
				if near(k.r, k.g, k.b, c.r, c.g, c.b, 1) {
					seen = true
				}
			}
			if !seen {
				candidates = append(candidates, c)
			}
		}
	}
	same := func(a, b *rgbColor) bool {
		return a != nil && b != nil && near(a.r, a.g, a.b, b.r, b.g, b.b, 1)
	}
	if aspect <= 0 {
		switch {
		case same(colors[0], colors[1]):
			candidates = []rgbColor{*colors[0]}
		case same(colors[2], colors[3]):
			candidates = []rgbColor{*colors[2]}
		default:
			candidates = nil
		}
	}
	best, bestErr := rect{}, math.MaxFloat64
	found := false
	for _, pb := range candidates {
		r, ok := canvasFor(f, cx, cy, pb)
		if !ok {
			continue
		}
		e := 0.0
		if aspect > 0 {
			e = math.Abs(float64(r.W)/float64(r.H)/aspect - 1)
			if e > aspectTolerance {
				continue
			}
		}
		if e < bestErr {
			best, bestErr, found = r, e, true
		}
	}
	if !found {
		return rect{}, errors.New("couldn't find the photo in Photoshop's window: fit the photo on screen so it shows whole with gray around it (View > Fit on Screen)")
	}
	// Photoshop draws a thin border line around the canvas; inset past it.
	out := rect{X: best.X + canvasInset, Y: best.Y + canvasInset, W: best.W - 2*canvasInset, H: best.H - 2*canvasInset}
	if out.W < minCanvasSide || out.H < minCanvasSide {
		return rect{}, errors.New("the photo is too small in Photoshop's window to preview: fit it on screen (View > Fit on Screen)")
	}
	return out, nil
}

// canvasFor finds the canvas rectangle (before the inset) if pb is the
// pasteboard color.
func canvasFor(f *frame, cx, cy int, pb rgbColor) (rect, bool) {
	cr, cg, cb := f.rgb(cx, cy)
	if near(cr, cg, cb, pb.r, pb.g, pb.b, colorTolerance) {
		return rect{}, false
	}
	left, okL := edgeToward(f, cx, cy, -1, 0, pb)
	right, okR := edgeToward(f, cx, cy, 1, 0, pb)
	top, okT := edgeToward(f, cx, cy, 0, -1, pb)
	bottom, okB := edgeToward(f, cx, cy, 0, 1, pb)
	switch {
	case okL && okR && okT && okB:
	case okT && okB && !(okL && okR):
		// Canvas fills the width: the pasteboard band just above it spans it.
		left, right = runExtent(f, cx, top-1, 1, 0, pb)
	case okL && okR && !(okT && okB):
		top, bottom = runExtent(f, left-1, cy, 0, 1, pb)
	default:
		return rect{}, false
	}
	r := trimShadow(f, rect{X: left, Y: top, W: right - left + 1, H: bottom - top + 1}, pb)
	return r, r.W >= minCanvasSide && r.H >= minCanvasSide
}

// shadowDepth: how far from the pasteboard gray Photoshop's canvas drop shadow
// gets (live, 2026-11-11: 31-33 against a #282828 pasteboard, four rows deep).
const (
	shadowDepth   = 16
	maxShadowRows = 12
)

// trimShadow drops edge rows and columns that are flat neutral gray close to
// the pasteboard: the canvas's drop shadow, which isn't pasteboard colored
// exactly and so ends up inside the edges found above.
func trimShadow(f *frame, r rect, pb rgbColor) rect {
	shadowLine := func(x0, y0, dx, dy, n int) bool {
		for i := 0; i < 16; i++ {
			k := i * (n - 1) / 15
			cr, cg, cb := f.rgb(x0+dx*k, y0+dy*k)
			if !neutral(cr, cg, cb) || abs(cr-pb.r) > shadowDepth {
				return false
			}
		}
		return true
	}
	for i := 0; i < maxShadowRows && r.H > minCanvasSide && shadowLine(r.X, r.Y+r.H-1, 1, 0, r.W); i++ {
		r.H--
	}
	for i := 0; i < maxShadowRows && r.H > minCanvasSide && shadowLine(r.X, r.Y, 1, 0, r.W); i++ {
		r.Y++
		r.H--
	}
	for i := 0; i < maxShadowRows && r.W > minCanvasSide && shadowLine(r.X+r.W-1, r.Y, 0, 1, r.H); i++ {
		r.W--
	}
	for i := 0; i < maxShadowRows && r.W > minCanvasSide && shadowLine(r.X, r.Y, 0, 1, r.H); i++ {
		r.X++
		r.W--
	}
	return r
}

// --- signatures -------------------------------------------------------------

const sigSide = 32

// signature is a sigSide x sigSide gray thumbnail of the crop: cheap to compare
// and small enough to pass on a command line.
func signature(f *frame, c rect) ([]byte, error) {
	if c.W < sigSide || c.H < sigSide || c.X < 0 || c.Y < 0 || c.X+c.W > f.w || c.Y+c.H > f.h {
		return nil, errors.New("the canvas crop is outside the captured window (did Photoshop's window move?)")
	}
	out := make([]byte, sigSide*sigSide)
	for sy := 0; sy < sigSide; sy++ {
		y0, y1 := c.Y+sy*c.H/sigSide, c.Y+(sy+1)*c.H/sigSide
		for sx := 0; sx < sigSide; sx++ {
			x0, x1 := c.X+sx*c.W/sigSide, c.X+(sx+1)*c.W/sigSide
			sum, n := 0, 0
			for y := y0; y < y1; y++ {
				for x := x0; x < x1; x++ {
					r, g, b := f.rgb(x, y)
					sum += (r*299 + g*587 + b*114) / 1000
					n++
				}
			}
			out[sy*sigSide+sx] = byte(sum / max(n, 1))
		}
	}
	return out, nil
}

func round2(v float64) float64 { return float64(int(v*100+0.5)) / 100 }

// sigDiff is the mean absolute difference between two signatures, 0-255.
func sigDiff(a, b []byte) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 255
	}
	total := 0
	for i := range a {
		total += abs(int(a[i]) - int(b[i]))
	}
	return float64(total) / float64(len(a))
}

// maxPreviewSide caps the preview's long edge: it's a low-resolution look at
// light and color, and smaller is cheaper to send.
const maxPreviewSide = 1024

// cropPNG encodes the crop, box-averaged down so its long edge is at most
// maxSide (0 = full size).
func cropPNG(f *frame, c rect, maxSide int) ([]byte, error) {
	if c.W <= 0 || c.H <= 0 || c.X < 0 || c.Y < 0 || c.X+c.W > f.w || c.Y+c.H > f.h {
		return nil, errors.New("the canvas crop is outside the captured window")
	}
	w, h := c.W, c.H
	if maxSide > 0 && max(w, h) > maxSide {
		if w >= h {
			w, h = maxSide, max(1, c.H*maxSide/c.W)
		} else {
			w, h = max(1, c.W*maxSide/c.H), maxSide
		}
	}
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		y0, y1 := c.Y+y*c.H/h, c.Y+(y+1)*c.H/h
		for x := 0; x < w; x++ {
			x0, x1 := c.X+x*c.W/w, c.X+(x+1)*c.W/w
			sr, sg, sb, n := 0, 0, 0, 0
			for yy := y0; yy < max(y1, y0+1); yy++ {
				for xx := x0; xx < max(x1, x0+1); xx++ {
					r, g, b := f.rgb(xx, yy)
					sr, sg, sb, n = sr+r, sg+g, sb+b, n+1
				}
			}
			img.SetNRGBA(x, y, color.NRGBA{uint8(sr / n), uint8(sg / n), uint8(sb / n), 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// --- the preview loop ---------------------------------------------------------

type previewOpts struct {
	crop     rect
	baseline []byte        // canvas signature before the panel opened
	window   []byte        // whole-window signature before the panel opened (optional)
	timeout  time.Duration // how long to wait for the preview to appear and settle
	poll     time.Duration
	// changed: mean canvas difference from the baseline that counts as the
	// preview having appeared. stable: difference between two successive
	// captures that counts as holding still.
	changed, stable float64
}

// windowOpened is the whole-window difference that means the Relight panel
// opened (Photoshop swaps the Properties panel and the options bar). It lets a
// preview that looks almost like the photo already on the canvas (an edit
// close to the current lights) settle without waiting out the timeout.
const (
	windowOpened      = 3.0
	panelSettleFrames = 6
)

type previewResult struct {
	Settled  bool    `json:"settled"`
	WaitedMs int64   `json:"waited_ms"`
	Change   float64 `json:"change"`
	Width    int     `json:"width,omitempty"`
	Height   int     `json:"height,omitempty"`
	PNG      string  `json:"png_base64,omitempty"`
	// Closed: "discarded" (dialog found and Discard clicked), "no_dialog"
	// (Escape sent and no dialog came up: Photoshop closed the panel without one,
	// as it does for an existing Relight layer, or the panel never opened), or
	// "failed" (the key could not be sent).
	Closed string `json:"closed"`
	Error  string `json:"error,omitempty"`
	// Trace is [elapsed ms, canvas change from baseline, change from previous
	// capture] per poll: numbers only, for diagnosing timing.
	Trace [][3]float64 `json:"trace,omitempty"`
}

type clock struct {
	now   func() time.Time
	sleep func(time.Duration)
}

// runRelightPreview waits for the preview, captures it, and always tries to
// close the panel, whatever happened before.
func runRelightPreview(w psWindow, o previewOpts, clk clock) previewResult {
	res := previewResult{}
	defer w.restoreFocus()
	start := clk.now()
	var prev []byte
	var last *frame
	steady, panelSteady := 0, 0
	for clk.now().Sub(start) < o.timeout {
		f, err := w.capture()
		if err == nil {
			if sig, serr := signature(f, o.crop); serr == nil {
				last = f
				res.Change = sigDiff(sig, o.baseline)
				step := 255.0
				if prev != nil {
					step = sigDiff(sig, prev)
				}
				res.Trace = append(res.Trace, [3]float64{
					float64(clk.now().Sub(start).Milliseconds()), round2(res.Change), round2(step),
				})
				opened := false
				if len(o.window) > 0 {
					if ws, werr := signature(f, rect{0, 0, f.w, f.h}); werr == nil {
						opened = sigDiff(ws, o.window) >= windowOpened
					}
				}
				steady = countSteady(steady, res.Change >= o.changed && step <= o.stable)
				panelSteady = countSteady(panelSteady, opened && step <= o.stable)
				if steady >= settleFrames || panelSteady >= panelSettleFrames {
					res.Settled = true
					break
				}
				prev = sig
			} else {
				res.Error = serr.Error()
			}
		} else {
			res.Error = err.Error()
		}
		clk.sleep(o.poll)
	}
	res.WaitedMs = clk.now().Sub(start).Milliseconds()

	if res.Settled {
		res.Error = ""
		// Hide the light markers for a clean image. If the key can't be sent,
		// or the window changed size, keep the frame already captured (markers
		// and all).
		if err := w.pressKey(keyN); err == nil {
			clk.sleep(400 * time.Millisecond)
			if f, err := w.capture(); err == nil {
				if _, serr := signature(f, o.crop); serr == nil {
					last = f
				}
			}
		}
	}
	if last != nil {
		if data, err := cropPNG(last, o.crop, maxPreviewSide); err == nil {
			if cfg, err := png.DecodeConfig(bytes.NewReader(data)); err == nil {
				res.Width, res.Height = cfg.Width, cfg.Height
			}
			res.PNG = base64.StdEncoding.EncodeToString(data)
		}
	}
	closed, err := closeRelightPanel(w, clk)
	res.Closed = closed
	if err != nil && res.Error == "" {
		res.Error = err.Error()
	}
	return res
}

func countSteady(n int, ok bool) int {
	if ok {
		return n + 1
	}
	return 0
}

// closeRelightPanel sends one Escape and clicks Discard on the dialog it brings
// up. Never Enter.
func closeRelightPanel(w psWindow, clk clock) (string, error) {
	if err := w.pressKey(keyEscape); err != nil {
		return "failed", err
	}
	deadline := clk.now().Add(3 * time.Second)
	for clk.now().Before(deadline) {
		clk.sleep(150 * time.Millisecond)
		found, err := w.clickRelightDiscard()
		if err != nil {
			return "failed", err
		}
		if found {
			return "discarded", nil
		}
	}
	return "no_dialog", nil
}

// --- command line -----------------------------------------------------------

func parseCrop(s string) (rect, error) {
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return rect{}, fmt.Errorf("crop must be x,y,w,h")
	}
	v := make([]int, 4)
	for i, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || n < 0 {
			return rect{}, fmt.Errorf("crop must be four non-negative integers")
		}
		v[i] = n
	}
	return rect{v[0], v[1], v[2], v[3]}, nil
}

func writeJSON(out io.Writer, v any) {
	_ = json.NewEncoder(out).Encode(v)
}

func windowFail(out io.Writer, err error) int {
	writeJSON(out, map[string]any{"error": err.Error(), "unsupported": errors.Is(err, errWindowUnsupported)})
	return 1
}

var realClock = clock{now: time.Now, sleep: time.Sleep}

// runWindow dispatches `editmamei-core window <action>`. Output is one JSON
// object on stdout; exit 1 carries {"error": ...}.
func runWindow(args []string, out io.Writer) int {
	if len(args) == 0 {
		return windowFail(out, errors.New("usage: editmamei-core window capture|relight-preview|cancel-relight"))
	}
	action := args[0]
	fs := flag.NewFlagSet("window "+action, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	cropFlag := fs.String("crop", "", "canvas crop x,y,w,h from capture")
	baseFlag := fs.String("baseline", "", "canvas signature (hex) from capture")
	winFlag := fs.String("window-baseline", "", "whole-window signature (hex) from capture")
	aspect := fs.Float64("aspect", 0, "document width / height, to tell the canvas from panels")
	timeoutMs := fs.Int("timeout-ms", 45000, "how long to wait for the preview")
	changed := fs.Float64("changed", 1, "baseline difference that counts as the preview appearing")
	stable := fs.Float64("stable", 0.75, "successive-capture difference that counts as settled")
	if err := fs.Parse(args[1:]); err != nil {
		return windowFail(out, err)
	}

	switch action {
	case "capture", "relight-preview", "cancel-relight":
	default:
		return windowFail(out, fmt.Errorf("unknown window action %q", action))
	}

	w, err := openPhotoshopWindow()
	if err != nil {
		return windowFail(out, err)
	}

	switch action {
	case "capture":
		f, err := w.capture()
		if err != nil {
			return windowFail(out, err)
		}
		c, err := findCanvas(f, *aspect)
		if err != nil {
			return windowFail(out, err)
		}
		sig, err := signature(f, c)
		if err != nil {
			return windowFail(out, err)
		}
		wsig, err := signature(f, rect{0, 0, f.w, f.h})
		if err != nil {
			return windowFail(out, err)
		}
		writeJSON(out, map[string]any{
			"crop":             c,
			"signature":        hex.EncodeToString(sig),
			"window_signature": hex.EncodeToString(wsig),
		})
		return 0

	case "relight-preview":
		c, err := parseCrop(*cropFlag)
		if err != nil {
			return windowFail(out, err)
		}
		base, err := hex.DecodeString(*baseFlag)
		if err != nil || len(base) != sigSide*sigSide {
			return windowFail(out, errors.New("baseline must be the signature from window capture"))
		}
		var winBase []byte
		if *winFlag != "" {
			if winBase, err = hex.DecodeString(*winFlag); err != nil || len(winBase) != sigSide*sigSide {
				return windowFail(out, errors.New("window-baseline must be the window_signature from window capture"))
			}
		}
		res := runRelightPreview(w, previewOpts{
			crop:     c,
			baseline: base,
			window:   winBase,
			timeout:  time.Duration(min(max(*timeoutMs, 1000), 120000)) * time.Millisecond,
			poll:     700 * time.Millisecond,
			changed:  *changed,
			stable:   *stable,
		}, realClock)
		writeJSON(out, res)
		return 0

	default: // cancel-relight
		defer w.restoreFocus()
		closed, err := closeRelightPanel(w, realClock)
		res := map[string]any{"closed": closed}
		if err != nil {
			res["error"] = err.Error()
		}
		writeJSON(out, res)
		return 0
	}
}
