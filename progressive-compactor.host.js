/**
 * Progressive Context Compactor — DeepSeek Harness (DSH) dynamic Cordis plugin, Host half.
 *
 * 这是一个「渐进式、类型感知」的上下文压缩器:
 *  - 触发:每个 agent/pre-step 时测量,总上下文 >= 80% 窗口才动;
 *  - 目标:从会话最远端开始逐单元降级,直到总上下文 <= 20% 窗口(或固定开销下限);
 *  - 保留:用户输入与纯文本助手消息永远原样;
 *  - 阶梯:工具结果 全量 → head+tail 裁剪 → 单行事实 → 整单元折叠为「总结句 + context_recall 召回指针」;
 *  - 兜底:全部单元到最低阶梯仍超目标时,对远端区间做八段式 LLM 检查点总结(前缀重放,命中 KV cache);
 *  - 协议:每次替换前写 compaction/prune shadow-price 事件;检查点 source 用 plugin:'compact' 标记,
 *    与官方回放/计价/UI 完全兼容。原始事件永远保留在会话日志中,context_recall 工具可按区间召回。
 *
 * 安装方式(动态插件,免审批,host-only):
 *   1. cordis_define: plugin.kind "new", idPrefix 3-6 个小写字母, code.host 填本文件 `code.host`
 *      之后的函数体(不含 `const CONFIG` 之前的说明注释);
 *   2. cordis_run 激活。更新:cordis_define 追加新包 + cordis_run mode "update"。
 *   3. cordis_stop 停用并恢复内置行为。
 *
 * 注意:本插件挂载在 host 根平面,会作用于进程中所有 agent 的会话(单用户 DSH 即当前会话);
 *       与内置 compaction-basic 并存时用 {prepend:true} 抢先执行,后者测得已低于阈值会自动让位。
 *
 * 已知 V1 边界(详见 README):
 *   - 阶梯状态按内容标记推断,进程重启后按内容识别,不会重复降级造成损伤;
 *   - 未实现 agent/request-error 溢出恢复(内置压缩器兜底);
 *   - context_recall 只还原文本与工具调用,不还原图片/思考块;
 *   - 包含图片等非文本块的工具结果在单元折叠时,其图片会从 surface 消失(原文仍在日志)。
 */
const CONFIG = {
  triggerRatio: 0.8,
  targetRatio: 0.2,
  headRatio: 0.4,
  tailRatio: 0.1,
  factTailChars: 300,
  excerptChars: 200,
  recallCapChars: 6000,
  fallbackRetainRatio: 0.05,
  fallbackMaxTokens: 8192,
  maxDegradationsPerPass: 30,
}

const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
const FACT_PREFIX = '[compacted-result] '

const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n')

const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

const busySessions = new Set()

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

function toolCallsOf(message) {
  if (!message || !Array.isArray(message.content)) return []
  return message.content.filter(block => block && block.type === 'tool-call')
}

function textOfToolResult(event) {
  const message = event && event.data && event.data.message
  const first = message && Array.isArray(message.content) ? message.content[0] : null
  return textOfBlocks(first && first.content)
}

function resultRung(event) {
  const text = textOfToolResult(event)
  if (text.startsWith(FACT_PREFIX)) return 2
  if (text.includes(PRUNE_MARKER)) return 1
  return 0
}

function makeFactLine(name, tailText) {
  const tail = tailText.slice(-CONFIG.factTailChars).replace(/\s+/g, ' ')
  return FACT_PREFIX + '工具 ' + name + ' 执行完毕。尾部内容: ' + tail
}

function toolNameFor(session, unit, resultSeq) {
  const event = session.events[resultSeq]
  const source = event && event.data && event.data.message && event.data.message.source
  const callId = source && source.callId
  for (const call of unit.calls) {
    if (call && call.id === callId) return call.name || '(工具)'
  }
  return '(工具)'
}

function nodeSeqMap(measurement) {
  const map = new Map()
  if (measurement && Array.isArray(measurement.nodes)) {
    for (const node of measurement.nodes) map.set(node.seq, node.tokens)
  }
  return map
}

