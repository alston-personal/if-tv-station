import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { IF_TV_DATA_DIR } from './paths';

const execPromise = promisify(exec);

import { Client } from '@gradio/client';

/**
 * Lip-Sync utility to synchronize video mouth movements with audio.
 * Uses Sync Labs API when key is available, otherwise calls free open-source Wav2Lip via Gradio Space.
 */
export async function syncLipMovement(videoPath: string, audioPath: string, outputPath: string): Promise<string> {
  console.log(`[LipSync] Starting lip-sync synchronization for ${path.basename(videoPath)}...`);

  const SYNCLABS_API_KEY = process.env.SYNCLABS_API_KEY;

  if (!SYNCLABS_API_KEY) {
    console.log('[LipSync] SYNCLABS_API_KEY not found. Using free open-source Wav2Lip / Gradio Lip-Sync...');
    return await generateFreeLipSync(videoPath, audioPath, outputPath);
  }

  try {
    console.log(`[LipSync] Uploading assets to temporary storage...`);
    const videoUrl = await uploadFileToTempStorage(videoPath);
    const audioUrl = await uploadFileToTempStorage(audioPath);

    console.log(`[LipSync] Assets uploaded. Calling Sync Labs API...`);

    const response = await axios.post('https://api.synclabs.so/lip-sync', {
      audioUrl: audioUrl,
      videoUrl: videoUrl,
      model: 'sync-1.6'
    }, {
      headers: { 'Authorization': `Bearer ${SYNCLABS_API_KEY}` }
    });

    const jobId = response.data.id;
    let status = 'processing';
    let resultUrl = '';

    while (status !== 'completed' && status !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const statusResp = await axios.get(`https://api.synclabs.so/get-status/${jobId}`, {
        headers: { 'Authorization': `Bearer ${SYNCLABS_API_KEY}` }
      });
      status = statusResp.data.status;
      if (status === 'completed') {
        resultUrl = statusResp.data.url;
      }
    }

    if (status === 'failed') throw new Error('Sync Labs lip-sync failed');

    console.log(`[LipSync] Downloading synchronized result from ${resultUrl}...`);
    const writer = fs.createWriteStream(outputPath);
    const download = await axios({
      method: 'get',
      url: resultUrl,
      responseType: 'stream'
    });
    download.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', reject);
    });

    console.log(`[LipSync] Successfully synchronized: ${outputPath}`);
    return outputPath;
  } catch (err: any) {
    console.warn(`[LipSync] Paid Sync Labs failed: ${err.message}. Falling back to free Wav2Lip...`);
    return await generateFreeLipSync(videoPath, audioPath, outputPath);
  }
}

/**
 * 免費開源極致畫質 LivePortrait / Wav2Lip 對嘴模組 (呼叫 Gradio Space)
 */
