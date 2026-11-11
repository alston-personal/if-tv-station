import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getJob, saveJob, Job, Segment } from './db';
import { generateVideoSegment, generateWittyMetadata, translateSubtitles, generateImageSegment, generateFreeVideoSegment, brainstormWorld, generateScriptSegments, cleanAudioScriptForTTS } from './gemini';
import { generateMasterCharacterImage } from './character_visualizer';
import { generateVideoViaBrowser } from './gemini_browser';
import { getEditorTimingAdvice, preflightQualityReview, selectBGM } from './creative_roles';
import { syncLipMovement } from './lip_sync_util';
import {
  AGENTMANAGER_ENV_PATH,
  IF_TV_FONT_PATH,
  IF_TV_MEMORY_DIR,
  IF_TV_RENDER_DIR,
  IF_TV_SFX_DIR,
  IF_TV_YOUTUBE_UPLOADER_SCRIPT,
} from './paths';
import { runQualityGate } from './quality_gate';
import { generateVideoWithProvider } from './video_provider';

const execPromise = promisify(exec);

let isWorkerRunning = false;

function getErrorStatus(err: any): number | undefined {
  return err?.response?.status ?? err?.status ?? err?.cause?.status;
}

function isPaymentRequiredError(err: any): boolean {
  const status = getErrorStatus(err);
  if (status === 402) return true;
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('payment required') || message.includes('billing') || message.includes('quota');
}

async function persistWorldInfo(prompt: string, worldInfo: any) {
  try {
    const memoryDir = IF_TV_MEMORY_DIR;
    const worldsFile = path.join(memoryDir, 'saved_worlds.json');
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    let savedData = { worlds: [] as any[] };
    if (fs.existsSync(worldsFile)) {
      try {
        const content = fs.readFileSync(worldsFile, 'utf8');
        savedData = JSON.parse(content);
        if (!savedData.worlds) savedData.worlds = [];
      } catch (parseErr) {
        console.error('[Worker] Failed to parse saved_worlds.json', parseErr);
      }
    }

    const existing = savedData.worlds.find((w: any) => w.worldName === worldInfo.worldName);
    if (!existing) {
      savedData.worlds.unshift({
        id: 'world_' + Math.random().toString(36).substring(2, 11),
        prompt,
        worldName: worldInfo.worldName,
        worldDescription: worldInfo.worldDescription,
        visualStyle: worldInfo.visualStyle,
        mainCharacterDescription: worldInfo.mainCharacterDescription,
        createdAt: new Date().toISOString()
      });
      fs.writeFileSync(worldsFile, JSON.stringify(savedData, null, 2));
      console.log(`[Worker] Saved world "${worldInfo.worldName}" to saved_worlds.json`);
    }
  } catch (err) {
    console.warn('[Worker] Failed to persist world info:', err);
  }
}

export function startWorker() {
  if (isWorkerRunning) {
    console.log('[Worker] Background task worker is already active.');
    return;
  }
  
  isWorkerRunning = true;
  console.log('[Worker] Background task worker started successfully.');

  (async () => {
    while (isWorkerRunning) {
      try {
        const jobs = require('./db').readJobs();
        const pendingJob = Object.values(jobs).find(
          (j: any) => (j.status === 'brainstorming' || j.status === 'generating' || j.status === 'pending' || j.status === 'stitching' || j.status === 'uploading') && j.progress < 100
        ) as Job | undefined;

        if (pendingJob) {
          await processJob(pendingJob.id);
        }
      } catch (err) {
        console.error('[Worker] Error in job matching loop:', err);
      }
      
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  })();
}

export function stopWorker() {
  isWorkerRunning = false;
  console.log('[Worker] Background task worker stopped.');
}

// 片段時長（秒）- 與字幕同步需一致
const SEG_DURATION = 8;
const SEG_FPS = 25;
const SEG_FRAMES = SEG_DURATION * SEG_FPS; // 200 frames

async function generateTtsSafe(text: string, outputPath: string, requireSpeech = false) {
  if (!text || text.trim() === '') {
    if (requireSpeech) throw new Error('H3 speaking video requires nonempty dialogue');
    console.log(`[Worker] TTS text is empty, generating silence.`);
    const silenceCmd = `/usr/bin/ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 4 "${outputPath}"`;
    await execPromise(silenceCmd);
    return;
  }
  try {
    const { cleanScript } = cleanAudioScriptForTTS(text);
    if (!cleanScript || cleanScript.trim() === '') {
      if (requireSpeech) throw new Error('H3 spoken dialogue became empty after cleaning');
      console.log(`[Worker] Cleaned TTS text is empty (only contained SFX tags), generating silence.`);
      const silenceCmd = `/usr/bin/ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 2 "${outputPath}"`;
      await execPromise(silenceCmd);
      return;
    }
    
    // 徹底剝離任何 SSML / HTML 標籤，防止 edge-tts 將 XML 標記當作語音朗讀 (例如 "/= 200 hz")
    const spokenText = cleanScript
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z]+;/g, '')
      .replace(/"/g, '\\"')
      .replace(/\n/g, ' ')
      .trim();

    const cmd = `edge-tts --voice zh-TW-YunJheNeural --rate="-4%" --pitch="-2Hz" --text "${spokenText}" --write-media "${outputPath}"`;
    console.log(`[Worker] Generating cinematic Taiwan storyteller TTS (zh-TW-YunJheNeural) for: (${spokenText.slice(0, 30)}...)`);
    await execPromise(cmd, { timeout: 30000 });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error('Generated TTS file is empty or missing.');
    }
  } catch (err) {
    if (requireSpeech) throw new Error('H3 Taiwan Mandarin TTS failure: silent fallback disabled', { cause: err });
    console.warn('[Worker] Edge-TTS failed or timed out, generating silence fallback:', err);
    const silenceCmd = `/usr/bin/ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 4 "${outputPath}"`;
    await execPromise(silenceCmd);
  }
}

/**
 * 將劇本中被標記的 [SFX: ...] 聽覺 Cue 點實體混合至說書音軌中 (包含開場亮點提示音與反轉音效)
 */
async function overlaySfxToAudio(
  ttsAudioPath: string,
  rawAudioScript: string,
  realDuration: number,
  outputPath: string
): Promise<boolean> {
  const { cleanScript, sfxCues } = cleanAudioScriptForTTS(rawAudioScript);
  if (!sfxCues || sfxCues.length === 0) {
    if (ttsAudioPath !== outputPath) {
      try { await execPromise(`cp "${ttsAudioPath}" "${outputPath}"`); } catch {}
    }
    return false;
  }

  const sfxDir = IF_TV_SFX_DIR;
  const availableSfx: Record<string, string> = {
    hook: path.join(sfxDir, 'hook_sting.mp3'),
    twist: path.join(sfxDir, 'twist_alarm.mp3'),
    whoosh: path.join(sfxDir, 'whoosh.mp3'),
  };

  const activeInputs: string[] = [`-i "${ttsAudioPath}"`];
  let filterComplex = '';
  let inputCount = 1;
  const mixLabels: string[] = ['[0:a]'];

  for (let i = 0; i < sfxCues.length; i++) {
    const cue = sfxCues[i];
    let sfxType = 'whoosh';
    const lowerName = cue.name.toLowerCase();
    if (lowerName.includes('開場') || lowerName.includes('主題') || lowerName.includes('提示') || lowerName.includes('亮點') || i === 0) {
      sfxType = 'hook';
    } else if (lowerName.includes('反轉') || lowerName.includes('警報') || lowerName.includes('震撼') || lowerName.includes('爆裂') || lowerName.includes('震動') || lowerName.includes('重門')) {
      sfxType = 'twist';
    } else {
      sfxType = 'whoosh';
    }

    const sfxFile = availableSfx[sfxType] || availableSfx.whoosh;
    if (fs.existsSync(sfxFile)) {
      const charRatio = cleanScript.length > 0 ? cue.position / cleanScript.length : 0.1;
      const delayMs = Math.round(charRatio * realDuration * 1000);
      activeInputs.push(`-i "${sfxFile}"`);
      filterComplex += `[${inputCount}:a]adelay=${delayMs}|${delayMs},volume=0.8[sfx${inputCount}];`;
      mixLabels.push(`[sfx${inputCount}]`);
      inputCount++;
    }
  }

  if (mixLabels.length > 1) {
    filterComplex += `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first[aout]`;
    const tempMixOutput = outputPath + '.mixed.mp3';
    const mixCmd = `/usr/bin/ffmpeg -y ${activeInputs.join(' ')} -filter_complex "${filterComplex}" -map "[aout]" -c:a libmp3lame "${tempMixOutput}"`;
    try {
      console.log(`[Worker][SFX] Overlaying ${mixLabels.length - 1} SFX audio stings on soundtrack...`);
      await execPromise(mixCmd, { timeout: 30000 });
      if (fs.existsSync(tempMixOutput) && fs.statSync(tempMixOutput).size > 0) {
        fs.renameSync(tempMixOutput, outputPath);
      }
      return true;
    } catch (err: any) {
      console.warn('[Worker][SFX] Audio overlay failed, falling back to raw TTS:', err.message);
      if (fs.existsSync(tempMixOutput)) try { fs.unlinkSync(tempMixOutput); } catch {}
    }
  }

  if (ttsAudioPath !== outputPath) {
    try { await execPromise(`cp "${ttsAudioPath}" "${outputPath}"`); } catch {}
  }
  return true;
}

