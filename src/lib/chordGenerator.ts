import type { DetectedNote } from '../hooks/useAudioRecorder'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export type ChordPattern = {
  name: string
  chords: string[]
  mood: string
  moodEn: string
  color: string
}

// Krumhansl-Schmuckler key profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function correlation(a: number[], b: number[]): number {
  const n = a.length
  const meanA = a.reduce((s, v) => s + v, 0) / n
  const meanB = b.reduce((s, v) => s + v, 0) / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    const va = a[i] - meanA
    const vb = b[i] - meanB
    num += va * vb
    da += va * va
    db += vb * vb
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db)
}

export function detectKey(notes: DetectedNote[]): { root: number; isMinor: boolean } {
  if (notes.length === 0) return { root: 0, isMinor: false }

  const counts = new Array(12).fill(0)
  for (const note of notes) {
    counts[note.midi % 12] += note.duration
  }

  let bestScore = -Infinity
  let bestRoot = 0
  let bestMinor = false

  for (let root = 0; root < 12; root++) {
    const rotated = [...counts.slice(root), ...counts.slice(0, root)]
    const majScore = correlation(rotated, MAJOR_PROFILE)
    const minScore = correlation(rotated, MINOR_PROFILE)
    if (majScore > bestScore) { bestScore = majScore; bestRoot = root; bestMinor = false }
    if (minScore > bestScore) { bestScore = minScore; bestRoot = root; bestMinor = true }
  }

  return { root: bestRoot, isMinor: bestMinor }
}

function noteName(root: number, semitones: number): string {
  return NOTE_NAMES[(root + semitones) % 12]
}

export function generateChordPatterns(notes: DetectedNote[]): ChordPattern[] {
  const { root, isMinor } = detectKey(notes)
  const r = root

  if (isMinor) {
    // Natural minor patterns
    const i   = noteName(r, 0) + 'm'
    const III = noteName(r, 3)
    const iv  = noteName(r, 5) + 'm'
    const VI  = noteName(r, 8)
    const VII = noteName(r, 10)
    const v   = noteName(r, 7) + 'm'
    const iim = noteName(r, 2) + 'm7♭5'
    const V7  = noteName(r, 7) + '7'

    return [
      {
        name: '王道マイナー',
        chords: [i, iv, VII, III],
        mood: '切ない、感情的な雰囲気',
        moodEn: 'melancholic',
        color: 'from-indigo-500 to-purple-600',
      },
      {
        name: 'ポップマイナー',
        chords: [i, VI, III, VII],
        mood: 'エモーショナルで力強い雰囲気',
        moodEn: 'emotional',
        color: 'from-rose-500 to-pink-600',
      },
      {
        name: '穏やかマイナー',
        chords: [i, iv, v, i],
        mood: '静かで内省的な雰囲気',
        moodEn: 'introspective',
        color: 'from-slate-500 to-blue-600',
      },
      {
        name: 'ジャジーマイナー',
        chords: [iim, V7, i, VI],
        mood: '洗練された大人の雰囲気',
        moodEn: 'jazzy',
        color: 'from-amber-500 to-orange-600',
      },
    ]
  } else {
    // Major patterns
    const I    = noteName(r, 0)
    const ii   = noteName(r, 2) + 'm'
    const IV   = noteName(r, 5)
    const V    = noteName(r, 7)
    const vi   = noteName(r, 9) + 'm'
    const iiim = noteName(r, 4) + 'm'
    const I7   = noteName(r, 0) + 'maj7'
    const ii7  = noteName(r, 2) + 'm7'
    const V7   = noteName(r, 7) + '7'

    return [
      {
        name: '王道',
        chords: [I, IV, V, I],
        mood: '明るく安定した、聴き慣れた雰囲気',
        moodEn: 'classic',
        color: 'from-yellow-400 to-orange-500',
      },
      {
        name: '切ない',
        chords: [vi, IV, I, V],
        mood: '感情的で切ない雰囲気',
        moodEn: 'melancholic',
        color: 'from-blue-500 to-indigo-600',
      },
      {
        name: 'ポップ',
        chords: [I, V, vi, IV],
        mood: 'キャッチーでポップな雰囲気',
        moodEn: 'pop',
        color: 'from-pink-500 to-rose-500',
      },
      {
        name: 'ジャジー',
        chords: [I7, ii7, V7, I7],
        mood: '洗練された大人の雰囲気',
        moodEn: 'jazzy',
        color: 'from-amber-500 to-yellow-600',
      },
      {
        name: '爽やか',
        chords: [I, iiim, IV, V],
        mood: '軽やかで爽やかな雰囲気',
        moodEn: 'fresh',
        color: 'from-teal-400 to-cyan-500',
      },
      {
        name: '壮大',
        chords: [I, vi, ii, V],
        mood: '壮大でドラマチックな雰囲気',
        moodEn: 'epic',
        color: 'from-purple-500 to-violet-600',
      },
    ]
  }
}

export function getKeyLabel(notes: DetectedNote[]): string {
  if (notes.length === 0) return '—'
  const { root, isMinor } = detectKey(notes)
  return `${NOTE_NAMES[root]} ${isMinor ? 'minor' : 'major'}`
}
