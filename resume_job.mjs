/**
 * resume_job.mjs
 * 補跑失敗 Job 的後續流程：FFmpeg Stitch → 字幕 → YouTube 上傳
 * 用法: node resume_job.mjs [jobId]
 * 範例: node resume_job.mjs job_nsy5lbi5s
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_FILE = path.join(__dirname, 'jobs.json');
const RENDERS_DIR = path.join(__dirname, 'public', 'renders');

const jobId = process.argv[2];
if (!jobId) {
  console.error('Usage: node resume_job.mjs <jobId>');
  process.exit(1);
}

// 1. 讀取 Job 資料
const allJobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
const job = allJobs[jobId];
if (!job) {
  console.error(`Job not found: ${jobId}`);
  process.exit(1);
}

console.log(`\n====== Resume Job: ${jobId} ======`);
console.log(`World: ${job.worldInfo?.worldName}`);
console.log(`Segments: ${job.segments?.length}`);
console.log(`Current Status: ${job.status}`);

// 2. 確認所有 seg 都完成
const segPaths = job.segments.map(seg => {
  const p = path.join(__dirname, 'public', seg.videoUrl);
  const exists = fs.existsSync(p);
  const size = exists ? fs.statSync(p).size : 0;
  console.log(`  Seg ${seg.id}: ${exists ? '✅' : '❌'} (${size} bytes) - ${p}`);
  return { seg, p, exists, size };
});

const allReady = segPaths.every(s => s.exists && s.size > 10000);
if (!allReady) {
  console.error('\n❌ 部分片段不完整，無法繼續');
  process.exit(1);
}

// 3. FFmpeg Stitch（帶 timebase 修正）
const finalFileName = `job_${jobId}_final.mp4`;
const finalFilePath = path.join(RENDERS_DIR, finalFileName);
const fadeDuration = 0.8;
const segCount = segPaths.length;

console.log('\n[Step 1] FFmpeg Stitch with timebase normalization...');

let finalCmd;
if (segCount === 1) {
  finalCmd = `/usr/bin/ffmpeg -y -i "${segPaths[0].p}" -c copy "${finalFilePath}"`;
} else {
  const inputs = segPaths.map(s => `-i "${s.p}"`).join(' ');
  
  // 統一 timebase（修正 Veo API 不同 timebase 問題）
  const normFilters = segPaths.map((_, i) =>
    `[${i}:v]fps=24,settb=1/24000[nv${i}];[${i}:a]aresample=24000[na${i}]`
  ).join(';');

  let vfChain = '';
  let prevVideoLabel = '[nv0]';
  let runningOffset = 0;
  for (let i = 1; i < segCount; i++) {
    const prevDuration = job.segments[i - 1].duration || 8.0;
    runningOffset += prevDuration - fadeDuration;
    const nextVideoLabel = i === segCount - 1 ? '[vout]' : `[v${i}]`;
    if (vfChain) vfChain += ';';
    vfChain += `${prevVideoLabel}[nv${i}]xfade=transition=fade:duration=${fadeDuration}:offset=${runningOffset.toFixed(2)}${nextVideoLabel}`;
    prevVideoLabel = nextVideoLabel;
  }

  let afChain = '';
  let prevAudioLabel = '[na0]';
  for (let i = 1; i < segCount; i++) {
    const nextAudioLabel = i === segCount - 1 ? '[aout]' : `[a${i}]`;
    if (afChain) afChain += ';';
    afChain += `${prevAudioLabel}[na${i}]acrossfade=d=${fadeDuration}:c1=tri:c2=tri${nextAudioLabel}`;
    prevAudioLabel = nextAudioLabel;
  }

  const filterComplex = `${normFilters};${vfChain};${afChain}`;
  finalCmd = `/usr/bin/ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -c:a aac "${finalFilePath}"`;
}

try {
  console.log('Running FFmpeg...');
  execSync(finalCmd, { timeout: 300000, stdio: 'pipe' });
  const finalSize = fs.statSync(finalFilePath).size;
  console.log(`✅ Stitch done! ${finalFilePath} (${(finalSize/1024/1024).toFixed(1)}MB)`);
} catch (err) {
  console.error('❌ FFmpeg failed:', err.stderr?.toString() || err.message);
  process.exit(1);
}

// 4. 更新 Job 狀態 → stitching done
job.finalVideoUrl = `/renders/${finalFileName}`;
job.status = 'stitching';
job.progress = 80;
allJobs[jobId] = job;
fs.writeFileSync(JOBS_FILE, JSON.stringify(allJobs, null, 2));
console.log('\n[Step 2] Job status updated to stitching, finalVideoUrl set.');

// 5. 生成 SRT 字幕
console.log('\n[Step 3] Generating SRT subtitles...');
const formatSrtTime = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
};

let baseSrt = '';
const chapters = [];
let runningAudioOffset = 0;

job.segments.forEach((seg, idx) => {
  const startSec = runningAudioOffset;
  const duration = seg.duration || 8.0;
  const endSec = idx === job.segments.length - 1 ? startSec + duration : startSec + duration - fadeDuration;
  runningAudioOffset += duration - fadeDuration;

  baseSrt += `${idx + 1}\n${formatSrtTime(startSec)} --> ${formatSrtTime(endSec)}\n${seg.audioScript}\n\n`;

  const mins = Math.floor(startSec / 60);
  const secs = Math.floor(startSec % 60);
  chapters.push({
    timestamp: `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`,
    title: `第 ${idx + 1} 幕`,
    script: seg.audioScript
  });
});

const srtPath = `/tmp/sub_${jobId}_zh-TW.srt`;
fs.writeFileSync(srtPath, baseSrt.trim());
console.log(`✅ SRT written to ${srtPath}`);
console.log('Chapters:');
chapters.forEach(c => console.log(`  ${c.timestamp} - ${c.title}: ${c.script?.slice(0,30)}...`));

// 6. 準備 YouTube 上傳設定
console.log('\n[Step 4] Preparing YouTube upload config...');
const configData = {
  videoPath: finalFilePath,
  title: `如果電視台: ${job.worldInfo?.worldName}`,
  description: `${job.worldInfo?.worldDescription?.slice(0, 500)}\n\n---\n影片由「如果電視台 If TV」全自動 AI 引擎生成！\n世界設定: ${job.worldInfo?.worldName}\n原始想法: ${job.prompt}\n\nPowered by Vertex AI | Experimental AI Project by Milkcat\n\n${chapters.map(c => `${c.timestamp} ${c.title}`).join('\n')}`,
  channel: job.channel,
  subtitles: [{ lang: 'zh-TW', name: '繁體中文 (AI 旁白)', path: srtPath }]
};

const configPath = `/tmp/upload_config_${jobId}.json`;
fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
console.log(`✅ Upload config written to ${configPath}`);

// 7. 呼叫 YouTube Uploader
console.log('\n[Step 5] Launching YouTube Uploader...');
const pythonBin = process.env.AGENT_PYTHON_BIN || 'python3';
const scriptPath = path.join(__dirname, 'src', 'lib', 'youtube_uploader.py');

if (!fs.existsSync(pythonBin)) {
  console.warn(`⚠️  Python venv not found at ${pythonBin}`);
  console.log('Skipping YouTube upload. finalVideoUrl is ready at:', job.finalVideoUrl);
  job.status = 'completed';
  job.progress = 100;
  allJobs[jobId] = job;
  fs.writeFileSync(JOBS_FILE, JSON.stringify(allJobs, null, 2));
  console.log('\n✅ Job marked as completed (no YouTube upload)');
  process.exit(0);
}

try {
  const uploadCmd = `"${pythonBin}" "${scriptPath}" "${configPath}"`;
  console.log('Running:', uploadCmd);
  const stdout = execSync(uploadCmd, { timeout: 300000 }).toString();
  console.log('Python output:', stdout);

  let uploadResult;
  try { uploadResult = JSON.parse(stdout.trim()); } catch {
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (t.startsWith('{') && t.endsWith('}')) {
        try { uploadResult = JSON.parse(t); break; } catch {}
      }
    }
  }

  if (!uploadResult || uploadResult.error) throw new Error(uploadResult?.error || 'Parse failed');

  job.status = 'published';
  job.progress = 100;
  job.youtubeId = uploadResult.video_id;
  job.youtubeUrl = uploadResult.youtube_url;
  allJobs[jobId] = job;
  fs.writeFileSync(JOBS_FILE, JSON.stringify(allJobs, null, 2));

  // 清理臨時檔
  [srtPath, configPath].forEach(p => { try { fs.unlinkSync(p); } catch {} });

  console.log(`\n🎉 Job ${jobId} published!`);
  console.log(`   YouTube ID: ${uploadResult.video_id}`);
  console.log(`   URL: ${uploadResult.youtube_url}`);
} catch (err) {
  console.error('❌ YouTube upload failed:', err.message);
  job.status = 'upload_failed';
  job.progress = 80;
  job.error = err.message;
  allJobs[jobId] = job;
  fs.writeFileSync(JOBS_FILE, JSON.stringify(allJobs, null, 2));
  console.log('\n⚠️  影片已合併完成，但 YouTube 上傳失敗。finalVideoUrl:', job.finalVideoUrl);
}
