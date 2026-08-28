# ToolBraid video production

This folder reproduces the 162-second English WebMCP Challenge master from a real public native-WebMCP capture plus a separately labelled local deterministic fixture sequence. Private voice material, model weights, intermediate audio, and rendered outputs remain Git-ignored.

## Tested environment

- Windows 11, Python 3.12.10, Node.js 22+
- Ubuntu/WSL2 with Python 3.11 for the isolated Chatterbox voice environment
- NVIDIA CUDA runtime with PyTorch `2.8.0+cu129` and torchaudio `2.8.0+cu129` for RTX 5090
- Chrome 149+ with native WebMCP enabled for the product capture
- Python packages pinned in `requirements.txt`

Install the Windows media dependencies with:

```powershell
python -m pip install -r requirements-e2e.txt
python -m pip install -r video-production/requirements.txt
```

The public/local recorder controls the installed Chrome build and does not download another browser. The public target is locked to `https://toolbraid-webmcp.vercel.app`, verifies the exact six provider origins and seven safe result IDs, and stops before either approval. The local target is the only capture allowed to complete deterministic fixture mutations. Both captures bake in a visible recording cursor driven by trusted Playwright mouse events.

## Local Chatterbox voice environment

Final narration uses the original English
[`ResembleAI/chatterbox`](https://github.com/resemble-ai/chatterbox) model, not
the Turbo variant. The original model exposes both `exaggeration` and
`cfg_weight`; the official tuning guide recommends lower CFG and higher
exaggeration for more expressive speech. The official source and model card are
MIT licensed, and generated audio includes Chatterbox's built-in PerTh neural
watermark.

The pipeline pins every mutable upstream used by synthesis and ASR verification:

```text
code:    resemble-ai/chatterbox@5de7a54aa4e5e2baadb0182dde554908b48b85c2
weights: ResembleAI/chatterbox@5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18
ASR:     Systran/faster-whisper-medium.en@a29b04bd15381511a9af671baec01072039215e3
```

Create the isolated environment from a fresh WSL shell. PyTorch is installed
first at the RTX-5090-compatible build; Chatterbox is then installed with
`--no-deps` so its older `torch==2.6.0` package pin cannot downgrade CUDA support.
The checkout is detached at ToolBraid's reviewed commit:

```bash
sudo apt-get update
sudo apt-get install -y git python3.11 python3.11-venv ffmpeg
python3.11 -m venv "$HOME/.venvs/toolbraid-chatterbox"
source "$HOME/.venvs/toolbraid-chatterbox/bin/activate"
python -m pip install --upgrade pip
python -m pip install torch==2.8.0 torchaudio==2.8.0 \
  --index-url https://download.pytorch.org/whl/cu129
mkdir -p "$HOME/src"
git clone https://github.com/resemble-ai/chatterbox.git "$HOME/src/toolbraid-chatterbox"
git -C "$HOME/src/toolbraid-chatterbox" checkout --detach 5de7a54aa4e5e2baadb0182dde554908b48b85c2
python -m pip install -r "/mnt/d/local ai/ToolBraid/video-production/requirements-chatterbox.txt"
python -m pip install --no-deps -e "$HOME/src/toolbraid-chatterbox"
```

Prepare only the public model assets at their exact revisions. This is the only
voice-pipeline step that needs network access:

```bash
cd "/mnt/d/local ai/ToolBraid"
python video-production/generate-chatterbox-narration.py --prepare-models
```

Normal generation loads the model and ASR exclusively from ignored local
directories. It has no server URL and no hosted inference path, so the private
reference audio is never transmitted:

```bash
cd "/mnt/d/local ai/ToolBraid"
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  python video-production/generate-chatterbox-narration.py --candidates 2
```

## Private input contract

Only use a voice recording you own or have explicit permission to clone. Provide:

```text
.private/voice/reference-11s-mono-24k.wav # selected owner-authorized prompt
.private/voice/reference.txt                # exact prompt transcript
```

`generate-chatterbox-narration.py` creates ten short semantic blocks, each under
300 characters, so emotional delivery can vary naturally without risking model
truncation. It renders at least two seeded candidates per block. Selection fails
closed above `0.06` WER, when any critical phrase is not recognized as an exact
contiguous token sequence, or when more than `1.02x` time compression would be
needed. No semantic ASR correction is allowed: a spoken "note" cannot be
silently normalized to "node".

The generator refuses a dirty Chatterbox checkout and verifies every TTS and
ASR file against the committed per-file SHA-256 manifest before loading either
model. Each cached WAV is tied to a SHA-256 request digest containing those
exact weight hashes, the pinned source revision, narration text, all Chatterbox
inference controls, device, reference audio and transcript hashes, and
post-processing settings. The cache is reused only when that digest and the
rendered-audio hash both match.

## Build sequence

Capture and final rendering run in the Windows media environment:

```powershell
python video-production/record-public-demo.py public
python video-production/record-public-demo.py local
```

Generate narration in the isolated WSL environment using the offline command
above, then return to the Windows media environment:

```powershell
python video-production/master-narration.py --seal-config video-production/render-config.json
python video-production/generate-ambient-bed.py
python video-production/render-final-video.py
python video-production/validate-final-video.py
```

The public recorder refuses alternate URLs and records discovery through the exact-effect human checkpoint without creating approvals or mutation audit events. The compositor labels every public plate `LIVE PUBLIC DEPLOYMENT` and every approving/executing plate `LOCAL DETERMINISTIC FIXTURE` so the final edit cannot imply public mutation access.

`master-narration.py` uses FabFilter Pro-L 2 through Pedalboard when the licensed local VST3 is present at its standard Windows path. If it is unavailable, the script records the reason and uses its deterministic true-peak-safe fallback. The original ambient bed is synthesized locally by `generate-ambient-bed.py`; it contains no stock music or third-party recording.

The final deliverables are:

```text
video-production/output/ToolBraid-WebMCP-Challenge-1080p.mp4
video-production/work/ToolBraid-WebMCP-Challenge.en.srt
video-production/work/final-video-validation.json
video-production/work/final-video-contact-sheet.jpg
```

The validator decodes all 4,860 video frames, measures the final AAC stream, checks the 1920×1080/30 fps/162-second contract, rejects sampled blank frames, and produces a 12-frame visual contact sheet.