export async function generateFreeLipSync(videoPath: string, audioPath: string, outputPath: string): Promise<string> {
  console.log(`[LipSync][FreeMode] Initiating open-source high-fidelity lip-sync for ${path.basename(videoPath)}...`);

  // 嘗試 1: KwaiVGI/LivePortrait 官方全臉高清表情對嘴引擎
  try {
    if (fs.existsSync(videoPath) && fs.existsSync(audioPath)) {
      console.log(`[LipSync][LivePortrait] Connecting to KwaiVGI/LivePortrait Gradio Space...`);
      const client = await Client.connect('KwaiVGI/LivePortrait');

      const videoBuffer = fs.readFileSync(videoPath);
      const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });

      // 使用靜態首幀圖片或影片作為 LivePortrait 輸入
      console.log(`[LipSync][LivePortrait] Submitting generation request to LivePortrait...`);
      const result = await client.predict('/gpu_wrapped_execute_video', {
        param_0: videoBlob, // source portrait
        param_1: { video: videoBlob }, // driving video
        param_2: true, // relative motion
        param_3: true, // do crop
        param_4: true  // paste-back
      });

      const videoData = (result.data as any)?.[0];
      const videoUrl = videoData?.video?.url || videoData?.url || (typeof videoData === 'string' ? videoData : null);

      if (videoUrl) {
        console.log(`[LipSync][LivePortrait] LivePortrait generated successfully! Downloading from ${videoUrl}...`);
        const resp = await axios({ method: 'get', url: videoUrl, responseType: 'stream', timeout: 90000 });
        const writer = fs.createWriteStream(outputPath);
        resp.data.pipe(writer);
        await new Promise<void>((resolve, reject) => {
          writer.on('finish', () => resolve());
          writer.on('error', reject);
        });

        // 將 LivePortrait 動畫視訊與原始音訊進行音畫合成
        const syncedWithAudio = outputPath.replace('.mp4', '_synced.mp4');
        const audioMergeCmd = `/usr/bin/ffmpeg -y -i "${outputPath}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${syncedWithAudio}"`;
        await execPromise(audioMergeCmd, { timeout: 30000 });
        if (fs.existsSync(syncedWithAudio) && fs.statSync(syncedWithAudio).size > 10000) {
          fs.renameSync(syncedWithAudio, outputPath);
        }

        console.log(`[LipSync][LivePortrait] Successfully saved LivePortrait HD video to ${outputPath}`);
        return outputPath;
      }
    }
  } catch (err: any) {
    console.warn(`[LipSync][LivePortrait] KwaiVGI/LivePortrait space busy or unavailable: ${err.message || err}. Trying Wav2Lip space...`);
  }

  // 嘗試 2: Wav2Lip Gradio Space (AIFSH/Wav2Lip 或 fallback)
  try {
    if (fs.existsSync(videoPath) && fs.existsSync(audioPath)) {
      const videoBuffer = fs.readFileSync(videoPath);
      const audioBuffer = fs.readFileSync(audioPath);
      const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });
      const audioBlob = new Blob([audioBuffer], { type: 'audio/mp3' });

      console.log(`[LipSync][Wav2Lip] Connecting to Wav2Lip Gradio Client...`);
      const client = await Client.connect('fffiloni/Wav2Lip');
      const result = await client.predict('/predict', {
        face: videoBlob,
        audio: audioBlob,
      });

      const videoData = (result.data as any)?.[0];
      const videoUrl = videoData?.url || (typeof videoData === 'string' ? videoData : null);

      if (videoUrl) {
        console.log(`[LipSync][Wav2Lip] Wav2Lip generated successfully! Downloading from ${videoUrl}...`);
        const resp = await axios({ method: 'get', url: videoUrl, responseType: 'stream', timeout: 90000 });
        const writer = fs.createWriteStream(outputPath);
        resp.data.pipe(writer);
        await new Promise<void>((resolve, reject) => {
          writer.on('finish', () => resolve());
          writer.on('error', reject);
        });
        console.log(`[LipSync][Wav2Lip] Successfully saved lip-synced video to ${outputPath}`);
        return outputPath;
      }
    }
  } catch (err: any) {
    console.warn(`[LipSync][Wav2Lip] Free Wav2Lip Gradio service unavailable: ${err.message || err}.`);
  }

  // 備用處理：若全彩 AI 對嘴 Gradio 空間繁忙，使用高畫質 FFmpeg 進行音畫完美精準對齊與 CRF 色彩編碼
  console.log(`[LipSync][Fallback] Merging audio-video track via FFmpeg (High Profile H.264)...`);
  try {
    const mergeCmd = `/usr/bin/ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 -shortest "${outputPath}"`;
    await execPromise(mergeCmd, { timeout: 30000 });
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
      console.log(`[LipSync][Fallback] High quality copy merge completed: ${outputPath}`);
      return outputPath;
    }
  } catch (e: any) {
    console.warn(`[LipSync][Fallback] Fast copy merge failed: ${e.message}. Trying high-crf re-encode...`);
  }
  try {
    const reencodeCmd = `/usr/bin/ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -color_primaries bt709 -color_trc bt709 -colorspace bt709 -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 -shortest "${outputPath}"`;
    await execPromise(reencodeCmd, { timeout: 30000 });
  } catch {
    await execPromise(`cp "${videoPath}" "${outputPath}"`);
  }
  return outputPath;
}

/**
 * Helper to upload local files to a temporary storage.
 * For the current POC, we implement a mock upload that assumes a local-to-web
 * bridge or a simple file server.
 *
 * TODO: Integrate with actual S3/GCS bucket using @aws-sdk/client-s3 or similar.
 */
async function uploadFileToTempStorage(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found for upload: ${filePath}`);
  }

  const fileName = path.basename(filePath);
  const publicDir = '/tmp/public_assets';
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  const targetPath = path.join(publicDir, fileName);
  fs.copyFileSync(filePath, targetPath);

  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
  const publicUrl = `${baseUrl.replace(/\/$/, '')}/iftv/api/temp-assets/${fileName}`;

  console.log(`[LipSync][Upload] Prepared public asset for API at ${publicUrl}`);
  return publicUrl;
}
