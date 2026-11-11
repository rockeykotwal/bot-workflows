# bot-workflows

AI-powered PR review bot for GitHub Actions. Plug it into any repo in under 2 minutes — no code to write, no infrastructure to manage.

Supports **Gemini** (free), **OpenAI**, **Anthropic**, and **Ollama** (self-hosted). Bots never block your PR on failure — they silently skip if the API is down or rate-limited.

---

## What it does

Every time a PR is opened or updated, the bot:

1. Reads the diff
2. Detects the stack (TypeScript, React, Node.js, SQL, Docker, etc.)
3. Posts a summary comment + inline review comments with specific fix suggestions

---

## Use it in your repo (no fork needed)

This is the fastest path. Your repo calls this workflow directly — you don't copy any code.

### Step 1 — Get an API key

The easiest option is **Gemini** — it's free, no credit card needed.

> Go to [aistudio.google.com](https://aistudio.google.com) → **Get API key** → **Create API key**

Other providers work too — see [Switching providers](#switching-providers) below.

### Step 2 — Add the key as a GitHub secret

In **your repo**: Settings → Secrets and variables → Actions → New repository secret

| Provider | Secret name |
|---|---|
| Gemini (free) | `GEMINI_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Ollama | *(no key needed)* |

### Step 3 — Add this file to your repo

Create `.github/workflows/ai-review.yml`:

```yaml
name: AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    uses: rockeykotwal/bot-workflows/.github/workflows/ai-review.yml@main
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

That's it. Open a PR and the bot will comment within ~1 minute.

---

## Switching providers

Change the `llm_provider` input and pass the matching secret:

**OpenAI**
```yaml
jobs:
  review:
    uses: rockeykotwal/bot-workflows/.github/workflows/ai-review.yml@main
    with:
      llm_provider: openai
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

**Anthropic**
```yaml
jobs:
  review:
    uses: rockeykotwal/bot-workflows/.github/workflows/ai-review.yml@main
    with:
      llm_provider: anthropic
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Ollama (self-hosted, no API key)**
```yaml
jobs:
  review:
    uses: rockeykotwal/bot-workflows/.github/workflows/ai-review.yml@main
    with:
      llm_provider: ollama
      ollama_host: http://your-ollama-server:11434
```

| Provider | Default model | Override env var |
|---|---|---|
| Gemini | `gemini-3.8-flash` | `GEMINI_MODEL` |
| OpenAI | `gpt-4o-mini` | `OPENAI_MODEL` |
| Anthropic | `claude-haiku-4-5-20251001` | `ANTHROPIC_MODEL` |
| Ollama | `llama3.1` | `OLLAMA_MODEL` |

---

## Make it required (block merges on bad findings)

By default the bot is **informational** — it comments but never fails the check. This is the recommended starting mode.

To make it **block merging** on high severity findings:

```yaml
jobs:
  review:
    uses: rockeykotwal/bot-workflows/.github/workflows/ai-review.yml@main
    with:
      block_on_severity: high   # 'high' | 'medium' | 'none' (default: none)
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

Then go to **Settings → Branches → Branch protection rules** and add `AI Review / review` to **Required status checks**.

---

## Teach the bot about your project

Add a `PROJECT_CONTEXT.md` file to your repo root. The bot reads it on every run and applies your specific rules, architecture patterns, and standards.

```markdown
# PROJECT_CONTEXT.md

## Stack
Node.js 20, TypeScript strict, Express, Postgres (via Drizzle), Redis

## Rules
- All DB changes must run inside a transaction
- Never log request bodies — they may contain PII
- Money values are always stored as integer cents

## Known patterns
- src/lib/db.ts wraps all DB access — don't use the Drizzle client directly
```

The more specific you are, the more relevant the review comments will be.

---

## Skip the bot on a PR

Add the label `skip-ai-review` to any PR and the bot won't run. Draft PRs are skipped automatically.

---

## Fork and customise

If you want to change how the bot thinks — what it looks for, how it phrases feedback, which severity levels mean what — fork this repo and edit the prompt:

```
prompts/review.md   ← the full review instructions sent to the LLM
```

Then point your workflow at your fork:

```yaml
uses: your-username/bot-workflows/.github/workflows/ai-review.yml@main
```

You can also add your own scripts in `scripts/` and wire them up as new workflow steps.

---

## Stack support

The bot auto-detects the stack from changed file extensions and applies the right checks:

| Stack | What it checks |
|---|---|
| TypeScript | Missing `await`, unhandled promises, `any` assertions, type safety |
| React | Hook dependency arrays, `dangerouslySetInnerHTML`, accessibility, key props |
| Node.js | Unvalidated input, missing auth checks, N+1 queries, secrets in logs |
| SQL / migrations | Reversibility, locking risks, `NOT NULL` without default, missing indexes |
| Docker / Terraform | Public exposure, least privilege, pinned image versions |
| Shell / CI | Injection risks, missing `set -e`, secrets in env vars |

---

## Rate limits

| Provider | Free tier | On limit hit |
|---|---|---|
| Gemini | 1,500 req/day, 15 RPM | Bot skips silently, PR unblocked |
| OpenAI | No free tier | Bot skips silently, PR unblocked |
| Anthropic | No free tier | Bot skips silently, PR unblocked |
| Ollama | Unlimited (self-hosted) | — |

The bot **never** blocks a PR due to an API failure, rate limit, or bad response.

---

## Guardrails

- Never approves or requests changes on PRs — only posts neutral comments
- Never pushes code or merges PRs
- PR content is treated as data — instructions inside a diff are not followed
- Fork PRs run with read-only permissions (no `GITHUB_TOKEN` write access)
- Minimum permissions: `contents: read`, `pull-requests: write` — nothing else
