import { useState, useMemo, useRef, useCallback } from 'react'
import { useAudioRecorder } from './hooks/useAudioRecorder'
import { generateChordPatterns, getKeyLabel } from './lib/chordGenerator'
import { playMelody, playChordPattern, playMelodyWithChords } from './lib/audioPlayer'
import { SheetMusic } from './components/SheetMusic'

type PlayState = 'idle' | 'melody' | 'chord' | 'both'

function App() {
  const { isRecording, notes, startRecording, stopRecording } = useAudioRecorder()
  const [selectedPattern, setSelectedPattern] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [playState, setPlayState] = useState<PlayState>('idle')
  const stopPlaybackRef = useRef<(() => void) | null>(null)

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
    setPlayState('idle')
  }, [])

  const handlePlay = useCallback((type: PlayState) => {
    stopCurrentPlayback()
    let stop: () => void
    if (type === 'melody') {
      stop = playMelody(notes)
    } else if (type === 'chord') {
      stop = playChordPattern(current.chords)
    } else {
      stop = playMelodyWithChords(notes, current.chords)
    }
    setPlayState(type)
    stopPlaybackRef.current = stop
    // 再生終了を検知して状態をリセット
    const totalSec = type === 'melody'
      ? Math.max(...notes.map(n => n.time + n.duration)) + 1
      : type === 'chord'
        ? current.chords.length * (60 / 72) * 2 + 1
        : Math.max(...notes.map(n => n.time + n.duration)) + 1
    setTimeout(() => {
      stopPlaybackRef.current = null
      setPlayState('idle')
    }, totalSec * 1000)
  }, [notes, current, stopCurrentPlayback])

  const handleAppStop = async () => {
    stopCurrentPlayback()
    try {
      await fetch('/api/stop', { method: 'POST' })
    } catch {
      // サーバーが停止するため通信エラーは正常
    }
  }

  const canPlay = notes.length > 0 && !isRecording

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
          title="アプリを停止する"
        >
          ⏹ アプリ停止
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-8">

        {/* Recording section */}
        <section className="bg-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">録音</h2>
            {isRecording && (
              <span className="flex items-center gap-2 text-red-400 text-sm">
                <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                録音中
              </span>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleStart}
              disabled={isRecording}
              className="flex-1 py-3 rounded-xl font-medium bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              ● 録音開始
            </button>
            <button
              onClick={stopRecording}
              disabled={!isRecording}
              className="flex-1 py-3 rounded-xl font-medium bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              ■ 停止
            </button>
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex gap-4 text-sm text-slate-400">
            <span>検出音符: <strong className="text-slate-200">{notes.length}</strong></span>
            <span>推定キー: <strong className="text-purple-300">{keyLabel}</strong></span>
          </div>
        </section>

        {/* Sheet music */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">五線譜</h2>
            {canPlay && (
              <div className="flex gap-2">
                {playState === 'melody' ? (
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
                )}
              </div>
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
                        <span
                          key={i}
                          className="px-4 py-2 bg-white/10 rounded-lg text-lg font-bold tracking-wide"
                        >
                          {chord}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-white/60 mb-1">印象</p>
                    <p className="text-white font-medium">{current.mood}</p>
                  </div>

                  {/* 再生ボタン */}
                  <div className="flex gap-2 pt-1 flex-wrap">
                    {playState === 'chord' ? (
                      <button
                        onClick={stopCurrentPlayback}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-600 hover:bg-orange-500 transition-colors"
                      >
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
                      <button
                        onClick={stopCurrentPlayback}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-600 hover:bg-orange-500 transition-colors"
                      >
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

        {notes.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-4">🎵</p>
            <p>録音を開始して鼻歌を歌ってください</p>
            <p className="text-sm mt-1">メロディを解析してコード進行を提案します</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
