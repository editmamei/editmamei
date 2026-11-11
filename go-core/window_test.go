package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image/png"
	"strings"
	"testing"
	"time"
)

// newFrame paints a w x h frame with a UI gray, a pasteboard rectangle, and a
// textured canvas inside it, like Photoshop's window at Fit on Screen.
func newFrame(w, h int, paste, canvas rect) *frame {
	f := &frame{w: w, h: h, pix: make([]byte, w*h*4)}
	set := func(x, y, r, g, b int) {
		i := (y*w + x) * 4
		f.pix[i], f.pix[i+1], f.pix[i+2] = byte(b), byte(g), byte(r)
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			switch {
			case x >= canvas.X && x < canvas.X+canvas.W && y >= canvas.Y && y < canvas.Y+canvas.H:
				// A photo: never a flat neutral run.
				set(x, y, 120+(x*7+y*3)%90, 90+(x*5)%60, 60+(y*11)%50)
			case x >= paste.X && x < paste.X+paste.W && y >= paste.Y && y < paste.Y+paste.H:
				set(x, y, 0x28, 0x28, 0x28)
			default:
				set(x, y, 0x53, 0x53, 0x53) // panels and toolbars
			}
		}
	}
	return f
}

func paint(f *frame, area rect, r, g, b int) {
	for y := area.Y; y < area.Y+area.H; y++ {
		for x := area.X; x < area.X+area.W; x++ {
			i := (y*f.w + x) * 4
			f.pix[i], f.pix[i+1], f.pix[i+2] = byte(b), byte(g), byte(r)
		}
	}
}

