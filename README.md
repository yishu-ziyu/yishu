# 奕枢 0.0.1

macOS 菜单栏伴侣。按住 Control+Option 对着屏幕说话。安装路径 `/Applications/奕枢.app`，源码在 `apps/clicky`。

事实以正在跑的 App 和源码为准。不要靠文档补叙事。

## Commands

```bash
pnpm install
pnpm product:check          # 日常内环
pnpm product:verify         # 发版前
./apps/clicky/scripts/run-local.sh   # 构建、装到 /Applications/奕枢.app、启动
```

需要：macOS 14+，Xcode 16+，Node 22.19+。

<!-- CAPABILITY_MATRIX:START -->

Only `accepted` and above appear here. The full truth table is [docs/capabilities/CAPABILITY_MATRIX.md](docs/capabilities/CAPABILITY_MATRIX.md).

No capability currently meets `accepted`. Implemented protocol paths are listed in the matrix with mock evidence only.

<!-- CAPABILITY_MATRIX:END -->

`packages/agent-core` 是离线实验室，不是奕枢。
