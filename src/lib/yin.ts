/**
 * YIN ピッチ検出アルゴリズム
 * 参考: de Cheveigné & Kawahara (2002) "YIN, a fundamental frequency estimator
 *       for speech and music", JASA 111(4)
 *
 * MPM（pitchy の実装）に比べてボーカル・鼻歌で精度が高い。
 * 時間計算量は O(W²) だが、オフライン解析なので許容範囲内。
 */

export type YinResult = {
  pitch: number   // Hz。検出できなかった場合は -1
  clarity: number // 0〜1。高いほど確信度が高い
}

export function yinDetect(
  buf: Float32Array,
  sampleRate: number,
  threshold = 0.20,
): YinResult {
  const W = Math.floor(buf.length / 2)  // 半分を解析窓として使用

  // ── Step 1: 差分関数 d(τ) ────────────────────────────────────────────────
  // d(τ) = Σ_{j=0}^{W-1} (x[j] - x[j+τ])²
  const d = new Float32Array(W)
  for (let tau = 1; tau < W; tau++) {
    let s = 0
    for (let j = 0; j < W; j++) {
      const v = buf[j] - buf[j + tau]
      s += v * v
    }
    d[tau] = s
  }

  // ── Step 2: 累積平均正規化差分関数 (CMNDF) ───────────────────────────────
  // d'(0) = 1
  // d'(τ) = d(τ) / ((1/τ) Σ_{j=1}^{τ} d(j))
  const cmndf = new Float32Array(W)
  cmndf[0] = 1
  let cumSum = 0
  for (let tau = 1; tau < W; tau++) {
    cumSum += d[tau]
    cmndf[tau] = cumSum === 0 ? 0 : (d[tau] * tau) / cumSum
  }

  // ── Step 3: 絶対閾値法でラグを探す ──────────────────────────────────────
  // threshold 以下になった最初の局所最小点を採用
  let tau = 2
  for (; tau < W - 1; tau++) {
    if (cmndf[tau] < threshold) {
      // 局所最小を探す（より深い谷へ）
      while (tau + 1 < W - 1 && cmndf[tau + 1] < cmndf[tau]) tau++
      break
    }
  }

  // threshold を下回る点が見つからない場合は全体最小を候補にする
  if (tau >= W - 1) {
    let bestTau = 2
    let bestVal = cmndf[2]
    for (let t = 3; t < W - 1; t++) {
      if (cmndf[t] < bestVal) { bestVal = cmndf[t]; bestTau = t }
    }
    // それでも確信度が低ければ未検出
    if (bestVal > 0.35) return { pitch: -1, clarity: 0 }
    tau = bestTau
  }

  // ── Step 4: 放物線補間で精度向上 ─────────────────────────────────────────
  let refinedTau: number = tau
  if (tau > 0 && tau < W - 1) {
    const a = cmndf[tau - 1]
    const b = cmndf[tau]
    const c = cmndf[tau + 1]
    const denom = 2 * (a - 2 * b + c)
    if (Math.abs(denom) > 1e-10) {
      refinedTau = tau + (a - c) / denom
    }
  }

  const clarity = Math.max(0, 1 - cmndf[tau])
  return { pitch: sampleRate / refinedTau, clarity }
}
