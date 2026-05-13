import { useRef, useState, useCallback, useEffect } from 'react'
import { detectPitchWithML } from '../lib/pitchDetection'

export type DetectedNote = {
  name: string
  midi: number
  time: number
  duration: number
}

export type RecordingState = 'idle' | 'countdown' | 'recording' | 'analyzing'

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


// ─── Hook ───────────────────────────────────────────────────────────────────

export function useAudioRecorder(bpm: number) {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [countdownBeat, setCountdownBeat] = useState(0)
  const [notes, setNotes] = useState<DetectedNote[]>([])
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const stopMetronomeRef = useRef<(() => void) | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const prevUrlRef = useRef<string | null>(null)
  const abortedRef = useRef(false)
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
      audio: true,  // ブラウザのデフォルトに委ねるのが最も自然な音質になる
    })
    streamRef.current = stream

    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx
    if (audioCtx.state === 'suspended') await audioCtx.resume()

    // カウントダウン
    const WARMUP = 0.3
    const beatDuration = 60 / bpm
    const countdownStart = audioCtx.currentTime + WARMUP

    setRecordingState('countdown')
    setCountdownBeat(0)
    await scheduleCountdown(audioCtx, bpm, 4, countdownStart, (beat) => setCountdownBeat(beat))
    setCountdownBeat(0)

    if (abortedRef.current) {
      stream.getTracks().forEach(t => t.stop())
      audioCtx.close()
      setRecordingState('idle')
      return
    }

    // 録音開始
    const recordingStart = countdownStart + 4 * beatDuration
    stopMetronomeRef.current = startMetronome(audioCtx, bpm, recordingStart)

    audioChunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
    const mr = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128000 })
    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
    mr.onstop = async () => {
      const blob = new Blob(audioChunksRef.current, { type: mimeType })
      const url = URL.createObjectURL(blob)
      prevUrlRef.current = url
      setRecordedAudioUrl(url)

      // Python API で解析
      setRecordingState('analyzing')
      try {
        const detected = await detectPitchWithML(blob, bpmRef.current)
        setNotes(detected)
      } catch (err) {
        console.error('解析エラー:', err)
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
    stopMetronomeRef.current?.()
    stopMetronomeRef.current = null

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
    streamRef.current = null
    audioCtxRef.current = null
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
