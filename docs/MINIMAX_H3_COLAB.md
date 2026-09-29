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
