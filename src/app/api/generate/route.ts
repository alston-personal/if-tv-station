import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import { createJob, saveJob, normalizeMainCharacterDescription } from '../../../lib/db';
import { startWorker } from '../../../lib/worker';

export async function POST(request: Request) {
  try {
    const { prompt, channel, worldInfo: existingWorldInfo, productPlacement, introUrl, productPlacementImg, previewOnly, segmentCount, productionTemplate } = await request.json();

    if (productionTemplate === 'iftv-leopardcat-outro-v1') {
      // Reuse THIS Job API; no new unauthenticated render/dispatch surface.
      // Fail closed unless an explicit per-deployment operator secret is configured.
      const expected = process.env.IFTV_OUTRO_JOB_TOKEN;
      const supplied = request.headers.get('x-iftv-outro-token') || '';
      if (!expected || !supplied || !timingSafeEqual(
        Buffer.from(expected.padEnd(Math.max(expected.length, supplied.length), '\\0')),
        Buffer.from(supplied.padEnd(Math.max(expected.length, supplied.length), '\\0'))
      ) || expected.length !== supplied.length) {
        return NextResponse.json({ error: 'IFTV_OUTRO_AUTH_REQUIRED' }, { status: 403 });
      }
      const masterSource = process.env.IFTV_LEOPARDCAT_MASTER_IMAGE || '';
      const cameraManifest = path.join(process.cwd(), 'examples', 'iftv-leopardcat-outro-camera-v1.yaml');
      if (!masterSource || !path.isAbsolute(masterSource) ||
          !fs.existsSync(masterSource) || fs.statSync(masterSource).size < 10000) {
        return NextResponse.json({ error: 'IFTV_CANONICAL_MASTER_NOT_READY' }, { status: 503 });
      }
      if (!fs.existsSync(cameraManifest) || fs.statSync(cameraManifest).size === 0) {
        return NextResponse.json({ error: 'IFTV_CAMERA_MANIFEST_NOT_READY' }, { status: 503 });
      }
      if (process.env.MINIMAX_H3_SKILL_DIR === '' || process.env.VIDEO_GENERATION_MODE === 'disabled') {
        return NextResponse.json({ error: 'IFTV_H3_RUNTIME_DISABLED' }, { status: 503 });
      }

      const script = '如果電視，我們下次見！';
      const job = createJob(
        '如果電視 6 秒石虎正式片尾。唯一石虎角色母版，先微推鏡，固定鏡頭說台詞，輕拉鏡揮手，最後乾淨品牌定格；不可生成假播放介面。',
        undefined, undefined, 'none', undefined, true, 1
      );
      const masterDestination = path.join(process.cwd(), 'public', 'renders', 'characters', job.id, 'master.jpg');
      try {
        fs.mkdirSync(path.dirname(masterDestination), { recursive: true });
        fs.copyFileSync(masterSource, masterDestination);
      } catch (copyError) {
        job.status = 'failed';
        job.error = 'Canonical mascot source copy failed';
        saveJob(job);
        throw copyError;
      }
      job.worldInfo = {
        worldName: '如果電視石虎片尾',
        worldDescription: 'Single locked Taiwanese leopard-cat host in professional studio; no extra characters.',
        visualStyle: 'High quality consistent 3D mascot, cinematic studio lighting, 16:9, no fake video-player UI.',
        mainCharacterDescription: 'Same Taiwanese leopard-cat from canonical reference image, fixed facial spots, ears, eyes, paws and clothing.'
      };
      job.segments = [{
        id: 1,
        visualPrompt: 'ONE continuous six-second 3D Taiwanese leopard-cat studio outro. Subtle dolly in during intro, hold medium close-up while speaking accurate Mandarin, subtle dolly out during paw wave, finish with clean Traditional Chinese 如果電視 brand card. Keep one identity, no cut to another mascot, no fake UI.',
        audioScript: script,
        status: 'pending'
      }];
      job.videoGenerationMode = 'h3_colab';
      job.cameraMotionManifestPath = cameraManifest;
      job.h3DurationSeconds = 6;
      job.status = 'generating';
      job.progress = 15;
      job.previewOnly = true;
      saveJob(job);
      startWorker();
      return NextResponse.json({ ...job, productionTemplate, publishAllowed: false });
    }
    if (productionTemplate) {
      return NextResponse.json({ error: 'UNSUPPORTED_PRODUCTION_TEMPLATE' }, { status: 400 });
    }
    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Valid prompt string is required' }, { status: 400 });
    }

    console.log(`[API][Generate] Starting automated generation for prompt: "${prompt}" (Channel: ${channel || 'default'}, SegmentCount: ${segmentCount || 5}, Product Placement: ${productPlacement || 'none'}, Intro: ${introUrl || 'default'}, Image: ${productPlacementImg || 'none'}, PreviewOnly: ${previewOnly ? 'yes' : 'no'})`);

    // 1. 建立初始任務紀錄
    const job = createJob(prompt, channel, productPlacement, introUrl, productPlacementImg, Boolean(previewOnly), segmentCount ? Number(segmentCount) : undefined);
    job.status = 'brainstorming';
    job.progress = 5;
    if (existingWorldInfo && typeof existingWorldInfo === 'object') {
      job.worldInfo = {
        ...existingWorldInfo,
        mainCharacterDescription: normalizeMainCharacterDescription(existingWorldInfo.mainCharacterDescription)
      };
    }
    saveJob(job);

    console.log(`[API][Generate] Job ${job.id} queued. Background worker will continue processing.`);
    startWorker();
    return NextResponse.json(job);
  } catch (error: any) {
    console.error('[API][Generate] Internal error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
