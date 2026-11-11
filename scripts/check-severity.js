/**
 * check-severity.js
 *
 * Reads an existing review.json and exits 1 if findings at or above
 * BLOCK_ON_SEVERITY exist. Called by the workflow's severity gate step
 * so we don't need a second Gemini API call.
 *
 * Usage: node scripts/check-severity.js /tmp/review.json
 */

import { readFileSync } from 'fs'

const reviewPath = process.argv[2]
const blockOn = process.env.BLOCK_ON_SEVERITY ?? 'none'

if (!reviewPath || blockOn === 'none') process.exit(0)

let review
try {
  review = JSON.parse(readFileSync(reviewPath, 'utf8'))
} catch {
  process.exit(0) // can't parse — don't block
}

const rank = { high: 2, medium: 1, low: 0 }
const threshold = rank[blockOn] ?? 2
const blocking = (review.findings ?? []).filter(f => (rank[f.severity] ?? 0) >= threshold)

if (blocking.length > 0) {
  console.error(`\n🔴 Severity gate failed: ${blocking.length} finding(s) at or above '${blockOn}':`)
  blocking.forEach(f => console.error(`   [${f.severity.toUpperCase()}] ${f.title} — ${f.file}:${f.line}`))
  console.error('\nFix the findings above or set block_on_severity: none to allow merging.\n')
  process.exit(1)
}

console.log(`Severity gate passed (threshold: ${blockOn})`)
process.exit(0)
