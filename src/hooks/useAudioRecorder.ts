import { useRef, useState, useCallback } from 'react'
import { PitchDetector } from 'pitchy'

export type DetectedNote = {
  name: string
  midi: number
  time: number
  duration: number
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function freqToMidi(freq: number): number {
  return Math.round(12 * Math.log2(freq / 440) + 69)
}

function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1
  const note = NOTE_NAMES[midi % 12]
  return `${note}${octave}`
}

// 直近 N フレームの MIDI 値の中央値を返す（ノイズ除去）
function medianMidi(buf: number[]): number {
  const sorted = [...buf].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const SMOOTH_FRAMES = 5       // 中央値を取るフレーム数
const CLARITY_THRESHOLD = 0.78 // 0.85→0.78 に下げて鼻歌の弱い音も拾う
const NOTE_CHANGE_SEMITONES = 1.5 // 音程変化の閾値（半音）
const MIN_NOTE_DURATION = 0.10    // 最短音符長（秒）

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [notes, setNotes] = useState<DetectedNote[]>([])

  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)

  const pendingRef = useRef<{ midi: number; startTime: number } | null>(null)
  const collectedRef = useRef<DetectedNote[]>([])
  const pitchBufRef = useRef<number[]>([])   // 直近フレームのピッチバッファ

  const stopDetection = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startRecording = useCallback(async () => {
    // echoCancellation / noiseSuppression を明示的に制御
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,  // マイク入力を自動増幅
      },
    })
    streamRef.current = stream

    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx

    // fftSize を 4096 に拡大 → 低音域の周波数分解能が 2 倍に向上
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 4096
    analyser.smoothingTimeConstant = 0.3  // 時間方向のスムージング

    // 入力コンプレッサー: 小さい鼻歌でも一定レベルまで持ち上げる
    const compressor = audioCtx.createDynamicsCompressor()
    compressor.threshold.value = -40  // dB: これ以下の音も検出対象
    compressor.knee.value = 20
    compressor.ratio.value = 12
    compressor.attack.value = 0.003
    compressor.release.value = 0.25

    // 入力ゲイン: さらに増幅
    const inputGain = audioCtx.createGain()
    inputGain.gain.value = 3.0

    // ハイパスフィルター: 低周波ノイズ（空調など）をカット
    const highpass = audioCtx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 70  // 70Hz 以下をカット

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
    setIsRecording(true)

    const commitNote = (midi: number, startTime: number, endTime: number) => {
      const duration = endTime - startTime
      if (duration < MIN_NOTE_DURATION) return
      const note: DetectedNote = {
        name: midiToNoteName(midi),
        midi,
        time: startTime,
        duration,
      }
      collectedRef.current = [...collectedRef.current, note]
      setNotes([...collectedRef.current])
    }

    const tick = () => {
      analyser.getFloatTimeDomainData(input)
      const [pitch, clarity] = detector.findPitch(input, audioCtx.sampleRate)
      const now = audioCtx.currentTime - startTimeRef.current

      if (clarity > CLARITY_THRESHOLD && pitch > 70 && pitch < 1400) {
        const rawMidi = freqToMidi(pitch)

        // ピッチバッファに追加して中央値で安定化
        pitchBufRef.current.push(rawMidi)
        if (pitchBufRef.current.length > SMOOTH_FRAMES) {
          pitchBufRef.current.shift()
        }
        const midi = medianMidi(pitchBufRef.current)

        const pending = pendingRef.current
        if (!pending) {
          pendingRef.current = { midi, startTime: now }
        } else if (Math.abs(midi - pending.midi) > NOTE_CHANGE_SEMITONES) {
          commitNote(pending.midi, pending.startTime, now)
          pendingRef.current = { midi, startTime: now }
        }
      } else {
        // 無声区間: バッファをリセット
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
  }, [])

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

    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close()
    setIsRecording(false)
  }, [stopDetection])

  return { isRecording, notes, startRecording, stopRecording }
}
