#!/usr/bin/env node
/**
 * Lightweight documentation gate for dsh-progressive-compactor.
 * Pure Node, zero dependencies. Checks:
 *   1. VERSION === CHANGELOG top version, and both READMEs carry the version
 *   2. README.md / README.en.md bilingual pairing (when --changed is passed)
 *   3. Relative markdown links resolve to existing files
 *
 * Usage:
 *   node scripts/verify-docs.mjs
 *   node scripts/verify-docs.mjs --changed "README.md DESIGN.md"
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const fail = (msg) => errors.push(msg)

// --- 1. VERSION / CHANGELOG / README version alignment -----------------------
const srcPath = join(ROOT, 'progressive-compactor.host.js')
const changelogPath = join(ROOT, 'CHANGELOG.md')
let version = null
if (!existsSync(srcPath)) {
  fail('progressive-compactor.host.js is missing')
} else {
  const src = readFileSync(srcPath, 'utf8')
  const m = /const VERSION\s*=\s*'([^']+)'/.exec(src)
  if (!m) fail('progressive-compactor.host.js: missing const VERSION = "x.y.z"')
  else version = m[1]
}
if (version !== null) {
  if (!existsSync(changelogPath)) {
    fail('CHANGELOG.md is missing')
  } else {
    const changelog = readFileSync(changelogPath, 'utf8')
    const top = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog)
    if (!top) fail('CHANGELOG.md: no `## [x.y.z]` version heading found')
    else if (top[1] !== version) fail(`version mismatch: CHANGELOG top is [${top[1]}], VERSION is ${version}`)
  }
  const versionBold = `**${version}**`
  for (const readme of ['README.md', 'README.en.md']) {
    const readmePath = join(ROOT, readme)
    if (!existsSync(readmePath)) {
      fail(`missing doc file: ${readme}`)
      continue
    }
    const text = readFileSync(readmePath, 'utf8')
    if (!text.includes(versionBold)) fail(`${readme}: current-version line must contain ${versionBold}`)
  }
}

// --- 2. bilingual pairing (PR context only) ----------------------------------
const args = process.argv.slice(2)
const changedIdx = args.indexOf('--changed')
if (changedIdx !== -1 && args[changedIdx + 1] && args[changedIdx + 1].trim()) {
  const changed = new Set(args[changedIdx + 1].trim().split(/\s+/))
  const pairs = [['README.md', 'README.en.md']]
  for (const [a, b] of pairs) {
    if (changed.has(a) !== changed.has(b)) {
      fail(`bilingual pairing: ${a} and ${b} must change in the same PR`)
    }
  }
}

// --- 3. relative markdown link check -----------------------------------------
const SCANNED = ['README.md', 'README.en.md', 'DESIGN.md', 'CHANGELOG.md', 'AGENTS.md']
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g
for (const file of SCANNED) {
  const filePath = join(ROOT, file)
  if (!existsSync(filePath)) {
    fail(`missing doc file: ${file}`)
    continue
  }
  const text = readFileSync(filePath, 'utf8')
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const m of line.matchAll(LINK_RE)) {
      const target = m[2].trim()
      if (!target || /^(https?:|mailto:)/.test(target) || target.startsWith('#')) continue
      const withoutAnchor = target.split('#')[0]
      if (!withoutAnchor) continue
      const resolved = resolve(dirname(filePath), withoutAnchor)
      if (!existsSync(resolved)) fail(`${file}: broken link -> ${target}`)
    }
  }
}

// --- report -------------------------------------------------------------------
if (errors.length === 0) {
  console.log('verify-docs: OK (version / bilingual pairing / links)')
  process.exit(0)
}
console.error('verify-docs: violations found:')
for (const e of errors) console.error('  - ' + e)
process.exit(1)
