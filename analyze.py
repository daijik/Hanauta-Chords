#!/usr/bin/env python3
"""
正規化自己相関（NAC）ピッチ検出 — コンパイル不要、全アーキテクチャ対応。

Praat が内部で使う自己相関法と同じ原理を numpy + scipy で実装。
tensorflow/crepe/parselmouth 等のコンパイルが必要なパッケージは一切使わない。

使い方: python analyze.py <wav_file> <bpm>
"""

import sys
import json
import warnings
warnings.filterwarnings("ignore")

import numpy as np
from scipy import signal
import soundfile as sf


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def quantize_duration(seconds: float, bpm: float) -> float:
    beat = 60.0 / bpm
    divs = [0.25, 0.375, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]
    best = min(divs, key=lambda d: abs(seconds / beat - d))
    return round(best * beat, 3)


# ─── 正規化自己相関（NAC）ピッチ検出 ────────────────────────────────────────
#
# Praat の自己相関法と同じ原理:
#   1. フレームを Hanning 窓で切り出し
#   2. FFT を使った高速自己相関（O(N log N)）
#   3. 自己相関 r(0) で正規化 → NAC
#   4. [min_lag, max_lag] の範囲で最大ピークを探す
#   5. 放物線補間でサブサンプル精度に改善
#
# Praat と同様、有声/無声の判定は NAC ピーク高さ（voicing threshold）で行う。

PITCH_FLOOR   = 80.0   # Hz: 鼻歌最低域
PITCH_CEILING = 650.0  # Hz: 鼻歌最高域
TIME_STEP     = 0.01   # s : 10ms フレームレート (= 100 fps)
VOICE_THR     = 0.30   # NAC ピーク高さの下限（これ未満は無声）
RMS_GATE      = 0.004  # 実効値ノイズゲート
SMOOTH_FRAMES = 9      # モードフィルタ幅
MIN_FRAMES    = 4      # 音符と判定する最短フレーム数


def nac_pitch(frame: np.ndarray, sr: int, min_lag: int, max_lag: int):
    """
    1フレームの正規化自己相関からピッチ（Hz）と確信度を返す。
    ピッチが見つからない場合は (0.0, 0.0) を返す。
    """
    n = len(frame)
    # FFT で高速自己相関を計算
    fft_size = 1 << (2 * n - 1).bit_length()  # 次の2の冪
    F = np.fft.rfft(frame, n=fft_size)
    acf = np.fft.irfft(F * np.conj(F))[:n].real

    # r(0) で正規化
    r0 = acf[0]
    if r0 < 1e-12:
        return 0.0, 0.0
    nac = acf / r0

    # [min_lag, max_lag] の範囲でローカル最大点を探す
    window = nac[min_lag:max_lag + 1]
    peaks, props = signal.find_peaks(window, height=VOICE_THR)

    if len(peaks) == 0:
        return 0.0, 0.0

    # 最高ピークを採用
    best_idx = peaks[np.argmax(props["peak_heights"])]
    lag = best_idx + min_lag
    strength = nac[lag]

    # 放物線補間でサブサンプル精度に
    if 0 < lag < n - 1:
        a, b, c = nac[lag - 1], nac[lag], nac[lag + 1]
        denom = 2 * (a - 2 * b + c)
        refined_lag = lag + (a - c) / denom if abs(denom) > 1e-10 else lag
    else:
        refined_lag = lag

    freq = sr / refined_lag if refined_lag > 0 else 0.0
    return freq, strength


def analyze(wav_path: str, bpm: float) -> list[dict]:
    # ── 音声読み込み ─────────────────────────────────────────────────────────
    y, sr = sf.read(wav_path, always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    y = y.astype(np.float64)

    min_lag  = max(2, int(sr / PITCH_CEILING))
    max_lag  = int(sr / PITCH_FLOOR)
    # ウィンドウ = ラグの最大値の 2 倍（少なくとも 2 周期分）
    win_size = 2 * max_lag
    hop_size = int(TIME_STEP * sr)
    window   = np.hanning(win_size)

    n_frames = max(0, (len(y) - win_size) // hop_size + 1)

    # ── フレームごとにピッチ推定 ──────────────────────────────────────────────
    times  = np.zeros(n_frames)
    f0s    = np.zeros(n_frames)

    for i in range(n_frames):
        start = i * hop_size
        frame = y[start:start + win_size]
        times[i] = i * TIME_STEP

        rms = np.sqrt(np.mean(frame ** 2))
        if rms < RMS_GATE:
            continue  # 無音

        freq, strength = nac_pitch(frame * window, sr, min_lag, max_lag)
        f0s[i] = freq

    # ── MIDI 変換 ─────────────────────────────────────────────────────────────
    valid = (f0s > 0) & (f0s >= PITCH_FLOOR) & (f0s <= PITCH_CEILING)
    midi_arr = np.where(
        valid,
        np.round(12 * np.log2(np.where(f0s > 0, f0s, 440) / 440.0) + 69).astype(int),
        -1,
    )

    # オクターブ補正: 鼻歌音域（MIDI 45-79）を外れていたら 12 半音シフト
    for i in range(len(midi_arr)):
        if midi_arr[i] < 0:
            continue
        if midi_arr[i] > 79:
            midi_arr[i] -= 12
        elif midi_arr[i] < 45:
            midi_arr[i] += 12

    # ── モードフィルタで平滑化 ────────────────────────────────────────────────
    smoothed = midi_arr.copy()
    voiced_idx = np.where(midi_arr >= 0)[0]
    for i in voiced_idx:
        lo = max(0, i - SMOOTH_FRAMES // 2)
        hi = min(len(midi_arr), lo + SMOOTH_FRAMES)
        win = midi_arr[lo:hi]
        win = win[win >= 0]
        if len(win) > 0:
            vals, counts = np.unique(win, return_counts=True)
            smoothed[i] = vals[np.argmax(counts)]

    # ── プラトー検出 → 音符確定 ───────────────────────────────────────────────
    notes: list[dict] = []
    run_start: int | None = None
    prev_midi = -1

    def commit(end_idx: int):
        nonlocal run_start
        if run_start is None:
            return
        run = [j for j in range(run_start, end_idx) if smoothed[j] >= 0]
        if len(run) < MIN_FRAMES:
            run_start = None
            return
        midi = int(np.bincount([smoothed[j] for j in run]).argmax())
        start_time = float(times[run[0]])
        raw_dur    = float(times[run[-1]]) - start_time + TIME_STEP
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
