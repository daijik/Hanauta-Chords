import { useRef, useState, useCallback } from 'react'
import { PitchDetector } from 'pitchy'

export type DetectedNote = {
  name: string    // e.g. "C4"
  midi: number    // MIDI note number
  time: number    // seconds from start
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

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [notes, setNotes] = useState<DetectedNote[]>([])

  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)

  const pendingRef = useRef<{ midi: number; startTime: number } | null>(null)
  const collectedRef = useRef<DetectedNote[]>([])

  const stopDetection = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startRecording = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    streamRef.current = stream

    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx

    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048
    analyserRef.current = analyser

    const source = audioCtx.createMediaStreamSource(stream)
    source.connect(analyser)

    const detector = PitchDetector.forFloat32Array(analyser.fftSize)
    const input = new Float32Array(detector.inputLength)

    startTimeRef.current = audioCtx.currentTime
    collectedRef.current = []
    pendingRef.current = null
    setNotes([])
    setIsRecording(true)

    const CLARITY_THRESHOLD = 0.85
    const SILENCE_MIDI_CHANGE = 2
    const MIN_NOTE_DURATION = 0.12

    const tick = () => {
      analyser.getFloatTimeDomainData(input)
      const [pitch, clarity] = detector.findPitch(input, audioCtx.sampleRate)
      const now = audioCtx.currentTime - startTimeRef.current

      if (clarity > CLARITY_THRESHOLD && pitch > 80 && pitch < 1200) {
        const midi = freqToMidi(pitch)
        const pending = pendingRef.current

        if (!pending) {
          pendingRef.current = { midi, startTime: now }
        } else if (Math.abs(midi - pending.midi) > SILENCE_MIDI_CHANGE) {
          const duration = now - pending.startTime
          if (duration >= MIN_NOTE_DURATION) {
            const note: DetectedNote = {
              name: midiToNoteName(pending.midi),
              midi: pending.midi,
              time: pending.startTime,
              duration,
            }
            collectedRef.current = [...collectedRef.current, note]
            setNotes([...collectedRef.current])
          }
          pendingRef.current = { midi, startTime: now }
        }
      } else {
        const pending = pendingRef.current
        if (pending) {
          const duration = now - pending.startTime
          if (duration >= MIN_NOTE_DURATION) {
            const note: DetectedNote = {
              name: midiToNoteName(pending.midi),
              midi: pending.midi,
              time: pending.startTime,
              duration,
            }
            collectedRef.current = [...collectedRef.current, note]
            setNotes([...collectedRef.current])
          }
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
      if (duration >= 0.12) {
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
