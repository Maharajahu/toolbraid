# Demo Video Production Report

**Status:** **RENDERED AND VALIDATED · PUBLIC YOUTUBE UPLOAD PENDING**

The repository includes an upload-ready, captioned demo rendered from the actual validated ToolBraid browser workflow.

## Release assets

- [`release/ToolBraid-WebMCP-Challenge-Demo.mp4`](../release/ToolBraid-WebMCP-Challenge-Demo.mp4)
- [`release/ToolBraid-WebMCP-Challenge-Demo.srt`](../release/ToolBraid-WebMCP-Challenge-Demo.srt)
- [`screenshots/toolbraid-video-thumbnail.png`](screenshots/toolbraid-video-thumbnail.png)
- [`video-validation.json`](video-validation.json)

## Technical specification

| Property | Result |
|---|---:|
| Duration | 156.9 seconds |
| Video | H.264, 1280 × 720, 20 fps |
| Audio | AAC, 48 kHz, mono |
| Integrated loudness | approximately −16.5 LUFS |
| Caption cues | 37 |
| Public challenge limit | under 3 minutes |

## What the recording shows

The capture executes the real browser workflow in sequence:

1. live provider discovery;
2. heterogeneous capability mappings;
3. adversarial metadata quarantine;
4. seven-node dependency planning;
5. safe read-only execution;
6. recommendation under budget;
7. rejected agent self-approval attempt;
8. visible human approval;
9. two reversible provider holds;
10. final provider state and audit trail.

No product step is replaced with a mocked screenshot or prerecorded backend response. The provider websites are deterministic synthetic fixtures, as disclosed in the narration and repository documentation.

## Validation

Automated media checks confirmed:

- duration remains below 180 seconds;
- one H.264 video stream and one AAC audio stream are present;
- all sampled workflow stages are visually distinct;
- no black interval of 1.5 seconds or longer exists;
- no audio silence interval of 2 seconds or longer exists;
- burned captions produce a measurable visual difference from the clean master;
- subtitle text is also supplied as a standalone SRT file.

The English narration is locally generated synthetic speech. The MP4 is technically ready for upload as-is. Re-recording the same approved script with a human voice is an optional editorial improvement, not a functional requirement.

## Remaining publication action

Upload the captioned MP4 to YouTube as **Public**, confirm audio playback and duration on the uploaded copy, then insert the YouTube URL into Devpost.
