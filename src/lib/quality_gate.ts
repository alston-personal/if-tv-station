import fs from 'fs';
import path from 'path';
import type { Job } from './db';

export type QualityGateResult = {
  passed: boolean;
  checks: Record<string, { passed: boolean; details: string }>;
};

const publicPath = (url: string) => path.join(process.cwd(), 'public', url.replace(/^\//, ''));

/** Hard gate for technical requirements that must be true before publishing. */
export function runQualityGate(job: Job, finalVideoPath: string, introPath: string, teaserCreated: boolean, outroPresent: boolean): QualityGateResult {
  const checks: QualityGateResult['checks'] = {};
  const segments = job.segments || [];

  checks.final_video = {
    passed: fs.existsSync(finalVideoPath) && fs.statSync(finalVideoPath).size > 0,
    details: fs.existsSync(finalVideoPath) ? 'final video exists' : 'final video is missing'
  };

  const openingPassed = Boolean(introPath)
    ? Boolean(job.hookOverlayApplied) && !teaserCreated
    : teaserCreated;
  checks.opening = {
    passed: openingPassed,
    details: Boolean(introPath) && teaserCreated
      ? 'intro and standalone teaser were both inserted; opening would be duplicated'
      : Boolean(introPath) && job.hookOverlayApplied
        ? 'single intro with teaser caption overlay was inserted'
        : teaserCreated
          ? 'single teaser was inserted'
          : 'opening prompt/teaser is missing'
  };

  checks.hook = {
    passed: Boolean(
      job.teaserAdvice?.caption?.trim() &&
      segments[0]?.audioScript?.trim() &&
      /[！？!?]/.test(segments[0].audioScript)
    ),
    details: job.teaserAdvice?.caption?.trim() && /[！？!?]/.test(segments[0]?.audioScript || '')
      ? 'teaser caption and explicit opening hook are present'
      : 'opening needs a teaser caption and a question/startling punctuation hook'
  };

  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  checks.narrative_structure = {
    passed: Boolean(firstSegment?.foreshadowing?.trim() && lastSegment?.payoff?.trim()),
    details: firstSegment?.foreshadowing?.trim() && lastSegment?.payoff?.trim()
      ? 'opening foreshadowing and final payoff are present'
      : 'missing concrete foreshadowing in segment 1 or payoff in the final segment'
  };

  const missingSfx = segments.filter((segment) => /\[SFX\s*:/i.test(segment.audioScript) && segment.sfxApplied !== true);
  checks.sfx = {
    passed: missingSfx.length === 0,
    details: missingSfx.length === 0 ? 'all scripted SFX were mixed successfully' : `SFX mix missing in segment(s): ${missingSfx.map((s) => s.id).join(', ')}`
  };

  const missingMedia = segments.filter((segment) => !segment.videoUrl || !fs.existsSync(publicPath(segment.videoUrl)));
  checks.segment_media = {
    passed: missingMedia.length === 0,
    details: missingMedia.length === 0 ? 'all segments have media' : `missing segment media: ${missingMedia.map((s) => s.id).join(', ')}`
  };

  const shotsRequiringLipSync = segments.flatMap((segment) => (segment.shots || []).filter((shot) => Boolean(shot.videoUrl)));
  const missingLipSync = shotsRequiringLipSync.filter((shot) => shot.lipSyncApplied !== true);
  checks.lip_sync = {
    passed: missingLipSync.length === 0,
    details: missingLipSync.length === 0 ? 'all generated speaking shots passed lip-sync' : `lip-sync missing in shot(s): ${missingLipSync.map((shot) => shot.id).join(', ')}`
  };

  checks.outro_lip_sync = {
    passed: !outroPresent || job.outroLipSyncApplied === true,
    details: !outroPresent
      ? 'no outro requires lip-sync'
      : job.outroLipSyncApplied === true
        ? 'outro passed lip-sync'
        : 'outro lip-sync is missing'
  };

  return { passed: Object.values(checks).every((check) => check.passed), checks };
}
