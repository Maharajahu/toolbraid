# ToolBraid video production

This folder builds the 69.700-second English WebMCP Challenge master from owner-supplied private voice material and the pinned local toolchain. The edit is one uninterrupted 66.800-second recording of the public deployment at 1×, followed by a 2.900-second generated ToolBraid outro. It contains no diagrams, stock footage, replay, zoom, retiming, scanline, or reused browser frame.

The deployed mutation flow runs only inside ToolBraid's deterministic browser sandbox. No external production system or public status page is changed. Private voice material, model weights, intermediate audio, and rendered outputs remain Git-ignored.

## Locked deliverable

- 1920 × 1080, 30 fps, 2,091 decoded frames;
- H.264/yuv420p video and AAC 48 kHz stereo audio;
- 69.700 seconds, including a 2.900-second outro;
- English owner-authorized cloned voice with burned-in English captions;
- one public-full source interval: source frames 37–2,040, presented once at 1×;
- native WebMCP disclosure visible throughout the product capture.

The final validation report must pass every check in `validate-final-video.py`.

## Tested environment

- Windows 11, Python 3.12.10, Node.js 22+, Chrome 149+ with native WebMCP;
- NVIDIA RTX 5090 with CUDA and BF16 IndexTTS 2.5 inference;
- Python media packages pinned in `requirements.txt`;
- local licensed VST3 cleanup/mastering chain, with deterministic fallbacks.

Install the project media dependencies:

~~~powershell
python -m pip install -r requirements-e2e.txt
python -m pip install -r video-production/requirements.txt
~~~

## Public capture

The recorder is locked to `https://toolbraid-webmcp.vercel.app`. The
`public-full` target verifies six deployed provider origins, nine native tools,
one quarantined tool, seven safe results, two separately approved mutations,
the exact execution order, `release-1841`, `notice-r9`, and a verified
54-entry `sha256-chain-v1` seal.

~~~powershell
python video-production/record-public-demo.py public-full
~~~

The recorder fails closed on an alternate URL, unexpected origin, result,
approval, mutation order, audit entry, seal, or browser error. The visible
cursor is driven by trusted Playwright mouse events with one smooth,
pace-independent path per action—no wobble, overshoot, micro-correction, or
synthetic click pulse.

## Local IndexTTS 2.5 voice

Final narration uses IndexTTS 2.5 locally:

~~~text
code:    index-tts/index-tts@ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c
weights: IndexTeam/IndexTTS-2.5@c39ce5ba981572cb187443877ff559dfb246ce63
ASR:     Systran/faster-whisper-medium.en@a29b04bd15381511a9af671baec01072039215e3
license: video-production/INDEXTTS-LICENSE.txt
~~~

The private reference never leaves this machine. The final 180-word narration
is generated as three long causal passages and joined with two 120 ms
equal-power crossfades. There are no scene windows, fixed waits, or
post-generation time stretching.

Prepare an isolated checkout of `index-tts/index-tts` at the code revision
above, create its `.venv`, install its reviewed dependencies, and download the
four checkpoint files from the pinned Hugging Face revision into
`video-production/models/index-tts-src/checkpoints/`. Accept and retain
`INDEXTTS-LICENSE.txt` before using the model. These ignored prerequisites are
not redistributed by this repository. The generator fails closed unless the
checkout revision and checkpoint revision evidence match.

From PowerShell with Git, `uv`, and the Hugging Face CLI available:

~~~powershell
git clone https://github.com/index-tts/index-tts `
  video-production\models\index-tts-src
git -C video-production\models\index-tts-src checkout --detach `
  ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c

Push-Location video-production\models\index-tts-src
uv sync --frozen --python 3.11
hf download IndexTeam/IndexTTS-2.5 `
  --revision c39ce5ba981572cb187443877ff559dfb246ce63 `
  --local-dir checkpoints
Pop-Location
~~~

Generation, mastering, and offline transcription then run with:

~~~powershell
& "video-production\models\index-tts-src\.venv\Scripts\python.exe" `
  video-production\generate-indextts-narration.py
python video-production/master-narration.py --seal-config video-production/render-config.json
python video-production/transcribe-continuous-narration.py
~~~

The accepted narration gate is:

- 66.436 seconds, 48 kHz stereo PCM24, placed at the master start;
- ASR WER 0.010363 across all 180 timestamped words;
- zero pauses of 750 ms or longer and zero pauses of 1.5 seconds or longer;
- no caption overlaps, maximum nine words and 2.8 seconds per cue;
- −16.041 LUFS and −1.020 dBTP before the final video mix.

## Private input contract

Only use a voice recording you own or have explicit permission to clone:

~~~text
.private/voice/reference-11s-mono-24k.wav
.private/voice/reference.txt
~~~

The project owner supplied and authorized the reference voice. Neither the
reference nor model weights are committed.

## Mastering and render

`master-narration.py` uses the installed iZotope RX 12 De-clip, FabFilter
Pro-Q 4, oeksound soothe2, FabFilter Pro-DS, and FabFilter Pro-L 2 VST3 chain
when available. The report records every active plugin and parameter; a missing
plugin is disclosed rather than silently claimed.

~~~powershell
python video-production/generate-ambient-bed.py
python video-production/render-final-video.py --validate-only
python video-production/render-final-video.py
python video-production/validate-final-video.py
~~~

The renderer rejects diagrams, motion fields, replay, reverse, zoom, retiming,
multiple product segments, a non-public source, or an outro longer than three
seconds. The validator decodes all 2,091 frames and checks the configured
duration, streams, codecs, resolution, frame rate, audio format, loudness,
true peak, sampled blank frames, and visual QC sheet.

## Deliverables

~~~text
video-production/output/ToolBraid-WebMCP-Challenge-1080p.mp4
video-production/output/ToolBraid-WebMCP-Challenge-1080p.render-report.json
video-production/work/ToolBraid-WebMCP-Challenge.en.srt
video-production/work/narration-word-timestamps.json
video-production/work/narration-transcription-report.json
video-production/work/final-video-validation.json
video-production/work/final-video-contact-sheet.jpg
~~~

The locked master contract is 69.700 seconds / 2,091 frames. Final integrated
loudness and true peak are taken only from the validation report produced after
the matching 69.700-second render; values from earlier masters are not reused.
