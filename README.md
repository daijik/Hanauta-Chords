# Hanauta-Chords

鼻歌のメロディを分析して、コードを自動でつけるアプリ。

## 概要

マイクで鼻歌を歌うと、メロディを解析してコード進行を提案します。

## 機能

- 鼻歌（音声）の録音
- メロディの音程解析・五線譜表示
- コード進行の自動提案（複数パターン）
- 各コードパターンへの印象説明付与

## 技術スタック

- React + Vite + TypeScript
- Web Audio API + pitchy（ピッチ検出）
- VexFlow（楽譜レンダリング）
- Tailwind CSS
- Podman + RHEL UBI 9（実行環境）

## 起動方法

### 開発環境

```bash
podman build -t hanauta-chords:dev --target dev .
podman run -p 5173:5173 hanauta-chords:dev
```

### 本番環境

```bash
podman build -t hanauta-chords:prod .
podman run -p 8080:8080 hanauta-chords:prod
```

## 設計書

[DESIGN.md](./DESIGN.md) を参照。
