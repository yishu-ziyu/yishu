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
