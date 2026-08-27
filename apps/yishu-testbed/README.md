# Yishu Testbed

Fixture app for #10, not a product shell and not a second 奕枢 identity.

```bash
swift test --package-path apps/yishu-testbed
swift run --package-path apps/yishu-testbed
YISHU_TESTBED_FIXTURE=duplicate-label swift run --package-path apps/yishu-testbed
node script/run-macos-e2e.mjs
```

Bundle id: `works.earendil.YishuTestbed`. Window title: `Yishu Testbed`.
AX identifiers: `testbed-effect`, `testbed-primary`, `testbed-submit`, `testbed-text`.
User-visible e2e launches this window and reads `testbed-effect` from a second process. In-process `performPrimaryAction` is a unit fixture, not that pass.

Fixtures: `single-button`, `duplicate-label`, `disabled`, `text-field`, `scroll-list`, `delayed`, `unknown-commit`.
