import { useEffect, useRef } from 'react'
import { Renderer, Stave, StaveNote, Voice, Formatter, Accidental } from 'vexflow'
import type { DetectedNote } from '../hooks/useAudioRecorder'

type Props = {
  notes: DetectedNote[]
}

const SHARP_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function durationToVex(dur: number): string {
  if (dur >= 1.5) return 'h'
  if (dur >= 0.75) return 'q'
  return '8'
}

function midiToVex(midi: number): { key: string; accidental?: string } {
  const octave = Math.floor(midi / 12) - 1
  const noteIdx = midi % 12
  const name = SHARP_NOTES[noteIdx]
  if (name.includes('#')) {
    const base = name[0].toLowerCase()
    return { key: `${base}#/${octave}`, accidental: '#' }
  }
  return { key: `${name.toLowerCase()}/${octave}` }
}

export function SheetMusic({ notes }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.innerHTML = ''

    const displayNotes = notes.slice(-16)

    const renderer = new Renderer(el, Renderer.Backends.SVG)
    const width = Math.max(400, displayNotes.length * 60 + 120)
    renderer.resize(width, 160)
    const ctx = renderer.getContext()
    ctx.setFillStyle('#e2e8f0')
    ctx.setStrokeStyle('#e2e8f0')

    const stave = new Stave(10, 20, width - 20)
    stave.addClef('treble').addTimeSignature('4/4')
    stave.setContext(ctx).draw()

    if (displayNotes.length === 0) return

    const vexNotes = displayNotes.map(n => {
      const { key, accidental } = midiToVex(n.midi)
      const dur = durationToVex(n.duration)
      const sn = new StaveNote({ keys: [key], duration: dur })
      if (accidental) sn.addModifier(new Accidental(accidental))
      return sn
    })

    const voice = new Voice({ numBeats: 4, beatValue: 4 }).setMode(Voice.Mode.SOFT)
    voice.addTickables(vexNotes)

    new Formatter().joinVoices([voice]).format([voice], width - 140)
    voice.draw(ctx, stave)
  }, [notes])

  return (
    <div className="bg-slate-800 rounded-xl p-4 overflow-x-auto">
      <p className="text-slate-400 text-xs mb-2">五線譜（最新16音）</p>
      <div ref={containerRef} className="min-h-[160px]" />
      {notes.length === 0 && (
        <p className="text-slate-500 text-sm text-center py-8">
          録音すると五線譜が表示されます
        </p>
      )}
    </div>
  )
}
