# AGENTS.md

本仓库是 `dsh-progressive-compactor` —— DeepSeek Harness (DSH) 的**动态 Cordis 插件**（host-only，单文件），渐进式、类型感知的上下文压缩器。仓库以**单一源码文件**为事实源，文档围绕它维护。

## 仓库布局

- `progressive-compactor.host.js` — 唯一源码（动态插件 host 函数体）。**版本号 = 文件内 `const VERSION`**，与 CHANGELOG 最新条目、git tag 三处一致
- `README.md` / `README.en.md` — 对外契约（中文 / 英文，**必须成对同步**）
- `DESIGN.md` — 设计决策与取舍（决策记录）
- `CHANGELOG.md` — 变更史
- `scripts/verify-docs.mjs` + `.github/workflows/verify-docs.yml` — 文档门禁
- `LICENSE` — MIT

## 验证命令

```sh
node --check progressive-compactor.host.js   # 语法检查（无依赖，改完必跑）
node scripts/verify-docs.mjs                # 文档门禁（版本 / 双语 / 链接）
```

## 文档规则

1. **非平凡变更必须在同一 PR 同步文档**：行为 / 协议 / 配置变化 → 更新 README 策略表与 CHANGELOG；设计取舍变化 → 更新 DESIGN.md。只有纯机械 / 局部编辑可豁免。
2. **双语配对**：`README.md`（中文）与 `README.en.md`（英文）必须同 PR 成对修改，内容保持等价；只改一边会被 CI 拒绝。
3. **版本三处一致**：源码 `const VERSION`、CHANGELOG 最新条目、git tag（发布时）。
4. **决策状态**：DESIGN.md 中的决策被取代时**保留原文**，在小节标题后标注 `（已被 §x.x 取代，YYYY-MM-DD）`，新决策写入对应小节；不删除、不改写旧决策。
5. **发布流程**：`node --check` + `node scripts/verify-docs.mjs` 全过 → 把 CHANGELOG 的 `[Unreleased]` 条目并入新版本号 → 提交并打 tag → `gh release create`。

## 门禁

`.github/workflows/verify-docs.yml` 在 PR 与 main 推送时运行：`node --check` 语法检查 + `scripts/verify-docs.mjs`（版本一致、双语成对、相对链接）。
