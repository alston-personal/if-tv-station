import { NextResponse } from 'next/server';
import { getJob, readJobs, saveJob } from '../../../lib/db';
import { startWorker } from '../../../lib/worker';
import { finalQualityReview } from '../../../lib/creative_roles';
import { generateScriptSegments } from '../../../lib/gemini';

function resetMediaForRegeneration(job: any, segments: any[]) {
  job.segments = segments.map((segment: any) => ({
    ...segment,
    status: 'pending',
    videoUrl: undefined,
    duration: undefined,
    sfxApplied: undefined,
    shots: Array.isArray(segment.shots)
      ? segment.shots.map((shot: any) => ({
          ...shot,
          status: 'pending',
          videoUrl: undefined,
          lipSyncApplied: undefined
        }))
      : segment.shots
  }));
  job.finalVideoUrl = undefined;
  job.qualityChecks = undefined;
  job.hookOverlayApplied = undefined;
  job.outroLipSyncApplied = undefined;
}

// GET: 查詢任務狀態與進度
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      const jobs = readJobs();
      const latestActiveJob = Object.values(jobs)
        .filter((job: any) => job.status === 'brainstorming' || job.status === 'generating' || job.status === 'stitching' || job.status === 'preview_ready' || job.status === 'quality_failed')
        .sort((a: any, b: any) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];

      return NextResponse.json({
        job: latestActiveJob || null
      });
    }

    const job = getJob(id);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // 自動確保 background worker 已啟動 (如果目前有任務在進行)
    if (
      job.status === 'pending' ||
      job.status === 'brainstorming' ||
      job.status === 'generating' ||
      job.status === 'stitching' ||
      job.status === 'uploading'
    ) {
      startWorker();
    }

    return NextResponse.json(job);
  } catch (error: any) {
    console.error('[API][Jobs] GET error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}

// POST: 確認編輯後的劇本，並啟動背景影片生成任務
export async function POST(request: Request) {
  try {
    const { jobId, segments, reviewOnly, improve, publishOnly } = await request.json();
    
    if (!jobId || (!improve && !publishOnly && (!segments || !Array.isArray(segments)))) {
      if (!reviewOnly) {
        return NextResponse.json({ error: 'jobId and segments array are required' }, { status: 400 });
      }
    }

    const job = getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (publishOnly) {
      const gatePassed = Boolean(
        job.status === 'preview_ready' &&
        job.qualityChecks &&
        Object.keys(job.qualityChecks).length > 0 &&
        Object.values(job.qualityChecks).every((check: any) => check?.passed === true)
      );
      if (!gatePassed) {
        return NextResponse.json({ error: '品質門檻尚未全部通過，禁止上傳。' }, { status: 409 });
      }
      job.previewOnly = false;
      job.status = 'generating';
      job.progress = 15;
      job.error = undefined;
      saveJob(job);
      startWorker();
      return NextResponse.json(job);
    }

    if (improve) {
      if (!job.worldInfo) {
        return NextResponse.json({ error: 'Cannot improve a job without world information' }, { status: 400 });
      }

      const feedback = job.error || '技術品質未達標，請重新檢查片頭、hook、伏筆、payoff、SFX 與 lip-sync。';
      console.log(`[API][Jobs] Regenerating improved script for Job ${jobId} using quality feedback.`);
      try {
        const generated = await generateScriptSegments(job.worldInfo, job.id, job.productPlacement, job.productPlacementImgDesc, feedback);
        const improvedSegments = ((generated as any).segments || []).map((segment: any, index: number) => ({
          id: index + 1,
          visualPrompt: segment.visualPrompt || segment.segmentVisualEssence || '',
          audioScript: segment.audioScript || '',
          foreshadowing: segment.foreshadowing || '',
          payoff: segment.payoff || '',
          status: 'pending',
          shots: segment.shots || []
        }));
        if (improvedSegments.length === 0) {
          throw new Error('改善生成沒有回傳任何分鏡');
        }
        resetMediaForRegeneration(job, improvedSegments);
        job.teaserAdvice = (generated as any).teaserAdvice;
        job.status = 'generating';
        job.progress = 15;
        job.error = undefined;
        job.previewOnly = true;
        saveJob(job);
        startWorker();
        return NextResponse.json(job);
      } catch (error: any) {
        console.error(`[API][Jobs] Improved regeneration failed for ${jobId}:`, error.message);
        job.status = 'quality_failed';
        job.error = `改善重生未完成：${error.message}\n原品質報告：\n${feedback}`;
        saveJob(job);
        return NextResponse.json(job, { status: 503 });
      }
    }

    if (reviewOnly) {
      if (!job.segments || job.segments.length === 0) {
        return NextResponse.json({ error: 'Cannot review a job without segments' }, { status: 400 });
      }

      console.log(`[API][Jobs] Re-running final quality review for Job ${jobId} without regenerating media...`);
      const review = await finalQualityReview(job, jobId);

      const technicalGateStillFailed = job.status === 'quality_failed' || Object.values(job.qualityChecks || {}).some((check: any) => check?.passed === false);
      job.error = review.passed && !technicalGateStillFailed
        ? undefined
        : `品質總評未通過 (得分: ${review.overallScore}/10，要求至少 6/10)。\n詳細意見：\n${review.summary}`;
      job.status = review.passed && !technicalGateStillFailed ? 'review_ready' : technicalGateStillFailed ? 'quality_failed' : 'failed';
      job.progress = review.passed ? Math.max(job.progress || 0, 80) : job.progress || 80;
      saveJob(job);

      return NextResponse.json({
        ...job,
        review
      });
    }

    console.log(`[API][Jobs] User committed segments for Job ${jobId}. Triggering video synthesis...`);

    // A quality-failed job must regenerate its media. Reusing completed files
    // would otherwise bypass failed SFX/lip-sync checks on resume.
    if (job.status === 'quality_failed') {
      resetMediaForRegeneration(job, segments);
    }

    // 1. 更新為使用者審核/編輯後的劇本
    job.segments = segments;
    job.status = 'generating';
    job.progress = 15;
    job.error = undefined; // 清除舊錯誤
    saveJob(job);

    // 2. 啟動背景調度器
    startWorker();

    return NextResponse.json(job);
  } catch (error: any) {
    console.error('[API][Jobs] POST error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
