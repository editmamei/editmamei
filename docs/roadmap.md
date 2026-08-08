# Roadmap

Editmamei, the MCP server that drives Adobe Photoshop from your AI assistant, is in active development. This page lists what's being built but **not yet shipped**. For what's in each edition today, see [`pro-features.md`](pro-features.md); that's the canonical edition split.

If a tool or capability appears here but not in [`pro-features.md`](pro-features.md), it isn't available in any build yet.

---

## What's shipped today

**Community is live.** Install it free from npm (`npm install -g editmamei`), or as a one-click `.mcpb` extension for Claude Desktop. See [installation.md](installation.md). The [CHANGELOG](../CHANGELOG.md) tracks what's landed.

**Pro is live.** Buy at [editmamei.com/pricing](https://editmamei.com/pricing) and activate with a license key. Pro is delivered as a downloaded module: activating fetches the signed Pro module and loads it alongside your Community install, so nothing gets reinstalled. Activation steps are in [installation.md "Pro"](installation.md#pro), [pro-features.md "Activating Pro"](pro-features.md#activating-pro), [faq.md](faq.md#how-do-i-activate-a-pro-license), and at [editmamei.com/activate](https://editmamei.com/activate).

---

## In development

These capabilities are being built and live-tested against Photoshop right now. None of them are in a shipped build yet, and the edition each one lands in (Community or Pro) is decided when it's verified and promoted.

### Brush strokes

AI-driven brush work: paint a stroke along a named path or contour, with control over the brush and its dynamics. Groundwork for painterly retouching that follows real geometry instead of guessed coordinates.

### Portrait retouch

Face-aware skin cleanup driven from the detected face, so the AI can work a portrait without you hand-selecting the area first.

### Face-aware contouring

Dodge, burn, or brush along a named facial contour (jawline, cheekbones, nose bridge, under-eye), following the local face mesh's real geometry. Builds on the Pro face-mesh perception already in the current build.

---

Roadmap discussion happens on the [issue tracker](https://github.com/editmamei/editmamei/issues).
