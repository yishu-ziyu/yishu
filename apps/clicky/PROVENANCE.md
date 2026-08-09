# Clicky source provenance

This directory is Yishu's independent copy of the formal macOS interaction
shell. It is ordinary source in the Yishu repository; it is not a submodule and
does not retain a nested Git repository.

## Import snapshot

- Source repository: https://github.com/yishu-ziyu/clicky.git
- Source checkout: `/Users/mahaoxuan/Desktop/AI产品经理/自研产品/scion/clicky`
- Source HEAD at import: `b79e081c8da8dee14289d7d9829a4831337e354e`
- The source checkout had eight commits ahead of its remote and uncommitted
  Yishu work when this copy was made. The copied files therefore represent a
  product snapshot, not a clean upstream release.
- The external Clicky checkout remains the recoverable source/WIP workspace;
  this import does not move, clean, reset, stash, or commit it.

## Deliberate exclusions

- Nested repository metadata (`.git`), code-graph databases, Xcode user data,
  Node modules, build/DerivedData output, logs, and local screenshot/QA notes.
- Local provider secrets (`worker/.dev.vars`) and any generated secret-bearing
  configuration. Secret values are never copied into this repository or this
  record.
- The upstream Sparkle feed/key, `appcast.xml`, and release automation. Yishu
  has no release contract here, so this snapshot intentionally carries no
  external update or publication channel.
- The historical bridge/progress implementation that coupled the old shell to
  another product. The independent shell uses the versioned Yishu runtime and
  its typed events instead.

## Ownership boundary

Future Clicky changes for Yishu are made under `apps/clicky` and reviewed with
the Yishu runtime integration. The external Clicky checkout and the separate
Kairos repository retain their own history and are not synchronized by this
path.

## Local build boundary

`scripts/run-local.sh` and `scripts/pin-local-permissions.sh` use
`$YISHU_CLICKY_DERIVED_DATA`, defaulting to the repository-local
`.build/clicky-derived-data`. The scripts resolve only that exact
`Build/Products/Debug/Clicky.app` path; they never scan global Xcode
DerivedData, so an older Clicky checkout cannot be selected accidentally.
