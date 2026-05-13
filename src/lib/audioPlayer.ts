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

function playTone(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  duration: number,
  gain = 0.25,
  type: OscillatorType = 'sine',
) {
  const osc = ctx.createOscillator()
  const gainNode = ctx.createGain()
  osc.connect(gainNode)
  gainNode.connect(ctx.destination)
  osc.type = type
  osc.frequency.value = freq
  gainNode.gain.setValueAtTime(gain, startTime)
  gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration * 0.95)
  osc.start(startTime)
  osc.stop(startTime + duration)
}

export function playMelody(notes: DetectedNote[]): () => void {
  if (notes.length === 0) return () => {}
  const ctx = new AudioContext()

  const now = ctx.currentTime + 0.05
  for (const note of notes) {
    const freq = midiToFreq(note.midi)
    playTone(ctx, freq, now + note.time, note.duration, 0.3, 'sine')
  }

  const totalDuration = Math.max(...notes.map(n => n.time + n.duration))
  const stopAt = now + totalDuration + 0.3
  const timeoutId = setTimeout(() => ctx.close(), (stopAt - ctx.currentTime) * 1000)

  return () => {
    clearTimeout(timeoutId)
    ctx.close()
  }
}

// コード名 → 構成音の MIDI オフセット（ルート音からの半音数）
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

export function playChordPattern(chords: string[], bpm = 72): () => void {
  if (chords.length === 0) return () => {}
  const ctx = new AudioContext()
  const beatDuration = 60 / bpm
  const chordDuration = beatDuration * 2  // 各コードを2拍

  const now = ctx.currentTime + 0.05
  chords.forEach((chord, ci) => {
    const startTime = now + ci * chordDuration
    const root = chordRootMidi(chord)
    const intervals = chordIntervals(chord)
    intervals.forEach((interval, ii) => {
      const midi = root + interval
      const freq = midiToFreq(midi)
      // アルペジオ風に少しずらして弾く
      const offset = ii * 0.04
      playTone(ctx, freq, startTime + offset, chordDuration - 0.05, 0.2, 'triangle')
    })
  })

  const totalDuration = chords.length * chordDuration + 0.5
  const timeoutId = setTimeout(() => ctx.close(), totalDuration * 1000 + 500)

  return () => {
    clearTimeout(timeoutId)
    ctx.close()
  }
}

export function playMelodyWithChords(
  notes: DetectedNote[],
  chords: string[],
): () => void {
  if (notes.length === 0) return () => {}
  const ctx = new AudioContext()
  const now = ctx.currentTime + 0.05

  // メロディ
  for (const note of notes) {
    const freq = midiToFreq(note.midi)
    playTone(ctx, freq, now + note.time, note.duration, 0.3, 'sine')
  }

  // コード（メロディの長さに合わせて均等割り）
  const totalMelodyDuration = Math.max(...notes.map(n => n.time + n.duration))
  const chordDuration = totalMelodyDuration / chords.length
  chords.forEach((chord, ci) => {
    const startTime = now + ci * chordDuration
    const root = chordRootMidi(chord)
    const intervals = chordIntervals(chord)
    intervals.forEach((interval, ii) => {
      const midi = root + interval
      const freq = midiToFreq(midi)
      playTone(ctx, freq, startTime + ii * 0.04, chordDuration - 0.05, 0.15, 'triangle')
    })
  })

  const stopAt = now + totalMelodyDuration + 0.5
  const timeoutId = setTimeout(() => ctx.close(), (stopAt - ctx.currentTime) * 1000 + 500)

  return () => {
    clearTimeout(timeoutId)
    ctx.close()
  }
}

// 音符名→MIDIの変換（外部参照用）
export { noteNameToMidi }
