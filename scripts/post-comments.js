/**
 * post-comments.js
 *
 * Reads the JSON output from review.js and posts it to a GitHub PR:
 *   - One summary comment at the PR top level (edited in-place on re-runs)
 *   - Inline review comments on the exact changed lines
 *
 * Required env vars:
 *   GITHUB_TOKEN   — provided automatically by GitHub Actions
 *   REPO           — e.g. "rockeykotwal/creatorlens-api"
 *   PR_NUMBER      — the pull request number
 *
 * Usage:
 *   node scripts/post-comments.js /tmp/review.json
 */

import { Octokit } from '@octokit/rest'
import { readFileSync } from 'fs'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
config({ path: join(ROOT, '.env') })

// --- Config ---

const token     = process.env.GITHUB_TOKEN
const repoFull  = process.env.REPO        // "owner/repo"
const prNumber  = parseInt(process.env.PR_NUMBER, 10)

if (!token || !repoFull || !prNumber) {
  console.error('Missing required env vars: GITHUB_TOKEN, REPO, PR_NUMBER')
  process.exit(0) // exit 0 — never block a PR on bot failure
}

const [owner, repo] = repoFull.split('/')
const octokit = new Octokit({ auth: token })

// HTML marker used to find and update the summary comment on re-runs
const SUMMARY_MARKER = '<!-- ai-review-bot-summary -->'

// Severity → emoji mapping for readable output
const SEVERITY_EMOJI = { high: '🔴', medium: '🟡', low: '🟢' }
const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' }

// --- Read findings ---

const reviewPath = process.argv[2]
if (!reviewPath) {
  console.error('Usage: node post-comments.js <path-to-review.json>')
  process.exit(0)
}

let review
try {
  review = JSON.parse(readFileSync(reviewPath, 'utf8'))
} catch (err) {
  console.error('Could not parse review JSON:', err.message)
  process.exit(0)
}

const findings = review.findings ?? []
const highCount   = findings.filter(f => f.severity === 'high').length
const mediumCount = findings.filter(f => f.severity === 'medium').length
const lowCount    = findings.filter(f => f.severity === 'low').length

// --- Build the summary comment ---

function buildSummary() {
  const riskEmoji = review.risk === 'high' ? '🔴' : review.risk === 'medium' ? '🟡' : '🟢'
  const countLine = findings.length === 0
    ? 'No findings.'
    : `${highCount > 0 ? `${SEVERITY_EMOJI.high} **${highCount} High**  ` : ''}${mediumCount > 0 ? `${SEVERITY_EMOJI.medium} **${mediumCount} Medium**  ` : ''}${lowCount > 0 ? `${SEVERITY_EMOJI.low} **${lowCount} Low**` : ''}`.trim()

  let body = `${SUMMARY_MARKER}
## AI Review ${riskEmoji}

**${review.summary}**

${countLine}
`

  if (findings.length === 0) {
    body += '\n_Nothing to flag. Looks clean._\n'
  } else {
    body += '\n_Inline comments posted on the changed lines below._\n'
  }

  body += '\n---\n_Powered by [bot-workflows](https://github.com/rockeykotwal/bot-workflows) · Gemini · [What is this?](https://github.com/rockeykotwal/bot-workflows#readme)_'

  return body
}

// --- Post or update the summary comment ---

async function upsertSummary() {
  // List all issue comments on the PR (top-level comments)
  const { data: comments } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })

  const existing = comments.find(c => c.body?.includes(SUMMARY_MARKER))
  const body = buildSummary()

  if (existing) {
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    })
    console.log('Updated existing summary comment')
  } else {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    })
    console.log('Created new summary comment')
  }
}

// --- Build inline comment body ---

function buildInlineComment(finding) {
  const emoji   = SEVERITY_EMOJI[finding.severity] ?? '⚪'
  const label   = SEVERITY_LABEL[finding.severity] ?? finding.severity

  let body = `${emoji} **[${label}] ${finding.title}**\n\n`
  body += `**Problem:** ${finding.problem}\n\n`
  body += `**Why it matters:** ${finding.why}\n`

  if (finding.suggestion) {
    body += `\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``
  }

  return body
}

// --- Post inline review comments ---

async function postInlineComments(commitId) {
  if (findings.length === 0) return

  // Build review comments — one per finding that has file + line
  const inlineComments = []
  const fallbackFindings = [] // findings we can't post inline

  for (const finding of findings) {
    if (finding.file && finding.line) {
      inlineComments.push({
        path: finding.file,
        line: finding.line,
        side: 'RIGHT',
        body: buildInlineComment(finding),
      })
    } else {
      fallbackFindings.push(finding)
    }
  }

  if (inlineComments.length > 0) {
    try {
      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitId,
        event: 'COMMENT', // never APPROVE or REQUEST_CHANGES
        comments: inlineComments,
      })
      console.log(`Posted ${inlineComments.length} inline comment(s)`)
    } catch (err) {
      // GitHub rejects inline comments if the line isn't in the diff.
      // Fall back to posting them in the summary instead of failing.
      console.error('Inline comments rejected (lines may be outside diff):', err.message)
      console.log('Falling back: findings will be listed in the summary comment')
      await appendFindingsToSummary(findings)
    }
  }

  if (fallbackFindings.length > 0) {
    await appendFindingsToSummary(fallbackFindings)
  }
}

// --- Fallback: append findings to the summary comment as a list ---

async function appendFindingsToSummary(fallbackFindings) {
  if (fallbackFindings.length === 0) return

  const lines = fallbackFindings.map(f => {
    const emoji = SEVERITY_EMOJI[f.severity] ?? '⚪'
    const label = SEVERITY_LABEL[f.severity] ?? f.severity
    const loc   = f.file ? ` · \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''
    return `- ${emoji} **[${label}] ${f.title}**${loc}\n  ${f.problem}`
  }).join('\n')

  // Find the existing summary comment and append to it
  const { data: comments } = await octokit.issues.listComments({
    owner, repo, issue_number: prNumber, per_page: 100,
  })
  const existing = comments.find(c => c.body?.includes(SUMMARY_MARKER))
  if (!existing) return

  const updated = existing.body + `\n\n### Additional findings\n\n${lines}`
  await octokit.issues.updateComment({
    owner, repo, comment_id: existing.id, body: updated,
  })
}

// --- Main ---

async function run() {
  try {
    // Get the PR details (need the head commit SHA for the review)
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    })
    const commitId = pr.head.sha

    // Post summary first so something is visible even if inline comments fail
    await upsertSummary()

    // Post inline comments
    await postInlineComments(commitId)

    console.log('Done')
  } catch (err) {
    // Log the error but always exit 0 — the bot never blocks a PR
    console.error('post-comments failed:', err.message)
    process.exit(0)
  }
}

run()
