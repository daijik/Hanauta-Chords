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

// ─── クリック音を1発スケジュール ─────────────────────────────────────────────

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

// ─── カウントダウン ──────────────────────────────────────────────────────────
// startTime: AudioContext 上の絶対時刻（ctx.currentTime + 余裕）

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
    // UI の拍表示は setTimeout で同期（Web Audio は別スレッドのため）
    setTimeout(() => onBeat(i + 1), Math.max(0, (t - ctx.currentTime) * 1000))
  }
  // カウントダウン完了まで await
  const endTime = startTime + beats * beatDuration
  return new Promise(resolve =>
    setTimeout(resolve, Math.max(0, (endTime - ctx.currentTime) * 1000)),
  )
}

// ─── 録音中メトロノーム（look-ahead スケジューラー）──────────────────────────
// 精密なタイミングのため「少し先を先読みして予約」を繰り返す方式

const METRONOME_LOOKAHEAD = 0.4   // 秒: この分だけ先にスケジュール
const METRONOME_INTERVAL = 150    // ms: スケジューラーの呼び出し間隔

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

  schedule()  // 初回は即実行
  const id = setInterval(schedule, METRONOME_INTERVAL)
  return () => clearInterval(id)
}

// ─── PCM 解析 ────────────────────────────────────────────────────────────────

const ANALYSIS_WINDOW = 4096
const HOP_DIVISOR = 80
const CLARITY_THRESHOLD = 0.88
const MIN_FREQ_HZ = 85
const MAX_FREQ_HZ = 600
const SMOOTH_FRAMES = 11
const ONSET_FRAMES = 4
const NOTE_CHANGE_SEMITONES = 1.0
const MIN_NOTE_SEC = 0.18
const RMS_NOISE_GATE = 0.008

