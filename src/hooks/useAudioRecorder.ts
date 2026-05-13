import { useRef, useState, useCallback, useEffect } from 'react'
import { yinDetect } from '../lib/yin'

export type DetectedNote = {
  name: string
  midi: number
  time: number
  duration: number
}

export type RecordingState = 'idle' | 'countdown' | 'recording' | 'analyzing'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function freqToMidi(freq: number): number {
  return Math.round(12 * Math.log2(freq / 440) + 69)
}

function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1
  return `${NOTE_NAMES[midi % 12]}${octave}`
}

// ─── クリック音スケジューラー ────────────────────────────────────────────────

function scheduleClick(ctx: AudioContext, time: number, accented: boolean) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.type = 'square'
  osc.frequency.value = accented ? 880 : 660
  gain.gain.setValueAtTime(0.5, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.07)
  osc.start(time)
  osc.stop(time + 0.08)
}

function scheduleCountdown(
  ctx: AudioContext,
  bpm: number,
  beats: number,
  startTime: number,
  onBeat: (beat: number) => void,
): Promise<void> {
  const beatDuration = 60 / bpm
  for (let i = 0; i < beats; i++) {
    const t = startTime + i * beatDuration
    scheduleClick(ctx, t, i === 0)
    setTimeout(() => onBeat(i + 1), Math.max(0, (t - ctx.currentTime) * 1000))
  }
  const endTime = startTime + beats * beatDuration
  return new Promise(resolve =>
    setTimeout(resolve, Math.max(0, (endTime - ctx.currentTime) * 1000)),
  )
}

const METRONOME_LOOKAHEAD = 0.4
const METRONOME_INTERVAL = 150

function startMetronome(ctx: AudioContext, bpm: number, startTime: number): () => void {
  const beatDuration = 60 / bpm
  let nextBeatTime = startTime
  let beatIndex = 0
  const schedule = () => {
    while (nextBeatTime < ctx.currentTime + METRONOME_LOOKAHEAD) {
      scheduleClick(ctx, nextBeatTime, beatIndex % 4 === 0)
      nextBeatTime += beatDuration
      beatIndex++
    }
  }
  schedule()
  const id = setInterval(schedule, METRONOME_INTERVAL)
  return () => clearInterval(id)
}

// ─── オフライン解析パイプライン ──────────────────────────────────────────────
//
// PCM → YIN フレーム解析 → フィルタ → MIDI スナップ
//   → モード平滑化 → プラトー検出 → BPM 量子化 → DetectedNote[]
//
// pitchy (MPM) から YIN に変更: ボーカル・鼻歌に対してオクターブ誤検出が少ない

const YIN_WINDOW = 2048      // YIN の解析ウィンドウ（=ハーフが 1024、最低検出 ~43 Hz）
const HOP_FPS = 25           // 解析フレームレート（1フレーム = 40ms）
const YIN_THRESHOLD = 0.18   // YIN の CMNDF 閾値（小さいほど厳しい）
const MIN_CLARITY = 0.55     // YIN の確信度最低ライン
const MIN_FREQ = 80          // 鼻歌最低音（Hz）
const MAX_FREQ = 650         // 鼻歌最高音（Hz）
const RMS_GATE = 0.006       // 無音ゲート（RMS がこれ以下は無視）
const SMOOTH_WINDOW = 7      // モード平滑化のフレーム数
const MIN_NOTE_FRAMES = 3    // 音符と認定する最短フレーム数
const NOTE_SNAP_SEMITONES = 0.5  // 同一音符とみなす半音幅（±0.5 以内なら同音）