function degradeResult(ctx, session, seq, name) {
  const event = session.events[seq]
  if (!event) return false
  const msg = event.data.message
  const first = msg && Array.isArray(msg.content) ? msg.content[0] : null
  const blocks = first && first.content
  if (!Array.isArray(blocks)) return false
  if (blocks.some(block => !block || block.type !== 'text')) return false
  const text = blocks.map(block => block.text || '').join('')
  if (!text) return false
  const rung = resultRung(event)
  let newText = null
  if (rung === 0) {
    if (text.length > 64) {
      const head = Math.floor(text.length * CONFIG.headRatio)
      const tail = Math.floor(text.length * CONFIG.tailRatio)
      newText = text.slice(0, head) + PRUNE_MARKER + text.slice(text.length - tail)
      if (newText.length >= text.length) newText = null
    }
    if (newText === null) newText = makeFactLine(name, text)
  } else if (rung === 1) {
    newText = makeFactLine(name, text)
  } else {
    return false
  }
  const newMsg = { ...msg, content: [{ ...first, content: [{ type: 'text', text: newText }] }] }
  const before = ctx.tokenMeter.estimateMessage(msg)
  const after = ctx.tokenMeter.estimateMessage(newMsg)
  if (after >= before) return false
  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: before,
  })
  session.append('tool/result', { ...event.data, message: newMsg }, {
    surfaceOp: { op: 'replace', start: seq, end: seq },
    sourceEventSeqs: [seq],
  })
  return true
}

function replaceUnit(ctx, session, unit) {
  const start = unit.assistantSeq
  const end = unit.resultSeqs[unit.resultSeqs.length - 1]
  const shadowedSeqs = [unit.assistantSeq, ...unit.resultSeqs]
  const assistantEvent = session.events[unit.assistantSeq]
  const assistantText = textOfBlocks(assistantEvent && assistantEvent.data && assistantEvent.data.message && assistantEvent.data.message.content)
    .replace(/\s+/g, ' ').trim().slice(0, CONFIG.excerptChars)
  const names = unit.calls.map(call => call && call.name).filter(Boolean)
  const recallId = 'r' + start + '-' + end
  let sentence = '此阶段模型调用了工具:' + (names.length > 0 ? names.join('、') : '(未知)')
  if (assistantText.length > 0) sentence += '。模型当时的结论: ' + assistantText
  sentence += '。如需查看工具执行的完整细节,请调用 context_recall,id 为 "' + recallId + '"。'
  const checkpoint = {
    role: 'user',
    id: uid('msg'),
    content: [{ type: 'text', text: sentence }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: uid('c') },
  }
  const measurement = ctx.tokenMeter.measure(session)
  const tokens = nodeSeqMap(measurement)
  let shadowedTokenCount = 0
  for (const seq of shadowedSeqs) shadowedTokenCount += tokens.get(seq) || 0
  const framed = ctx.tokenMeter.estimateMessage(checkpoint)
  if (framed >= shadowedTokenCount || shadowedTokenCount === 0) return false
  const prune = session.append('compaction/prune', {
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
  })
  session.append('user/message', checkpoint, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [prune.seq, ...shadowedSeqs],
  })
  console.log('[prog-compact] 单元折叠:', recallId, '→', sentence.slice(0, 80))
  return true
}

function findDegradable(session, skip) {
  const nodes = session.surface.nodes
  for (let i = 0; i < nodes.length; i++) {
    const seq = nodes[i]
    if (skip.has(seq)) continue
    const event = session.events[seq]
    if (!event) continue
    if (event.type === 'user/message') continue
    if (event.type === 'assistant/message') {
      const calls = toolCallsOf(event.data.message)
      if (calls.length === 0) continue
      const resultSeqs = []
      let j = i + 1
      while (j < nodes.length) {
        const nextEvent = session.events[nodes[j]]
        if (!nextEvent || nextEvent.type !== 'tool/result') break
        resultSeqs.push(nodes[j])
        j++
      }
      if (resultSeqs.length === 0) continue
      return { kind: 'unit', assistantSeq: seq, resultSeqs, calls }
    }
    if (event.type === 'tool/result') return { kind: 'single', seq }
  }
  return null
}

function degradeOne(ctx, session, unit) {
  if (unit.kind === 'single') {
    return degradeResult(ctx, session, unit.seq, '(工具)')
  }
  for (const seq of unit.resultSeqs) {
    if (resultRung(session.events[seq]) < 2) {
      const changed = degradeResult(ctx, session, seq, toolNameFor(session, unit, seq))
      if (changed) return true
    }
  }
  return replaceUnit(ctx, session, unit)
}

function sameSurface(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].seq !== b[i].seq) return false
  }
  return true
}

function hasUnmatchedCompactionStart(session) {
  const events = session.events
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!event) continue
    if (event.type === 'compaction/start') return true
    if (event.type === 'compaction/end') return false
  }
  return false
}