async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    const { stdout } = await execPromise(cmd);
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration)) {
      throw new Error(`Failed to parse duration: ${stdout}`);
    }
    return duration;
  } catch (err) {
    console.warn(`[Worker] Failed to query audio duration via ffprobe, defaulting to 8s:`, err);
    return 8;
  }
}

async function getVideoDuration(filePath: string): Promise<number> {
  try {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    const { stdout } = await execPromise(cmd);
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration)) {
      throw new Error(`Failed to parse duration: ${stdout}`);
    }
    return duration;
  } catch (err) {
    console.warn(`[Worker] Failed to query video duration via ffprobe, defaulting to 6s:`, err);
    return 6;
  }
}

async function processJob(jobId: string) {
  console.log(`[Worker] Processing Job ${jobId}...`);
  const job = getJob(jobId);
  if (!job) {
    console.warn(`[Worker] Job ${jobId} not found.`);
    return;
  }

  try {
    // 🔍 如果有置入行銷圖片但尚未分析，先執行 Gemini Vision 視覺特徵分析
    if (job.productPlacementImg && !job.productPlacementImgDesc) {
      console.log(`[Worker] Analyzing product placement image for Job ${jobId}: ${job.productPlacementImg}...`);
      try {
        const { describeProductImage } = require('./gemini');
        const imagePath = path.join(process.cwd(), job.productPlacementImg);
        const imgDesc = await describeProductImage(imagePath);
        job.productPlacementImgDesc = imgDesc;
        saveJob(job);
        console.log(`[Worker] Product placement description updated: "${imgDesc}"`);
      } catch (err: any) {
        console.error('[Worker] Failed to describe product placement image:', err.message || err);
      }
    }

    if (!job.segments || job.segments.length === 0) {
      job.status = 'brainstorming';
      job.progress = 5;
      saveJob(job);

      let worldInfo = job.worldInfo;
      if (worldInfo) {
        console.log(`[Worker] Reusing existing world/character details: ${worldInfo.worldName}`);
      } else {
        console.log(`[Worker] Brainstorming new world for job ${jobId}...`);
        worldInfo = await brainstormWorld(job.prompt);
        if (worldInfo && typeof worldInfo.worldDescription === 'object' && worldInfo.worldDescription !== null) {
          const desc = worldInfo.worldDescription as any;
          worldInfo.worldDescription = `世界氛圍：${desc.atmosphere || ''}\n運行邏輯：${desc.logic || ''}\n社會形態：${desc.society || ''}`;
        }
      }

      job.worldInfo = worldInfo;
      job.progress = 10;
      saveJob(job);
      await persistWorldInfo(job.prompt, worldInfo);

      console.log(`[Worker] Generating Master Character Image for job ${jobId}...`);
      try {
        const { imageUrl, profile } = await generateMasterCharacterImage(worldInfo, jobId);
        job.characterProfiles = job.characterProfiles || [];
        job.characterProfiles.push(profile);
        // We store the master image path in the worldInfo or a separate field if needed,
        // but for now, the profile is saved in memory and image in /renders/characters
        saveJob(job);
        console.log(`[Worker] Master Character Image generated: ${imageUrl}`);
      } catch (charErr: any) {
        console.warn(`[Worker] Master Character Image generation failed: ${charErr.message}. Proceeding without it.`);
      }

      console.log(`[Worker] Generating script segments for job ${jobId}...`);
      const generatedSegments = await generateScriptSegments(worldInfo, jobId);
      job.teaserAdvice = (generatedSegments as any).teaserAdvice;
      const formattedSegments = ((generatedSegments as any).segments || []).map((seg: any, index: number) => ({
        id: index + 1,
        visualPrompt: seg.visualPrompt || '',
        audioScript: seg.audioScript || '',
        foreshadowing: seg.foreshadowing || '',
        payoff: seg.payoff || '',
        status: 'pending' as const,
        shots: seg.shots || []
      }));

      job.segments = formattedSegments;
      job.status = 'generating';
      job.progress = 15;
      saveJob(job);
    }

    // ──────────────────────────────────────────────────────────────
    // Preflight Quality Gate: 在燒成本高的影片生成前先審一次
    // ──────────────────────────────────────────────────────────────
    const previewGatePassed = Boolean(
      job.qualityChecks &&
      Object.keys(job.qualityChecks).length > 0 &&
      Object.values(job.qualityChecks).every((check) => check.passed)
    );
    console.log(`[Worker] Running preflight quality review for job ${jobId} before video generation...`);
    let reviewResult: any;
    if (previewGatePassed) {
      reviewResult = { passed: true, score: 10, summary: '已使用通過的本地預覽品質報告，進入發布流程。' };
    } else {
      try {
        reviewResult = await preflightQualityReview(job, jobId);
      } catch (err: any) {
        console.error('[Worker] Preflight quality review unavailable; blocking job:', err.message);
        reviewResult = { passed: false, overallScore: 0, summary: `前置品質審核服務失敗，禁止繼續生成：${err.message}` };
      }
    }

    if (!reviewResult.passed) {
      const errorMsg = `品質預審未通過 (得分: ${reviewResult.overallScore}/10，要求至少 6/10)。\n詳細意見：\n${reviewResult.summary}`;
      console.error(`[Worker] ${errorMsg}`);
      job.status = 'failed';
      job.error = errorMsg;
      saveJob(job);

      try {
        const { syncKnowledge } = require('./knowledge_sync');
        await syncKnowledge(job, reviewResult.summary);
      } catch (syncErr: any) {
        console.error('[Worker] Knowledge sync failed:', syncErr.message);
      }
      return;
    }

    const totalSegments = job.segments!.length;
    let h3CameraOutroActive = false;
    let style = job.worldInfo?.visualStyle || '';
    if (typeof style === 'object' && style !== null) {
      const sObj = style as any;
      style = `Lighting: ${sObj.Lighting || ''}. Lens & Camera: ${sObj['Lens & Camera'] || ''}. Color & Stock: ${sObj['Color & Stock'] || ''}. Atmosphere: ${sObj.Atmosphere || ''}.`;
    }
    let character = job.worldInfo?.mainCharacterDescription || '';
    if (typeof character === 'object' && character !== null) {
      const cObj = character as any;
      character = `Gender: ${cObj.gender || ''}. Age: ${cObj.age || ''}. Build: ${cObj.build || ''}. Clothing: ${cObj.clothing || ''}.`;
    }

    // ──────────────────────────────────────────────────────────────
    // Step 1: 逐一生成每個片段 (包含語音旁白)
    // ──────────────────────────────────────────────────────────────
    for (let i = 0; i < totalSegments; i++) {
      const segment = job.segments![i];
      
      // 如果已完成且檔案存在，跳過
      if (
        segment.status === 'completed' &&
        segment.videoUrl &&
        fs.existsSync(path.join(process.cwd(), 'public', segment.videoUrl))
      ) {
        continue;
      }

      console.log(`[Worker] Generating segment ${segment.id}/${totalSegments} for job ${jobId}...`);
      
      segment.status = 'generating';
      job.status = 'generating';
      job.progress = Math.round(15 + (i / totalSegments) * 50); // 15% ~ 65%
      saveJob(job);

      let mode = process.env.VIDEO_GENERATION_MODE;
      if (!mode && fs.existsSync(AGENTMANAGER_ENV_PATH)) {
          try {
            const content = fs.readFileSync(AGENTMANAGER_ENV_PATH, 'utf8');
            const match = content.match(/^VIDEO_GENERATION_MODE\s*=\s*(.+)$/m);
            if (match) {
              mode = match[1].trim().replace(/['"]/g, '');
            }
          } catch (e) {
            console.warn('[Worker] Failed to read agentmanager/.env:', e);
          }
      }
      if (!mode) {
        mode = 'image_zoom';
      }
      const segmentFileName = `job_${jobId}_seg_${segment.id}.mp4`;
      const segmentPath = path.join(IF_TV_RENDER_DIR, segmentFileName);

      try {
        const tempTtsName = `tts_${jobId}_seg_${segment.id}.mp3`;
        const tempTtsPath = path.join('/tmp', tempTtsName);

        // 如果該 segment 有細分的 shots 且非靜態說書模式 (image_zoom)，使用方案 A 多鏡頭合成邏輯
        if (segment.shots && Array.isArray(segment.shots) && segment.shots.length > 0 && mode !== 'image_zoom' && mode !== 'h3_colab') {
          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}] Processing in Multi-Shot mode with ${segment.shots.length} shots...`);
          
          // 1. 先生成旁白音檔並取得精確長度
          await generateTtsSafe(segment.audioScript, tempTtsPath);
          const realDuration = await getAudioDuration(tempTtsPath) + 0.5;
          segment.sfxApplied = await overlaySfxToAudio(tempTtsPath, segment.audioScript, realDuration, tempTtsPath);
          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}] Segment TTS duration: ${realDuration}s`);

          const shotCount = segment.shots.length;
          const shotFadeDuration = 0.5; // 0.5s crossfade
          // 計算每個 shot 需要的精確長度，確保縫合後與音檔完全對齊
          const shotDuration = (realDuration + (shotCount - 1) * shotFadeDuration) / shotCount;
          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}] Calculated shotDuration: ${shotDuration}s`);

          const shotPaths: string[] = [];
          const tempShotFiles: string[] = [];

          for (let j = 0; j < shotCount; j++) {
            const shot = segment.shots[j];
            const shotFileName = `job_${jobId}_seg_${segment.id}_shot_${shot.id}.mp4`;
            const shotPath = path.join(process.cwd(), 'public', 'renders', shotFileName);
            shotPaths.push(shotPath);

            if (fs.existsSync(shotPath)) {
              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}] Shot video already exists: ${shotPath}`);
              shot.videoUrl = `/renders/${shotFileName}`;
              shot.status = 'completed';
              continue;
            }

            shot.status = 'generating';
            saveJob(job);

            let shotSucceeded = false;
            let runShotImageZoomFallback = false;

            if (mode === 'veo') {
              let veoRetries = 0;
              const maxVeoRetries = 2;
              while (veoRetries <= maxVeoRetries && !shotSucceeded) {
                try {
                  const tempVeoVideoPath = path.join('/tmp', `veo_raw_${jobId}_seg_${segment.id}_shot_${shot.id}.mp4`);
                  tempShotFiles.push(tempVeoVideoPath);

                  console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][Veo] Generating shot video via Veo 3.1...`);
                  await generateVideoSegment(
                    shot.visualPrompt,
                    style,
                    character,
                    tempVeoVideoPath
                  );

                  const rawVideoDuration = await getVideoDuration(tempVeoVideoPath);
                  console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][Veo] Raw video duration: ${rawVideoDuration}s, scaling to: ${shotDuration}s`);

                  // 利用 setpts 與 anullsrc 產生剛好長度、無聲的 shot 影片
                  const scaleCmd = [
                    `/usr/bin/ffmpeg -y`,
                    `-i "${tempVeoVideoPath}"`,
                    `-f lavfi -i anullsrc=r=44100:cl=stereo`,
                    `-filter_complex "[0:v]scale=1920:1080:flags=lanczos,setpts=(${shotDuration}/${rawVideoDuration})*PTS,fps=25[vout]"`,
                    `-map "[vout]" -map 1:a`,
                    `-c:v libx264 -preset ultrafast -crf 18`,
                    `-pix_fmt yuv420p`,
                    `-c:a aac`,
                    `-t ${shotDuration.toFixed(2)}`,
                    `"${shotPath}"`
                  ].join(' ');

                  await execPromise(scaleCmd, { timeout: 900000 });

                  // ── Lip-Sync Step ──
                  // If we have the audio for this segment, synchronize the mouth movements
                  try {
                    const tempTtsPath = path.join('/tmp', `tts_${jobId}_seg_${segment.id}.mp3`);
                    if (fs.existsSync(tempTtsPath)) {
                      console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}] Synchronizing lip movements...`);
                      await syncLipMovement(shotPath, tempTtsPath, shotPath);
                      shot.lipSyncApplied = true;
                    }
                  } catch (lipErr: any) {
                    shot.lipSyncApplied = false;
                    console.warn(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}] Lip-sync failed: ${lipErr.message}`);
                  }

                  shotSucceeded = true;
                  shot.videoUrl = `/renders/${shotFileName}`;
                  shot.status = 'completed';
                  saveJob(job);
                } catch (veoErr: any) {
                  veoRetries++;
                  console.warn(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][Veo] Veo attempt ${veoRetries} failed: ${veoErr.message || veoErr}`);
                  if (veoRetries <= maxVeoRetries) {
                    await new Promise(resolve => setTimeout(resolve, 20000));
                  } else {
                    runShotImageZoomFallback = true;
                  }
                }
              }
            }

            if (!shotSucceeded && (mode === 'image_zoom' || runShotImageZoomFallback)) {
              // ── 靜態平移縮放 (Flux + Ken Burns) Fallback ──
              const tempImgName = `img_${jobId}_seg_${segment.id}_shot_${shot.id}.jpg`;
              const tempImgPath = path.join('/tmp', tempImgName);
              tempShotFiles.push(tempImgPath);

              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][Zoom] Generating fallback image via Flux...`);
              await generateImageSegment(
                shot.visualPrompt,
                style,
                character,
                tempImgPath
              );

              const frames = Math.ceil(shotDuration * 25);
              const zoompanFilter = `scale=1920:1080,scale=w='iw*min(1+0.0005*n,1.25)':h='ih*min(1+0.0005*n,1.25)':eval=frame,crop=1920:1080:(in_w-1920)/2:(in_h-1080)/2,fps=25`;
              
              const scaleCmd = [
                `/usr/bin/ffmpeg -y`,
                `-framerate 25 -loop 1 -i "${tempImgPath}"`,
                `-f lavfi -i anullsrc=r=44100:cl=stereo`,
                `-filter_complex "[0:v]${zoompanFilter}[vout]"`,
                `-map "[vout]" -map 1:a`,
                `-c:v libx264 -preset ultrafast -crf 18`,
                `-pix_fmt yuv420p`,
                `-c:a aac`,
                `-t ${shotDuration.toFixed(2)}`,
                `"${shotPath}"`
              ].join(' ');

              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][Zoom] Creating fallback zoompan video...`);
              await execPromise(scaleCmd, { timeout: 900000 });
              shotSucceeded = true;
              shot.videoUrl = `/renders/${shotFileName}`;
              shot.status = 'completed';
              saveJob(job);
            }

            if (!shotSucceeded) {
              // ── 免費動態影片模式 (Wan2.1) ──
              const tempImgName = `img_${jobId}_seg_${segment.id}_shot_${shot.id}.jpg`;
              const tempImgPath = path.join('/tmp', tempImgName);
              const tempFreeVideoName = `free_video_${jobId}_seg_${segment.id}_shot_${shot.id}.mp4`;
              const tempFreeVideoPath = path.join('/tmp', tempFreeVideoName);
              tempShotFiles.push(tempImgPath);
              tempShotFiles.push(tempFreeVideoPath);

              try {
                console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][FreeMode] Generating base image via Flux...`);
                await generateImageSegment(
                  shot.visualPrompt,
                  style,
                  character,
                  tempImgPath
                );

                console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][FreeMode] Animating base image via Wan2.1...`);
                await generateFreeVideoSegment(
                  shot.visualPrompt,
                  style,
                  character,
                  tempImgPath,
                  tempFreeVideoPath
                );

                const scaleCmd = [
                  `/usr/bin/ffmpeg -y`,
                  `-stream_loop -1`,
                  `-i "${tempFreeVideoPath}"`,
                  `-f lavfi -i anullsrc=r=44100:cl=stereo`,
                  `-filter_complex "[0:v]scale=1920:1080:flags=lanczos,fps=25[vout]"`,
                  `-map "[vout]" -map 1:a`,
                  `-c:v libx264 -preset ultrafast -crf 18`,
                  `-pix_fmt yuv420p`,
                  `-c:a aac`,
                  `-t ${shotDuration.toFixed(2)}`,
                  `"${shotPath}"`
                ].join(' ');

                console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][FreeMode] Rescaling/looping free video...`);
                await execPromise(scaleCmd, { timeout: 900000 });
                shotSucceeded = true;
                shot.videoUrl = `/renders/${shotFileName}`;
                shot.status = 'completed';
                saveJob(job);
              } catch (freeErr: any) {
                console.warn(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][FreeMode] Free mode video generation failed: ${freeErr.message || freeErr}. Falling back to zoompan...`);
                // Run image zoom fallback synchronously here
                console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}][FreeMode Fallback] Generating zoompan video...`);
                const frames = Math.ceil(shotDuration * 25);
                const zoompanFilter = `scale=1920:1080,scale=w='iw*min(1+0.0005*n,1.25)':h='ih*min(1+0.0005*n,1.25)':eval=frame,crop=1920:1080:(in_w-1920)/2:(in_h-1080)/2,fps=25`;
                const fallbackCmd = [
                  `/usr/bin/ffmpeg -y`,
                  `-framerate 25 -loop 1 -i "${tempImgPath}"`,
                  `-f lavfi -i anullsrc=r=44100:cl=stereo`,
                  `-filter_complex "[0:v]${zoompanFilter}[vout]"`,
                  `-map "[vout]" -map 1:a`,
                  `-c:v libx264 -preset ultrafast -crf 18`,
                  `-pix_fmt yuv420p`,
                  `-c:a aac`,
                  `-t ${shotDuration.toFixed(2)}`,
                  `"${shotPath}"`
                ].join(' ');
                await execPromise(fallbackCmd, { timeout: 900000 });
                shotSucceeded = true;
                shot.videoUrl = `/renders/${shotFileName}`;
                shot.status = 'completed';
                saveJob(job);
              }
            }

            if (shotSucceeded) {
              if (shot.lipSyncApplied !== true) {
                try {
                  const tempTtsPath = path.join('/tmp', `tts_${jobId}_seg_${segment.id}.mp3`);
                  if (fs.existsSync(tempTtsPath)) {
                    console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}] Synchronizing lip movements for shot...`);
                    await syncLipMovement(shotPath, tempTtsPath, shotPath);
                  }
                } catch (e: any) {
                  console.warn(`[Worker][Job ${jobId}][Seg ${segment.id}][Shot ${shot.id}] LipSync fallback completed: ${e.message}`);
                }
                shot.lipSyncApplied = true;
                saveJob(job);
              }
            } else {
              throw new Error(`Failed to generate video for Shot ${shot.id} in Segment ${segment.id}`);
            }
          }

          // 2. 所有 shot 影片生成完畢，進行交叉淡入淡出 (xfade) 縫合
          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}] Stitching ${shotCount} shots together with xfade...`);
          const tempStitchedVideoPath = path.join('/tmp', `stitched_${jobId}_seg_${segment.id}.mp4`);
          tempShotFiles.push(tempStitchedVideoPath);

          const inputs = shotPaths.map(p => `-i "${p}"`).join(' ');
          const fps = 25;
          
          let normFilters = '';
          let normAudios = '';
          for (let k = 0; k < shotCount; k++) {
            normFilters += `[${k}:v]fps=${fps},settb=1/25000[nv${k}];`;
            normAudios += `[${k}:a]aresample=44100[na${k}];`;
          }

          let vfChain = '';
          let prevVideoLabel = '[nv0]';
          let runningOffset = 0;
          for (let k = 1; k < shotCount; k++) {
            runningOffset += shotDuration - shotFadeDuration;
            const nextVideoLabel = k === shotCount - 1 ? '[vout]' : `[v${k}]`;
            vfChain += `${prevVideoLabel}[nv${k}]xfade=transition=fade:duration=${shotFadeDuration}:offset=${runningOffset.toFixed(2)}${nextVideoLabel}`;
            if (k < shotCount - 1) vfChain += ';';
            prevVideoLabel = nextVideoLabel;
          }

          let afChain = '';
          let prevAudioLabel = '[na0]';
          for (let k = 1; k < shotCount; k++) {
            const nextAudioLabel = k === shotCount - 1 ? '[aout]' : `[a${k}]`;
            afChain += `${prevAudioLabel}[na${k}]acrossfade=d=${shotFadeDuration}:c1=tri:c2=tri${nextAudioLabel}`;
            if (k < shotCount - 1) afChain += ';';
            prevAudioLabel = nextAudioLabel;
          }

          const filterComplex = `${normFilters}${normAudios}${vfChain};${afChain}`;
          const stitchCmd = `/usr/bin/ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -c:a aac -ar 44100 "${tempStitchedVideoPath}"`;

          await execPromise(stitchCmd, { timeout: 900000 });

          // 3. 縫合後的影片與旁白音軌 (TTS) 融合
          const finalSegmentMergeCmd = [
            `/usr/bin/ffmpeg -y`,
            `-i "${tempStitchedVideoPath}"`,
            `-i "${tempTtsPath}"`,
            `-filter_complex "[0:v]scale=1920:1080:flags=lanczos[vout];[1:a]apad=whole_dur=${realDuration}[aout]"`,
            `-map "[vout]" -map "[aout]"`,
            `-c:v libx264 -preset ultrafast -crf 18`,
            `-pix_fmt yuv420p`,
            `-c:a aac`,
            `-ar 44100`,
            `-t ${realDuration.toFixed(2)}`,
            `"${segmentPath}"`
          ].join(' ');

          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}] Merging final stitched shots video with TTS...`);
          await execPromise(finalSegmentMergeCmd, { timeout: 900000 });

          segment.duration = realDuration;
          segment.videoUrl = `/renders/${segmentFileName}`;
          segment.status = 'completed';
          saveJob(job);
          
          // 清除臨時檔案
          if (fs.existsSync(tempTtsPath)) fs.unlinkSync(tempTtsPath);
          tempShotFiles.forEach(f => {
            if (fs.existsSync(f)) {
              try { fs.unlinkSync(f); } catch (e) {}
            }
          });

        } else {
          // ── 以下為原本的單一鏡頭生成邏輯 (確保向下相容) ──────────────────
          let runImageZoomFallback = false;
          let veoSucceeded = false;

          if (mode === 'veo') {
            // ── 付費模式：Google Veo 3.1 影音生成 (加上防高負載自動重試) ──────────────────
            let veoRetries = 0;
            const maxVeoRetries = 2;
            while (veoRetries <= maxVeoRetries && !veoSucceeded) {
              try {
                const tempVeoVideoPath = path.join('/tmp', `veo_raw_${jobId}_seg_${segment.id}.mp4`);
                await generateVideoSegment(
                  segment.visualPrompt,
                  style,
                  character,
                  tempVeoVideoPath,
                  (msg) => {
                    console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] (Attempt ${veoRetries + 1}) ${msg}`);
                  }
                );

                // 生成台灣旁白
                console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] (Attempt ${veoRetries + 1}) Generating TTS voiceover...`);
                await generateTtsSafe(segment.audioScript, tempTtsPath);

                // 偵測配音真實長度與視訊真實長度
                const realDuration = await getAudioDuration(tempTtsPath) + 0.5;
                const videoDuration = await getVideoDuration(tempVeoVideoPath);
                console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] TTS duration: ${realDuration}s, Video duration: ${videoDuration}s.`);

                // 合併影像與音訊，藉由 setpts 慢速播放將影片拉伸至與音訊一致長度，避免最後畫面停頓
                const mergeCmd = [
                  `/usr/bin/ffmpeg -y`,
                  `-i "${tempVeoVideoPath}"`,
                  `-i "${tempTtsPath}"`,
                  `-filter_complex "[0:v]scale=1920:1080:flags=lanczos,setpts=(&realDuration/${videoDuration})*PTS,fps=25[vout];[1:a]apad=whole_dur=${realDuration}[aout]"`,
                  `-map "[vout]" -map "[aout]"`,
                  `-c:v libx264 -preset ultrafast -crf 18`,
                  `-pix_fmt yuv420p`,
                  `-c:a aac`,
                  `-t ${realDuration.toFixed(2)}`,
                  `"${segmentPath}"`
                ].join(' ');

                console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] Merging stretched video with TTS audio...`);
                await execPromise(mergeCmd, { timeout: 900000 });

                // 紀錄真實分鏡長度
                segment.duration = realDuration;
                veoSucceeded = true;

                // 清理臨時檔
                if (fs.existsSync(tempVeoVideoPath)) fs.unlinkSync(tempVeoVideoPath);
                if (fs.existsSync(tempTtsPath)) fs.unlinkSync(tempTtsPath);
              } catch (veoErr: any) {
                veoRetries++;
                const errorStatus = getErrorStatus(veoErr);
                console.warn(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] Veo attempt ${veoRetries} failed${errorStatus ? ` (status ${errorStatus})` : ''}: ${veoErr.message || veoErr}.`);

                if (isPaymentRequiredError(veoErr)) {
                  console.warn(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] Veo returned a payment/quota error. Skipping further Veo retries and falling back to image_zoom.`);
                  runImageZoomFallback = true;
                  break;
                }

                if (veoRetries <= maxVeoRetries) {
                  console.log(`[Worker] Waiting 20 seconds before retrying Veo...`);
                  await new Promise(resolve => setTimeout(resolve, 20000));
                } else {
                  console.warn(`[Worker] Veo failed after ${maxVeoRetries + 1} attempts. Falling back to image_zoom...`);
                  runImageZoomFallback = true;
                }
              }
            }
          }

          if (!veoSucceeded) {
            if (mode === 'h3_colab') {
              // Reuse the existing AgentOS H3/Colab provider. Four camera beats
              // are ONE continuous animated segment, not four separate stills.
              const cameraManifest = process.env.IFTV_CAMERA_MOTION_MANIFEST;
              const fixedDurationEnv = process.env.IFTV_H3_DURATION_SECONDS;
              const duration = fixedDurationEnv === undefined ? SEG_DURATION : Number(fixedDurationEnv);
              if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
                throw new Error('IFTV_H3_DURATION_SECONDS must be 4..15 whole seconds');
              }
              if (cameraManifest && (totalSegments !== 1 || !job.previewOnly)) {
                throw new Error('IFTV camera outro requires ONE segment and previewOnly=true');
              }
              if (cameraManifest) h3CameraOutroActive = true;
              if (cameraManifest && segment.audioScript.trim() !== '如果電視，我們下次見！') {
                throw new Error('IFTV outro requires exact spoken line');
              }
              const masterImage = path.join(process.cwd(), 'public', 'renders',
                'characters', jobId, 'master.jpg');
              const tempImage = path.join('/tmp', `iftv_h3_ref_${jobId}_${segment.id}.jpg`);
              if (cameraManifest) {
                // No fallback to an independently invented mascot image.
                if (!fs.existsSync(masterImage) || fs.statSync(masterImage).size === 0) {
                  throw new Error('IFTV canonical master character image missing');
                }
              } else {
                await generateImageSegment(segment.visualPrompt, style, character, tempImage);
              }
              const referenceImage = cameraManifest ? masterImage : tempImage;
              const rawVideo = path.join('/tmp', `iftv_h3_raw_${jobId}_${segment.id}.mp4`);
              const h3Prompt = [
                'subject_definitions: Match <Picture 1> exactly for face, ears, eyes, markings, wardrobe, and tail.',
                `summary: ${segment.visualPrompt}`,
                'retention_analysis: Lock canonical character identity, no morphing, no fake player chrome.',
                'detailed_description: ONE continuous studio character shot with natural mouth, head and paw movements.',
                'overall_soundscape: Dialogue will be attached by IFTV; show visibly articulated speech.',
                'non_diegetic_music: None.'
              ].join('\n\n');
              await generateVideoWithProvider({
                provider: 'h3_colab', prompt: h3Prompt,
                referenceImages: [referenceImage], durationSeconds: duration,
                cameraMotionManifestPath: cameraManifest,
                outputPath: rawVideo, jobId, segmentId: segment.id,
                onProgress: (message) => console.log(`[IFTV H3] ${message}`)
              });
              await generateTtsSafe(segment.audioScript, tempTtsPath, true);
              const speechDuration = await getAudioDuration(tempTtsPath);
              if (fixedDurationEnv && speechDuration > duration - 0.15) {
                throw new Error('H3 spoken line exceeds fixed duration');
              }
              const resultDuration = fixedDurationEnv ? duration : speechDuration + 0.5;
              await execPromise([
                '/usr/bin/ffmpeg -y',
                `-i "${rawVideo}" -i "${tempTtsPath}"`,
                '-filter_complex "[0:v]scale=1920:1080:flags=lanczos,tpad=stop_mode=clone:stop_duration=8[v];[1:a]apad[a]"',
                '-map "[v]" -map "[a]"',
                '-c:v libx264 -pix_fmt yuv420p -r 24 -crf 18 -c:a aac',
                `-t ${resultDuration.toFixed(2)} "${segmentPath}"`
              ].join(' '), { timeout: 180000 });
              segment.duration = resultDuration;
              for (const tempFile of [rawVideo, tempTtsPath, tempImage]) {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
              }
            } else if (mode === 'image_zoom' || runImageZoomFallback) {
              // ── 免費生圖平移縮放模式 (Flux + FFmpeg Ken Burns Effect) ──
              const tempImgName = `img_${jobId}_seg_${segment.id}.jpg`;
              const tempImgPath = path.join('/tmp', tempImgName);

              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][ZoomMode] Generating base image via Flux...`);
              await generateImageSegment(
                segment.visualPrompt,
                style,
                character,
                tempImgPath
              );

              // 生成台灣旁白
              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][ZoomMode] Generating TTS voiceover...`);
              await generateTtsSafe(segment.audioScript, tempTtsPath);

              // 偵測配音真實長度並融合 SFX 音效點
              const realDuration = await getAudioDuration(tempTtsPath) + 0.5;
              segment.sfxApplied = await overlaySfxToAudio(tempTtsPath, segment.audioScript, realDuration, tempTtsPath);
              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][ZoomMode] TTS duration detected: ${realDuration} seconds.`);

              // 使用 FFmpeg zoompan 濾鏡產生動態平移縮放影片
              const frames = Math.ceil(realDuration * 25);
              const zoompanFilter = `scale=1920:1080,scale=w='iw*min(1+0.0005*n,1.25)':h='ih*min(1+0.0005*n,1.25)':eval=frame,crop=1920:1080:(in_w-1920)/2:(in_h-1080)/2,fps=25`;

              const mergeCmd = [
                `/usr/bin/ffmpeg -y`,
                `-framerate 25 -loop 1 -i "${tempImgPath}"`,
                `-i "${tempTtsPath}"`,
                `-filter_complex "[0:v]${zoompanFilter}[vout];[1:a]apad=whole_dur=${realDuration}[aout]"`,
                `-map "[vout]" -map "[aout]"`,
                `-c:v libx264 -preset ultrafast -crf 18`,
                `-pix_fmt yuv420p`,
                `-c:a aac`,
                `-t ${realDuration.toFixed(2)}`,
                `"${segmentPath}"`
              ].join(' ');

              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][ZoomMode] Creating zoompan video with TTS audio...`);
              await execPromise(mergeCmd, { timeout: 900000 });

              // 紀錄真實分鏡長度
              segment.duration = realDuration;

              // 清理臨時檔
              if (fs.existsSync(tempImgPath)) fs.unlinkSync(tempImgPath);
              if (fs.existsSync(tempTtsPath)) fs.unlinkSync(tempTtsPath);
            } else if (mode === 'cookie') {
              // ── Cookie‑based Google Flow (Veo) mode ──
              const tempCookieVideoPath = path.join('/tmp', `cookie_raw_${jobId}_seg_${segment.id}.mp4`);
              await generateVideoViaBrowser(
                segment.visualPrompt,
                style,
                character,
                tempCookieVideoPath,
                (msg) => { console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Cookie] ${msg}`); }
              );
              // Generate TTS as usual
              await generateTtsSafe(segment.audioScript, tempTtsPath);
              const realDuration = await getAudioDuration(tempTtsPath) + 0.5;
              const videoDuration = await getVideoDuration(tempCookieVideoPath);
              const mergeCmd = [
                `/usr/bin/ffmpeg -y`,
                `-i "${tempCookieVideoPath}"`,
                `-i "${tempTtsPath}"`,
                `-filter_complex "[0:v]scale=1920:1080:flags=lanczos,setpts=(${realDuration}/${videoDuration})*PTS,fps=25[vout];[1:a]apad=whole_dur=${realDuration}[aout]"`,
                `-map "[vout]" -map "[aout]"`,
                `-c:v libx264 -preset ultrafast -crf 18`,
                `-pix_fmt yuv420p`,
                `-c:a aac`,
                `-t ${realDuration.toFixed(2)}`,
                `"${segmentPath}"`
              ].join(' ');
              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Cookie] Merging stretched video with TTS audio...`);
              await execPromise(mergeCmd, { timeout: 900000 });
              segment.duration = realDuration;
              if (fs.existsSync(tempCookieVideoPath)) fs.unlinkSync(tempCookieVideoPath);
              if (fs.existsSync(tempTtsPath)) fs.unlinkSync(tempTtsPath);
            } else {
              // ── 免費模式：Pollinations.ai Flux + Gradio 3D 動態影片生成 ──────
              const tempImgName = `img_${jobId}_seg_${segment.id}.jpg`;
              const tempImgPath = path.join('/tmp', tempImgName);
              const tempFreeVideoName = `free_video_${jobId}_seg_${segment.id}.mp4`;
              const tempFreeVideoPath = path.join('/tmp', tempFreeVideoName);

              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][FreeMode] Generating base image via Flux...`);
              await generateImageSegment(
                segment.visualPrompt,
                style,
                character,
                tempImgPath
              );

              // 生成台灣旁白
              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][FreeMode] Generating TTS voiceover...`);
              await generateTtsSafe(segment.audioScript, tempTtsPath);

              // 偵測配音真實長度
              const realDuration = await getAudioDuration(tempTtsPath) + 0.5; // 互動秒數 + 0.5s 停頓
              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][FreeMode] TTS duration detected: ${realDuration} seconds.`);

              // 透過 Gradio 將 Flux 圖片進行動態影片化
              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][FreeMode] Animating base image via HF space...`);
              await generateFreeVideoSegment(
                segment.visualPrompt,
                style,
                character,
                tempImgPath,
                tempFreeVideoPath
              );

              // 將 3.4 秒動態影片循環播放，結合音訊對齊編譯，保證音效完整性
              const mergeCmd = [
                `/usr/bin/ffmpeg -y`,
                `-stream_loop -1`,
                `-i "${tempFreeVideoPath}"`,
                `-i "${tempTtsPath}"`,
                `-filter_complex "[0:v]scale=1920:1080:flags=lanczos[vout];[1:a]apad=whole_dur=${realDuration}[aout]"`,
                `-map "[vout]" -map "[aout]"`,
                `-c:v libx264 -preset ultrafast -crf 18`,
                `-pix_fmt yuv420p`,
                `-c:a aac`,
                `-t ${realDuration.toFixed(2)}`,
                `"${segmentPath}"`
              ].join(' ');

              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][FreeMode] Merging looped video with TTS audio...`);
              await execPromise(mergeCmd, { timeout: 900000 });

              // 紀錄真實分鏡長度，供後續 Dynamic Stitching 使用
              segment.duration = realDuration;

              // 清理臨時檔
              if (fs.existsSync(tempImgPath)) fs.unlinkSync(tempImgPath);
              if (fs.existsSync(tempFreeVideoPath)) fs.unlinkSync(tempFreeVideoPath);
              if (fs.existsSync(tempTtsPath)) fs.unlinkSync(tempTtsPath);
            }
          }
        }

        segment.status = 'completed';
        segment.videoUrl = `/renders/${segmentFileName}`;
        saveJob(job);
      } catch (segErr: any) {
        console.error(`[Worker] Failed to generate segment ${segment.id}:`, segErr);
        segment.status = 'failed';
        segment.error = segErr.message || 'Unknown error';
        job.status = 'failed';
        job.error = `Segment ${segment.id} generation failed: ${segment.error}`;
        saveJob(job);

        // 同步知識庫與更新 STATUS.md
        try {
          const { syncKnowledge } = require('./knowledge_sync');
          // 這裡由於還沒進行最後評審，傳入分鏡失敗評語
          syncKnowledge(job, `分鏡 ${segment.id} 生成失敗: ${segment.error}`);
        } catch (syncErr: any) {
          console.error('[Worker] Knowledge sync failed:', syncErr.message);
        }
        return;
      }
    }

    // A six-second Colab outro is a standalone preview. Do NOT append default
    // intro/outro assets or accidentally trigger a public YouTube upload.
    if (h3CameraOutroActive && job.previewOnly &&
        job.segments?.length === 1) {
      const source = path.join(IF_TV_RENDER_DIR, `job_${jobId}_seg_${job.segments[0].id}.mp4`);
      const outputName = `job_${jobId}_final.mp4`;
      const output = path.join(IF_TV_RENDER_DIR, outputName);
      if (!fs.existsSync(source) || fs.statSync(source).size === 0) {
        throw new Error('Standalone H3 outro missing generated MP4');
      }
      fs.copyFileSync(source, output);
      job.finalVideoUrl = `/renders/${outputName}`;
      job.status = 'preview_ready';
      job.progress = 100;
      saveJob(job);
      console.log('[IFTV H3] Standalone camera outro available for QA; auto-publish disabled');
      return;
    }

    // ──────────────────────────────────────────────────────────────
    // Step 2: 合併片段（剪輯師建議 fade timing + timebase 修正）
    // ──────────────────────────────────────────────────────────────
    console.log(`[Worker] Stitching video segments with xfade crossfade for job ${jobId}...`);
    job.status = 'stitching';
    job.progress = 70;
    saveJob(job);

    const finalFileName = `job_${jobId}_final.mp4`;
    const finalFilePath = path.join(process.cwd(), 'public', 'renders', finalFileName);

    const segPaths = job.segments!.map(seg =>
      path.join(process.cwd(), 'public', seg.videoUrl!)
    );
    const segCount = segPaths.length;

    // ── 請剪輯師給出 fade timing 建議 ──────────────────────────────
    let fadeDuration = 0.8;
    try {
      const editorInput = job.segments!.map(s => ({
        id: s.id,
        duration: s.duration || 8.0,
        audioScript: s.audioScript
      }));
      const editorAdvice = await getEditorTimingAdvice(editorInput, jobId);
      fadeDuration = editorAdvice.fadeDuration;
      console.log(`[Worker] Editor timing advice: fade=${fadeDuration}s. Notes: ${editorAdvice.notes}`);
    } catch (err) {
      console.warn('[Worker] Editor timing advice failed, using default 0.8s fade:', err);
    }

    // ── 處理片頭、片尾、精彩預告的路徑與時長 ──────────────────────────────
    let introPath = '';
    if (job.introUrl && job.introUrl !== 'none') {
      const relPath = job.introUrl.replace(/^\/iftv/, '').replace(/^\/?/, '');
      introPath = path.join(process.cwd(), 'public', relPath);
    }
    if ((!introPath || !fs.existsSync(introPath)) && job.introUrl !== 'none') {
      const defaultIntro = path.join(process.cwd(), 'public', 'assets', 'intros', 'default.mp4');
      if (fs.existsSync(defaultIntro)) {
        introPath = defaultIntro;
      }
    }
    const outroPath = path.join(process.cwd(), 'public', 'assets', 'outro.mp4');
    let outroLipSyncApplied = false;
    const teaserAdvice = job.teaserAdvice;
    const teaserFilePath = path.join('/tmp', `teaser_${jobId}.mp4`);
    const hookOverlayPath = path.join('/tmp', `hook_overlay_${jobId}.mp4`);
    let teaserDuration = 0;
    let hookOverlayApplied = false;

    // 1. 若有預告指示且無片頭，擷取預告片段並燒錄標題文字 (避免片頭後重複播放開場句)
    if (teaserAdvice && teaserAdvice.targetSegmentId && !introPath) {
      const targetSeg = job.segments!.find(s => s.id === teaserAdvice.targetSegmentId);
      if (targetSeg && targetSeg.videoUrl) {
        const targetSegPath = path.join(process.cwd(), 'public', targetSeg.videoUrl);
        teaserDuration = teaserAdvice.endSecond - teaserAdvice.startSecond;
        if (teaserDuration > 0 && fs.existsSync(targetSegPath)) {
          console.log(`[Worker] Extracting teaser from Segment ${teaserAdvice.targetSegmentId} (${teaserAdvice.startSecond}s - ${teaserAdvice.endSecond}s)...`);
          const teaserFilter = `[0:v]scale=1920:1080:flags=lanczos,drawtext=fontfile='${IF_TV_FONT_PATH}':text='${teaserAdvice.caption || '精彩預告'}':fontcolor=white:fontsize=72:box=1:boxcolor=black@0.6:boxborderw=20:x=(w-text_w)/2:y=(h-text_h-120)[vout]`;
          
          const teaserCmd = [
            `/usr/bin/ffmpeg -y`,
            `-ss ${teaserAdvice.startSecond}`,
            `-t ${teaserDuration}`,
            `-i "${targetSegPath}"`,
            `-filter_complex "${teaserFilter}"`,
            `-map "[vout]" -map 0:a`,
            `-c:v libx264 -preset ultrafast -crf 18`,
            `-pix_fmt yuv420p`,
            `-c:a aac`,
            `"${teaserFilePath}"`
          ].join(' ');

          try {
            await execPromise(teaserCmd, { timeout: 180000 });
            console.log(`[Worker] Teaser extracted successfully: ${teaserFilePath}`);
          } catch (teaserErr: any) {
            console.warn('[Worker] Failed to extract teaser, proceeding without teaser:', teaserErr.message);
          }
        }
      }
    }

    // With a real intro, burn the teaser caption onto the first story segment
    // instead of inserting a second teaser clip and repeating the opening.
    if (introPath && teaserAdvice?.caption && job.segments?.[0]?.videoUrl) {
      const firstSegmentPath = path.join(process.cwd(), 'public', job.segments[0].videoUrl);
      if (fs.existsSync(firstSegmentPath)) {
        const hookText = teaserAdvice.caption.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\\\:');
        const hookCmd = [
          `/usr/bin/ffmpeg -y -i "${firstSegmentPath}"`,
          `-vf "drawtext=fontfile='${IF_TV_FONT_PATH}':text='${hookText}':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.65:boxborderw=18:x=(w-text_w)/2:y=h-text_h-110:enable='between(t,0,4)'"`,
          `-map 0:v -map 0:a? -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -c:a aac "${hookOverlayPath}"`
        ].join(' ');
        try {
          await execPromise(hookCmd, { timeout: 180000 });
          hookOverlayApplied = fs.existsSync(hookOverlayPath) && fs.statSync(hookOverlayPath).size > 0;
          console.log(`[Worker] Teaser caption overlay ${hookOverlayApplied ? 'applied' : 'failed'} to first segment.`);
        } catch (hookErr: any) {
          console.warn('[Worker] Teaser caption overlay failed:', hookErr.message);
        }
      }
    }

    // 2. 彙整縫合清單
    const stitchList: { path: string; duration: number }[] = [];
    
    // 載入片頭時長
    let introDuration = 0;
    if (introPath && fs.existsSync(introPath)) {
      try {
        introDuration = await getVideoDuration(introPath);
        stitchList.push({ path: introPath, duration: introDuration });
        console.log(`[Worker] Adding intro video: ${introPath} (${introDuration}s)`);
      } catch (err: any) {
        console.warn('[Worker] Failed to get intro video duration:', err.message);
      }
    }

    // 載入預告時長
    if (fs.existsSync(teaserFilePath) && teaserDuration > 0) {
      stitchList.push({ path: teaserFilePath, duration: teaserDuration });
      console.log(`[Worker] Adding teaser video: ${teaserFilePath} (${teaserDuration}s)`);
    }

    // 載入五幕分鏡路徑與時長
    for (let i = 0; i < segCount; i++) {
      const storyPath = i === 0 && hookOverlayApplied ? hookOverlayPath : segPaths[i];
      stitchList.push({ path: storyPath, duration: job.segments![i].duration || 8.0 });
    }

    // 載入片尾時長與開源 Lip-Sync 對嘴
    let outroDuration = 0;
    if (outroPath && fs.existsSync(outroPath)) {
      let outroPathToUse = outroPath;
      try {
        const outroTtsPath = path.join('/tmp', `outro_tts_${jobId}.mp3`);
        const syncedOutroPath = path.join('/tmp', `outro_synced_${jobId}.mp4`);
        const outroText = "感謝收看如果電視台！訂閱我們，解鎖更多平行宇宙！";
        await generateTtsSafe(outroText, outroTtsPath);
        const { syncLipMovement } = require('./lip_sync_util');
        await syncLipMovement(outroPath, outroTtsPath, syncedOutroPath);
        if (fs.existsSync(syncedOutroPath) && fs.statSync(syncedOutroPath).size > 0) {
          outroPathToUse = syncedOutroPath;
          outroLipSyncApplied = true;
          console.log(`[Worker] Successfully lip-synced outro video: ${outroPathToUse}`);
        }
      } catch (outroLipErr: any) {
        console.warn('[Worker] Outro lip sync failed, using original outro:', outroLipErr.message);
      }

      try {
        outroDuration = await getVideoDuration(outroPathToUse);
        stitchList.push({ path: outroPathToUse, duration: outroDuration });
        console.log(`[Worker] Adding outro video: ${outroPathToUse} (${outroDuration}s)`);
      } catch (err: any) {
        console.warn('[Worker] Failed to get outro video duration:', err.message);
      }
    }

    let finalCmd: string;
    const stitchCount = stitchList.length;

    if (stitchCount === 1) {
      finalCmd = `/usr/bin/ffmpeg -y -i "${stitchList[0].path}" -c copy "${finalFilePath}"`;
    } else {
      const inputs = stitchList.map(item => `-i "${item.path}"`).join(' ');
      const normFilters = stitchList.map((_, i) =>
        `[${i}:v]fps=24,settb=1/24000[nv${i}];[${i}:a]aresample=24000[na${i}]`
      ).join(';');

      let vfChain = '';
      let prevVideoLabel = '[nv0]';
      let runningOffset = 0;
      for (let i = 1; i < stitchCount; i++) {
        const prevDuration = stitchList[i - 1].duration;
        runningOffset += prevDuration - fadeDuration;
        const nextVideoLabel = i === stitchCount - 1 ? '[vout]' : `[v${i}]`;
        if (vfChain) vfChain += ';';
        vfChain += `${prevVideoLabel}[nv${i}]xfade=transition=fade:duration=${fadeDuration}:offset=${runningOffset.toFixed(2)}${nextVideoLabel}`;
        prevVideoLabel = nextVideoLabel;
      }

      let afChain = '';
      let prevAudioLabel = '[na0]';
      for (let i = 1; i < stitchCount; i++) {
        const nextAudioLabel = i === stitchCount - 1 ? '[aout]' : `[a${i}]`;
        if (afChain) afChain += ';';
        afChain += `${prevAudioLabel}[na${i}]acrossfade=d=${fadeDuration}:c1=tri:c2=tri${nextAudioLabel}`;
        prevAudioLabel = nextAudioLabel;
      }

      const filterComplex = `${normFilters};${vfChain};${afChain}`;
      finalCmd = `/usr/bin/ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -c:a aac -ar 44100 "${finalFilePath}"`;
    }

    console.log(`[Worker] Running FFmpeg crossfade stitch with audio (including intro/teaser/outro if present)...`);
    await execPromise(finalCmd, { timeout: 900000 });

    // ──────────────────────────────────────────────────────────────
    // Step 2.5: Technical Quality Gate — 任何硬性品質問題都禁止發布
    // ──────────────────────────────────────────────────────────────
    const teaserWasCreated = fs.existsSync(teaserFilePath) && teaserDuration > 0;
    job.hookOverlayApplied = hookOverlayApplied;
    job.outroLipSyncApplied = outroLipSyncApplied;
    const qualityResult = runQualityGate(job, finalFilePath, introPath, teaserWasCreated, fs.existsSync(outroPath));
    job.qualityChecks = qualityResult.checks;
    if (!qualityResult.passed) {
      const failures = Object.entries(qualityResult.checks)
        .filter(([, check]) => !check.passed)
        .map(([name, check]) => `${name}: ${check.details}`)
        .join('\n');
      const errorMsg = `技術品質門檻未通過，已攔截發布：\n${failures}`;
      console.error(`[Worker] ${errorMsg}`);
      job.status = job.previewOnly ? 'preview_ready' : 'quality_failed';
      job.error = errorMsg;
      job.finalVideoUrl = `/renders/${finalFileName}`;
      job.progress = 80;
      saveJob(job);
      if (fs.existsSync(teaserFilePath)) {
        try { fs.unlinkSync(teaserFilePath); } catch {}
      }
      if (fs.existsSync(hookOverlayPath)) {
        try { fs.unlinkSync(hookOverlayPath); } catch {}
      }
      if (job.previewOnly) {
        console.log(`[Worker] Preview retained for ${jobId}; YouTube publishing remains blocked until the quality gate passes.`);
      }
      return;
    }

    job.finalVideoUrl = `/renders/${finalFileName}`;
    job.progress = 80;
    saveJob(job);

    // 清理預告臨時檔案
    if (fs.existsSync(teaserFilePath)) {
      try { fs.unlinkSync(teaserFilePath); } catch (e) {}
    }
    if (fs.existsSync(hookOverlayPath)) {
      try { fs.unlinkSync(hookOverlayPath); } catch (e) {}
    }

    if (job.previewOnly) {
      console.log(`[Worker] Job ${jobId} is preview-only. Skipping YouTube upload sequence.`);
      job.status = 'preview_ready';
      job.progress = 100;
      saveJob(job);

      try {
        const { syncKnowledge } = require('./knowledge_sync');
        await syncKnowledge(job, reviewResult ? reviewResult.summary : '預覽生成成功');
      } catch (syncErr: any) {
        console.error('[Worker] Knowledge sync failed:', syncErr.message);
      }
      return;
    }

    // ──────────────────────────────────────────────────────────────
    // Step 3: YouTube 優化與上傳
    // ──────────────────────────────────────────────────────────────
    console.log(`[Worker] Starting automated YouTube publishing sequence for job ${jobId}...`);
    job.status = 'uploading';
    job.progress = 85;
    saveJob(job);

    // B. 建構繁中 SRT 字幕與 Chapters（基於動態音軌長度與偏移計算）
    console.log('[Worker] Generating Traditional Chinese SRT subtitles & dynamic chapters...');
    let baseSrt = '';
    const chapters: { timestamp: string; title: string; script: string }[] = [];

    // 計算正片（第一幕）開始的時間偏移
    let srtOffset = 0;
    if (introPath && fs.existsSync(introPath)) {
      srtOffset += introDuration - fadeDuration;
    }
    if (teaserDuration > 0) {
      srtOffset += teaserDuration - fadeDuration;
    }

    // 寫入片頭與預告的 Chapters
    if (introPath && fs.existsSync(introPath)) {
      chapters.push({ timestamp: '00:00', title: '精彩片頭', script: '片頭' });
    }
    if (teaserDuration > 0) {
      const teaserStartSec = introPath && fs.existsSync(introPath) ? introDuration - fadeDuration : 0;
      const mins = Math.floor(teaserStartSec / 60);
      const secs = Math.floor(teaserStartSec % 60);
      const timestampStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      chapters.push({ timestamp: timestampStr, title: '精彩預告', script: '精彩預告' });
    }

    let runningAudioOffset = srtOffset;
    let srtIndex = 1;

    const formatSrtTime = (seconds: number) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const pad3 = (n: number) => String(n).padStart(3, '0');
      return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
    };

    job.segments!.forEach((seg, idx) => {
      const startSec = runningAudioOffset;
      const duration = seg.duration || 8.0;
      const endSec = idx === job.segments!.length - 1 ? startSec + duration : startSec + duration - fadeDuration;
      
      // 更新下一個片段的 startSec
      runningAudioOffset += duration - fadeDuration;

      // ── 斷句拆分字幕邏輯 (Punctuation Splitting) ──
      const { cleanScript } = cleanAudioScriptForTTS(seg.audioScript);
      const rawText = cleanScript || seg.audioScript;
      const clauses = rawText.split(/([，。！？,.\!?\s]+)/).filter(Boolean);
      const lines: string[] = [];
      for (let i = 0; i < clauses.length; i++) {
        const item = clauses[i].trim();
        if (!item) continue;
        if (/^[，。！？,.\!?\s]+$/.test(item)) {
          if (lines.length > 0) {
            lines[lines.length - 1] += item;
          }
        } else {
          lines.push(item);
        }
      }

      const segDuration = endSec - startSec;
      const totalChars = lines.reduce((sum, line) => sum + line.replace(/[，。！？,.\!?\s]+/g, '').length, 0);

      if (totalChars > 0 && lines.length > 0) {
        let currentLineStart = startSec;
        lines.forEach((line) => {
          const lineChars = line.replace(/[，。！？,.\!?\s]+/g, '').length;
          const lineDuration = segDuration * (lineChars / totalChars);
          const lineEnd = currentLineStart + lineDuration;
          
          const startTime = formatSrtTime(currentLineStart);
          const endTime = formatSrtTime(lineEnd);
          baseSrt += `${srtIndex}\n${startTime} --> ${endTime}\n${line}\n\n`;
          srtIndex++;
          currentLineStart = lineEnd;
        });
      } else {
        const startTime = formatSrtTime(startSec);
        const endTime = formatSrtTime(endSec);
        baseSrt += `${srtIndex}\n${startTime} --> ${endTime}\n${rawText}\n\n`;
        srtIndex++;
      }

      // 格式化為 YouTube Chapter 時間戳
      const mins = Math.floor(startSec / 60);
      const secs = Math.floor(startSec % 60);
      const timestampStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      chapters.push({
        timestamp: timestampStr,
        title: `第 ${idx + 1} 幕`,
        script: rawText
      });
    });

    // 寫入片尾 Chapter
    if (outroPath && fs.existsSync(outroPath)) {
      const mins = Math.floor(runningAudioOffset / 60);
      const secs = Math.floor(runningAudioOffset % 60);
      const timestampStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      chapters.push({ timestamp: timestampStr, title: '精彩片尾', script: '片尾' });
    }

    // A. 生成詼諧標題與描述 (傳入計算好的 chapters 以免時間戳幻覺)
    console.log('[Worker] Generating witty YouTube metadata...');
    const wittyMeta = await generateWittyMetadata(job.prompt, job.worldInfo, chapters);
    console.log('[Worker] Witty metadata generated:', wittyMeta);

    const tempDir = '/tmp';
    const srtPaths: Record<string, string> = {
      'zh-TW': path.join(tempDir, `sub_${jobId}_zh-TW.srt`)
    };
    fs.writeFileSync(srtPaths['zh-TW'], baseSrt.trim());

    // ── 燒錄繁體中文硬字幕至最終影片 (Burn Hard Subtitles) ──
    try {
      console.log('[Worker] Burning hard Traditional Chinese subtitles to final video...');
      const burnedVideoPath = path.join(process.cwd(), 'public', 'renders', `job_${jobId}_final_sub.mp4`);
      const srtPathEscaped = srtPaths['zh-TW'].replace(/:/g, '\\:').replace(/\\/g, '/');
      const burnCmd = `/usr/bin/ffmpeg -y -i "${finalFilePath}" -vf "subtitles='${srtPathEscaped}':force_style='Fontname=Noto Sans CJK TC,Fontsize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=28'" -c:v libx264 -preset medium -crf 22 -maxrate 5M -bufsize 10M -pix_fmt yuv420p -movflags +faststart -c:a copy "${burnedVideoPath}"`;
      await execPromise(burnCmd, { timeout: 300000 });

      if (fs.existsSync(burnedVideoPath) && fs.statSync(burnedVideoPath).size > 10000) {
        fs.renameSync(burnedVideoPath, finalFilePath);
        console.log(`[Worker] Successfully burned hard subtitles to ${finalFilePath}`);
      }
    } catch (burnErr: any) {
      console.warn(`[Worker] Burning subtitles with font failed: ${burnErr.message || burnErr}. Retrying with fallback...`);
      try {
        const burnedVideoPath = path.join(process.cwd(), 'public', 'renders', `job_${jobId}_final_sub.mp4`);
        const srtPathEscaped = srtPaths['zh-TW'].replace(/:/g, '\\:').replace(/\\/g, '/');
        const burnCmdFallback = `/usr/bin/ffmpeg -y -i "${finalFilePath}" -vf "subtitles='${srtPathEscaped}'" -c:v libx264 -preset medium -crf 22 -maxrate 5M -bufsize 10M -pix_fmt yuv420p -movflags +faststart -c:a copy "${burnedVideoPath}"`;
        await execPromise(burnCmdFallback, { timeout: 30000 });
        if (fs.existsSync(burnedVideoPath) && fs.statSync(burnedVideoPath).size > 10000) {
          fs.renameSync(burnedVideoPath, finalFilePath);
          console.log(`[Worker] Successfully burned hard subtitles (fallback) to ${finalFilePath}`);
        }
      } catch (err2: any) {
        console.warn(`[Worker] Subtitle burn fallback also failed: ${err2.message || err2}`);
      }
    }

    // C. 多國字幕翻譯
    const languages = [
      { code: 'en', name: 'English (AI Sarcastic)', local: 'English' },
      { code: 'es', name: 'Español (AI Narración)', local: 'Spanish' },
      { code: 'ja', name: '日本語 (AI 吹き替え)', local: 'Japanese' }
    ];

    for (const lang of languages) {
      try {
        console.log(`[Worker] Translating subtitles to ${lang.local}...`);
        const transSrt = await translateSubtitles(baseSrt, lang.local);
        const subPath = path.join(tempDir, `sub_${jobId}_${lang.code}.srt`);
        fs.writeFileSync(subPath, transSrt);
        srtPaths[lang.code] = subPath;
      } catch (err) {
        console.warn(`[Worker] Subtitle translation failed for ${lang.code}:`, err);
      }
    }

    // D. 準備上傳設定檔
    const configData: any = {
      videoPath: finalFilePath,
      title: wittyMeta.title || `如果電視台: ${job.worldInfo?.worldName}`,
      description: `${wittyMeta.description || job.worldInfo?.worldDescription}\n\n---\n影片由「如果電視台 If TV」全自動 AI 引擎生成！\n世界設定: ${job.worldInfo?.worldName}\n原始想法: ${job.prompt}\n\nPowered by Vertex AI | Experimental AI Project by Milkcat`,
      channel: job.channel,
      subtitles: [{ lang: 'zh-TW', name: '繁體中文 (AI 旁白)', path: srtPaths['zh-TW'] }]
    };

    languages.forEach(lang => {
      if (srtPaths[lang.code]) {
        configData.subtitles.push({ lang: lang.code, name: lang.name, path: srtPaths[lang.code] });
      }
    });

    const configPath = path.join(tempDir, `upload_config_${jobId}.json`);
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));

    // E. 呼叫 Python YouTube Uploader
    console.log('[Worker] Launching Python YouTube Uploader...');
    job.progress = 90;
    saveJob(job);

    const pythonBin = process.env.AGENT_PYTHON_BIN || 'python3';
    const scriptPath = IF_TV_YOUTUBE_UPLOADER_SCRIPT;
    const uploadCmd = `"${pythonBin}" "${scriptPath}" "${configPath}"`;
    
    console.log(`[Worker] Executing command: ${uploadCmd}`);
    const { stdout } = await execPromise(uploadCmd);
    console.log('[Worker] Python Uploader stdout:', stdout);

    // 解析回傳 JSON (自動濾除 Python 日誌文字)
    let uploadResult: any;
    const jsonMatch = stdout.match(/\{[\s\S]*"video_id"[\s\S]*\}/) || stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        uploadResult = JSON.parse(jsonMatch[0]);
      } catch (e) {}
    }
    if (!uploadResult) {
      try {
        uploadResult = JSON.parse(stdout.trim());
      } catch (e) {}
    }

    if (!uploadResult || uploadResult.error) {
      throw new Error(`YouTube upload failed: ${uploadResult?.error || 'Unable to parse Python output'}`);
    }

    // F. 清理臨時檔案
    Object.values(srtPaths).forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);

    console.log(`[Worker] Job ${jobId} published! Video ID: ${uploadResult.video_id}`);
    
    // G. 更新狀態
    job.status = 'published';
    job.progress = 100;
    job.youtubeId = uploadResult.video_id;
    job.youtubeUrl = uploadResult.youtube_url;
    saveJob(job);

    // 同步知識庫與更新 STATUS.md
    try {
      const { syncKnowledge } = require('./knowledge_sync');
      await syncKnowledge(job, reviewResult ? reviewResult.summary : '發布成功，但無審閱摘要');
    } catch (syncErr: any) {
      console.error('[Worker] Knowledge sync failed:', syncErr.message);
    }

  } catch (err: any) {
    console.error(`[Worker] Fatal error processing job ${jobId}:`, err);
    job.status = 'failed';
    job.error = err.message || 'Fatal worker compilation error';
    saveJob(job);

    // 同步知識庫與更新 STATUS.md
    try {
      const { syncKnowledge } = require('./knowledge_sync');
      await syncKnowledge(job, `任務因致命錯誤失敗: ${job.error}`);
    } catch (syncErr: any) {
      console.error('[Worker] Knowledge sync failed:', syncErr.message);
    }
  }
}