function rms(buf: Float32Array): number {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

// 配列の最頻値
function modeOf(arr: number[]): number {
  const count: Record<number, number> = {}
  let maxN = 0
  let mode = arr[0]
  for (const v of arr) {
    count[v] = (count[v] ?? 0) + 1
    if (count[v] > maxN) { maxN = count[v]; mode = v }
  }
  return mode
}

// BPM グリッドに最も近い音符長を返す（16分音符〜全音符）
const NOTE_DIVISIONS = [0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4]  // 拍数単位

function quantizeDuration(seconds: number, bpm: number): number {
  const beats = seconds / (60 / bpm)
  let best = NOTE_DIVISIONS[0]
  let bestErr = Infinity
  for (const div of NOTE_DIVISIONS) {
    const err = Math.abs(beats - div)
    if (err < bestErr) { bestErr = err; best = div }
  }
  return best * (60 / bpm)
}

// オクターブ補正: 鼻歌音域（MIDI 45-80）を外れていたら 12 半音シフト
function octaveCorrect(midi: number): number {
  if (midi > 80) return midi - 12
  if (midi < 45) return midi + 12
  return midi
}

function analyzePCM(samples: Float32Array, sampleRate: number, bpm: number): DetectedNote[] {
  const hopSize = Math.floor(sampleRate / HOP_FPS)

  // ── Phase 1: フレームごとに YIN 解析 ─────────────────────────────────────
  type Frame = { time: number; midi: number }
  const validFrames: Frame[] = []

  for (let i = 0; i + YIN_WINDOW < samples.length; i += hopSize) {
    const win = samples.slice(i, i + YIN_WINDOW)
    const time = i / sampleRate

    if (rms(win) < RMS_GATE) continue  // 無音スキップ

    const { pitch, clarity } = yinDetect(win, sampleRate, YIN_THRESHOLD)
    if (clarity < MIN_CLARITY || pitch < MIN_FREQ || pitch > MAX_FREQ) continue

    const raw = freqToMidi(pitch)
    const midi = octaveCorrect(raw)
    validFrames.push({ time, midi })
  }

  if (validFrames.length === 0) return []

  // ── Phase 2: モード平滑化（スライディングウィンドウで最頻値を取る）────────
  // ランダムなノイズフレームを除去し、支配的な音程を残す
  const smoothed: Frame[] = []
  for (let i = 0; i < validFrames.length; i++) {
    const lo = Math.max(0, i - Math.floor(SMOOTH_WINDOW / 2))
    const hi = Math.min(validFrames.length, lo + SMOOTH_WINDOW)
    const window = validFrames.slice(lo, hi).map(f => f.midi)
    smoothed.push({ time: validFrames[i].time, midi: modeOf(window) })
  }

  // ── Phase 3: プラトー検出（同じ MIDI 音が連続するランをまとめる）──────────
  const notes: DetectedNote[] = []
  let runStart = 0

  const commitRun = (endIdx: number) => {
    const run = smoothed.slice(runStart, endIdx)
    if (run.length < MIN_NOTE_FRAMES) return

    // ランの中で最頻の MIDI を音符のピッチとする
    const midi = modeOf(run.map(f => f.midi))
    const startTime = run[0].time
    const rawDuration = run[run.length - 1].time - startTime + (1 / HOP_FPS)
    const duration = quantizeDuration(rawDuration, bpm)

    notes.push({ name: midiToNoteName(midi), midi, time: startTime, duration })
  }

  for (let i = 1; i < smoothed.length; i++) {
    const isGap = smoothed[i].time - smoothed[i - 1].time > (2 / HOP_FPS)  // 無音ギャップ
    const isPitchChange = Math.abs(smoothed[i].midi - smoothed[i - 1].midi) > NOTE_SNAP_SEMITONES * 2

    if (isGap || isPitchChange) {
      commitRun(i)
      runStart = i
    }
  }
  commitRun(smoothed.length)

  return notes
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useAudioRecorder(bpm: number) {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [countdownBeat, setCountdownBeat] = useState(0)
  const [notes, setNotes] = useState<DetectedNote[]>([])
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null)
  const stopMetronomeRef = useRef<(() => void) | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const pcmChunksRef = useRef<Float32Array[]>([])
  const prevUrlRef = useRef<string | null>(null)
  const abortedRef = useRef(false)
  const sampleRateRef = useRef(44100)
  const bpmRef = useRef(bpm)
  useEffect(() => { bpmRef.current = bpm }, [bpm])

  useEffect(() => {
    return () => { if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current) }
  }, [])

  const startRecording = useCallback(async () => {
    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current)
      prevUrlRef.current = null
      setRecordedAudioUrl(null)
    }
    setNotes([])
    abortedRef.current = false

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    })
    streamRef.current = stream

    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx
    sampleRateRef.current = audioCtx.sampleRate
    if (audioCtx.state === 'suspended') await audioCtx.resume()

    // PCM キャプチャチェーン（スピーカーには出さない）
    const source = audioCtx.createMediaStreamSource(stream)
    const highpass = audioCtx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 70
    const micGain = audioCtx.createGain()
    micGain.gain.value = 4.0
    const scriptNode = audioCtx.createScriptProcessor(2048, 1, 1)
    scriptNodeRef.current = scriptNode
    pcmChunksRef.current = []
    const silentGain = audioCtx.createGain()
    silentGain.gain.value = 0

    let capturing = false
    scriptNode.onaudioprocess = (e) => {
      if (!capturing) return
      pcmChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }

    source.connect(highpass)
    highpass.connect(micGain)
    micGain.connect(scriptNode)
    scriptNode.connect(silentGain)
    silentGain.connect(audioCtx.destination)

    // カウントダウン（AudioContext warm-up 後に 0.3s 余裕を持たせる）
    const WARMUP = 0.3
    const beatDuration = 60 / bpm
    const countdownStart = audioCtx.currentTime + WARMUP

    setRecordingState('countdown')
    setCountdownBeat(0)
    await scheduleCountdown(audioCtx, bpm, 4, countdownStart, (beat) => setCountdownBeat(beat))
    setCountdownBeat(0)

    if (abortedRef.current) {
      scriptNode.disconnect(); source.disconnect()
      stream.getTracks().forEach(t => t.stop()); audioCtx.close()
      setRecordingState('idle'); return
    }

    // 録音開始
    capturing = true
    const recordingStart = countdownStart + 4 * beatDuration
    stopMetronomeRef.current = startMetronome(audioCtx, bpm, recordingStart)

    audioChunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
    const mr = new MediaRecorder(stream, { mimeType })
    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
    mr.onstop = async () => {
      const blob = new Blob(audioChunksRef.current, { type: mimeType })
      const url = URL.createObjectURL(blob)
      prevUrlRef.current = url
      setRecordedAudioUrl(url)

      setRecordingState('analyzing')
      try {
        const totalLen = pcmChunksRef.current.reduce((s, c) => s + c.length, 0)
        const pcm = new Float32Array(totalLen)
        let ofs = 0
        for (const c of pcmChunksRef.current) { pcm.set(c, ofs); ofs += c.length }
        setNotes(analyzePCM(pcm, sampleRateRef.current, bpmRef.current))
      } catch (err) {
        console.error('音声解析エラー:', err)
      } finally {
        setRecordingState('idle')
      }
    }
    mr.start(100)
    mediaRecorderRef.current = mr
    setRecordingState('recording')
  }, [bpm])

  const stopRecording = useCallback(() => {
    abortedRef.current = true
    stopMetronomeRef.current?.(); stopMetronomeRef.current = null
    scriptNodeRef.current?.disconnect(); scriptNodeRef.current = null

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    } else {
      streamRef.current?.getTracks().forEach(t => t.stop())
      audioCtxRef.current?.close()
      setRecordingState('idle')
    }
    mediaRecorderRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close()
    streamRef.current = null; audioCtxRef.current = null
  }, [])

  return {
    recordingState,
    isRecording: recordingState === 'recording',
    isCountingDown: recordingState === 'countdown',
    isAnalyzing: recordingState === 'analyzing',
    countdownBeat,
    notes,
    recordedAudioUrl,
    startRecording,
    stopRecording,
  }
}
