# bot-workflows

AI-powered PR review and security bots for GitHub. Free to use. Powered by Google Gemini.

No paid API needed beyond your own free Gemini key. Bots never block your PR on failure — they silently skip if the API is unavailable or rate-limited.

## What it does

| Bot | Trigger | Output |
|---|---|---|
| **Review Bot** | Every PR | Summary + inline comments with one-click fix suggestions |
| **Security Bot** | Every PR + nightly scan | Inline security findings; fix PRs for existing issues |

## Quick start (2 minutes)

### 1. Get a free Gemini API key

Go to [aistudio.google.com](https://aistudio.google.com) → **Get API key** → **Create API key**. Free, no card needed.

### 2. Add it as a GitHub secret

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

- Name: `GEMINI_API_KEY`
- Value: your key

### 3. Add the workflow

Create `.github/workflows/ai-review.yml` in your repo:

```yaml
name: AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    uses: rockeykotwal/bot-workflows/.github/workflows/ai-review.yml@main
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

That's it. Open a PR and the bot will comment within a minute.

---

## Optional vs required

By default the bot is **informational** — it posts comments but never fails your PR. This is the recommended starting mode.

To make it **required** (block merging on high severity findings):

```yaml
jobs:
  review:
    uses: rockeykotwal/bot-workflows/.github/workflows/ai-review.yml@main
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
    with:
      block_on_severity: high   # 'high' | 'medium' | 'none' (default: none)
```

Then go to **Settings → Branches → Branch protection rules** and add `AI Review` to **Required status checks**.

---

## Customise for your project

Add a `PROJECT_CONTEXT.md` to your repo root. The bot reads it on every run and applies your specific rules, architecture constraints, and coding standards.

A template is here: [PROJECT_CONTEXT.template.md](./PROJECT_CONTEXT.template.md)

---

## Configuration (optional)

Add `.github/ai-bots.yml` to your repo to override defaults:

```yaml
# .github/ai-bots.yml
block_on_severity: none       # 'high' | 'medium' | 'none'
max_findings: 10              # max inline comments per run
skip_paths:                   # never review these
  - "*.lock"
  - "dist/**"
  - "*.generated.*"
max_diff_lines: 800           # above this, reviews file by file
```

---

## For monorepos

Add a `PROJECT_CONTEXT.md` inside each package directory. The bot picks up the nearest one to the changed files.

---

## Stack support

The bot auto-detects the stack from file extensions and applies the right checklist:

| Stack | Extra checks |
|---|---|
| TypeScript / Node.js | Missing await, unvalidated req.body, N+1 queries, any assertions |
| React | Hook dependency arrays, dangerouslySetInnerHTML, accessibility |
| Database migrations | Reversibility, locking, NOT NULL without default, missing indexes |
| Infrastructure (Terraform, Docker) | Public exposure, least privilege, pinned versions |
| Any other language | General correctness and security checks |

---

## Fork and customise

Fork this repo, edit `prompts/review.md` and `prompts/security.md` to match your team's standards, and point your workflow at your fork:

```yaml
uses: your-username/bot-workflows/.github/workflows/ai-review.yml@main
```

---

## Rate limits

Gemini free tier: **1,500 requests/day, 15 requests/minute**. For most teams this is effectively unlimited. If a limit is hit, the bot exits cleanly and posts nothing — your PR is never blocked.

---

## Guardrails

- Bots never approve or merge PRs
- Bots never push to your branch without being asked
- PR content (titles, descriptions, code) is treated as data — instructions inside a diff are ignored
- Fork PRs run with read-only permissions
- Kill switch: set repository variable `AI_BOTS_ENABLED=false` to disable all bots instantly