async function llmSummarize(ctx, session, header, regionMessages, cfg, signal) {
  const messages = [
    ...regionMessages,
    {
      role: 'user',
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'prog-compact' },
    },
  ]
  const options = {
    provider: cfg.provider,
    model: cfg.model,
    messages,
    maxTokens: CONFIG.fallbackMaxTokens,
    sessionId: session.id,
    purpose: 'compaction',
    signal,
  }
  if (header && typeof header.system === 'string') options.system = header.system
  if (header && Array.isArray(header.tools)) options.tools = header.tools.slice()
  let text = ''
  let finish = null
  let sawToolCall = false
  let usage = null
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'block-end') {
      const block = chunk.block
      if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
      else if (block && block.type === 'tool-call') sawToolCall = true
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  if (finish && finish.kind !== 'stop') {
    if (finish.kind === 'tool-calls') throw new Error('summarizer attempted a tool call')
    const detail = finish.failure && finish.failure.message ? finish.failure.message : finish.kind
    throw new Error('summarization finished with ' + detail)
  }
  if (sawToolCall) throw new Error('summarizer attempted a tool call')
  if (text.trim().length === 0) throw new Error('summarization produced no text')
  return { text: text.trim(), usage }
}

async function fallbackSummary(ctx, session, agent, cfg, window, turn, signal) {
  if (hasUnmatchedCompactionStart(session)) return
  const m = ctx.tokenMeter.measure(session)
  const overhead = m.totalTokens - m.surfaceTokens
  const targetTotal = Math.max(window * CONFIG.targetRatio, overhead + 512)
  const retain = Math.max(window * CONFIG.fallbackRetainRatio, m.totalTokens - targetTotal)
  const nodes = session.surface.nodes
  const tokens = nodeSeqMap(m)
  let accumulated = 0
  let keepFrom = nodes.length
  for (let i = nodes.length - 1; i >= 0; i--) {
    accumulated += tokens.get(nodes[i]) || 0
    keepFrom = i
    if (accumulated >= retain) break
  }
  while (keepFrom > 0 && keepFrom < nodes.length) {
    const event = session.events[nodes[keepFrom]]
    if (!event || event.type !== 'tool/result') break
    keepFrom++
  }
  if (keepFrom <= 1) return
  const start = nodes[0]
  const end = nodes[keepFrom - 1]
  const shadowedSeqs = nodes.slice(0, keepFrom)
  let shadowedTokenCount = 0
  for (const seq of shadowedSeqs) shadowedTokenCount += tokens.get(seq) || 0
  const header = session.requestHeader()
  const regionMessages = []
  for (const seq of shadowedSeqs) {
    const message = session.deriveEventMessage(session.events[seq])
    if (message) regionMessages.push(message)
  }
  if (regionMessages.length === 0) return
  const compactionId = uid('c')
  const recallId = 'r' + start + '-' + end
  const startEvent = session.append('compaction/start', { compactionId, turn })
  try {
    const summary = await llmSummarize(ctx, session, header, regionMessages, cfg, signal)
    const framed = CHECKPOINT_PREAMBLE + '\n\n<compacted-summary>\n' + summary.text + '\n</compacted-summary>\n\n如需查看此区间内工具执行的完整细节,请调用 context_recall,id 为 "' + recallId + '"。'
    const checkpoint = {
      role: 'user',
      id: uid('msg'),
      content: [{ type: 'text', text: framed }],
      source: { kind: 'plugin', plugin: 'compact', compactionId },
    }
    if (ctx.tokenMeter.estimateMessage(checkpoint) >= shadowedTokenCount) {
      throw new Error('summary is not smaller than the shadowed content')
    }
    const m2 = ctx.tokenMeter.measure(session)
    if (!sameSurface(m.nodes, m2.nodes)) {
      throw new Error('surface changed during summarization')
    }
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: summary.text }],
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
      provider: cfg.provider,
      model: cfg.model,
      ...(summary.usage ? { usage: summary.usage } : {}),
    })
    session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    session.append('compaction/end', { compactionId, turn })
    console.log('[prog-compact] 八段式兜底完成:', recallId, 'shadowed', shadowedSeqs.length, 'nodes,', shadowedTokenCount, 'tokens')
  } catch (error) {
    try {
      session.append('compaction/end', { compactionId, turn, error: String(error && error.message ? error.message : error) })
    } catch (closeError) {
      console.error('[prog-compact] 兜底失败且无法关闭事务:', closeError && closeError.message)
    }
    console.error('[prog-compact] 八段式兜底失败:', error && error.message)
  }
}

