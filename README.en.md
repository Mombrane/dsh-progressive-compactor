# dsh-progressive-compactor

[中文](README.md) | **English**

DeepSeek Harness (DSH) dynamic Cordis plugin: a **progressive, type-aware context compactor**.

Unlike the built-in `compaction-basic` (which summarizes the whole history into an eight-section LLM checkpoint at 80% pressure), this plugin:

- **compacts tool results only** — never summarizes intermediate content;
- **keeps user input and model output (assistant text) fully intact**;
- **degrades from the far end of the session, one tier at a time**, stopping as soon as the ~20% target is reached — protecting the newest context as much as possible;
- folded tool calls are not deleted outright: they are replaced with a **summary sentence + a `context_recall` pointer**, the original always remains in the session log and can be recalled at any time;
- only when every tier is exhausted and the target is still not met does it fall back to an **eight-section LLM checkpoint summary** of the far-end range (reusing the official protocol and KV-cache prefix replay).

## Strategy

| Stage | Behavior |
| --- | --- |
| Trigger | measured on every `agent/pre-step`; only acts when total ≥ **80%** of the window |
| Target | compact until total ≈ **20%** of the window (after fixed overhead such as the system prompt; if fixed overhead alone is >20%, that becomes the floor) |
| Order | strictly from the farthest unit; re-measure after each degradation, **stop once the target is met** |
| Keep | `user/message` and tool-free `assistant/message` are always preserved verbatim |
| Tiers (tool results) | ① full → ② head 40% + tail 10% trim (insert a pruned marker) → ③ one-line fact (`tool name + last 300 chars`) → ④ whole-unit fold |
| Unit fold | an assistant tool-call message + all its tool/result messages form one unit, replaced by one summary: `This stage the model called tools: X, Y. The model's conclusion then: <200-char excerpt>. For full tool-execution details call context_recall with id "r<start>-<end>"` |
| Recall | `context_recall(id)`: restore the original assistant message and tool results from the persisted event log by range seq (capped at 6000 chars, head/tail truncated) |
| Fallback | all units at the lowest tier and still over target → eight-section summary of the far end, keeping ≈5% of the window tail; prefix replay hits KV cache; with shrink validation, a compaction lock, and surface-stability checks |

## Protocol compliance (compatible with the official compaction infrastructure)

- every replacement first appends a `compaction/prune` **shadow-price event** (shadowedRange / shadowedSeqs / shadowedTokenCount), so pure consumers can deduct metering exactly;
- unit folds and fallback checkpoint messages use `{ kind: 'plugin', plugin: 'compact', compactionId }` as source — recognizable by UI checkpoint nodes, replay, and session statistics;
- the fallback runs the full `compaction/start → compaction/summary → replace user/message → compaction/end` transaction: writing start acquires the lock, a failed run still writes an end with error, and before commit it validates the surface is unchanged and the summary is strictly smaller than the shadowed content;
- replacement boundaries always stay on **unit boundaries** (assistant message + following consecutive tool/result), never splitting a tool call/result pair.

## Installation (dynamic plugin)

1. Copy the function body from `const CONFIG = {...}` to the end of `progressive-compactor.host.js`;
2. `cordis_define`: `plugin.kind: "new"` (3–6 lowercase idPrefix), fill `code.host` with the body above, leave `code.client` empty (host-only, **no approval needed**);
3. `cordis_run` to activate;
4. Update: `cordis_define` appends a new package under the same pluginId + `cordis_run mode: "update"`;
5. Stop: `cordis_stop` (restores built-in behavior); remove entirely: `cordis_undefine`.

## Configuration

Edit `CONFIG` at the top of the source (dynamic plugins have no config injection; change the constants and hot-reload):

| Key | Default | Meaning |
| --- | --- | --- |
| `triggerRatio` | 0.8 | trigger threshold (share of the model context window) |
| `targetRatio` | 0.2 | compaction target (share of the window) |
| `headRatio` / `tailRatio` | 0.4 / 0.1 | retention ratios for the trim tier |
| `factTailChars` | 300 | tail chars kept in a one-line fact |
| `excerptChars` | 200 | assistant-conclusion excerpt kept in a unit fold |
| `recallCapChars` | 6000 | recall output cap |
| `fallbackRetainRatio` | 0.05 | tail ratio retained by the eight-section fallback |
| `fallbackMaxTokens` | 8192 | fallback summary output cap |
| `maxDegradationsPerPass` | 30 | max degradations per pass (guards against per-step latency blowups) |

## Coexistence with the built-in compactor

The plugin mounts on the host root plane (dynamic plugin mechanism); its listener registers with `{prepend: true}` and **runs before** the built-in `compaction-basic`; the built-in then re-measures and yields automatically when below the threshold. Manual `/compact` still goes through the built-in engine — no conflict.

To make this plugin the **only** automatic compactor: copy your agent preset and configure the `compaction-basic` row with `auto: false` (requires restarting the DSH process to remount).

## Known boundaries (V1)

- tier state is inferred from content markers; after a plugin or process restart existing degradations are recognized by content and are not degraded again, avoiding extra damage;
- `agent/request-error` context-overflow recovery is not implemented (the built-in compactor covers it);
- `context_recall` restores text and tool calls only — not images or thinking blocks;
- tool results containing non-text blocks (e.g. images) lose their images from the surface when folded (the original events remain in the log);
- the plugin acts on **all** agents' sessions in the process (for single-user DSH that is the current session);
- recall ids are range-seq encoded (`r<start>-<end>`), stable within a session and valid across restarts.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full history. Current version **0.1.1** (aligned with the `const VERSION` in the source).

## Design rationale

See [DESIGN.md](./DESIGN.md): why "keep full user input + model output, compact only tool results" beats full-summary approaches on long-running tasks, and the trade-offs among the progressive tiers, recall pointers, and the eight-section fallback.

## License

[MIT](./LICENSE) © Mombrane
