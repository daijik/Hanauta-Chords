#!/usr/bin/env python3
"""
鼻歌音声（WAV）を Praat の自己相関ピッチ解析で音符列に変換して JSON で返す。
使い方: python analyze.py <wav_file> <bpm>
"""

import sys
import json
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import parselmouth
from parselmouth.praat import call


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def freq_to_midi(freq: float) -> int:
    return int(round(12 * np.log2(freq / 440.0) + 69))


def midi_to_note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def quantize_duration(seconds: float, bpm: float) -> float:
    beat = 60.0 / bpm
    divisions = [0.25, 0.375, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]
    beats = seconds / beat
    best = min(divisions, key=lambda d: abs(d - beats))
    return round(best * beat, 3)


def analyze(wav_path: str, bpm: float) -> list[dict]:
    sound = parselmouth.Sound(wav_path)

    # ─── Praat 自己相関ピッチ追跡 ────────────────────────────────────────────
    # Praat の "To Pitch (ac)" は人の声・歌声に最適化されたアルゴリズム。
    # viterbi 的な Viterbi 解（最適経路）を使って時間方向に滑らかなピッチ曲線を得る。
    pitch = call(
        sound, "To Pitch (ac)...",
        0.01,   # time_step (s): 10ms フレームレート
        80.0,   # pitch_floor (Hz): 鼻歌最低域
        15,     # max_candidates
        True,   # very_accurate (SHS 事前候補)
        0.03,   # silence_threshold
        0.40,   # voicing_threshold: 低めにして有声フレームを多く取る
        0.01,   # octave_cost
        0.35,   # octave_jump_cost
        0.14,   # voiced_unvoiced_cost
        600.0,  # pitch_ceiling (Hz): 鼻歌最高域
    )

    n_frames = int(call(pitch, "Get number of frames"))
    time_step = call(pitch, "Get time step")
    start_t   = call(pitch, "Get start time")

    # ─── フレームごとに F0 を取得 ─────────────────────────────────────────────
    times:  list[float] = []
    f0s:    list[float] = []

    for i in range(1, n_frames + 1):
        t  = start_t + (i - 1) * time_step
        f0 = call(pitch, "Get value in frame", i, "Hertz")
        times.append(t)
        # NaN = 無声フレーム → 0 に統一
        f0s.append(f0 if (f0 and not np.isnan(f0)) else 0.0)

    times = np.array(times)
    f0s   = np.array(f0s)

    # ─── MIDI 変換 + モード平滑化 ─────────────────────────────────────────────
    midi_arr = np.where(f0s > 0, np.round(12 * np.log2(
        np.where(f0s > 0, f0s, 440) / 440.0) + 69).astype(int), -1)

    SMOOTH = 9   # 9フレーム × 10ms = 90ms ウィンドウでモードフィルタ
    smoothed = midi_arr.copy()
    voiced_idx = np.where(midi_arr >= 0)[0]
    for i in voiced_idx:
        lo = max(0, i - SMOOTH // 2)
        hi = min(len(midi_arr), lo + SMOOTH)
        window = midi_arr[lo:hi]
        window = window[window >= 0]
        if len(window) > 0:
            vals, counts = np.unique(window, return_counts=True)
            smoothed[i] = vals[np.argmax(counts)]

    # ─── プラトー検出 → 音符確定 ──────────────────────────────────────────────
    notes: list[dict] = []
    run_start: int | None = None
    prev_midi = -1
    MIN_FRAMES = 4  # 最短 4 フレーム = 40ms

    def commit(end_idx: int):
        nonlocal run_start
        if run_start is None:
            return
        run_indices = [j for j in range(run_start, end_idx) if smoothed[j] >= 0]
        if len(run_indices) < MIN_FRAMES:
            run_start = None
            return
        midi = int(np.bincount([smoothed[j] for j in run_indices]).argmax())
        start_time = float(times[run_indices[0]])
        raw_dur    = float(times[run_indices[-1]]) - start_time + 0.01
        duration   = quantize_duration(raw_dur, bpm)
        notes.append({
            "name":     midi_to_note_name(midi),
            "midi":     midi,
            "time":     round(start_time, 3),
            "duration": duration,
        })
        run_start = None

    for i in voiced_idx:
        midi = smoothed[i]
        if midi < 0:
            continue
        if run_start is None:
            run_start = i
            prev_midi = midi
            continue
        # 無音ギャップ（80ms 超）または音程変化（2 半音以上）で区切る
        gap = times[i] - times[i - 1] if i > 0 else 0
        if gap > 0.08 or abs(int(midi) - int(prev_midi)) >= 2:
            commit(i)
            run_start = i
        prev_midi = midi

    commit(len(smoothed))
    return notes


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: analyze.py <wav_file> <bpm>"}))
        sys.exit(1)
    try:
        result = analyze(sys.argv[1], float(sys.argv[2]))
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
