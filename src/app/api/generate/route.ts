import { NextResponse } from 'next/server';
import { createJob, saveJob, normalizeMainCharacterDescription } from '../../../lib/db';
import { startWorker } from '../../../lib/worker';

export async function POST(request: Request) {
  try {
    const { prompt, channel, worldInfo: existingWorldInfo, productPlacement, introUrl, productPlacementImg, previewOnly, segmentCount } = await request.json();
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
