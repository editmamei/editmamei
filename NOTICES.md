# Third-Party Notices

Editmamei includes software developed by third parties. Their
respective copyright notices and license terms are reproduced below as
required by their licenses.

---

## Open-Source Dependencies (resolved via npm)

Editmamei's shipped tarball contains the compiled `dist/` output plus this
notice file, the LICENSE, and the README. Runtime dependencies are NOT
bundled into the tarball — they are resolved from npm at install time and
land under the consumer's `node_modules/`. The full license text and any
`NOTICE` file for each dependency travels with that dependency's published
package.

To enumerate the dependency set and inspect each license, run from the
project root after `npm install`:

```
npx license-checker --production --summary
```

To extract the full license texts (e.g. for downstream redistribution or
internal review):

```
npx license-checker --production --out THIRD_PARTY_LICENSES.txt
```

### License Summary

The runtime dependency closure resolves under MIT, Apache-2.0, ISC,
BSD-2-Clause, BSD-3-Clause, Python-2.0, BlueOak-1.0.0, and 0BSD — all
permissive and compatible with redistribution.

### Apache-2.0 NOTICE Files

For any Apache-2.0-licensed dependency that includes a `NOTICE` file, that
file is shipped inside the dependency's own npm package. Section 4(d) of
Apache 2.0 requires redistributors to preserve those NOTICE contents; because
Editmamei does not bundle the dependencies into its own tarball, the
preservation requirement is satisfied by the dependency's own published
artifact rather than by inlining the text here.

---

## Bundled Machine-Learning Models

Unlike the npm dependencies above, the local-vision ONNX model weights are
**bundled** in Editmamei's tarball (under `dist/models/`) and redistributed with
it, so their notices are reproduced here. The models run entirely on-device; no
image data is transmitted. The ONNX runtime that executes them
(`onnxruntime-web`, MIT) is a resolved npm dependency covered by the section
above.

### Ultraface (`ultraface-rfb-320.onnx`) — face detection

- **Upstream:** Ultra-Light-Fast-Generic-Face-Detector-1MB (version-RFB-320), by
  Linzaer (Fei Yu); distributed via the ONNX Model Zoo.
- **License:** MIT.
- Used to locate forward-facing faces. Returns bounding boxes only.

### D-FINE-S (`dfine-s-coco-quant.onnx`) — object detection

- **Upstream:** D-FINE ("Redefine Regression Task of DETRs as Fine-grained
  Distribution Refinement", Peng et al.), COCO-trained S variant; ONNX export +
  int8 quantization via the Hugging Face `onnx-community/dfine_s_coco-ONNX`
  repository.
- **License:** Apache-2.0. The upstream D-FINE repository's `NOTICE`/attribution
  terms (Apache-2.0 §4(d)) are preserved by reference to that source.
- Used to detect the 80 COCO object classes.

### Separately licensed modules

The Pro module is delivered as its own artifact and bundles additional third-party
models. Redistribution obligations follow the artifact that carries the files, so
those notices and their full license texts ship **inside the Pro module**, beside
its manifest, rather than being enumerated here.

---

## Trademarks

"Adobe" and "Photoshop" are registered trademarks of Adobe Inc. This product
is not affiliated with, endorsed by, or sponsored by Adobe Inc. References to
Adobe products are made solely for the purpose of identifying compatibility
and interoperability.

All other trademarks are the property of their respective owners.

---
