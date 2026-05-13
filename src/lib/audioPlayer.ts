import type { DetectedNote } from '../hooks/useAudioRecorder'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function noteNameToMidi(name: string): number {
  const match = name.match(/^([A-G]#?)(\d+)$/)
  if (!match) return 60
  const noteIdx = NOTE_NAMES.indexOf(match[1])
  const octave = parseInt(match[2])
  return noteIdx + (octave + 1) * 12
}

// 出力チェーン: オシレーター → ノートゲイン → マスターゲイン → コンプレッサー → destination
function createOutputChain(ctx: AudioContext) {
  const master = ctx.createGain()
  master.gain.value = 1.8  // 全体音量を底上げ

  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = -12
  compressor.knee.value = 6
  compressor.ratio.value = 3
  compressor.attack.value = 0.01
  compressor.release.value = 0.15

  master.connect(compressor)
  compressor.connect(ctx.destination)
  return master
}

function playTone(
  ctx: AudioContext,
  dest: AudioNode,
  freq: number,
  startTime: number,
  duration: number,
  gain: number,
  type: OscillatorType,
) {
  const osc = ctx.createOscillator()
  const gainNode = ctx.createGain()

  osc.connect(gainNode)
  gainNode.connect(dest)

  osc.type = type
  osc.frequency.value = freq

  // アタック: 急な立ち上がりでクリックノイズを防ぐ
  gainNode.gain.setValueAtTime(0, startTime)
  gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.02)
  gainNode.gain.setValueAtTime(gain, startTime + duration * 0.75)
  gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration)

  osc.start(startTime)
  osc.stop(startTime + duration + 0.01)
}

// コード名 → 構成音の MIDI オフセット
function chordIntervals(chordName: string): number[] {
  if (chordName.endsWith('maj7'))  return [0, 4, 7, 11]
  if (chordName.endsWith('m7♭5')) return [0, 3, 6, 10]
  if (chordName.endsWith('m7'))   return [0, 3, 7, 10]
  if (chordName.endsWith('7'))    return [0, 4, 7, 10]
  if (chordName.endsWith('m'))    return [0, 3, 7]
  return [0, 4, 7]
}

function chordRootMidi(chordName: string): number {
  const rootStr = chordName.match(/^[A-G]#?/)?.[0] ?? 'C'
  const idx = NOTE_NAMES.indexOf(rootStr)
  return 48 + idx  // C3 ベース
}

export function playMelody(notes: DetectedNote[]): () => void {
  if (notes.length === 0) return () => {}
  const ctx = new AudioContext()
  const master = createOutputChain(ctx)

  const now = ctx.currentTime + 0.05
  for (const note of notes) {
    const freq = midiToFreq(note.midi)
    playTone(ctx, master, freq, now + note.time, note.duration, 0.65, 'sine')
  }

  const totalDuration = Math.max(...notes.map(n => n.time + n.duration))
  const timeoutId = setTimeout(() => ctx.close(), (totalDuration + 1) * 1000)
  return () => { clearTimeout(timeoutId); ctx.close() }
}

export function playChordPattern(chords: string[], bpm = 72): () => void {
  if (chords.length === 0) return () => {}
  const ctx = new AudioContext()
  const master = createOutputChain(ctx)

  const beatDuration = 60 / bpm
  const chordDuration = beatDuration * 2

  const now = ctx.currentTime + 0.05
  chords.forEach((chord, ci) => {
    const startTime = now + ci * chordDuration
    const root = chordRootMidi(chord)
    const intervals = chordIntervals(chord)
    intervals.forEach((interval, ii) => {
      const freq = midiToFreq(root + interval)
      const offset = ii * 0.05  // アルペジオ
      playTone(ctx, master, freq, startTime + offset, chordDuration - 0.08, 0.45, 'triangle')
    })
  })

  const totalDuration = chords.length * chordDuration + 1
  const timeoutId = setTimeout(() => ctx.close(), totalDuration * 1000)
  return () => { clearTimeout(timeoutId); ctx.close() }
}

export function playMelodyWithChords(
  notes: DetectedNote[],
  chords: string[],
): () => void {
  if (notes.length === 0) return () => {}
  const ctx = new AudioContext()
  const master = createOutputChain(ctx)

  const now = ctx.currentTime + 0.05
  const totalMelodyDuration = Math.max(...notes.map(n => n.time + n.duration))

  // メロディ（やや大きめ）
  for (const note of notes) {
    playTone(ctx, master, midiToFreq(note.midi), now + note.time, note.duration, 0.6, 'sine')
  }

  // コード（メロディより少し小さく）
  const chordDuration = totalMelodyDuration / chords.length
  chords.forEach((chord, ci) => {
    const startTime = now + ci * chordDuration
    const root = chordRootMidi(chord)
    chordIntervals(chord).forEach((interval, ii) => {
      const freq = midiToFreq(root + interval)
      playTone(ctx, master, freq, startTime + ii * 0.05, chordDuration - 0.08, 0.30, 'triangle')
    })
  })

  const timeoutId = setTimeout(() => ctx.close(), (totalMelodyDuration + 1) * 1000)
  return () => { clearTimeout(timeoutId); ctx.close() }
}

export { noteNameToMidi }
