#!/usr/bin/env python3
"""
正規化自己相関（NAC）ピッチ検出 — コンパイル不要、全アーキテクチャ対応。
numpy + scipy のみ使用（全て aarch64 ビルド済みホイールあり）。

使い方: python analyze.py <wav_file> <bpm>

オクターブ誤検出対策:
  1. ピーク選択時にオクターブコストを加算（低い周波数 = 高いラグ を嫌う）
  2. 半周期チェック: ラグ τ の peak と同程度の peak が τ/2 にあれば τ/2 を採用
  3. 対数周波数でメジアンフィルタ → オクターブジャンプを多数決で除去
  4. 最終 MIDI 配列にも 11 フレームモードフィルタ
"""

import sys
import json
import warnings
warnings.filterwarnings("ignore")

import numpy as np
from scipy import signal
from scipy.ndimage import median_filter
import soundfile as sf


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def quantize_duration(seconds: float, bpm: float) -> float:
    beat = 60.0 / bpm
    divs = [0.25, 0.375, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]
    best = min(divs, key=lambda d: abs(seconds / beat - d))
    return round(best * beat, 3)


# ─── パラメータ ───────────────────────────────────────────────────────────────
PITCH_FLOOR   = 80.0    # Hz: 鼻歌最低域
PITCH_CEILING = 650.0   # Hz: 鼻歌最高域
TIME_STEP     = 0.010   # s : 10ms フレームレート
VOICE_THR     = 0.28    # NAC ピーク高さの下限
RMS_GATE      = 0.004   # 無音ゲート
OCTAVE_COST   = 0.025   # 1オクターブ低いほど score がこれだけ下がる（log2 scale）
SMOOTH_LOG    = 13      # 対数周波数メジアンフィルタ幅（奇数）
MODE_FRAMES   = 11      # MIDI モードフィルタ幅
MIN_FRAMES    = 4       # 音符と判定する最短フレーム数


