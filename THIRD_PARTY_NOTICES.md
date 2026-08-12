# Third-party notices

## Clicky provenance

`apps/clicky` is Yishu's formal Clicky source and installation source. The
import boundary and source snapshot are recorded in
[`apps/clicky/PROVENANCE.md`](apps/clicky/PROVENANCE.md); the copied source's
license notice is preserved in [`apps/clicky/LICENSE`](apps/clicky/LICENSE).

The local license file identifies the imported Clicky source as MIT licensed and
retains its `Copyright (c) 2026 Farza` notice. This notice applies to the
imported Clicky source covered by that file; it does not assert a license for
unrelated Yishu code or for any external repository beyond the recorded import
snapshot.

## thinking-orbs — orb geometry

Yishu's macOS spatial presence adapts the 20 px `working`, `searching`,
`solving`, `listening`, `connecting`, `weaving`, `composing`, `breathing`, and
`shaping` geometry from [`thinking-orbs`](https://github.com/Jakubantalik/thinking-orbs)
0.3.1, including its dot, line, projection, sizing, ink, and alpha rules. The
adapted Swift source retains an inline attribution. The upstream project is
licensed under the MIT License:

Copyright (c) 2026 Jakub Antalik

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

## Agent Native — design methodology only

Yishu does not import or copy Agent Native code. It only borrows the design
methodology of a single typed Action, fresh target/observation references,
execution-time revalidation, structured receipts, and visible read-back. The
official source is:

https://github.com/BuilderIO/agent-native

No Agent Native runtime dependency is added to Swift or Node. The upstream
repository currently presents inconsistent license metadata (the root package
manifest says ISC, while the README and `@agent-native/core` package say MIT),
so this notice makes no blanket license claim for that repository. Because Yishu
only references its methodology and does not copy its code, no third-party code
notice is claimed here.