async function considerCompaction(ctx, busy, payload) {
  const agent = payload.agent
  const session = agent && agent.session
  if (!session) return
  const sid = session.id || String(session)
  if (busy.has(sid)) return
  const header = session.requestHeader()
  const cfg = header && header.config
  if (!cfg || !cfg.provider || !cfg.model) return
  const info = await ctx.llm.resolveModelInfo(cfg.provider, cfg.model, payload.signal)
  const window = info && info.context && info.context.contextWindow
  if (!Number.isInteger(window) || window <= 0) return
  let m = ctx.tokenMeter.measure(session)
  if (m.totalTokens < window * CONFIG.triggerRatio) return
  const overhead = m.totalTokens - m.surfaceTokens
  const targetTotal = Math.max(window * CONFIG.targetRatio, overhead + Math.min(Math.floor(window * 0.05), 512))
  if (m.totalTokens <= targetTotal) return
  busy.add(sid)
  try {
    const skip = new Set()
    let guard = 0
    while (guard < CONFIG.maxDegradationsPerPass) {
      m = ctx.tokenMeter.measure(session)
      if (m.totalTokens <= targetTotal) break
      const unit = findDegradable(session, skip)
      if (!unit) break
      const changed = degradeOne(ctx, session, unit)
      if (!changed) skip.add(unit.kind === 'single' ? unit.seq : unit.assistantSeq)
      else guard++
    }
    m = ctx.tokenMeter.measure(session)
    if (m.totalTokens > targetTotal) {
      console.log('[prog-compact] 渐进压缩后仍超目标(' + m.totalTokens + '>' + targetTotal + '),进入八段式兜底')
      await fallbackSummary(ctx, session, agent, cfg, window, payload.turn, payload.signal)
    }
  } catch (error) {
    console.error('[prog-compact] 压缩 pass 异常:', error && error.message)
  } finally {
    busy.delete(sid)
  }
}

function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') parts.push('→ 调用工具 ' + (block.name || '(工具)') + (block.arguments ? '(' + String(block.arguments).slice(0, 200) + ')' : ''))
  }
  return parts.join('')
}

function capText(text, cap) {
  if (text.length <= cap) return text
  const head = Math.floor(cap * 2 / 3)
  const tail = Math.floor(cap / 3)
  return text.slice(0, head) + '\n...[中间内容已省略]...\n' + text.slice(text.length - tail)
}

const recallTool = harness.defineTool({
  name: 'context_recall',
  description: '召回被渐进式上下文压缩器折叠的工具执行详情。参数 id 是压缩替换句中给出的召回 id(形如 r123-456)。返回该区间内助手消息与工具结果的原文(超长时截断)。',
  parameters: {
    id: {
      type: 'string',
      required: true,
      description: '召回 id,形如 r<起始seq>-<结束seq>',
    },
  },
  output: {
    schema: { type: 'object', properties: { recalled: { type: 'string' } }, additionalProperties: false },
    render: (args, value) => [{ type: 'text', text: value.recalled }],
  },
  async execute(args, exec) {
    const session = exec.agent && exec.agent.session
    if (!session) return { recalled: 'context_recall 不可用:当前执行上下文没有绑定会话。' }
    const match = /^r(\d+)-(\d+)$/.exec(String(args.id || ''))
    if (!match) return { recalled: '无效的召回 id:' + String(args.id) + '(应为 r<起始seq>-<结束seq> 形式)' }
    const start = Number(match[1])
    const end = Number(match[2])
    const parts = []
    for (let seq = start; seq <= end; seq++) {
      const event = session.events[seq]
      if (!event) continue
      let message = null
      try { message = session.deriveEventMessage(event) } catch (error) { message = null }
      if (!message) continue
      const text = textOfMessage(message)
      if (text.length > 0) parts.push('[' + event.type + ' seq=' + seq + ']\n' + text)
    }
    if (parts.length === 0) return { recalled: '该区间没有可召回的内容(可能已被后续压缩合并)。' }
    return { recalled: capText(parts.join('\n\n'), CONFIG.recallCapChars) }
  },
})

return {
  name: 'progressive-compactor',
  inject: ['llm', 'tokenMeter'],
  apply(ctx) {
    harness.registerTool(ctx, recallTool)
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        await considerCompaction(ctx, busySessions, payload)
      } catch (error) {
        console.error('[prog-compact] pre-step 处理失败:', error && error.message)
      }
      return next()
    }, { prepend: true })
    console.log('[prog-compact] 已挂载:渐进式压缩器(context_recall 工具 + agent/pre-step 监听)')
  },
}
