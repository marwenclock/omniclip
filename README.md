# ✂ OMNICLIP <sub>by BANKASI<sup>MEDIA</sup></sub>

**Turn long videos into vertical shorts with captions — free, in your browser, entirely on your device.**
No account, no upload, no watermark. Your footage never leaves your computer.

**Live site:** https://useomniclip.com/

> Tested in desktop Chrome and Edge so far.

Sister project of [OMNIVIEWER](https://github.com/marwenclock/omniviewer3d), the free all-in-one 3D viewer.

---

## What it does

1. **Drop a video or audio file** (MP4, MOV, WebM, MP3, WAV…).
2. **Transcribes it** on your graphics card (WebGPU). Choose *Fast*, *Better* or *Best*.
3. **Finds the best moments** for shorts: strong opening hooks that make sense on their own.
   - *Smart* (default): transcript signals pick the moments, an on-device AI rates them and writes titles.
   - *Deep*: a stronger on-device AI for computers with a fast graphics card.
   - *Instant*: no AI download at all, works on any computer.
4. **Exports vertical 9:16 MP4s** (1080×1920 or 720×1280):
   - crop that **follows the speaker's face**, a fixed crop, or the full frame on a blurred background;
   - **burned-in captions**, word by word or classic subtitles;
   - an optional **title card**;
   - audio-only files become an **audiogram** (title, level bars, captions).

Also: edit the transcript to fix misheard words (captions use your fix), make your own short from selected lines, nudge clip start/end, download subtitles (`.srt`), and reopen a file without transcribing it again.

## Privacy

Everything runs in the browser tab. The only network requests download the open-source AI models (once, then cached by the browser) and the libraries below. Transcripts are remembered in your browser's own storage (IndexedDB) on your device.

## Requirements

- A recent **Chrome or Edge** on desktop (WebGPU, WebCodecs, MediaRecorder with MP4).
- First run downloads the models: Whisper Base ≈ 200 MB, clip-rating AI ≈ 1 GB (optional).
- Export runs in real time (a 30-second short takes about 30 seconds) and the tab must stay visible.

Measured on a low-end Intel UHD 630 integrated GPU: transcription ≈ 4–5× faster than real time; the AI rates a clip in ≈ 15 s. Computers with a dedicated GPU or Apple Silicon are much faster.

## Run it locally

It's plain HTML/JS — no build step. Serve the folder with any static server (modules and workers don't load from `file://`):

```sh
python -m http.server 5191
```

then open http://localhost:5191.

To make test audio on Windows: `powershell -File test/make-test-audio.ps1` (uses the built-in Windows voice).

## How it's built

| File | Role |
| --- | --- |
| `app.js` | Page logic, pipeline, transcript, export queue |
| `asr-worker.js` | Whisper speech-to-text in a Web Worker (transformers.js, WebGPU) |
| `clips.js` | Instant moment picker (text signals) and the local AI rater (WebLLM) |
| `export.js` | 9:16 rendering, captions, title card, audiogram, MP4 recording |
| `reframe.js` | Face tracking for the follow-the-speaker crop (MediaPipe) |
| `decode-stream.js` | Streamed audio decoding for large MP4/MOV files (mp4box.js + WebCodecs) |

## Credits and licences

- Speech: [Whisper](https://github.com/openai/whisper) (MIT) via [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0)
- Clip rating: [Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) (Apache-2.0) and [Phi-3.5-mini-instruct](https://huggingface.co/microsoft/Phi-3.5-mini-instruct) (MIT) via [WebLLM](https://github.com/mlc-ai/web-llm) (Apache-2.0)
- Face detection: [MediaPipe](https://github.com/google-ai-edge/mediapipe) BlazeFace (Apache-2.0)
- MP4 parsing: [mp4box.js](https://github.com/gpac/mp4box.js) (BSD-3-Clause)

Models are downloaded by the visitor's browser from their public hosts; they are not redistributed here.

OMNICLIP is released under the [MIT License](LICENSE). © 2026 BANKASI MEDIA.
