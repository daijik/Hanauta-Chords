import express from 'express'
import { createServer as createViteServer } from 'vite'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isProd = process.env.NODE_ENV === 'production'
const PORT = process.env.PORT || 5173

const app = express()

// ── アプリ停止 ───────────────────────────────────────────────────────────────
app.post('/api/stop', (_req, res) => {
  res.json({ ok: true })
  setTimeout(() => process.exit(0), 200)
})

// ── Basic Pitch モデルをオフラインで配信 ─────────────────────────────────────
// node_modules に同梱されているモデルファイルをブラウザに提供する
const modelPath = join(__dirname, 'node_modules', '@spotify', 'basic-pitch', 'model')
if (existsSync(modelPath)) {
  app.use('/basic-pitch-model', express.static(modelPath))
} else {
  console.warn('Basic Pitch model not found at', modelPath)
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
