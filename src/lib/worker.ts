import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getJob, saveJob, Job, Segment } from './db';
import { generateVideoSegment, generateWittyMetadata, translateSubtitles, generateImageSegment, generateFreeVideoSegment } from './gemini';
import { generateVideoViaBrowser } from './gemini_browser';

const execPromise = promisify(exec);

let isWorkerRunning = false;

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
          (j: any) => (j.status === 'generating' || j.status === 'pending') && j.progress < 100
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

async function generateTtsSafe(text: string, outputPath: string) {
  if (!text || text.trim() === '') {
    console.log(`[Worker] TTS text is empty, generating silence.`);
    const silenceCmd = `/usr/bin/ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 8 "${outputPath}"`;
    await execPromise(silenceCmd);
    return;
  }
  try {
    const cleanText = text.replace(/"/g, '\\"').replace(/\n/g, ' ');
    // 預設採用優質的台灣國語男聲 (Taiwanese Mandarin)
    const cmd = `edge-tts --voice zh-TW-YunJheNeural --text "${cleanText}" --write-media "${outputPath}"`;
    console.log(`[Worker] Generating TTS: ${cmd}`);
    await execPromise(cmd, { timeout: 30000 });
    
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error('Generated TTS file is empty or missing.');
    }
  } catch (err) {
    console.warn('[Worker] edge-tts failed or timed out, falling back to silence:', err);
    const silenceCmd = `/usr/bin/ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 8 "${outputPath}"`;
    await execPromise(silenceCmd);
  }
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

async function processJob(jobId: string) {
  console.log(`[Worker] Processing Job ${jobId}...`);
  const job = getJob(jobId);
  if (!job || !job.segments || job.segments.length === 0) {
    console.warn(`[Worker] Job ${jobId} has no segments to generate.`);
    return;
  }

  try {
    const totalSegments = job.segments.length;
    const style = job.worldInfo?.visualStyle || '';
    const character = job.worldInfo?.mainCharacterDescription || '';

    // ──────────────────────────────────────────────────────────────
    // Step 1: 逐一生成每個片段 (包含語音旁白)
    // ──────────────────────────────────────────────────────────────
    for (let i = 0; i < totalSegments; i++) {
      const segment = job.segments[i];
      
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
      // Ensure mode fallback if not set
      if (!mode) mode = 'image_zoom';
      if (!mode) {
        const envPath = '/home/ubuntu/agentmanager/.env';
        if (fs.existsSync(envPath)) {
          try {
            const content = fs.readFileSync(envPath, 'utf8');
            const match = content.match(/^VIDEO_GENERATION_MODE\s*=\s*(.+)$/m);
            if (match) {
              mode = match[1].trim().replace(/['"]/g, '');
            }
          } catch (e) {
            console.warn('[Worker] Failed to read agentmanager/.env:', e);
          }
        }
      }
      if (!mode) {
        mode = 'image_zoom';
      }
      const segmentFileName = `job_${jobId}_seg_${segment.id}.mp4`;
      const segmentPath = path.join(process.cwd(), 'public', 'renders', segmentFileName);

      try {
        const tempTtsName = `tts_${jobId}_seg_${segment.id}.mp3`;
        const tempTtsPath = path.join('/tmp', tempTtsName);

        if (mode === 'veo') {
          // ── 付費模式：Google Veo 3.1 影音生成 ──────────────────
          const tempVeoVideoPath = path.join('/tmp', `veo_raw_${jobId}_seg_${segment.id}.mp4`);
          await generateVideoSegment(
            segment.visualPrompt,
            style,
            character,
            tempVeoVideoPath,
            (msg) => {
              console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] ${msg}`);
            }
          );

          // 生成台灣旁白
          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] Generating TTS voiceover...`);
          await generateTtsSafe(segment.audioScript, tempTtsPath);

          // 偵測配音真實長度
          const realDuration = await getAudioDuration(tempTtsPath) + 0.5;
          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] TTS duration detected: ${realDuration} seconds.`);

          // 合併影像與音訊，保證長度為實體音軌長度 (以 freeze frame 補足影像長度)
          const mergeCmd = [
            `/usr/bin/ffmpeg -y`,
            `-i "${tempVeoVideoPath}"`,
            `-i "${tempTtsPath}"`,
            `-filter_complex "[0:v]scale=1920:1080:flags=lanczos,tpad=stop_mode=clone:stop_duration=5[vout];[1:a]apad=whole_dur=${realDuration}[aout]"`,
            `-map "[vout]" -map "[aout]"`,
            `-c:v libx264 -preset fast -crf 18`,
            `-pix_fmt yuv420p`,
            `-c:a aac`,
            `-t ${realDuration.toFixed(2)}`,
            `"${segmentPath}"`
          ].join(' ');

          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Veo] Merging video with TTS audio...`);
          await execPromise(mergeCmd, { timeout: 60000 });

          // 紀錄真實分鏡長度
          segment.duration = realDuration;

          // 清理臨時檔
          if (fs.existsSync(tempVeoVideoPath)) fs.unlinkSync(tempVeoVideoPath);
          if (fs.existsSync(tempTtsPath)) fs.unlinkSync(tempTtsPath);
        } else if (mode === 'image_zoom') {
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

          // 偵測配音真實長度
          const realDuration = await getAudioDuration(tempTtsPath) + 0.5;
          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][ZoomMode] TTS duration detected: ${realDuration} seconds.`);

          // 使用 FFmpeg zoompan 濾鏡產生動態平移縮放影片
          const frames = Math.ceil(realDuration * 25);
          const zoompanFilter = `scale=2048:1152,zoompan=z='min(zoom+0.0006,1.2)':d=${frames}:x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':s=1920x1080`;
          
          const mergeCmd = [
            `/usr/bin/ffmpeg -y`,
            `-loop 1 -i "${tempImgPath}"`,
            `-i "${tempTtsPath}"`,
            `-filter_complex "[0:v]${zoompanFilter}[vout];[1:a]apad=whole_dur=${realDuration}[aout]"`,
            `-map "[vout]" -map "[aout]"`,
            `-c:v libx264 -preset fast -crf 18`,
            `-pix_fmt yuv420p`,
            `-c:a aac`,
            `-t ${realDuration.toFixed(2)}`,
            `"${segmentPath}"`
          ].join(' ');

          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][ZoomMode] Creating zoompan video with TTS audio...`);
          await execPromise(mergeCmd, { timeout: 120000 });

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
          const mergeCmd = [
            `/usr/bin/ffmpeg -y`,
            `-i "${tempCookieVideoPath}"`,
            `-i "${tempTtsPath}"`,
            `-filter_complex "[0:v]scale=1920:1080:flags=lanczos,tpad=stop_mode=clone:stop_duration=5[vout];[1:a]apad=whole_dur=${realDuration}[aout]"`,
            `-map "[vout]" -map "[aout]"`,
            `-c:v libx264 -preset fast -crf 18`,
            `-pix_fmt yuv420p`,
            `-c:a aac`,
            `-t ${realDuration.toFixed(2)}`,
            `"${segmentPath}"`
          ].join(' ');
          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][Cookie] Merging video with TTS audio...`);
          await execPromise(mergeCmd, { timeout: 60000 });
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
            `-c:v libx264 -preset fast -crf 18`,
            `-pix_fmt yuv420p`,
            `-c:a aac`,
            `-t ${realDuration.toFixed(2)}`,
            `"${segmentPath}"`
          ].join(' ');

          console.log(`[Worker][Job ${jobId}][Seg ${segment.id}][FreeMode] Merging looped video with TTS audio...`);
          await execPromise(mergeCmd, { timeout: 120000 });

          // 紀錄真實分鏡長度，供後續 Dynamic Stitching 使用
          segment.duration = realDuration;

          // 清理臨時檔
          if (fs.existsSync(tempImgPath)) fs.unlinkSync(tempImgPath);
          if (fs.existsSync(tempFreeVideoPath)) fs.unlinkSync(tempFreeVideoPath);
          if (fs.existsSync(tempTtsPath)) fs.unlinkSync(tempTtsPath);
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
        return;
      }
    }

    // ──────────────────────────────────────────────────────────────
    // Step 2: 合併片段 (xfade 淡入淡出轉場 + acrossfade 音訊串接)
    // ──────────────────────────────────────────────────────────────
    console.log(`[Worker] Stitching video segments with xfade crossfade for job ${jobId}...`);
    job.status = 'stitching';
    job.progress = 70;
    saveJob(job);

    const finalFileName = `job_${jobId}_final.mp4`;
    const finalFilePath = path.join(process.cwd(), 'public', 'renders', finalFileName);

    const segPaths = job.segments.map(seg =>
      path.join(process.cwd(), 'public', seg.videoUrl!)
    );
    const segCount = segPaths.length;
    const fadeDuration = 0.8; // 秒

    let finalCmd: string;

    if (segCount === 1) {
      // 單一片段直接 copy (保留影像與音軌)
      finalCmd = `/usr/bin/ffmpeg -y -i "${segPaths[0]}" -c copy "${finalFilePath}"`;
    } else {
      // 多片段：xfade (影像淡入淡出) + acrossfade (音訊淡入淡出) 串接
      const inputs = segPaths.map(p => `-i "${p}"`).join(' ');
      
      let vfChain = '';
      let prevVideoLabel = '[0:v]';
      let runningOffset = 0;
      for (let i = 1; i < segCount; i++) {
        const prevDuration = job.segments[i - 1].duration || 8.0;
        runningOffset += prevDuration - fadeDuration;
        const nextVideoLabel = i === segCount - 1 ? '[vout]' : `[v${i}]`;
        if (vfChain) vfChain += ';';
        vfChain += `${prevVideoLabel}[${i}:v]xfade=transition=fade:duration=${fadeDuration}:offset=${runningOffset.toFixed(2)}${nextVideoLabel}`;
        prevVideoLabel = nextVideoLabel;
      }

      let afChain = '';
      let prevAudioLabel = '[0:a]';
      for (let i = 1; i < segCount; i++) {
        const nextAudioLabel = i === segCount - 1 ? '[aout]' : `[a${i}]`;
        if (afChain) afChain += ';';
        afChain += `${prevAudioLabel}[${i}:a]acrossfade=d=${fadeDuration}:c1=tri:c2=tri${nextAudioLabel}`;
        prevAudioLabel = nextAudioLabel;
      }

      const filterComplex = `${vfChain};${afChain}`;
      finalCmd = `/usr/bin/ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -c:a aac "${finalFilePath}"`;
    }

    console.log(`[Worker] Running FFmpeg crossfade stitch with audio...`);
    await execPromise(finalCmd, { timeout: 300000 });

    job.finalVideoUrl = `/renders/${finalFileName}`;
    job.progress = 80;
    saveJob(job);

    // ──────────────────────────────────────────────────────────────
    // Step 3: YouTube 優化與上傳
    // ──────────────────────────────────────────────────────────────
    console.log(`[Worker] Starting automated YouTube publishing sequence for job ${jobId}...`);
    job.status = 'uploading';
    job.progress = 85;
    saveJob(job);

    // B. 建構繁中 SRT 字幕與 Chapters（基於動態音軌長度計算）
    console.log('[Worker] Generating Traditional Chinese SRT subtitles & dynamic chapters...');
    let baseSrt = '';
    const chapters: { timestamp: string; title: string; script: string }[] = [];
    let runningAudioOffset = 0;

    job.segments.forEach((seg, idx) => {
      const startSec = runningAudioOffset;
      const duration = seg.duration || 8.0;
      // 避免字幕在淡出時重疊，將 endSec 設定為下一片段開始時間或本片段結束時間
      const endSec = idx === job.segments!.length - 1 ? startSec + duration : startSec + duration - fadeDuration;
      
      // 更新下一個片段的 startSec
      runningAudioOffset += duration - fadeDuration;

      // 格式化為 SRT 時間戳 (HH:MM:SS,mmm)
      const formatSrtTime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        
        const pad2 = (n: number) => String(n).padStart(2, '0');
        const pad3 = (n: number) => String(n).padStart(3, '0');
        
        return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
      };

      const startTime = formatSrtTime(startSec);
      const endTime   = formatSrtTime(endSec);
      baseSrt += `${idx + 1}\n${startTime} --> ${endTime}\n${seg.audioScript}\n\n`;

      // 格式化為 YouTube Chapter 時間戳 (mm:ss 或 hh:mm:ss)
      const mins = Math.floor(startSec / 60);
      const secs = Math.floor(startSec % 60);
      const timestampStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      chapters.push({
        timestamp: timestampStr,
        title: `第 ${idx + 1} 幕`,
        script: seg.audioScript
      });
    });

    // A. 生成詼諧標題與描述 (傳入計算好的 chapters 以免時間戳幻覺)
    console.log('[Worker] Generating witty YouTube metadata...');
    const wittyMeta = await generateWittyMetadata(job.prompt, job.worldInfo, chapters);
    console.log('[Worker] Witty metadata generated:', wittyMeta);

    const tempDir = '/tmp';
    const srtPaths: Record<string, string> = {
      'zh-TW': path.join(tempDir, `sub_${jobId}_zh-TW.srt`)
    };
    fs.writeFileSync(srtPaths['zh-TW'], baseSrt.trim());

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
      description: `${wittyMeta.description || job.worldInfo?.worldDescription}\n\n---\n影片由「如果電視台 If TV」全自動 AI 引擎生成！\n世界設定: ${job.worldInfo?.worldName}\n原始想法: ${job.prompt}`,
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

    const pythonBin = '/home/ubuntu/youtube-ai-manager/.venv/bin/python';
    const scriptPath = path.join(process.cwd(), 'src', 'lib', 'youtube_uploader.py');
    const uploadCmd = `"${pythonBin}" "${scriptPath}" "${configPath}"`;
    
    console.log(`[Worker] Executing command: ${uploadCmd}`);
    const { stdout } = await execPromise(uploadCmd);
    console.log('[Worker] Python Uploader stdout:', stdout);

    // 解析回傳
    let uploadResult: any;
    try {
      uploadResult = JSON.parse(stdout.trim());
    } catch {
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try { uploadResult = JSON.parse(trimmed); break; } catch {}
        }
      }
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

  } catch (err: any) {
    console.error(`[Worker] Fatal error processing job ${jobId}:`, err);
    job.status = 'failed';
    job.error = err.message || 'Fatal worker compilation error';
    saveJob(job);
  }
}
