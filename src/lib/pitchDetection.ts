/**
 * Basic Pitch (Spotify) を使ったブラウザ内 ML ピッチ検出。
 * モデルは node_modules に同梱 → Express 経由でオフライン配信。
 * @tensorflow/tfjs は動的インポートでコード分割し、初期ロードを軽くする。
 */

import type { DetectedNote } from '../hooks/useAudioRecorder'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function midiToNoteName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

function quantizeDuration(secs: number, bpm: number): number {
  const beat = 60 / bpm
  const divs = [0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4]
  const best = divs.reduce((a, b) =>
    Math.abs(secs / beat - b) < Math.abs(secs / beat - a) ? b : a,
  )
  return Math.round(best * beat * 1000) / 1000
}

const TARGET_SAMPLE_RATE = 22050  // Basic Pitch が要求するサンプルレート

/** Blob を 22050 Hz モノラル AudioBuffer にデコード＆リサンプリング */
async function decodeAs22050(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer()

  // まず元のサンプルレートでデコード
  const tmpCtx = new AudioContext()
  let native: AudioBuffer
  try {
    native = await tmpCtx.decodeAudioData(arrayBuffer)
  } finally {
    tmpCtx.close()
  }

  if (native.sampleRate === TARGET_SAMPLE_RATE) return native

  // OfflineAudioContext でリサンプリング（ブラウザの高品質リサンプラを使用）
  const numFrames = Math.ceil(native.duration * TARGET_SAMPLE_RATE)
  const offCtx = new OfflineAudioContext(1, numFrames, TARGET_SAMPLE_RATE)
  const src = offCtx.createBufferSource()
  src.buffer = native
  src.connect(offCtx.destination)
  src.start(0)
  return offCtx.startRendering()
}

// モデルインスタンスをキャッシュ（ページリロードまで再利用）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedBp: any = null

export async function detectPitchWithML(blob: Blob, bpm: number): Promise<DetectedNote[]> {
  // 動的インポート: TF.js は初回解析時にだけ読み込む
  const {
    BasicPitch,
    outputToNotesPoly,
    noteFramesToTime,
    addPitchBendsToNoteEvents,  // 正しいエクスポート名
  } = await import('@spotify/basic-pitch')

  if (!cachedBp) {
    // モデルは Express が /basic-pitch-model/ で配信
    cachedBp = new BasicPitch('/basic-pitch-model/model.json')
  }

  // 録音 Blob → 22050 Hz AudioBuffer（Basic Pitch が要求するサンプルレート）
  const audioBuffer = await decodeAs22050(blob)

  // ── BasicPitch 推論 ────────────────────────────────────────────────────────
  const frames: number[][] = []
  const onsets: number[][] = []
  const contours: number[][] = []

  await cachedBp.evaluateModel(
    audioBuffer,
    (f: number[][], o: number[][], c: number[][]) => {
      frames.push(...f)
      onsets.push(...o)
      contours.push(...c)
    },
    (_pct: number) => { /* progress */ },
  )

  // ── フレーム → 音符変換 ────────────────────────────────────────────────────
  // onsetThresh=0.5, frameThresh=0.3, minNoteLenFrames=11 (~50ms), melodiaTrick=true
  const noteEvents = outputToNotesPoly(frames, onsets, 0.5, 0.3, 11, true, null, null, true, 10)
  const withBends  = addPitchBendsToNoteEvents(contours, noteEvents)
  const timed      = noteFramesToTime(withBends)

  // NoteEventTime: { startTimeSeconds, durationSeconds, pitchMidi, amplitude, pitchBends? }
  return timed.map(note => ({
    name: midiToNoteName(note.pitchMidi),
    midi: note.pitchMidi,
    time: note.startTimeSeconds,
    duration: quantizeDuration(note.durationSeconds, bpm),
  }))
}
