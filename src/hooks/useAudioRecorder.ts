import { useRef, useState, useCallback, useEffect } from 'react'
import { PitchDetector } from 'pitchy'

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

function medianMidi(buf: number[]): number {
  const sorted = [...buf].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function scheduleCountdown(
  ctx: AudioContext,
  bpm: number,
  beats: number,
  onBeat: (beat: number) => void,
): Promise<void> {
  const beatDuration = 60 / bpm
  const now = ctx.currentTime + 0.1

  for (let i = 0; i < beats; i++) {
    const t = now + i * beatDuration
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'square'
    osc.frequency.value = i === 0 ? 880 : 660
    gain.gain.setValueAtTime(0.5, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07)
    osc.start(t)
    osc.stop(t + 0.08)
    setTimeout(() => onBeat(i + 1), (t - ctx.currentTime) * 1000)
  }

  return new Promise(resolve =>
    setTimeout(resolve, (now + beats * beatDuration - ctx.currentTime) * 1000),
  )
}

// ─── オフライン音声解析 ──────────────────────────────────────────────────────

const WINDOW_SIZE = 4096
const SMOOTH_FRAMES = 7
const CLARITY_THRESHOLD = 0.76
const NOTE_CHANGE_SEMITONES = 1.5
const MIN_NOTE_DURATION = 0.10

async function preprocessAudio(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  const arrayBuffer = await blob.arrayBuffer()

  // まずデコードして実際のサンプルレートを取得
  const tmpCtx = new AudioContext()
  let srcBuffer: AudioBuffer
  try {
    srcBuffer = await tmpCtx.decodeAudioData(arrayBuffer)
  } finally {
    tmpCtx.close()
  }

  const { sampleRate, length } = srcBuffer

  // OfflineAudioContext で前処理（ハイパス + コンプレッサー + ゲイン）
  const offCtx = new OfflineAudioContext(1, length, sampleRate)

  const source = offCtx.createBufferSource()
  source.buffer = srcBuffer

  const highpass = offCtx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 70

  const compressor = offCtx.createDynamicsCompressor()
  compressor.threshold.value = -40
  compressor.knee.value = 20
  compressor.ratio.value = 12
  compressor.attack.value = 0.003
  compressor.release.value = 0.25

  const gainNode = offCtx.createGain()
  gainNode.gain.value = 4.0

  source.connect(highpass)
  highpass.connect(compressor)
  compressor.connect(gainNode)
  gainNode.connect(offCtx.destination)
  source.start(0)

  const rendered = await offCtx.startRendering()
  return { samples: rendered.getChannelData(0), sampleRate }
}

async function analyzeAudioBlob(blob: Blob): Promise<DetectedNote[]> {
  const { samples, sampleRate } = await preprocessAudio(blob)

  const detector = PitchDetector.forFloat32Array(WINDOW_SIZE)
  // ~80フレーム/秒の解析密度
  const hopSize = Math.floor(sampleRate / 80)

  const pitchBuf: number[] = []
  const notes: DetectedNote[] = []
  let pending: { midi: number; startTime: number } | null = null

  const commitNote = (midi: number, startTime: number, endTime: number) => {
    const duration = endTime - startTime
    if (duration >= MIN_NOTE_DURATION) {
      notes.push({ name: midiToNoteName(midi), midi, time: startTime, duration })
    }
  }

  for (let i = 0; i + WINDOW_SIZE < samples.length; i += hopSize) {
    const window = samples.slice(i, i + WINDOW_SIZE)
    const [pitch, clarity] = detector.findPitch(window, sampleRate)
    const time = i / sampleRate

    if (clarity > CLARITY_THRESHOLD && pitch > 70 && pitch < 1400) {
      pitchBuf.push(freqToMidi(pitch))
      if (pitchBuf.length > SMOOTH_FRAMES) pitchBuf.shift()
      const midi = medianMidi(pitchBuf)

      if (!pending) {
        pending = { midi, startTime: time }
      } else if (Math.abs(midi - pending.midi) > NOTE_CHANGE_SEMITONES) {
        commitNote(pending.midi, pending.startTime, time)
        pending = { midi, startTime: time }
      }
    } else {
      pitchBuf.length = 0
      if (pending) {
        commitNote(pending.midi, pending.startTime, time)
        pending = null
      }
    }
  }

  if (pending) {
    commitNote(pending.midi, pending.startTime, samples.length / sampleRate)
  }

  return notes
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useAudioRecorder(bpm: number) {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [countdownBeat, setCountdownBeat] = useState(0)
  const [notes, setNotes] = useState<DetectedNote[]>([])
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const prevUrlRef = useRef<string | null>(null)
  const abortedRef = useRef(false)   // カウントダウン中に停止された場合のフラグ

  useEffect(() => {
    return () => { if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current) }
  }, [])

  const startRecording = useCallback(async () => {
    // 前回録音をクリア
    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current)
      prevUrlRef.current = null
      setRecordedAudioUrl(null)
    }
    setNotes([])
    abortedRef.current = false

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    streamRef.current = stream

    // ── カウントダウン ───────────────────────────────────────
    const clickCtx = new AudioContext()
    setRecordingState('countdown')
    setCountdownBeat(0)
    await scheduleCountdown(clickCtx, bpm, 4, (beat) => setCountdownBeat(beat))
    clickCtx.close()
    setCountdownBeat(0)

    if (abortedRef.current) {
      // 停止ボタンが押された場合はここで終了
      stream.getTracks().forEach(t => t.stop())
      setRecordingState('idle')
      return
    }

    // ── 録音開始（MediaRecorder のみ。リアルタイム検出は行わない）──
    audioChunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
    const mr = new MediaRecorder(stream, { mimeType })

    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }

    mr.onstop = async () => {
      // Blob URL を生成（オリジナル再生用）
      const blob = new Blob(audioChunksRef.current, { type: mimeType })
      const url = URL.createObjectURL(blob)
      prevUrlRef.current = url
      setRecordedAudioUrl(url)

      // ── オフライン解析 ────────────────────────────────────
      setRecordingState('analyzing')
      try {
        const detected = await analyzeAudioBlob(blob)
        setNotes(detected)
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
    abortedRef.current = true   // カウントダウン中でも止められる

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()   // onstop で解析が始まる
    } else {
      // まだ MediaRecorder が始まっていない（カウントダウン中など）
      streamRef.current?.getTracks().forEach(t => t.stop())
      setRecordingState('idle')
    }
    mediaRecorderRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
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
