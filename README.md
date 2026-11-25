# ✂ OMNICLIP <sub>by BANKASI<sup>MEDIA</sup></sub>

**Turn long videos into vertical shorts with captions — free, in your browser, entirely on your device.**
No account, no upload, no watermark. Your footage never leaves your computer.

**Live site:** https://useomniclip.com/

> Tested in desktop Chrome and Edge so far.

Sister project of [OMNIVIEWER](https://github.com/marwenclock/omniviewer3d), the free all-in-one 3D viewer.

---

## What it does

Two ways in, one editor:

- **Create shorts** — drop a long video or podcast. OMNICLIP transcribes it on your graphics card (WebGPU) and finds the strongest moments: *Smart* (an on-device AI rates them and writes titles), *Deep* (a stronger model for fast GPUs) or *Instant* (no AI download).
- **Edit a video** — opens the file straight away as one clip to cut by hand. No transcription, nothing to download. Add captions later with *Transcribe it* or by importing an `.srt`/`.vtt`.

The editor:

- **Output monitor** that draws every frame with the same code as the export, so what you preview is what you get. Switch to **Source** to see the whole video, set In/Out and make new clips.
- **Timeline** with ruler, waveform, caption blocks and draggable trim handles. Split at the playhead, delete or reorder ranges, cut long pauses automatically, change speed.
- **Per-clip styling**: caption presets (or your own), font, weight, case, colours, edge, size, position, words at a time, right-to-left text; shapes 9:16, 4:5, 1:1, 16:9 or original; follow-the-speaker, fixed, blurred or fitted framing; rotate and mirror; an image or video overlay; volume and fades. *Apply to all* with undo.
- **Projects saved on your device** with undo/redo; reopen them from the start page (choose the video again) or save a small project file.
- **Export queue** with progress, cancel, retry and *Download all (.zip)*. Exports are 1080p or 720p MP4 (WebM where MP4 isn't available). A *background-safe* export (beta) renders frame by frame with WebCodecs.
- Edit the transcript (captions use your fix), search it, make a short from selected lines, download full or per-clip subtitles (`.srt`).
- Audio-only files become an **audiogram** (title, level bars, captions).
- Free and ad-free, no account, no watermark. A *Support* entry in About will take donations once they're set up (`config.js`).

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
| `app.js` | Start page, the two entry flows, transcription and picking pipeline, saved projects |
| `editor.js` | Editor: clip bin, monitor, inspector, timeline wiring, transcript, export queue |
| `project.js` | Project model (clips as ranges, per-clip styles), undo/redo, autosave, project files |
| `render.js` | The compositor shared by the Output monitor and the export (framing, captions, title, overlay) |
| `timeline.js` | Timeline canvas |
| `tools.js` | Subtitles (SRT/VTT), ZIP writer, audio peaks and pause detection |
| `fastexport.js` | Background-safe export (beta, WebCodecs + mp4-muxer) |
| `asr-worker.js` | Whisper speech-to-text in a Web Worker (transformers.js, WebGPU) |
| `clips.js` | Instant moment picker (text signals) and the local AI rater (WebLLM) |
| `export.js` | Real-time export: plays each range and records the compositor's frames with MediaRecorder |
| `reframe.js` | Face tracking for the follow-the-speaker crop (MediaPipe) |
| `decode-stream.js` | Streamed audio decoding for large MP4/MOV files (mp4box.js + WebCodecs) |

## Credits and licences

- Speech: [Whisper](https://github.com/openai/whisper) (MIT) via [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0)
- Clip rating: [Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) (Apache-2.0) and [Phi-3.5-mini-instruct](https://huggingface.co/microsoft/Phi-3.5-mini-instruct) (MIT) via [WebLLM](https://github.com/mlc-ai/web-llm) (Apache-2.0)
- Face detection: [MediaPipe](https://github.com/google-ai-edge/mediapipe) BlazeFace (Apache-2.0)
- MP4 parsing: [mp4box.js](https://github.com/gpac/mp4box.js) (BSD-3-Clause)
- MP4 writing (beta export): [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT)

Models are downloaded by the visitor's browser from their public hosts; they are not redistributed here.

OMNICLIP is released under the [MIT License](LICENSE). © 2026 BANKASI MEDIA.
