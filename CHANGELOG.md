# Changelog

本文件记录 `dsh-progressive-compactor` 所有值得记录的变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。版本号事实源为 `progressive-compactor.host.js` 中的 `const VERSION`。

## [Unreleased]

### Added

- `LICENSE`（MIT）。
- `AGENTS.md`：仓库常驻规则（文档与代码同 PR 同步、双语配对、版本对齐、决策状态约定）。
- `README.en.md`：英文 README，与中文版双语配对。
- 文档门禁 `scripts/verify-docs.mjs` + GitHub Actions（语法检查、版本一致、双语配对、相对链接）。
- PR 模板（`.github/PULL_REQUEST_TEMPLATE.md`）。

## [0.1.1] - 2026-08-15

### Fixed

- 崩溃 / 重启后残留的压缩锁不再永久禁用本插件八段式 LLM 兜底（P2）：`hasUnmatchedCompactionStart` 增加 `session/end-seed` 边界判断，上一个会话生命周期遗留的陈旧 `compaction/start` 被正确放行，与官方 `assertCompactionInactive` 语义对齐。

## [0.1.0] - 2026-08-15

### Added

- 渐进式、类型感知的上下文压缩器（动态 Cordis 插件，host-only，免审批）：
  - 只压缩工具结果，完整保留用户输入与模型输出；
  - 从会话最远端开始按阶梯渐进降级（全量 → head+tail 裁剪 → 单行事实 → 整单元折叠），达到 20% 目标即停；
  - 折叠替换为「总结句 + `context_recall` 召回指针」，原文永远留在会话日志；
  - 兜底八段式 LLM 检查点（前缀重放命中 KV cache，带 shrink 校验、压缩锁、surface 稳定性校验）；
  - 协议合规：`compaction/prune` shadow-price、`plugin:'compact'` source 标记、完整 compaction 事务。
