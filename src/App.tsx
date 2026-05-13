import { useState, useMemo, useRef, useCallback } from 'react'
import { useAudioRecorder } from './hooks/useAudioRecorder'
import { generateChordPatterns, getKeyLabel } from './lib/chordGenerator'
import { playMelody, playChordPattern, playMelodyWithChords } from './lib/audioPlayer'
import { SheetMusic } from './components/SheetMusic'

type PlayState = 'idle' | 'melody' | 'chord' | 'both' | 'original'

// カウントダウン表示: ビート番号をドットで表現
function CountdownIndicator({ beat, total = 4 }: { beat: number; total?: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-yellow-400 text-sm font-medium">カウント中</span>
      <div className="flex gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`w-3 h-3 rounded-full transition-all duration-75 ${
              i + 1 <= beat ? 'bg-yellow-400 scale-125' : 'bg-slate-600'
            }`}
          />
        ))}
      </div>
    </div>
  )
}

function App() {
  const [bpm, setBpm] = useState(120)
  const {
    isRecording,
    isCountingDown,
    isAnalyzing,
    countdownBeat,
    notes,
    recordedAudioUrl,
    startRecording,
    stopRecording,
  } = useAudioRecorder(bpm)

  const [selectedPattern, setSelectedPattern] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [playState, setPlayState] = useState<PlayState>('idle')
  const stopPlaybackRef = useRef<(() => void) | null>(null)
  const originalAudioRef = useRef<HTMLAudioElement | null>(null)

  const patterns = useMemo(() => generateChordPatterns(notes), [notes])
  const keyLabel = useMemo(() => getKeyLabel(notes), [notes])
  const current = patterns[selectedPattern] ?? patterns[0]

  const handleStart = async () => {
    try {
      setError(null)
      await startRecording()
    } catch {
      setError('マイクへのアクセスが許可されていません。ブラウザの設定をご確認ください。')
    }
  }

  const stopCurrentPlayback = useCallback(() => {
    stopPlaybackRef.current?.()
    stopPlaybackRef.current = null
    if (originalAudioRef.current) {
      originalAudioRef.current.pause()
      originalAudioRef.current.currentTime = 0
      originalAudioRef.current = null
    }
    setPlayState('idle')
  }, [])

  const handlePlay = useCallback((type: Exclude<PlayState, 'idle' | 'original'>) => {
    stopCurrentPlayback()
    let stop: () => void
    let durationSec: number

    if (type === 'melody') {
      stop = playMelody(notes)
      durationSec = Math.max(...notes.map(n => n.time + n.duration)) + 1
    } else if (type === 'chord') {
      stop = playChordPattern(current.chords, bpm)
      durationSec = current.chords.length * (60 / bpm) * 2 + 1
    } else {
      stop = playMelodyWithChords(notes, current.chords, bpm)
      durationSec = Math.max(...notes.map(n => n.time + n.duration)) + 1
    }

    setPlayState(type)
    stopPlaybackRef.current = stop
    setTimeout(() => {
      stopPlaybackRef.current = null
      setPlayState('idle')
    }, durationSec * 1000)
  }, [notes, current, bpm, stopCurrentPlayback])

  const handlePlayOriginal = useCallback(() => {
    if (!recordedAudioUrl) return
    stopCurrentPlayback()
    const audio = new Audio(recordedAudioUrl)
    originalAudioRef.current = audio
    setPlayState('original')
    audio.play()
    audio.onended = () => {
      originalAudioRef.current = null
      setPlayState('idle')
    }
  }, [recordedAudioUrl, stopCurrentPlayback])

  const handleAppStop = async () => {
    stopCurrentPlayback()
    try {
      await fetch('/api/stop', { method: 'POST' })
    } catch {
      // サーバー停止による通信エラーは正常
    }
  }

  const isBusy = isRecording || isCountingDown || isAnalyzing
  const canPlay = notes.length > 0 && !isBusy

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-700 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="text-purple-400">♪</span> Hanauta-Chords
          </h1>
          <p className="text-slate-400 text-sm mt-0.5">
            鼻歌のメロディからコード進行を自動提案
          </p>
        </div>
        <button
          onClick={handleAppStop}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-red-900/60 hover:bg-red-700 border border-red-700 hover:border-red-500 transition-colors"
        >
          ⏹ アプリ停止
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-8">

        {/* Recording section */}
        <section className="bg-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-lg font-semibold">録音</h2>
            {isCountingDown && <CountdownIndicator beat={countdownBeat} />}
            {isRecording && (
              <span className="flex items-center gap-2 text-red-400 text-sm">
                <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                録音中
              </span>
            )}
            {isAnalyzing && (
              <span className="flex items-center gap-2 text-blue-400 text-sm">
                <span className="w-2 h-2 rounded-full bg-blue-400 animate-ping" />
                音声を解析中...
              </span>
            )}
          </div>

          {/* BPM 設定 */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-400 shrink-0">BPM</label>
            <input
              type="range"
              min={40}
              max={240}
              value={bpm}
              onChange={e => setBpm(Number(e.target.value))}
              disabled={isBusy}
              className="flex-1 accent-purple-500 disabled:opacity-40"
            />
            <input
              type="number"
              min={40}
              max={240}
              value={bpm}
              onChange={e => setBpm(Math.min(240, Math.max(40, Number(e.target.value))))}
              disabled={isBusy}
              className="w-16 text-center bg-slate-700 rounded-lg px-2 py-1 text-sm disabled:opacity-40 [appearance:textfield]"
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleStart}
              disabled={isBusy}
              className="flex-1 py-3 rounded-xl font-medium bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isCountingDown ? '準備中...' : isAnalyzing ? '解析中...' : '● 録音開始'}
            </button>
            <button
              onClick={stopRecording}
              disabled={!isBusy}
              className="flex-1 py-3 rounded-xl font-medium bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              ■ 停止
            </button>
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex gap-4 text-sm text-slate-400 flex-wrap">
            <span>検出音符: <strong className="text-slate-200">{notes.length}</strong></span>
            <span>推定キー: <strong className="text-purple-300">{keyLabel}</strong></span>
            {recordedAudioUrl && (
              <span className="text-green-400">● 音声録音済み</span>
            )}
          </div>

          {/* オリジナル音源再生 */}
          {recordedAudioUrl && (
            <div className="pt-1">
              {playState === 'original' ? (
                <button
                  onClick={stopCurrentPlayback}
                  className="w-full py-2 rounded-xl text-sm font-medium bg-orange-600 hover:bg-orange-500 transition-colors"
                >
                  ⏹ 停止
                </button>
              ) : (
                <button
                  onClick={handlePlayOriginal}
                  disabled={playState !== 'idle'}
                  className="w-full py-2 rounded-xl text-sm font-medium bg-teal-700 hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ▶ オリジナル音源を再生
                </button>
              )}
            </div>
          )}
        </section>

        {/* Sheet music */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">五線譜</h2>
            {canPlay && (
              playState === 'melody' ? (
                <button
                  onClick={stopCurrentPlayback}
                  className="px-3 py-1.5 text-sm rounded-lg bg-orange-600 hover:bg-orange-500 transition-colors"
                >
                  ⏹ 停止
                </button>
              ) : (
                <button
                  onClick={() => handlePlay('melody')}
                  disabled={playState !== 'idle'}
                  className="px-3 py-1.5 text-sm rounded-lg bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ▶ メロディ再生
                </button>
              )
            )}
          </div>
          <SheetMusic notes={notes} />
        </section>

        {/* Chord patterns */}
        {notes.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">コードパターン</h2>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {patterns.map((p, i) => (
                <button
                  key={p.name}
                  onClick={() => { setSelectedPattern(i); stopCurrentPlayback() }}
                  className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                    i === selectedPattern
                      ? 'border-purple-500 bg-purple-500/20 text-purple-200'
                      : 'border-slate-600 hover:border-slate-400 text-slate-300'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>

            {current && (
              <div className={`rounded-2xl p-6 bg-gradient-to-br ${current.color} bg-opacity-20`}>
                <div className="bg-black/30 rounded-xl p-4 space-y-4">
                  <div>
                    <p className="text-xs text-white/60 mb-1">コード進行</p>
                    <div className="flex flex-wrap gap-2">
                      {current.chords.map((chord, i) => (
                        <span key={i} className="px-4 py-2 bg-white/10 rounded-lg text-lg font-bold tracking-wide">
                          {chord}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-white/60 mb-1">印象</p>
                    <p className="text-white font-medium">{current.mood}</p>
                  </div>

                  <div className="flex gap-2 pt-1 flex-wrap">
                    {playState === 'chord' ? (
                      <button onClick={stopCurrentPlayback} className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-600 hover:bg-orange-500 transition-colors">
                        ⏹ 停止
                      </button>
                    ) : (
                      <button
                        onClick={() => handlePlay('chord')}
                        disabled={playState !== 'idle'}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-white/15 hover:bg-white/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        ▶ コードのみ再生
                      </button>
                    )}
                    {playState === 'both' ? (
                      <button onClick={stopCurrentPlayback} className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-600 hover:bg-orange-500 transition-colors">
                        ⏹ 停止
                      </button>
                    ) : (
                      <button
                        onClick={() => handlePlay('both')}
                        disabled={playState !== 'idle'}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-600/70 hover:bg-purple-500/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        ▶ メロディ＋コード再生
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {isAnalyzing && (
          <div className="text-center py-12 text-blue-400">
            <p className="text-4xl mb-4 animate-pulse">🎼</p>
            <p className="font-medium">鼻歌を解析して五線譜に変換中...</p>
            <p className="text-sm mt-1 text-slate-500">録音音源からピッチを抽出しています</p>
          </div>
        )}

        {notes.length === 0 && !isBusy && (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-4">🎵</p>
            <p>録音を開始して鼻歌を歌ってください</p>
            <p className="text-sm mt-1">クリック音4拍のあとに歌い始めてください</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
