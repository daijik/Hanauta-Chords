import { useRef, useState, useCallback, useEffect } from 'react'

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

// ─── Blob → WAV 変換 ────────────────────────────────────────────────────────
// MediaRecorder は webm/ogg (lossy) で録音するが、Python 側は WAV を期待する。
// AudioContext でデコードして Int16 WAV に再エンコードしてから送信する。

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numCh = 1
  const bps = 16
  const blockAlign = numCh * (bps / 8)
  const dataSize = samples.length * blockAlign
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const s = (off: number, str: string) =>
    [...str].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)))
  s(0, 'RIFF');  v.setUint32(4, 36 + dataSize, true)
  s(8, 'WAVE'); s(12, 'fmt ')
  v.setUint32(16, 16, true);       v.setUint16(20, 1, true)  // PCM
  v.setUint16(22, numCh, true);    v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * blockAlign, true)
  v.setUint16(32, blockAlign, true); v.setUint16(34, bps, true)
  s(36, 'data'); v.setUint32(40, dataSize, true)
  const out = new Int16Array(buf, 44)
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)))
  }
  return new Blob([buf], { type: 'audio/wav' })
}

async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer()
  const ctx = new AudioContext()
  let audioBuffer: AudioBuffer
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer)
  } finally {
    ctx.close()
  }
  return encodeWav(audioBuffer.getChannelData(0), audioBuffer.sampleRate)
}

// ─── Python API 呼び出し ─────────────────────────────────────────────────────

async function analyzeWithPython(blob: Blob, bpm: number): Promise<DetectedNote[]> {
  const wavBlob = await blobToWav(blob)
  const res = await fetch(`/api/analyze?bpm=${bpm}`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wavBlob,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? res.statusText)
  }
  return res.json()
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
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
    const mr = new MediaRecorder(stream, { mimeType })
    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
    mr.onstop = async () => {
      const blob = new Blob(audioChunksRef.current, { type: mimeType })
      const url = URL.createObjectURL(blob)
      prevUrlRef.current = url
      setRecordedAudioUrl(url)

      // Python API で解析
      setRecordingState('analyzing')
      try {
        const detected = await analyzeWithPython(blob, bpmRef.current)
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
