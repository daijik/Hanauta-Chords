import express from 'express'
import { createServer as createViteServer } from 'vite'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isProd = process.env.NODE_ENV === 'production'
const PORT = process.env.PORT || 5173
const TMP_DIR = join(__dirname, 'tmp')

if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR)

const app = express()

// ── アプリ停止 ───────────────────────────────────────────────────────────────
app.post('/api/stop', (_req, res) => {
  res.json({ ok: true })
  setTimeout(() => process.exit(0), 200)
})

// ── 音声解析（Python crepe へ委譲）──────────────────────────────────────────
app.post('/api/analyze', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  const bpm = parseFloat(req.query.bpm) || 120
  const tmpFile = join(TMP_DIR, `${randomUUID()}.wav`)

  try {
    await writeFile(tmpFile, req.body)

    const notes = await runPython(tmpFile, bpm)
    res.json(notes)
  } catch (err) {
    console.error('analyze error:', err)
    res.status(500).json({ error: String(err) })
  } finally {
    try { unlinkSync(tmpFile) } catch { /* ignore */ }
  }
})

function runPython(audioPath, bpm) {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [join(__dirname, 'analyze.py'), audioPath, String(bpm)])
    let stdout = ''
    let stderr = ''
    py.stdout.on('data', d => { stdout += d })
    py.stderr.on('data', d => { stderr += d })
    py.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `exit ${code}`))
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.error) return reject(new Error(parsed.error))
        resolve(parsed)
      } catch {
        reject(new Error(`JSON parse error: ${stdout}`))
      }
    })
  })
}

// ── 静的ファイル / Vite dev ──────────────────────────────────────────────────
if (isProd) {
  const distDir = join(__dirname, 'dist')
  if (!existsSync(distDir)) {
    console.error('dist/ が見つかりません。先に npm run build を実行してください。')
    process.exit(1)
  }
  app.use(express.static(distDir))
  app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')))
  app.listen(PORT, () => console.log(`http://0.0.0.0:${PORT}`))
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  })
  app.use(vite.middlewares)
  app.listen(PORT, () => console.log(`http://0.0.0.0:${PORT}`))
}
