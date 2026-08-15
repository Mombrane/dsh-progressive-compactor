# dsh-progressive-compactor

[English](README.en.md) | **中文**

DeepSeek Harness (DSH) 动态 Cordis 插件:**渐进式、类型感知的上下文压缩器**。

与内置 `compaction-basic`(80% 触发时把整段历史归纳成八段式 LLM 检查点)不同,本插件:

- **只压缩工具结果,不归纳中间内容**;
- **完整保留用户输入与模型输出(助手文本)**;
- **从会话最远端开始、按阶梯渐进降级**,达到 20% 目标即停止,最大程度保护最新上下文;
- 被折叠的工具调用不直接删除,而是替换为**总结句 + `context_recall` 召回指针**,原文永远留在会话日志中,可随时召回;
- 只有全部阶梯耗尽仍压不到目标时,才对远端区间做**八段式 LLM 检查点总结**兜底(复用官方协议与 KV-cache 前缀重放)。

## 策略

| 环节 | 行为 |
| --- | --- |
| 触发 | 每个 `agent/pre-step` 测量一次,总量 ≥ **80%** 窗口才动 |
| 目标 | 压缩至总量 ≈ **20%** 窗口(扣除系统提示词等固定开销;若固定开销本身 >20% 则目标是其下限) |
| 顺序 | 严格从最远端单元开始,每次降级后重新测量,**达到目标即停** |
| 保留 | `user/message`、无工具调用的 `assistant/message` 永远原样 |
| 阶梯(工具结果) | ① 全量 → ② head 40% + tail 10% 裁剪(插入 pruned 标记)→ ③ 单行事实(`工具名 + 尾部 300 字符`)→ ④ 整单元折叠 |
| 单元折叠 | 一个 assistant 工具调用消息 + 其全部 tool/result 作为一个单元,替换为一句总结:`此阶段模型调用了工具:X、Y。模型当时的结论:<摘录 200 字符>。如需查看工具执行的完整细节,请调用 context_recall,id 为 "r<start>-<end>"` |
| 召回 | `context_recall(id)`:按区间 seq 从持久化事件日志还原助手消息与工具结果原文(6000 字符封顶,head/tail 截断) |
| 兜底 | 全部单元到最低阶梯仍超目标 → 远端八段式总结,保留 ≈5% 窗口尾部;前缀重放命中 KV cache;带 shrink 校验、压缩锁、surface 稳定性校验 |

## 协议合规(与官方压缩基础设施兼容)

- 每次替换前同步追加 `compaction/prune` **shadow-price 事件**(shadowedRange / shadowedSeqs / shadowedTokenCount),纯消费者可精确扣减计价;
- 单元折叠与兜底检查点消息 source 使用 `{ kind: 'plugin', plugin: 'compact', compactionId }` 标记,UI 检查点节点、回放、会话统计均可识别;
- 兜底走完整 `compaction/start → compaction/summary → 替换 user/message → compaction/end` 事务:写 start 即持锁,失败也补写带 error 的 end,提交前校验 surface 未变、摘要严格小于被遮蔽内容;
- 替换边界始终在**单元边界**(assistant 消息 + 其后连续 tool/result),不拆散工具调用/结果配对。

## 安装(动态插件)

1. 复制 `progressive-compactor.host.js` 中 `const CONFIG = {...}` 起到文件末尾的函数体;
2. `cordis_define`:`plugin.kind: "new"`(3–6 位小写 idPrefix),`code.host` 填入上述函数体,`code.client` 留空(host-only,**免审批**);
3. `cordis_run` 激活;
4. 更新:`cordis_define` 在同 pluginId 下追加新包 + `cordis_run mode: "update"`;
5. 停止:`cordis_stop`(恢复内置行为);彻底删除:`cordis_undefine`。

## 配置

修改源码顶部 `CONFIG`(动态插件无配置注入,改常量后热更新):

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `triggerRatio` | 0.8 | 触发阈值(占模型上下文窗口) |
| `targetRatio` | 0.2 | 压缩目标(占窗口) |
| `headRatio` / `tailRatio` | 0.4 / 0.1 | 裁剪阶梯保留比例 |
| `factTailChars` | 300 | 单行事实保留的尾部字符数 |
| `excerptChars` | 200 | 单元折叠句中保留的助手结论摘录 |
| `recallCapChars` | 6000 | 召回输出封顶 |
| `fallbackRetainRatio` | 0.05 | 八段式兜底保留的尾部比例 |
| `fallbackMaxTokens` | 8192 | 兜底摘要输出上限 |
| `maxDegradationsPerPass` | 30 | 单次 pass 最大降级次数(防单步延迟失控) |

## 与内置压缩器并存

本插件挂载在 host 根平面(动态插件机制),监听器以 `{prepend: true}` 注册,**先于**内置 `compaction-basic` 执行;内置压缩器随后重新测量,低于阈值自动让位。手动 `/compact` 仍走内置引擎,互不冲突。

若希望本插件成为**唯一**自动压缩器:复制你的 agent preset,将 `compaction-basic` 行配置为 `auto: false`(需重启 DSH 进程挂载)。

## 已知边界(V1)

- 阶梯状态按内容标记推断;插件或进程重启后按内容识别既有降级,不会重复降级造成额外损伤;
- 未实现 `agent/request-error` 上下文溢出恢复(内置压缩器会兜底);
- `context_recall` 只还原文本与工具调用,不还原图片与思考块;
- 包含图片等非文本块的工具结果,在单元折叠时其图片会从 surface 消失(原始事件仍在日志中);
- 插件作用于进程中**所有** agent 的会话(单用户 DSH 即当前会话);
- 召回 id 为区间 seq 编码(`r<start>-<end>`),同一会话内稳定且重启后有效。

## 📋 更新记录

变更历史见 [CHANGELOG.md](./CHANGELOG.md)。当前版本 **0.1.1**（与源码 `const VERSION` 对齐）。

## 设计动机

详见 [DESIGN.md](./DESIGN.md):为什么"保留完整用户输入+模型输出、只动态压缩工具结果"在长程任务上优于全量归纳式摘要,以及渐进阶梯、召回指针、八段式兜底之间的取舍。

## License

[MIT](./LICENSE) © Mombrane