function rms(buf: Float32Array): number {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

function medianOf(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function octaveCorrect(midi: number, prevMidi: number | null): number {
  if (midi > 76 && (prevMidi === null || midi - prevMidi > 10)) return midi - 12
  if (midi < 45 && (prevMidi === null || prevMidi - midi > 10)) return midi + 12
  return midi
}

type NoteState = 'silent' | 'onset' | 'stable'

function analyzePCM(samples: Float32Array, sampleRate: number): DetectedNote[] {
  const detector = PitchDetector.forFloat32Array(ANALYSIS_WINDOW)
  const hopSize = Math.floor(sampleRate / HOP_DIVISOR)
  const notes: DetectedNote[] = []

  let state: NoteState = 'silent'
  let onsetCount = 0
  let pitchBuf: number[] = []
  let currentMidi = 0
  let noteStart = 0
  let prevCommittedMidi: number | null = null

  const commit = (midi: number, start: number, end: number) => {
    if (end - start >= MIN_NOTE_SEC) {
      notes.push({ name: midiToNoteName(midi), midi, time: start, duration: end - start })
      prevCommittedMidi = midi
    }
  }

  for (let i = 0; i + ANALYSIS_WINDOW < samples.length; i += hopSize) {
    const window = samples.slice(i, i + ANALYSIS_WINDOW)
    const time = i / sampleRate
    const frameRms = rms(window)

    if (frameRms < RMS_NOISE_GATE) {
      if (state === 'stable') commit(currentMidi, noteStart, time)
      state = 'silent'; onsetCount = 0; pitchBuf = []
      continue
    }

    const [rawFreq, clarity] = detector.findPitch(window, sampleRate)
    if (clarity < CLARITY_THRESHOLD || rawFreq < MIN_FREQ_HZ || rawFreq > MAX_FREQ_HZ) {
      if (state === 'stable') commit(currentMidi, noteStart, time)
      state = 'silent'; onsetCount = 0; pitchBuf = []
      continue
    }

    const rawMidi = freqToMidi(rawFreq)
    const midi = octaveCorrect(rawMidi, prevCommittedMidi ?? (pitchBuf.length > 0 ? medianOf(pitchBuf) : null))
    pitchBuf.push(midi)
    if (pitchBuf.length > SMOOTH_FRAMES) pitchBuf.shift()
    const smoothMidi = medianOf(pitchBuf)

    switch (state) {
      case 'silent':
        state = 'onset'; onsetCount = 1; currentMidi = smoothMidi; noteStart = time
        break
      case 'onset':
        if (Math.abs(smoothMidi - currentMidi) <= NOTE_CHANGE_SEMITONES) {
          currentMidi = smoothMidi
          if (++onsetCount >= ONSET_FRAMES) state = 'stable'
        } else {
          state = 'onset'; onsetCount = 1; currentMidi = smoothMidi; noteStart = time
        }
        break
      case 'stable':
        if (Math.abs(smoothMidi - currentMidi) > NOTE_CHANGE_SEMITONES) {
          commit(currentMidi, noteStart, time)
          state = 'onset'; onsetCount = 1; currentMidi = smoothMidi
          noteStart = time; pitchBuf = [midi]
        } else {
          currentMidi = smoothMidi
        }
        break
    }
  }

  if (state === 'stable') commit(currentMidi, noteStart, samples.length / sampleRate)
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

    // ── AudioContext を1つだけ作成し、カウントダウン〜録音〜メトロノームを通して使う ──
    // ※ 別 AudioContext を使うと起動遅延で1クリック目が消えるため統一する
    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx
    sampleRateRef.current = audioCtx.sampleRate

    // AudioContext が suspended 状態なら resume して確実に動作させる
    if (audioCtx.state === 'suspended') await audioCtx.resume()

    // ScriptProcessorNode を先にセットアップ（PCM キャプチャ）
    const source = audioCtx.createMediaStreamSource(stream)
    const highpass = audioCtx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 70

    const micGain = audioCtx.createGain()
    micGain.gain.value = 4.0

    const scriptNode = audioCtx.createScriptProcessor(2048, 1, 1)
    scriptNodeRef.current = scriptNode
    pcmChunksRef.current = []
    // PCM 収集は録音開始後に有効化するためフラグで制御
    let capturing = false
    scriptNode.onaudioprocess = (e) => {
      if (!capturing) return
      pcmChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }

    const silentGain = audioCtx.createGain()
    silentGain.gain.value = 0

    source.connect(highpass)
    highpass.connect(micGain)
    micGain.connect(scriptNode)
    scriptNode.connect(silentGain)
    silentGain.connect(audioCtx.destination)

    // ── カウントダウン ────────────────────────────────────────────
    // AudioContext が十分 warm になるよう 0.3 秒の余裕を持たせる
    const WARMUP = 0.3
    const beatDuration = 60 / bpm
    const countdownStart = audioCtx.currentTime + WARMUP

    setRecordingState('countdown')
    setCountdownBeat(0)
    await scheduleCountdown(audioCtx, bpm, 4, countdownStart, (beat) => setCountdownBeat(beat))
    setCountdownBeat(0)

    if (abortedRef.current) {
      scriptNode.disconnect()
      source.disconnect()
      stream.getTracks().forEach(t => t.stop())
      audioCtx.close()
      setRecordingState('idle')
      return
    }

    // ── 録音開始（PCM キャプチャ ON）──────────────────────────────
    capturing = true

    // カウントダウン終了直後からメトロノーム開始（グリッドを繋げる）
    const recordingStart = countdownStart + 4 * beatDuration
    const stopMetronome = startMetronome(audioCtx, bpm, recordingStart)
    stopMetronomeRef.current = stopMetronome

    // MediaRecorder（再生用）
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
        for (const chunk of pcmChunksRef.current) { pcm.set(chunk, ofs); ofs += chunk.length }
        setNotes(analyzePCM(pcm, sampleRateRef.current))
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

    // メトロノームを止める
    stopMetronomeRef.current?.()
    stopMetronomeRef.current = null

    scriptNodeRef.current?.disconnect()
    scriptNodeRef.current = null

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()   // onstop → 解析へ
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
