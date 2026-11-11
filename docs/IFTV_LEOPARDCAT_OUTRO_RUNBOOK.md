# IFTV six-second leopard-cat outro — authorized Colab Job

This is an operator runbook for the **existing** IFTV `/iftv/api/generate`
endpoint, not a new queue or a public self-service render API.

## Preconditions on the actual Oracle/IFTV runtime

- The deployed IFTV source contains the verified full Worker from
  `wip/2026-11-06` and the H3 provider.
- The AgentOS shared Camera Motion v1 compiler from merged AgentOS PR #2217
  is installed at `agentos_node/vision_studio_camera.py`.
- A pinned MiniMax H3/Colab skill is installed; its Google Colab CLI is logged
  in and `runner.py usage --json` passes. GPU access must be verified.
- An approved **single canonical Taiwanese leopard-cat** image is on disk,
  with no baked fake player controls. Do not substitute a separately generated
  mascot or the prior v0.5 handmade prototype.
- The existing Taiwan Mandarin `edge-tts` runtime is functional.
- The available lip-sync model can handle THIS stylized leopard-cat face
  (not assumed: Wav2Lip is primarily trained for human faces). The strict path
  deliberately fails instead of claiming that an FFmpeg audio mux is lip sync.
- The service's storage paths for job data and renders are writable.
- Deployment operator configures:
  - `IFTV_OUTRO_JOB_TOKEN`: a fresh nonempty operator-only secret, protected
    via the deployment's secret manager (never commit it or include in receipts).
  - `IFTV_LEOPARDCAT_MASTER_IMAGE`: **absolute path** to the approved master JPG,
    with real nonzero content.
  - `AGENTOS_CAMERA_MOTION_COMPILER`: explicit compiler path if AgentOS is not
    under `/home/ubuntu/agentmanager`.
  - `MINIMAX_H3_SKILL_DIR` / `MINIMAX_H3_RUNNER` and Colab auth per existing
    `docs/MINIMAX_H3_COLAB.md`.

Do not flip global `VIDEO_GENERATION_MODE` for all IFTV jobs: this Job
sets `videoGenerationMode=h3_colab` locally and uses the pinned
`examples/iftv-leopardcat-outro-camera-v1.yaml` file.

## Authorized job creation (from an authenticated operator)

```bash
curl -fsS -X POST 'https://<IFTV_HOST>/iftv/api/generate' \
  -H 'Content-Type: application/json' \
  -H "x-iftv-outro-token: ${IFTV_OUTRO_JOB_TOKEN}" \
  --data '{"productionTemplate":"iftv-leopardcat-outro-v1"}'
```

Server resolves the fixed canonical image, duplicates it into this Job's
standard character location, creates ONE six-second segment with the exact
spoken text `如果電視，我們下次見！`, sets `previewOnly=true`, and reuses
the existing persistent Job DB/Worker processing path.

No custom `prompt`, `segments`, `masterImage`, `outputUrl`, `publish`,
or arbitrary manifest path is accepted from the HTTP request for this
template. Unsupported template requests fail closed.

To read Job status, use the existing:
`GET https://<IFTV_HOST>/iftv/api/jobs?id=<job_id>`

The template purposely returns 403 without the operator token and 503 if
the canonical master/manifest is absent. Neither rejection creates a Job.
CI asserts these rejection behaviors at the real Next.js basePath.

## Acceptance (do not auto-approve)

1. Record actual ONE/Oracle dispatch and Colab job receipt with model,
   pinned skill version and actual GPU/usage state, redacting credentials.
2. Verify an actual 6.0s 1920×1080 H.264/AAC MP4.
3. Manually review one coherent leopard-cat identity across 0.5s, 2.5s,
   4.2s and 5.2s. Subtle push → locked speech → restrained pull/wave →
   fixed clean Traditional Chinese brand title.
4. Listen for natural Taiwanese Mandarin spoken EXACT line. Check mouth
   timing, face fidelity, no warped head/ears or inconsistent spot patterns.
   A Wav2Lip completion receipt only proves inference ran, **not** a good
   animal-face result; visual QA is mandatory.
5. Retain `previewOnly` until editorial approval. No YouTube auto-upload.
6. Deliver MP4 to existing Google Drive `IFTV-delivery` destination; read
   back remote file size / URL and obtain user playback acceptance.

## Known limits

This integration is source-code / CI verified, NOT proof that Oracle has
installed/authorized H3, Colab allocated GPU or a speaking render occurred.
If live Colab cannot generate high-quality native dialogue/lip sync, assess
the upstream H3 skill's native reference-image/audio mode before substituting
another non-audio-aware human-face model. Do not fall back to a handmade GIF.
