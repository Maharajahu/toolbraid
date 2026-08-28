# ToolBraid video production

This folder reproduces the 162-second English WebMCP Challenge master from the real native product capture. Private voice material, model weights, intermediate audio, and rendered outputs remain Git-ignored.

## Tested environment

- Windows 11, Python 3.12.10, Node.js 22+
- NVIDIA CUDA runtime with PyTorch 2.11.0+cu128
- Chrome 149+ with native WebMCP enabled for the product capture
- Python packages pinned in `requirements.txt`

Install a PyTorch build compatible with the local CUDA driver, then run:

```powershell
python -m pip install -r requirements-e2e.txt
python -m pip install -r video-production/requirements.txt
```

The default native recorder controls the installed Chrome build and does not download another browser. Only the optional `scripts/record-demo-video.py --runtime harness` path needs `python -m playwright install chromium`.

The voice-clone model is the Apache-2.0 `Qwen/Qwen3-TTS-12Hz-1.7B-Base` checkpoint. Place its complete files at:

```text
video-production/models/Qwen3-TTS-12Hz-1.7B-Base/
```

## Private input contract

Only use a voice recording you own or have explicit permission to clone. Provide:

```text
.private/voice/reference.wav  # source recording
.private/voice/reference.txt # exact transcript of the selected reference interval
```

The current reference interval is controlled by `REFERENCE_START` and `REFERENCE_END` in `generate-narration.py`; change both values for a different recording. No private input is sent to a remote inference service.

Scene candidates use fixed seeds and deterministic selection metadata. Scene 11 intentionally selects candidate 3 through `SCENE_CANDIDATE_OVERRIDES` because it preserves the correct product-name pronunciation; this is recorded in the ignored QC report instead of being applied as an undocumented manual copy.

## Build sequence

From the repository root, using the same Python environment throughout:

```powershell
python scripts/record-demo-video.py
python video-production/generate-narration.py --candidates 2
python video-production/master-narration.py
python video-production/generate-ambient-bed.py
python video-production/render-final-video.py
python video-production/validate-final-video.py
```

`master-narration.py` uses FabFilter Pro-L 2 through Pedalboard when the licensed local VST3 is present at its standard Windows path. If it is unavailable, the script records the reason and uses its deterministic true-peak-safe fallback. The original ambient bed is synthesized locally by `generate-ambient-bed.py`; it contains no stock music or third-party recording.

The final deliverables are:

```text
video-production/output/ToolBraid-WebMCP-Challenge-1080p.mp4
video-production/work/ToolBraid-WebMCP-Challenge.en.srt
video-production/work/final-video-validation.json
video-production/work/final-video-contact-sheet.jpg
```

The validator decodes all 4,860 video frames, measures the final AAC stream, checks the 1920×1080/30 fps/162-second contract, rejects sampled blank frames, and produces a 12-frame visual contact sheet.
