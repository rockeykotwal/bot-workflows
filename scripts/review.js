/**
 * review.js
 *
 * Reads a git diff from stdin (or a file), sends it to the configured LLM,
 * and prints structured findings as JSON to stdout.
 *
 * Usage:
 *   git diff main...HEAD | node scripts/review.js
 *   node scripts/review.js < sample.diff
 *
 * Exit codes:
 *   0 — success (findings printed to stdout, even if empty)
 *   0 — rate limit or API error (we never want to block a PR)
 *   1 — bad configuration (missing API key)
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from 'dotenv'
import { getProjectContext, detectStack, detectFormatterConfig } from './get-context.js'
import { generate, PROVIDER } from './llm.js'

// __dirname equivalent in ES modules
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// Always load .env from the bot-workflows root, regardless of where the script is called from
config({ path: join(ROOT, '.env') })

// --- 1. Load the prompt ---

// The prompt lives in prompts/review.md so it is versioned separately from code.
// This makes it easy to tune review quality without touching the script.
const prompt = readFileSync(join(ROOT, 'prompts', 'review.md'), 'utf8')

// --- 2. Load project context from the repo being reviewed ---

// getProjectContext() reads PROJECT_CONTEXT.md and CLAUDE.md from cwd (the repo under review)
const projectContext = getProjectContext(process.cwd())

// detectFormatterConfig() reads biome.json / .prettierrc / .editorconfig
const formatterConfig = detectFormatterConfig(process.cwd())

// --- 3. Read the diff from stdin ---

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    // If stdin is a TTY (running interactively with no pipe), resolve immediately
    if (process.stdin.isTTY) resolve('')
  })
}

// --- 4. Call LLM ---

async function reviewDiff(diff) {
  if (!diff || diff.trim().length === 0) {
    console.log(JSON.stringify({ summary: 'Empty diff — nothing to review.', risk: 'low', findings: [] }))
    return
  }

  // Skip diffs that are only lockfiles or generated files — saves tokens and avoids noise
  const meaningfulLines = diff.split('\n').filter(line =>
    line.startsWith('diff --git') &&
    !line.includes('package-lock.json') &&
    !line.includes('yarn.lock') &&
    !line.includes('pnpm-lock') &&
    !line.includes('.generated.') &&
    !line.includes('dist/')
  )

  if (meaningfulLines.length === 0) {
    console.log(JSON.stringify({ summary: 'Diff contains only generated or lock files — skipped.', risk: 'low', findings: [] }))
    return
  }

  // Count actual changed lines (+ and -) to gauge diff complexity.
  // Context lines, headers, and hunk markers are excluded.
  const MAX_CHANGED_LINES = parseInt(process.env.MAX_DIFF_LINES ?? '400', 10)
  const changedLineCount = diff.split('\n').filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---')).length

  if (changedLineCount > MAX_CHANGED_LINES) {
    console.log(JSON.stringify({
      summary: `Diff too large to review automatically (${changedLineCount} changed lines, limit is ${MAX_CHANGED_LINES}). Consider splitting this PR into smaller focused changes — reviews are more useful and faster to merge when each PR does one thing.`,
      risk: 'unknown',
      findings: [],
    }))
    return
  }

  // Detect stack from the diff so the prompt can focus on the right checks
  const stack = detectStack(diff)
  const stackNote = stack.length > 0
    ? `\n\n## Detected stack\n\nThe following stack was detected from the changed files: ${stack.join(', ')}. Apply the matching checks from the prompt above.`
    : ''

  const lineWidth   = formatterConfig?.lineWidth   ?? 80
  const indentWidth = formatterConfig?.indentWidth ?? 2
  const indentStyle = formatterConfig?.indentStyle ?? 'space'
  const configSource = formatterConfig ? 'detected from project config' : 'default fallback — no formatter config found'

  const formatterNote = `\n\n## Formatter constraints (${configSource})\n\nLine width: ${lineWidth} chars. Indent: ${indentWidth} ${indentStyle}s.\n\nAll code in the \`suggestion\` field MUST respect these rules:\n1. No line may exceed ${lineWidth} characters.\n2. When a line would be too long, break it at a LOGICAL boundary — after a comma, after an opening brace or paren, before a closing brace or paren, or before an operator (\`??\`, \`&&\`, \`||\`, \`+\`). Never break mid-token, mid-string, or mid-argument-name.\n3. Each item in a broken list (function arguments, object properties, array elements) goes on its own line, indented by ${indentWidth} ${indentStyle}s relative to the opening bracket.\n4. The closing bracket/paren goes on its own line, aligned with the line that opened it.`

  const fullPrompt = `${prompt}${projectContext}${stackNote}${formatterNote}

## Diff to review

\`\`\`diff
${diff}
\`\`\`

Return ONLY the JSON object. No markdown fences around it, no extra text.`

  try {
    const text = (await generate(fullPrompt)).trim()

    // LLMs sometimes wrap the JSON in markdown fences — strip them
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()

    // Validate it's parseable JSON before printing
    const parsed = JSON.parse(cleaned)
    console.log(JSON.stringify(parsed, null, 2))

  } catch (err) {
    const msg = err.message ?? ''

    if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.includes('rate_limit')) {
      console.error(`${PROVIDER} rate limit reached — skipping review this run.`)
      process.exit(0)
    }

    if (err instanceof SyntaxError) {
      console.error(`${PROVIDER} returned non-JSON response — skipping.`)
      console.error('Raw response was:', msg)
      process.exit(0)
    }

    if (msg.includes('fetch failed') || msg.includes('ETIMEDOUT')) {
      console.error(`${PROVIDER} network error after retries — skipping review.`)
      process.exit(0)
    }

    if (msg.includes('API_KEY') || msg.includes('is not set')) {
      console.error(`Configuration error: ${msg}`)
      process.exit(1)
    }

    console.error(`${PROVIDER} API error:`, msg)
    process.exit(0)
  }
}

// --- Run ---
const diff = await readStdin()
await reviewDiff(diff)
