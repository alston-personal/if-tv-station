# MiniMax H3 / Colab video provider

IFTV can now use AgentOS' declared MiniMax H3-over-Colab capability as an optional segment-generation backend.

## Mode

Set:

```bash
VIDEO_GENERATION_MODE=h3_colab
```

The worker keeps existing modes unchanged. In H3 mode each segment:

1. creates one reference image using IFTV's existing image generator;
2. sends that image plus the segment prompt to MiniMax H3 via Google Colab;
3. receives an MP4;
4. merges the existing IFTV TTS audio with the generated video;
5. continues through IFTV's normal stitching and YouTube pipeline.

## Runtime prerequisites

The runtime node must have the upstream skill installed at a pinned revision and Google Colab CLI authenticated.

Environment knobs:

- `MINIMAX_H3_SKILL_DIR` (default `~/.codex/skills/minimax-h3-colab`)
- `MINIMAX_H3_RUNNER`
- `MINIMAX_H3_PYTHON` (default `python3`)
- `MINIMAX_H3_GPU` (default `A100`)
- `MINIMAX_H3_TIMEOUT_SECONDS` (default `10800`)
- `MINIMAX_H3_HIGH_MEM=0` to disable high-memory allocation

Quota and GPU allocation are checked at runtime. A compute-unit balance does not guarantee the requested GPU is available.

## Camera Motion IR integration for the six-second IFTV outro

AgentOS already ships the shared camera-motion compiler on main
(`agentos_node/vision_studio_camera.py`, from merged AgentOS PR #2217).
Do not implement a second camera vocabulary in IFTV.

The IFTV H3 provider now takes an **optional** camera-motion manifest and
uses the existing AgentOS compiler to validate and append the ordered
camera directions to the **actual H3 prompt file** before Colab inference.

On a node with the AgentOS source and H3 skill installed:

```bash
export VIDEO_GENERATION_MODE=h3_colab
export IFTV_CAMERA_MOTION_MANIFEST="$PWD/examples/iftv-leopardcat-outro-camera-v1.yaml"
export IFTV_H3_DURATION_SECONDS=6
# Only needed if the AgentOS source does not live at /home/ubuntu/agentmanager:
export AGENTOS_CAMERA_MOTION_COMPILER=/absolute/path/to/agentos_node/vision_studio_camera.py
```

The manifest sets **four ordered beats inside ONE continuous six-second H3
segment**, not four unrelated video generations. The compiler is reused
as-is; when it is missing, produces malformed output, or rejects an invalid
motion schema, the provider fails closed rather than stripping directions.
A camera manifest is rejected for multi-segment jobs to prevent applying
the same four-shot plan to every segment.

**Important operational limitations:**

- The main IFTV Worker still produces its reference image using its existing
  image generator. For the final mascot, pin and verify the canonical reference
  against the approved Character Blueprint; this integration alone does **not**
  prove a character lock is enforced across distinct jobs.
- The current H3 mode generates video and then independently mixes existing
  `edge-tts` Taiwan Mandarin narration. Post-muxing speech is **not**
  phoneme-accurate lip sync; do not accept it as a complete talking character.
- IFTV's `generateTtsSafe` currently falls back to **silence** on a TTS
  failure, so a format-valid MP4 is not proof that speech is present. Visually
  inspect the mouth and listen to the actual spoken words.
- For fixed-duration H3 segments, audio longer than the segment is rejected.
  A final 6.0-second 1920×1080 H.264/AAC outro is a separate runtime acceptance
  requiring an authorized ONE/Oracle job, authenticated Colab, output receipt
  and Google Drive readback. No source merge alone proves this.
- The existing Worker proceeds to YouTube publication after stitching.
  Use only an approved job/channel and production workflow. Do not invoke
  a test render with automatic public publishing unexpectedly.
