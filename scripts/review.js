/**
 * review.js
 *
 * Reads a git diff from stdin (or a file), sends it to Gemini Flash,
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

import { GoogleGenerativeAI } from '@google/generative-ai'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from 'dotenv'
import { getProjectContext, detectStack } from './get-context.js'

// __dirname equivalent in ES modules
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// Always load .env from the bot-workflows root, regardless of where the script is called from
config({ path: join(ROOT, '.env') })

// --- 1. Validate config ---

const API_KEY = process.env.GEMINI_API_KEY
if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY is not set. Add it to .env or as a GitHub secret.')
  process.exit(1)
}

// --- 2. Load the prompt ---

// The prompt lives in prompts/review.md so it is versioned separately from code.
// This makes it easy to tune review quality without touching the script.
const prompt = readFileSync(join(ROOT, 'prompts', 'review.md'), 'utf8')

// --- 3. Load project context from the repo being reviewed ---

// getProjectContext() reads PROJECT_CONTEXT.md and CLAUDE.md from cwd (the repo under review)
const projectContext = getProjectContext(process.cwd())

// --- 4. Read the diff from stdin ---

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

// --- 5. Call Gemini ---

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

  const genAI = new GoogleGenerativeAI(API_KEY)

  // gemini-3.8-flash is the current free tier model
  const model = genAI.getGenerativeModel(
    { model: 'gemini-3.8-flash' },
    { timeout: 120000 }  // 120s — GitHub Actions runners have higher latency to Gemini
  )

  // Detect stack from the diff so the prompt can focus on the right checks
  const stack = detectStack(diff)
  const stackNote = stack.length > 0
    ? `\n\n## Detected stack\n\nThe following stack was detected from the changed files: ${stack.join(', ')}. Apply the matching checks from the prompt above.`
    : ''

  const fullPrompt = `${prompt}${projectContext}${stackNote}

## Diff to review

\`\`\`diff
${diff}
\`\`\`

Return ONLY the JSON object. No markdown fences around it, no extra text.`

  // Retry up to 3 times with backoff — GitHub Actions runners sometimes get transient fetch failures
  async function callWithRetry(fn, retries = 3, delayMs = 3000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const isRetryable = err.message?.includes('fetch failed') ||
          err.message?.includes('ECONNRESET') ||
          err.message?.includes('ETIMEDOUT') ||
          err.message?.includes('aborted') ||
          err.message?.includes('network')
        if (isRetryable && attempt < retries) {
          console.error(`Attempt ${attempt} failed (${err.message}). Retrying in ${delayMs / 1000}s...`)
          await new Promise(r => setTimeout(r, delayMs * attempt))
          continue
        }
        throw err
      }
    }
  }

  try {
    const result = await callWithRetry(() => model.generateContent(fullPrompt))
    const text = result.response.text().trim()

    // Gemini sometimes wraps the JSON in markdown fences — strip them
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()

    // Validate it's parseable JSON before printing
    const parsed = JSON.parse(cleaned)
    console.log(JSON.stringify(parsed, null, 2))

    // block_on_severity: if set, exit 1 when findings at or above that severity exist
    // This is what makes the check "required" in GitHub branch protection
    const blockOn = process.env.BLOCK_ON_SEVERITY // 'high' | 'medium' | 'none'
    if (blockOn && blockOn !== 'none') {
      const severityRank = { high: 2, medium: 1, low: 0 }
      const threshold = severityRank[blockOn] ?? 2
      const blocking = parsed.findings?.filter(f => (severityRank[f.severity] ?? 0) >= threshold)
      if (blocking?.length > 0) {
        console.error(`\nBlocking: ${blocking.length} finding(s) at or above '${blockOn}' severity.`)
        process.exit(1)
      }
    }

  } catch (err) {
    if (err.message?.includes('429') || err.message?.toLowerCase().includes('rate limit')) {
      // Rate limit hit — log to stderr (GitHub Actions will show this in the log)
      // but exit 0 so the PR is never blocked
      console.error('Gemini rate limit reached — skipping review this run.')
      process.exit(0)
    }

    if (err instanceof SyntaxError) {
      // Gemini returned something that wasn't valid JSON — not fatal
      console.error('Gemini returned non-JSON response — skipping.')
      console.error('Raw response was:', err.message)
      process.exit(0)
    }

    // Network error (fetch failed, timeout) — log and exit cleanly
    if (err.message?.includes('fetch failed') || err.message?.includes('ETIMEDOUT')) {
      console.error('Gemini network error after retries — skipping review.')
      process.exit(0)
    }

    // Any other API error — log and exit cleanly
    console.error('Gemini API error:', err.message)
    process.exit(0)
  }
}

// --- Run ---
const diff = await readStdin()
await reviewDiff(diff)
