/**
 * llm.js — unified LLM adapter
 *
 * Abstracts the LLM provider so the rest of the codebase doesn't care
 * which model is running underneath. Switch providers with one env var.
 *
 * Usage:
 *   import { generate } from './llm.js'
 *   const text = await generate(prompt)
 *
 * Environment variables:
 *   LLM_PROVIDER     gemini (default) | openai | anthropic | ollama
 *
 *   GEMINI_API_KEY   required when LLM_PROVIDER=gemini
 *   GEMINI_MODEL     optional, default: gemini-3.8-flash
 *
 *   OPENAI_API_KEY   required when LLM_PROVIDER=openai
 *   OPENAI_MODEL     optional, default: gpt-4o-mini
 *
 *   ANTHROPIC_API_KEY  required when LLM_PROVIDER=anthropic
 *   ANTHROPIC_MODEL    optional, default: claude-haiku-4-5-20251001
 *
 *   OLLAMA_HOST      optional, default: http://localhost:11434
 *   OLLAMA_MODEL     optional, default: llama3.1
 *
 * All providers:
 *   - Return plain text (the raw LLM response)
 *   - Retry once on transient errors before giving up
 *   - Exit 0 on failure — the bot never blocks a PR
 */

const PROVIDER = process.env.LLM_PROVIDER?.toLowerCase() ?? 'gemini'

// --- Retry helper ---
// Waits delayMs, doubles on each attempt. Retries on network/transient errors only.

async function withRetry(fn, { retries = 2, delayMs = 10000, label = '' } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err.message ?? ''
      const isTransient =
        msg.includes('fetch failed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('aborted') ||
        msg.includes('503') ||
        msg.includes('high demand') ||
        msg.includes('overloaded') ||
        msg.includes('rate_limit') ||
        msg.includes('529')           // Anthropic overloaded

      if (isTransient && attempt < retries) {
        const wait = delayMs * attempt
        console.error(`${label} attempt ${attempt} failed (${msg.slice(0, 80)}). Retrying in ${wait / 1000}s...`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      throw err
    }
  }
}

// --- Gemini ---

async function gemini(prompt) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai')
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set')

  // Try models in order — primary may be overloaded on free tier
  const models = [
    process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
    'gemini-3.5-flash',
    'gemini-flash-latest',
  ]

  const genAI = new GoogleGenerativeAI(key)

  for (let m = 0; m < models.length; m++) {
    const modelName = models[m]
    try {
      const model = genAI.getGenerativeModel(
        { model: modelName },
        { timeout: 120000 }
      )
      console.error(`Gemini: using ${modelName}`)
      return await withRetry(
        () => model.generateContent(prompt).then(r => r.response.text()),
        { retries: 2, delayMs: 10000, label: `Gemini ${modelName}` }
      )
    } catch (err) {
      const msg = err.message ?? ''
      const isHard = msg.includes('404') || msg.includes('400') || msg.includes('deprecated')
      if (isHard || m < models.length - 1) {
        console.error(`Gemini ${modelName} unavailable. ${m < models.length - 1 ? 'Trying next...' : ''}`)
        continue
      }
      throw err
    }
  }
  throw new Error('All Gemini models failed')
}

// --- OpenAI ---

async function openai(prompt) {
  const { default: OpenAI } = await import('openai')
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not set')

  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  const client = new OpenAI({ apiKey: key })

  console.error(`OpenAI: using ${model}`)
  return withRetry(async () => {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,   // low temperature for consistent structured output
    })
    return response.choices[0].message.content ?? ''
  }, { retries: 2, delayMs: 5000, label: `OpenAI ${model}` })
}

// --- Anthropic ---

async function anthropic(prompt) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set')

  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'
  const client = new Anthropic({ apiKey: key })

  console.error(`Anthropic: using ${model}`)
  return withRetry(async () => {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
    return response.content[0].text ?? ''
  }, { retries: 2, delayMs: 5000, label: `Anthropic ${model}` })
}

// --- Ollama (self-hosted, no API key needed) ---

async function ollama(prompt) {
  const host  = process.env.OLLAMA_HOST  ?? 'http://localhost:11434'
  const model = process.env.OLLAMA_MODEL ?? 'llama3.1'

  console.error(`Ollama: using ${model} at ${host}`)
  return withRetry(async () => {
    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Ollama ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = await res.json()
    return data.response ?? ''
  }, { retries: 2, delayMs: 5000, label: `Ollama ${model}` })
}

// --- Public API ---

const PROVIDERS = { gemini, openai, anthropic, ollama }

export async function generate(prompt) {
  const fn = PROVIDERS[PROVIDER]
  if (!fn) {
    throw new Error(
      `Unknown LLM_PROVIDER "${PROVIDER}". Valid options: ${Object.keys(PROVIDERS).join(', ')}`
    )
  }
  return fn(prompt)
}

export { PROVIDER }
