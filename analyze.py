#!/usr/bin/env python3
"""
鼻歌音声ファイルを解析して音符列を JSON で返す。
crepe（Google 製歌声ピッチ検出 NN）+ librosa を使用。
使い方: python analyze.py <audio_file> <bpm>
"""

import sys
import json
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import librosa
import crepe


def freq_to_midi(freq: float) -> int:
    if freq <= 0:
        return -1
    return int(round(12 * np.log2(freq / 440.0) + 69))


def midi_to_note_name(midi: int) -> str:
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    octave = midi // 12 - 1
    return f"{names[midi % 12]}{octave}"


def quantize_duration(seconds: float, bpm: float) -> float:
    """音符長を BPM グリッドに量子化（16分〜全音符）"""
    beat = 60.0 / bpm
    divisions = [0.25, 0.375, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]
    beats = seconds / beat
    best = min(divisions, key=lambda d: abs(d - beats))
    return best * beat


def analyze(audio_path: str, bpm: float) -> list[dict]:
    # ─── 1. 音声読み込み（22050 Hz モノラルにリサンプル）────────────────────
    y, sr = librosa.load(audio_path, sr=22050, mono=True)

    # ─── 2. crepe でピッチ推定 ────────────────────────────────────────────────
    # step_size: フレーム間隔（ms）。10ms = 100fps
    # model: tiny/small/medium/large/full から選択。small がバランス良い
    time_arr, freq_arr, confidence_arr, _ = crepe.predict(
        y, sr,
        model_capacity="small",
        step_size=10,
        viterbi=True,       # ビタービ復号で時間方向に滑らかなピッチ曲線に
        verbose=0,
    )

    # ─── 3. フィルタリング ────────────────────────────────────────────────────
    MIN_CONFIDENCE = 0.55   # 確信度の下限
    MIN_FREQ = 80.0         # Hz（鼻歌の最低域）
    MAX_FREQ = 700.0        # Hz（鼻歌の最高域）

    valid_mask = (
        (confidence_arr >= MIN_CONFIDENCE) &
        (freq_arr >= MIN_FREQ) &
        (freq_arr <= MAX_FREQ)
    )

    # ─── 4. MIDI スナップ + モード平滑化 ─────────────────────────────────────
    midi_arr = np.array([freq_to_midi(f) if m else -1
                         for f, m in zip(freq_arr, valid_mask)])

    # 有効フレームだけ保持
    valid_idx = np.where(valid_mask)[0]
    if len(valid_idx) == 0:
        return []

    # 7フレームのモードフィルタ（最頻値でスムージング）
    SMOOTH = 7
    smoothed_midi = midi_arr.copy()
    for i in valid_idx:
        lo = max(0, i - SMOOTH // 2)
        hi = min(len(midi_arr), lo + SMOOTH)
        window = midi_arr[lo:hi]
        window = window[window >= 0]
        if len(window) > 0:
            vals, counts = np.unique(window, return_counts=True)
            smoothed_midi[i] = vals[np.argmax(counts)]

    # ─── 5. プラトー検出（連続する同 MIDI ランを1音符に集約）────────────────
    notes = []
    run_start_idx = None
    prev_midi = -1

    def commit(end_idx: int):
        nonlocal run_start_idx
        if run_start_idx is None:
            return
        run = [(i, smoothed_midi[i]) for i in range(run_start_idx, end_idx)
               if smoothed_midi[i] >= 0]
        if len(run) < 3:   # 最短 3 フレーム（30ms）
            run_start_idx = None
            return
        midi = int(np.bincount([r[1] for r in run]).argmax())
        start_time = float(time_arr[run[0][0]])
        raw_dur = float(time_arr[run[-1][0]]) - start_time + 0.01
        duration = quantize_duration(raw_dur, bpm)
        notes.append({
            "name": midi_to_note_name(midi),
            "midi": midi,
            "time": round(start_time, 3),
            "duration": round(duration, 3),
        })
        run_start_idx = None

    for i in valid_idx:
        midi = smoothed_midi[i]
        if midi < 0:
            continue

        # 新しいランの開始
        if run_start_idx is None:
            run_start_idx = i
            prev_midi = midi
            continue

        # 無音ギャップ（前フレームとの時刻差が 80ms 超）
        time_gap = time_arr[i] - time_arr[i - 1] if i > 0 else 0
        is_gap = time_gap > 0.08

        # 音程変化（2半音以上）
        is_pitch_change = abs(int(midi) - int(prev_midi)) >= 2

        if is_gap or is_pitch_change:
            commit(i)
            run_start_idx = i

        prev_midi = midi

    commit(len(smoothed_midi))
    return notes


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: analyze.py <audio_file> <bpm>"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    bpm = float(sys.argv[2])

    try:
        result = analyze(audio_path, bpm)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
