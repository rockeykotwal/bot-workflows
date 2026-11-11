/**
 * get-context.js
 *
 * Reads project-specific context files from the repo being reviewed
 * and returns a combined string to prepend to any bot prompt.
 *
 * Files it reads (all optional):
 *   PROJECT_CONTEXT.md  — project rules, architecture, standards
 *   CLAUDE.md           — existing AI instructions for the project
 *
 * Usage:
 *   import { getProjectContext } from './get-context.js'
 *   const context = getProjectContext('/path/to/repo')
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Reads common formatter config files and returns line width + indent style.
 * Checked in order: biome.json → .prettierrc → .prettierrc.json → .editorconfig
 *
 * @param {string} repoRoot
 * @returns {{ lineWidth: number, indentStyle: 'space'|'tab', indentWidth: number } | null}
 */
export function detectFormatterConfig(repoRoot = process.cwd()) {
  // biome.json / biome.jsonc
  for (const name of ['biome.json', 'biome.jsonc']) {
    const p = join(repoRoot, name)
    if (existsSync(p)) {
      try {
        const cfg = JSON.parse(readFileSync(p, 'utf8'))
        return {
          lineWidth:   cfg.formatter?.lineWidth   ?? 80,
          indentStyle: cfg.formatter?.indentStyle ?? 'tab',
          indentWidth: cfg.formatter?.indentWidth ?? 2,
        }
      } catch { /* malformed JSON — skip */ }
    }
  }

  // .prettierrc / .prettierrc.json
  for (const name of ['.prettierrc', '.prettierrc.json']) {
    const p = join(repoRoot, name)
    if (existsSync(p)) {
      try {
        const cfg = JSON.parse(readFileSync(p, 'utf8'))
        return {
          lineWidth:   cfg.printWidth  ?? 80,
          indentStyle: cfg.useTabs ? 'tab' : 'space',
          indentWidth: cfg.tabWidth   ?? 2,
        }
      } catch { /* malformed JSON — skip */ }
    }
  }

  // .editorconfig — parse max_line_length and indent_style
  const ec = join(repoRoot, '.editorconfig')
  if (existsSync(ec)) {
    const text = readFileSync(ec, 'utf8')
    const lineWidth   = parseInt(text.match(/max_line_length\s*=\s*(\d+)/)?.[1] ?? '0', 10) || null
    const indentStyle = text.match(/indent_style\s*=\s*(space|tab)/)?.[1] ?? null
    const indentWidth = parseInt(text.match(/indent_size\s*=\s*(\d+)/)?.[1]  ?? '0', 10) || null
    if (lineWidth || indentStyle) {
      return {
        lineWidth:   lineWidth   ?? 80,
        indentStyle: indentStyle ?? 'space',
        indentWidth: indentWidth ?? 2,
      }
    }
  }

  return null
}

/**
 * @param {string} repoRoot — absolute path to the repo being reviewed (defaults to cwd)
 * @returns {string} formatted context block to prepend to a prompt, or empty string
 */
export function getProjectContext(repoRoot = process.cwd()) {
  const sections = []

  // PROJECT_CONTEXT.md — project-specific rules written by the repo owner
  const contextPath = join(repoRoot, 'PROJECT_CONTEXT.md')
  if (existsSync(contextPath)) {
    const content = readFileSync(contextPath, 'utf8').trim()
    if (content) {
      sections.push(`## Project-specific rules (from PROJECT_CONTEXT.md)\n\n${content}`)
    }
  }

  // CLAUDE.md — existing AI instructions if the project uses Claude Code
  const claudePath = join(repoRoot, 'CLAUDE.md')
  if (existsSync(claudePath)) {
    const content = readFileSync(claudePath, 'utf8').trim()
    if (content) {
      sections.push(`## Additional project instructions (from CLAUDE.md)\n\n${content}`)
    }
  }

  if (sections.length === 0) return ''

  return `\n\n---\n\n# Project context\n\n${sections.join('\n\n---\n\n')}\n\n---`
}

/**
 * Detects the stack from file extensions present in the diff.
 * Returns a list of active stack labels so the prompt can focus checks.
 *
 * @param {string} diff — raw git diff text
 * @returns {string[]} e.g. ['typescript', 'react', 'node', 'sql']
 */
export function detectStack(diff) {
  const stack = new Set()

  const fileLines = diff.split('\n').filter(l => l.startsWith('diff --git'))

  for (const line of fileLines) {
    if (/\.(ts|tsx)$/.test(line))   stack.add('typescript')
    if (/\.(jsx|tsx)$/.test(line))  stack.add('react')
    if (/\.(js|mjs|cjs)$/.test(line)) stack.add('javascript')
    if (/\.(jsx)$/.test(line))      stack.add('react')
    if (/\.sql$/.test(line))        stack.add('sql')
    if (/migration/i.test(line))    stack.add('sql')
    if (/Dockerfile/i.test(line))   stack.add('docker')
    if (/\.ya?ml$/.test(line))      stack.add('ci')
    if (/\.tf$/.test(line))         stack.add('terraform')
    if (/\.sh$/.test(line))         stack.add('shell')
    if (/\.(py)$/.test(line))       stack.add('python')
    if (/\.(go)$/.test(line))       stack.add('go')
  }

  // node is implied when typescript or javascript server files are present
  if (stack.has('typescript') || stack.has('javascript')) {
    // Check if it looks like server-side (routes, controllers, services, api)
    const serverPattern = /\/(routes|controllers|services|api|middleware|handlers)\//i
    if (fileLines.some(l => serverPattern.test(l))) {
      stack.add('node')
    }
  }

  return [...stack]
}
