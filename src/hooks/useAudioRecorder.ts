import { useRef, useState, useCallback, useEffect } from 'react'
import { PitchDetector } from 'pitchy'

export type DetectedNote = {
  name: string
  midi: number
  time: number
  duration: number
}

export type RecordingState = 'idle' | 'countdown' | 'recording'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function freqToMidi(freq: number): number {
  return Math.round(12 * Math.log2(freq / 440) + 69)
}

function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1
  const note = NOTE_NAMES[midi % 12]
  return `${note}${octave}`
}

function medianMidi(buf: number[]): number {
  const sorted = [...buf].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// カウントダウン用クリック音を Web Audio でスケジュール
// 終了後に resolve する Promise を返す
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
    const isFirst = i === 0

    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'square'
    osc.frequency.value = isFirst ? 880 : 660
    gain.gain.setValueAtTime(0.5, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07)
    osc.start(t)
    osc.stop(t + 0.08)

    // UI 更新は setTimeout で同期させる
    const delay = (t - ctx.currentTime) * 1000
    setTimeout(() => onBeat(i + 1), delay)
  }

  return new Promise(resolve =>
    setTimeout(resolve, (now + beats * beatDuration - ctx.currentTime) * 1000),
  )
}

const SMOOTH_FRAMES = 5
const CLARITY_THRESHOLD = 0.78
const NOTE_CHANGE_SEMITONES = 1.5
const MIN_NOTE_DURATION = 0.10

export function useAudioRecorder(bpm: number) {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [countdownBeat, setCountdownBeat] = useState(0)
  const [notes, setNotes] = useState<DetectedNote[]>([])
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)
  const pendingRef = useRef<{ midi: number; startTime: number } | null>(null)
  const collectedRef = useRef<DetectedNote[]>([])
  const pitchBufRef = useRef<number[]>([])
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const prevUrlRef = useRef<string | null>(null)

  // アンマウント時に Blob URL を解放
  useEffect(() => {
    return () => {
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current)
    }
  }, [])

  const stopDetection = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startRecording = useCallback(async () => {
    // 前回の録音 URL を破棄
    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current)
      prevUrlRef.current = null
      setRecordedAudioUrl(null)
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    streamRef.current = stream

    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx

    // ── カウントダウン ──────────────────────────────
    setRecordingState('countdown')
    setCountdownBeat(0)
    await scheduleCountdown(audioCtx, bpm, 4, (beat) => setCountdownBeat(beat))
    setCountdownBeat(0)

    // ── 録音開始 ────────────────────────────────────
    // MediaRecorder でオリジナル音声を録音
    audioChunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
    const mr = new MediaRecorder(stream, { mimeType })
    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
    mr.onstop = () => {
      const blob = new Blob(audioChunksRef.current, { type: mimeType })
      const url = URL.createObjectURL(blob)
      prevUrlRef.current = url
      setRecordedAudioUrl(url)
    }
    mr.start(100)
    mediaRecorderRef.current = mr

    // ピッチ検出チェーン
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 4096
    analyser.smoothingTimeConstant = 0.3

    const compressor = audioCtx.createDynamicsCompressor()
    compressor.threshold.value = -40
    compressor.knee.value = 20
    compressor.ratio.value = 12
    compressor.attack.value = 0.003
    compressor.release.value = 0.25

    const inputGain = audioCtx.createGain()
    inputGain.gain.value = 3.0

    const highpass = audioCtx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 70

    const source = audioCtx.createMediaStreamSource(stream)
    source.connect(highpass)
    highpass.connect(compressor)
    compressor.connect(inputGain)
    inputGain.connect(analyser)

    const detector = PitchDetector.forFloat32Array(analyser.fftSize)
    const input = new Float32Array(detector.inputLength)

    startTimeRef.current = audioCtx.currentTime
    collectedRef.current = []
    pendingRef.current = null
    pitchBufRef.current = []
    setNotes([])
    setRecordingState('recording')

    const commitNote = (midi: number, startTime: number, endTime: number) => {
      const duration = endTime - startTime
      if (duration < MIN_NOTE_DURATION) return
      const note: DetectedNote = { name: midiToNoteName(midi), midi, time: startTime, duration }
      collectedRef.current = [...collectedRef.current, note]
      setNotes([...collectedRef.current])
    }

    const tick = () => {
      analyser.getFloatTimeDomainData(input)
      const [pitch, clarity] = detector.findPitch(input, audioCtx.sampleRate)
      const now = audioCtx.currentTime - startTimeRef.current

      if (clarity > CLARITY_THRESHOLD && pitch > 70 && pitch < 1400) {
        const rawMidi = freqToMidi(pitch)
        pitchBufRef.current.push(rawMidi)
        if (pitchBufRef.current.length > SMOOTH_FRAMES) pitchBufRef.current.shift()
        const midi = medianMidi(pitchBufRef.current)

        const pending = pendingRef.current
        if (!pending) {
          pendingRef.current = { midi, startTime: now }
        } else if (Math.abs(midi - pending.midi) > NOTE_CHANGE_SEMITONES) {
          commitNote(pending.midi, pending.startTime, now)
          pendingRef.current = { midi, startTime: now }
        }
      } else {
        pitchBufRef.current = []
        const pending = pendingRef.current
        if (pending) {
          commitNote(pending.midi, pending.startTime, now)
          pendingRef.current = null
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [bpm])

  const stopRecording = useCallback(() => {
    stopDetection()

    if (pendingRef.current && audioCtxRef.current) {
      const now = audioCtxRef.current.currentTime - startTimeRef.current
      const duration = now - pendingRef.current.startTime
      if (duration >= MIN_NOTE_DURATION) {
        const note: DetectedNote = {
          name: midiToNoteName(pendingRef.current.midi),
          midi: pendingRef.current.midi,
          time: pendingRef.current.startTime,
          duration,
        }
        collectedRef.current = [...collectedRef.current, note]
        setNotes([...collectedRef.current])
      }
      pendingRef.current = null
    }

    mediaRecorderRef.current?.stop()
    mediaRecorderRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close()
    setRecordingState('idle')
  }, [stopDetection])

  const isRecording = recordingState === 'recording'
  const isCountingDown = recordingState === 'countdown'

  return {
    recordingState,
    isRecording,
    isCountingDown,
    countdownBeat,
    notes,
    recordedAudioUrl,
    startRecording,
    stopRecording,
  }
}