def nac_pitch(frame: np.ndarray, sr: int, min_lag: int, max_lag: int) -> tuple[float, float]:
    """
    1 フレームの正規化自己相関からピッチ（Hz）と確信度を返す。
    ピッチが見つからない場合は (0.0, 0.0)。

    オクターブ誤検出を減らすために:
      - ピーク候補にオクターブコストを加算（低周波候補を抑制）
      - ラグ τ/2 に同程度の peak があれば τ/2 を優先（倍周期誤検出を修正）
    """
    n = len(frame)
    fft_size = 1 << (2 * n - 1).bit_length()
    F = np.fft.rfft(frame, n=fft_size)
    acf = np.fft.irfft(F * np.conj(F))[:n].real

    r0 = acf[0]
    if r0 < 1e-12:
        return 0.0, 0.0
    nac = acf / r0

    # [min_lag, max_lag] でピーク検索
    window = nac[min_lag:max_lag + 1]
    peaks_rel, props = signal.find_peaks(
        window,
        height=VOICE_THR,
        distance=max(1, min_lag // 4),  # 近すぎる偽ピークを除外
    )
    if len(peaks_rel) == 0:
        return 0.0, 0.0

    peaks_abs  = peaks_rel + min_lag       # 絶対ラグ
    peaks_vals = props["peak_heights"]

    # ── 候補ごとにスコア計算 ────────────────────────────────────────────────
    # score = NAC値 - オクターブコスト×(基音より何オクターブ低いか)
    # 低周波候補（高いラグ）ほどスコアが下がり、基音に近い候補が選ばれやすくなる。
    best_lag   = peaks_abs[0]
    best_score = -1.0

    for lag, val in zip(peaks_abs, peaks_vals):
        # オクターブコスト: lag が min_lag の何倍か（log2）
        oct_penalty = OCTAVE_COST * np.log2(lag / min_lag)
        score = val - oct_penalty

        # ── 半周期チェック ────────────────────────────────────────────────
        # ラグ τ の peak と同程度の peak が τ/2 にある場合、
        # 真の基音は τ/2（1オクターブ上）の可能性が高い。
        half = lag // 2
        if min_lag <= half < n and nac[half] > VOICE_THR * 0.80:
            # τ/2 の peak が十分強い → τ/2 を採用してスコアを上書き
            lag  = half
            val  = nac[half]
            score = val  # オクターブコストなし（基音候補として扱う）

        if score > best_score:
            best_score = score
            best_lag   = lag

    # ── 放物線補間でサブサンプル精度 ─────────────────────────────────────────
    if 0 < best_lag < n - 1:
        a, b, c = nac[best_lag - 1], nac[best_lag], nac[best_lag + 1]
        denom = 2 * (a - 2 * b + c)
        refined = best_lag + (a - c) / denom if abs(denom) > 1e-10 else float(best_lag)
    else:
        refined = float(best_lag)

    freq = sr / refined if refined > 0 else 0.0
    return freq, nac[best_lag]


def analyze(wav_path: str, bpm: float) -> list[dict]:
    # ── 音声読み込み ─────────────────────────────────────────────────────────
    y, sr = sf.read(wav_path, always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    y = y.astype(np.float64)

    min_lag  = max(2, int(sr / PITCH_CEILING))
    max_lag  = int(sr / PITCH_FLOOR)
    win_size = 2 * max_lag          # 最低周波数の最低 2 周期分
    hop_size = int(TIME_STEP * sr)
    hanning  = np.hanning(win_size)

    n_frames = max(0, (len(y) - win_size) // hop_size + 1)

    # ── Phase 1: フレームごとに NAC ピッチ推定 ─────────────────────────────
    times = np.arange(n_frames, dtype=float) * TIME_STEP
    f0s   = np.zeros(n_frames)

    for i in range(n_frames):
        start = i * hop_size
        frame = y[start:start + win_size]
        if np.sqrt(np.mean(frame ** 2)) < RMS_GATE:
            continue
        freq, _ = nac_pitch(frame * hanning, sr, min_lag, max_lag)
        if PITCH_FLOOR <= freq <= PITCH_CEILING:
            f0s[i] = freq

    # ── Phase 2: 対数周波数でメジアンフィルタ（オクターブジャンプを多数決除去）─
    # オクターブジャンプは log2 スケールで ±1.0 の差。
    # メジアンフィルタは外れ値（少数派のオクターブ誤検出）を強力に除去する。
    voiced = f0s > 0
    if voiced.sum() > 1:
        log_f0 = np.where(voiced, np.log2(np.maximum(f0s, 1e-6)), np.nan)

        # NaN を線形補間で埋めてメジアンフィルタを適用
        x = np.arange(n_frames)
        finite_mask = np.isfinite(log_f0)
        if finite_mask.sum() > 1:
            filled = np.interp(x, x[finite_mask], log_f0[finite_mask])
            smoothed_log = median_filter(filled, size=SMOOTH_LOG, mode="reflect")
            # 有声フレームのみ更新（無声フレームは 0 のまま）
            f0s = np.where(voiced, np.power(2.0, smoothed_log), 0.0)

    # ── Phase 3: MIDI 変換 ────────────────────────────────────────────────
    voiced = f0s > 0
    midi_arr = np.where(
        voiced,
        np.round(12 * np.log2(np.maximum(f0s, 1e-6) / 440.0) + 69).astype(int),
        -1,
    )

    # ── Phase 4: MIDI モードフィルタ（窓内の最頻値で平滑化）────────────────
    smoothed = midi_arr.copy()
    voiced_idx = np.where(midi_arr >= 0)[0]
    for i in voiced_idx:
        lo = max(0, i - MODE_FRAMES // 2)
        hi = min(len(midi_arr), lo + MODE_FRAMES)
        win = midi_arr[lo:hi]
        win = win[win >= 0]
        if len(win) > 0:
            vals, counts = np.unique(win, return_counts=True)
            smoothed[i] = vals[np.argmax(counts)]

    # ── Phase 5: プラトー検出 → 音符確定 ──────────────────────────────────
    notes: list[dict] = []
    run_start: int | None = None
    prev_midi = -1

    def commit(end_idx: int) -> None:
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
        notes.append({
            "name":     midi_to_note_name(midi),
            "midi":     midi,
            "time":     round(start_time, 3),
            "duration": quantize_duration(raw_dur, bpm),
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
        print(json.dumps(analyze(sys.argv[1], float(sys.argv[2]))))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
