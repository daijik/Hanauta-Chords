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

// ─── カウントダウン ──────────────────────────────────────────────────────────

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

// ─── PCM 解析（メインロジック）──────────────────────────────────────────────

const ANALYSIS_WINDOW = 4096   // pitchy に渡すウィンドウサイズ（大きいほど低音域精度↑）
const HOP_DIVISOR = 80         // フレームレート(fps)
const CLARITY_THRESHOLD = 0.88 // 高めにして確信度の高いフレームだけ使う
const MIN_FREQ_HZ = 85         // 鼻歌の最低域（E2 付近）
const MAX_FREQ_HZ = 600        // 鼻歌の最高域（D5 付近）
const SMOOTH_FRAMES = 11       // 中央値を取るフレーム数
const ONSET_FRAMES = 4         // 音符とみなすまでの連続フレーム数
const NOTE_CHANGE_SEMITONES = 1.0  // 音程変化の閾値
const MIN_NOTE_SEC = 0.18      // 最短音符長（秒）
const RMS_NOISE_GATE = 0.008   // RMS がこれ以下は無音と判断

function rms(buf: Float32Array): number {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

function medianOf(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// オクターブ誤検出補正
// 鼻歌の音域を逸脱していたら 12 半音ずらして戻す
function octaveCorrect(midi: number, prevMidi: number | null): number {
  // 高すぎる → 1オクターブ下げる
  if (midi > 76 && (prevMidi === null || midi - prevMidi > 10)) return midi - 12
  // 低すぎる → 1オクターブ上げる
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
      // ── 無音区間 ────────────────────────────────────────────
      if (state === 'stable') commit(currentMidi, noteStart, time)
      state = 'silent'
      onsetCount = 0
      pitchBuf = []
      continue
    }

    const [rawFreq, clarity] = detector.findPitch(window, sampleRate)

    if (clarity < CLARITY_THRESHOLD || rawFreq < MIN_FREQ_HZ || rawFreq > MAX_FREQ_HZ) {
      // 確信度不足 or 音域外
      if (state === 'stable') commit(currentMidi, noteStart, time)
      state = 'silent'
      onsetCount = 0
      pitchBuf = []
      continue
    }

    const rawMidi = freqToMidi(rawFreq)
    const midi = octaveCorrect(rawMidi, prevCommittedMidi ?? (pitchBuf.length > 0 ? medianOf(pitchBuf) : null))

    pitchBuf.push(midi)
    if (pitchBuf.length > SMOOTH_FRAMES) pitchBuf.shift()
    const smoothMidi = medianOf(pitchBuf)

    switch (state) {
      case 'silent':
        state = 'onset'
        onsetCount = 1
        currentMidi = smoothMidi
        noteStart = time
        break

      case 'onset':
        if (Math.abs(smoothMidi - currentMidi) <= NOTE_CHANGE_SEMITONES) {
          onsetCount++
          currentMidi = smoothMidi
          if (onsetCount >= ONSET_FRAMES) state = 'stable'
        } else {
          // onset 中に音程がブレた → リセット
          state = 'onset'
          onsetCount = 1
          currentMidi = smoothMidi
          noteStart = time
        }
        break

      case 'stable':
        if (Math.abs(smoothMidi - currentMidi) > NOTE_CHANGE_SEMITONES) {
          // 音程変化 → 前の音符を確定して新しい onset へ
          commit(currentMidi, noteStart, time)
          state = 'onset'
          onsetCount = 1
          currentMidi = smoothMidi
          noteStart = time
          pitchBuf = [midi]
        } else {
          // 安定継続（running median で追従）
          currentMidi = smoothMidi
        }
        break
    }
  }

  // 末尾に残った音符を確定
  if (state === 'stable') {
    commit(currentMidi, noteStart, samples.length / sampleRate)
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
  const audioCtxRef = useRef<AudioContext | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const pcmChunksRef = useRef<Float32Array[]>([])
  const prevUrlRef = useRef<string | null>(null)
  const abortedRef = useRef(false)

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

    // カウントダウン（独立した AudioContext で鳴らす）
    const clickCtx = new AudioContext()
    setRecordingState('countdown')
    setCountdownBeat(0)
    await scheduleCountdown(clickCtx, bpm, 4, (beat) => setCountdownBeat(beat))
    clickCtx.close()
    setCountdownBeat(0)

    if (abortedRef.current) {
      stream.getTracks().forEach(t => t.stop())
      setRecordingState('idle')
      return
    }

    // ── 録音用 AudioContext ──────────────────────────────────────
    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx
    const sampleRate = audioCtx.sampleRate

    const source = audioCtx.createMediaStreamSource(stream)

    // ハイパスフィルター（低周波ノイズ除去）
    const highpass = audioCtx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 70

    // 入力ゲイン（小さな声を持ち上げる）
    const gainNode = audioCtx.createGain()
    gainNode.gain.value = 4.0

    // ScriptProcessorNode で生 PCM をキャプチャ
    // ※ AudioWorklet より互換性が高く実装が単純
    const scriptNode = audioCtx.createScriptProcessor(2048, 1, 1)
    scriptNodeRef.current = scriptNode
    pcmChunksRef.current = []

    scriptNode.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0)
      pcmChunksRef.current.push(new Float32Array(data))
    }

    // 無音出力先（スピーカーから聞こえないよう gain=0）
    const silentGain = audioCtx.createGain()
    silentGain.gain.value = 0

    source.connect(highpass)
    highpass.connect(gainNode)
    gainNode.connect(scriptNode)
    scriptNode.connect(silentGain)
    silentGain.connect(audioCtx.destination)

    // MediaRecorder でオリジナル音源（再生用）を同時録音
    audioChunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
    const mr = new MediaRecorder(stream, { mimeType })
    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
    mr.onstop = async () => {
      // 再生用 URL を生成
      const blob = new Blob(audioChunksRef.current, { type: mimeType })
      const url = URL.createObjectURL(blob)
      prevUrlRef.current = url
      setRecordedAudioUrl(url)

      // ── オフライン解析（生 PCM から）──────────────────────────
      setRecordingState('analyzing')
      try {
        // PCM チャンクを結合
        const totalLen = pcmChunksRef.current.reduce((s, c) => s + c.length, 0)
        const pcm = new Float32Array(totalLen)
        let offset = 0
        for (const chunk of pcmChunksRef.current) {
          pcm.set(chunk, offset)
          offset += chunk.length
        }
        const detected = analyzePCM(pcm, sampleRate)
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
    abortedRef.current = true

    scriptNodeRef.current?.disconnect()
    scriptNodeRef.current = null

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
