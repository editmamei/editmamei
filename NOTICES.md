# Third-Party Notices

Editmamei includes software developed by third parties. Their
respective copyright notices and license terms are reproduced below as
required by their licenses.

---

## Open-Source Dependencies (bundled)

Editmamei's npm tarball bundles its runtime dependencies under
`node_modules/`, at the exact versions recorded in this repository's
`package-lock.json`, so an install resolves nothing from the registry. Each
bundled package keeps its own published files, including its license text and
any `NOTICE` file. The packages that publish no license file of their own are
listed below with their terms reproduced.

One bundled package is modified: `onnxruntime-web` ships without the WebAssembly
variants Editmamei never loads. Only `ort-wasm-simd-threaded.wasm` is kept.

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

The bundled runtime dependencies are licensed under MIT, Apache-2.0, ISC,
BSD-2-Clause, and BSD-3-Clause, all permissive and compatible with
redistribution. The build refuses to bundle a package under any other license.

### Apache-2.0 NOTICE Files

Section 4(d) of Apache 2.0 requires redistributors to preserve a work's
`NOTICE` contents. Any `NOTICE` file a bundled Apache-2.0 package publishes is
redistributed unchanged inside that package's directory under `node_modules/`.

### Packages without a license file of their own

These packages declare their license in `package.json` but publish no license
file, so the terms are reproduced here.

### `onnxruntime-web`

### `onnxruntime-common`

Both are part of ONNX Runtime (https://github.com/microsoft/onnxruntime),
licensed under the MIT License:

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### `guid-typescript`

Published by its author as "nicolas"
(https://github.com/NicolasDeveloper/guid-typescript) under the ISC License,
as declared in its `package.json`:

```
ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

---

## Bundled Machine-Learning Models

The local-vision ONNX model weights are also bundled in Editmamei's tarball
(under `dist/models/`) and redistributed with it, so their notices are
reproduced here. The models run entirely on-device; no image data is
transmitted. The ONNX runtime that executes them (`onnxruntime-web`, MIT) is a
bundled npm dependency covered by the section above.

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