func TestFindCanvasSurroundedByPasteboard(t *testing.T) {
	canvas := rect{X: 300, Y: 120, W: 400, H: 600}
	f := newFrame(1000, 800, rect{X: 60, Y: 40, W: 880, H: 740}, canvas)
	got, err := findCanvas(f, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := rect{X: canvas.X + canvasInset, Y: canvas.Y + canvasInset, W: canvas.W - 2*canvasInset, H: canvas.H - 2*canvasInset}
	if got != want {
		t.Fatalf("crop = %+v, want %+v", got, want)
	}
}

// Photoshop's drop shadow under the canvas is a few rows a little darker than
// the pasteboard (31-33 against 40, live 2026-11-11); it must not end up in the
// preview.
func TestFindCanvasDropsTheCanvasShadow(t *testing.T) {
	canvas := rect{X: 300, Y: 120, W: 400, H: 600}
	f := newFrame(1000, 800, rect{X: 60, Y: 40, W: 880, H: 740}, canvas)
	for i, v := range []int{33, 32, 32, 31} {
		paint(f, rect{X: canvas.X, Y: canvas.Y + canvas.H + i, W: canvas.W, H: 1}, v, v, v)
	}
	got, err := findCanvas(f, float64(canvas.W)/float64(canvas.H))
	if err != nil {
		t.Fatal(err)
	}
	if bottom := got.Y + got.H; bottom != canvas.Y+canvas.H-canvasInset {
		t.Fatalf("bottom = %d, want %d (shadow left in the crop)", bottom, canvas.Y+canvas.H-canvasInset)
	}
}

// A scrollbar beside the pasteboard isn't pasteboard colored; the edge must stop
// where the pasteboard starts, not run on to the window edge.
func TestFindCanvasIgnoresScrollbar(t *testing.T) {
	canvas := rect{X: 300, Y: 120, W: 400, H: 600}
	f := newFrame(1000, 800, rect{X: 60, Y: 40, W: 880, H: 740}, canvas)
	paint(f, rect{X: 925, Y: 40, W: 15, H: 740}, 0x3a, 0x3a, 0x3a)
	got, err := findCanvas(f, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.X+got.W != canvas.X+canvas.W-canvasInset {
		t.Fatalf("right edge = %d, want %d", got.X+got.W, canvas.X+canvas.W-canvasInset)
	}
}

// A landscape photo at Fit on Screen fills the width: no pasteboard left or
// right, so the pasteboard band above it gives the side edges.
func TestFindCanvasFillingTheWidth(t *testing.T) {
	paste := rect{X: 60, Y: 40, W: 880, H: 740}
	canvas := rect{X: 60, Y: 200, W: 880, H: 400}
	f := newFrame(1000, 800, paste, canvas)
	// The panel gray beside the canvas is a flat neutral too; the document's
	// shape tells them apart.
	got, err := findCanvas(f, 880.0/400.0)
	if err != nil {
		t.Fatal(err)
	}
	if got.X != canvas.X+canvasInset || got.W != canvas.W-2*canvasInset {
		t.Fatalf("crop = %+v, want x %d w %d", got, canvas.X+canvasInset, canvas.W-2*canvasInset)
	}
	if got.Y != canvas.Y+canvasInset || got.H != canvas.H-2*canvasInset {
		t.Fatalf("crop = %+v, want y %d h %d", got, canvas.Y+canvasInset, canvas.H-2*canvasInset)
	}
}

func TestFindCanvasRefusesWithoutPasteboard(t *testing.T) {
	// Zoomed in: the photo covers the whole document area.
	f := newFrame(1000, 800, rect{}, rect{X: 0, Y: 0, W: 1000, H: 800})
	if _, err := findCanvas(f, 0); err == nil || !strings.Contains(err.Error(), "Fit on Screen") {
		t.Fatalf("err = %v, want a Fit on Screen hint", err)
	}
}

func TestSignatureDiff(t *testing.T) {
	canvas := rect{X: 300, Y: 120, W: 400, H: 600}
	f := newFrame(1000, 800, rect{X: 60, Y: 40, W: 880, H: 740}, canvas)
	a, err := signature(f, canvas)
	if err != nil {
		t.Fatal(err)
	}
	if d := sigDiff(a, a); d != 0 {
		t.Fatalf("self diff = %v", d)
	}
	paint(f, canvas, 250, 200, 120)
	b, _ := signature(f, canvas)
	if d := sigDiff(a, b); d < 10 {
		t.Fatalf("repainted canvas diff = %v, want a large change", d)
	}
	if _, err := signature(f, rect{X: 900, Y: 700, W: 200, H: 200}); err == nil {
		t.Fatal("a crop outside the frame must fail")
	}
}

// --- the loop, against a fake window -------------------------------------------

type fakeWindow struct {
	frames   []*frame // returned in order; the last one repeats
	calls    int
	keys     []psKey
	keyErr   map[psKey]error
	dialogAt int // clickRelightDiscard call that finds the dialog (0 = never)
	dialogN  int
	restored bool
}

func (w *fakeWindow) capture() (*frame, error) {
	i := min(w.calls, len(w.frames)-1)
	w.calls++
	return w.frames[i], nil
}

func (w *fakeWindow) pressKey(k psKey) error {
	if err := w.keyErr[k]; err != nil {
		return err
	}
	w.keys = append(w.keys, k)
	return nil
}

func (w *fakeWindow) clickRelightDiscard() (bool, error) {
	w.dialogN++
	return w.dialogAt > 0 && w.dialogN >= w.dialogAt, nil
}

func (w *fakeWindow) restoreFocus() { w.restored = true }

type fakeClock struct{ t time.Time }

func (c *fakeClock) clock() clock {
	return clock{now: func() time.Time { return c.t }, sleep: func(d time.Duration) { c.t = c.t.Add(d) }}
}

func previewFixture() (before, after *frame, crop rect, base []byte, winBase []byte) {
	crop = rect{X: 300, Y: 120, W: 400, H: 600}
	paste := rect{X: 60, Y: 40, W: 880, H: 740}
	before = newFrame(1000, 800, paste, crop)
	after = newFrame(1000, 800, paste, crop)
	paint(after, rect{X: 300, Y: 120, W: 200, H: 600}, 250, 190, 110) // the relit half
	base, _ = signature(before, crop)
	winBase, _ = signature(before, rect{0, 0, before.w, before.h})
	return
}

func TestRelightPreviewSettlesThenHidesMarkersThenDiscards(t *testing.T) {
	before, after, crop, base, _ := previewFixture()
	w := &fakeWindow{frames: []*frame{before, before, before, after}, dialogAt: 2}
	clk := &fakeClock{t: time.Unix(0, 0)}
	res := runRelightPreview(w, previewOpts{crop: crop, baseline: base, timeout: 45 * time.Second, poll: 700 * time.Millisecond, changed: 1, stable: 0.75}, clk.clock())

	if !res.Settled {
		t.Fatalf("not settled: %+v", res)
	}
	if len(w.keys) != 2 || w.keys[0] != keyN || w.keys[1] != keyEscape {
		t.Fatalf("keys = %v, want [N, Escape]", w.keys)
	}
	if res.Closed != "discarded" {
		t.Fatalf("closed = %q, want discarded", res.Closed)
	}
	if !w.restored {
		t.Fatal("focus was not handed back")
	}
	data, err := base64.StdEncoding.DecodeString(res.PNG)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != crop.W || b.Dy() != crop.H {
		t.Fatalf("png is %dx%d, want the %dx%d canvas crop only", b.Dx(), b.Dy(), crop.W, crop.H)
	}
}

// An existing Relight layer's panel closes on Escape with no dialog (live,
// 2026-11-11). That's a clean close, not a failure.
func TestRelightPreviewNoDialogIsAClose(t *testing.T) {
	before, after, crop, base, _ := previewFixture()
	w := &fakeWindow{frames: []*frame{before, after}}
	clk := &fakeClock{t: time.Unix(0, 0)}
	res := runRelightPreview(w, previewOpts{crop: crop, baseline: base, timeout: 45 * time.Second, poll: 700 * time.Millisecond, changed: 1, stable: 0.75}, clk.clock())
	if res.Closed != "no_dialog" || res.Error != "" {
		t.Fatalf("closed = %q err = %q, want no_dialog and no error", res.Closed, res.Error)
	}
}

// The panel opening changes the whole window even when the preview barely
// changes the canvas; that must settle well before the timeout.
func TestRelightPreviewSettlesOnPanelWhenCanvasBarelyChanges(t *testing.T) {
	before, _, crop, base, winBase := previewFixture()
	opened := newFrame(1000, 800, rect{X: 60, Y: 40, W: 880, H: 740}, crop)
	paint(opened, rect{X: 940, Y: 0, W: 60, H: 800}, 200, 200, 200) // the panel
	w := &fakeWindow{frames: []*frame{before, opened}, dialogAt: 1}
	clk := &fakeClock{t: time.Unix(0, 0)}
	res := runRelightPreview(w, previewOpts{crop: crop, baseline: base, window: winBase, timeout: 45 * time.Second, poll: 700 * time.Millisecond, changed: 1, stable: 0.75}, clk.clock())
	if !res.Settled || res.WaitedMs > 10000 {
		t.Fatalf("settled=%v after %d ms, want settled within 10 s", res.Settled, res.WaitedMs)
	}
}

// When nothing changes the loop gives up at the timeout and still closes the
// panel.
func TestRelightPreviewTimeoutStillCloses(t *testing.T) {
	before, _, crop, base, _ := previewFixture()
	w := &fakeWindow{frames: []*frame{before}, dialogAt: 1}
	clk := &fakeClock{t: time.Unix(0, 0)}
	res := runRelightPreview(w, previewOpts{crop: crop, baseline: base, timeout: 5 * time.Second, poll: 700 * time.Millisecond, changed: 1, stable: 0.75}, clk.clock())
	if res.Settled {
		t.Fatal("settled on an unchanged canvas")
	}
	if len(w.keys) != 1 || w.keys[0] != keyEscape {
		t.Fatalf("keys = %v, want just Escape (no N on an unsettled preview)", w.keys)
	}
	if res.Closed != "discarded" {
		t.Fatalf("closed = %q", res.Closed)
	}
}

// If Photoshop can't be brought to the front, no key goes anywhere and the
// result says the panel was not closed.
func TestRelightPreviewEscapeRefused(t *testing.T) {
	before, after, crop, base, _ := previewFixture()
	refused := errors.New("couldn't bring Photoshop to the front, so no key was sent")
	w := &fakeWindow{frames: []*frame{before, after}, keyErr: map[psKey]error{keyN: refused, keyEscape: refused}}
	clk := &fakeClock{t: time.Unix(0, 0)}
	res := runRelightPreview(w, previewOpts{crop: crop, baseline: base, timeout: 45 * time.Second, poll: 700 * time.Millisecond, changed: 1, stable: 0.75}, clk.clock())
	if res.Closed != "failed" || res.Error == "" {
		t.Fatalf("closed = %q err = %q, want failed with the reason", res.Closed, res.Error)
	}
	if w.dialogN != 0 {
		t.Fatal("looked for the discard dialog without having sent Escape")
	}
	if res.PNG == "" {
		t.Fatal("the settled frame (with markers) should still come back")
	}
}

func TestParseCrop(t *testing.T) {
	if c, err := parseCrop("1,2,300,400"); err != nil || c != (rect{1, 2, 300, 400}) {
		t.Fatalf("parseCrop = %+v, %v", c, err)
	}
	for _, bad := range []string{"", "1,2,3", "a,b,c,d", "-1,0,10,10"} {
		if _, err := parseCrop(bad); err == nil {
			t.Fatalf("parseCrop(%q) accepted", bad)
		}
	}
}

// The key set is closed: there is no way to ask for Enter.
func TestOnlyNAndEscapeExist(t *testing.T) {
	if keyN == keyEscape {
		t.Fatal("keys collide")
	}
	var buf bytes.Buffer
	if code := runWindow([]string{"press-enter"}, &buf); code == 0 || !strings.Contains(buf.String(), "unknown window action") {
		t.Fatalf("runWindow accepted an unknown action: %s", buf.String())
	}
}

// The preview is a low-resolution look, capped on its long edge.
func TestCropPNGDownscales(t *testing.T) {
	canvas := rect{X: 100, Y: 50, W: 1800, H: 1200}
	f := newFrame(2000, 1400, rect{X: 50, Y: 20, W: 1900, H: 1360}, canvas)
	data, err := cropPNG(f, canvas, maxPreviewSide)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != 1024 || cfg.Height != 682 {
		t.Fatalf("got %dx%d, want 1024x682", cfg.Width, cfg.Height)
	}
	if _, err := cropPNG(f, rect{X: 1900, Y: 0, W: 400, H: 400}, 0); err == nil {
		t.Fatal("a crop outside the frame must fail, not panic")
	}
}
