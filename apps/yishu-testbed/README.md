# Yishu Testbed

Fixture app for #10, not a product shell and not a second 奕枢 identity.

```bash
swift test --package-path apps/yishu-testbed
swift run --package-path apps/yishu-testbed
YISHU_TESTBED_FIXTURE=duplicate-label swift run --package-path apps/yishu-testbed
```

Fixtures: `single-button`, `duplicate-label`, `disabled`, `text-field`, `scroll-list`, `delayed`, `unknown-commit`.
