# ADR 0002: apps/clicky 是唯一正式外壳

Type: decision
Status: superseded
Superseded-by: docs/decisions/0012-single-macos-app-source.md

## Status

Superseded 2026-08-12. 保留 Clicky bundle identity 与 TCC 连续性的结论不变；
“另设 `apps/macos` 开发壳”的决定由 ADR 0012 撤销。

## Context

macOS 外壳承载用户已授予的系统权限与长期使用形成的信任。仓库内同时存在正式源码与开发壳，必须明确唯一安装源。

## Decision

- `apps/clicky` 是唯一正式 Clicky 源码与安装源，保留 bundle identity（`com.yishu.yishu-buddy`）、TCC 权限、登录项、UserDefaults、鼠标伴随、语音与 TTS。
- `apps/macos` 仅为开发壳（`com.yishu.yishu-lab`，默认不占全局快捷键），不得成为第二常驻产品、登录项或安装源。

## Alternatives considered

- 从零建新壳。
- 双壳并行。

## Why

TCC 授权与用户信任连续性只能由同一 bundle identity 继承；换壳即重新授权、信任清零。

## Consequences

- 两壳间的受控重复由 `YishuContextFrameContractTests` 防漂移。
- TCC 依赖 `run-local.sh` 固定签名身份（见 `docs/runbooks/clicky-install.md`）。
- 无 DMG / Sparkle 分发。
