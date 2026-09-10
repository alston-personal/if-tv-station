import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { getGcpConfig, getApiKeys } from './gemini';
import { learnFromReview, RoleName } from './creative_roles';
import { Job, readJobs } from './db';
import { IF_TV_STATUS_PATH, IF_TV_YOUTUBE_FEEDBACK_SCRIPT } from './paths';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);

// ── AI 呼叫 ───────────────────────────────────────────────────────────────
async function callAI(systemPrompt: string, userContent: string): Promise<string> {
  const gcpConfig = getGcpConfig();
  const keys = getApiKeys();

  // Try Vertex AI first if configured
  if (gcpConfig.project && gcpConfig.keyPath) {
    try {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(gcpConfig.keyPath);
      const ai = new GoogleGenAI({ vertexai: true, project: gcpConfig.project, location: gcpConfig.location });
      const response = await (ai.models as any).generateContent({
        model: 'gemini-2.5-flash',
        contents: userContent,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json'
        }
      });
      return response.text || '{}';
    } catch (vertexErr: any) {
      console.warn(`[KnowledgeSync] Vertex AI failed: ${vertexErr.message}. Falling back to API keys...`);
    }
  }

  // Fallback to API keys rotation
  if (!keys.length) throw new Error('[KnowledgeSync] No API keys available');
  
  let lastError: any = null;
  for (const apiKey of keys) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await (ai.models as any).generateContent({
        model: 'gemini-2.5-flash',
        contents: userContent,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json'
        }
      });
      return response.text || '{}';
    } catch (apiKeyErr: any) {
      lastError = apiKeyErr;
      console.warn(`[KnowledgeSync] API key failed: ${apiKeyErr.message}. Trying next key...`);
    }
  }
  throw lastError || new Error('[KnowledgeSync] All API keys failed');
}

// ── 知識提取與同步 ─────────────────────────────────────────────────────────
export async function syncKnowledge(job: Job, reviewSummary: string): Promise<void> {
  console.log(`[KnowledgeSync] Extracting lessons from job ${job.id}...`);

  const systemPrompt = `你是一位 If TV Station 系統的 AI 創意總監，負責分析剛完成/失敗的影片生產任務，並提煉出編劇 (screenwriter)、導演 (director)、剪輯師 (editor)、配樂角色 (composer) 四個角色的學習內容。
分析的對象包含：
1. 原始 Prompt
2. 世界設定
3. 劇本分鏡內容
4. 最終審閱評語/評分

請為這四個角色各提煉出 0~2 條「好模式（做得好、下次繼續用）」或「壞模式（做得差、下次要避免）」的具體教訓。
你必須嚴格以 JSON 格式回應，格式如下：
{
  "screenwriter": {
    "good": ["好的旁白寫作方式/情節結構"],
    "bad": ["不好的旁白寫作方式/情節結構"]
  },
  "director": {
    "good": ["生動、易生成的畫面提示詞模式"],
    "bad": ["複雜、常導致生成失敗或扭曲的提示詞模式"]
  },
  "editor": {
    "good": ["合適的分鏡長度組合/節奏建議"],
    "bad": ["不合適的分鏡長度組合/節奏建議"]
  },
  "composer": {
    "good": ["合適的音樂氛圍與金句"],
    "bad": ["不合適的音樂氛圍與金句"]
  }
}

教訓請用簡短、具體的繁體中文（台灣用語）描述。如果是空的請給空陣列。`;

  const inputContent = JSON.stringify({
    job_id: job.id,
    prompt: job.prompt,
    status: job.status,
    error: job.error,
    worldInfo: job.worldInfo,
    segments: job.segments?.map(s => ({
      id: s.id,
      visualPrompt: s.visualPrompt,
      audioScript: s.audioScript,
      duration: s.duration,
      status: s.status
    })),
    reviewSummary
  }, null, 2);

  try {
    const responseText = await callAI(systemPrompt, inputContent);
    const parsed = JSON.parse(responseText.trim());

    const roles: RoleName[] = ['screenwriter', 'director', 'editor', 'composer'];
    for (const role of roles) {
      const lessons = parsed[role];
      if (lessons) {
        if (Array.isArray(lessons.good)) {
          for (const item of lessons.good) {
            learnFromReview(role, item, true);
          }
        }
        if (Array.isArray(lessons.bad)) {
          for (const item of lessons.bad) {
            learnFromReview(role, item, false);
          }
        }
      }
    }
    console.log(`[KnowledgeSync] Successfully synced role memories for job ${job.id}`);
  } catch (err: any) {
    console.error(`[KnowledgeSync] Error extracting/syncing lessons:`, err.message);
  }

  // 同步更新 STATUS.md
  await updateStatusFile(job, reviewSummary);
}

// ── STATUS.md 自動更新 ──────────────────────────────────────────────────────
async function updateStatusFile(job: Job, reviewSummary: string): Promise<void> {
  if (!fs.existsSync(IF_TV_STATUS_PATH)) {
    console.warn(`[KnowledgeSync] STATUS.md not found at: ${IF_TV_STATUS_PATH}`);
    return;
  }

  try {
    let content = fs.readFileSync(IF_TV_STATUS_PATH, 'utf8');
    const logStartTag = '<!-- LOG_START -->';
    const index = content.indexOf(logStartTag);

    if (index === -1) {
      console.warn(`[KnowledgeSync] <!-- LOG_START --> tag not found in STATUS.md`);
      return;
    }

    const localTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    const formattedTime = localTime.replace(/\//g, '-');

    let logMessage = '';
    if (job.status === 'published' || job.status === 'preview_ready') {
      const suffix = job.status === 'published' ? '成功完成影片任務' : '成功完成預覽影片任務';
      logMessage = `- \`${formattedTime}\` 🟢 **SUCCESS**: ${suffix} \`${job.id}\` (原始 Prompt: "${job.prompt}")。\n`;
      if (job.youtubeUrl) {
        logMessage += `  YouTube 影片: ${job.youtubeUrl}\n`;
      }
      if (job.finalVideoUrl) {
        logMessage += `  預覽影片: ${job.finalVideoUrl}\n`;
      }
      if (reviewSummary) {
        logMessage += `  四角色最終審查結果：\n  ${reviewSummary.replace(/\n/g, '\n  ')}\n`;
      }
    } else {
      logMessage = `- \`${formattedTime}\` 🔴 **FAILED**: 影片任務 \`${job.id}\` (原始 Prompt: "${job.prompt}") 失敗。原因: ${job.error || '未知錯誤'}\n`;
      if (reviewSummary) {
        logMessage += `  四角色最終審查結果：\n  ${reviewSummary.replace(/\n/g, '\n  ')}\n`;
      }
    }

    const before = content.substring(0, index + logStartTag.length);
    const after = content.substring(index + logStartTag.length);
    
    // 寫回
    fs.writeFileSync(IF_TV_STATUS_PATH, before + '\n' + logMessage.trim() + '\n' + after);
    console.log(`[KnowledgeSync] STATUS.md updated successfully with job ${job.id}`);
  } catch (err: any) {
    console.error(`[KnowledgeSync] Failed to update STATUS.md:`, err.message);
  }
}

// ── YouTube 數據與留言反饋學習 ──────────────────────────────────────────────────
export async function syncYouTubeFeedback(): Promise<void> {
  console.log('[KnowledgeSync] Checking YouTube feedback for published videos...');
  const jobs = readJobs();
  const publishedJobs = Object.values(jobs)
    .filter(j => j.status === 'published' && j.youtubeId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5); // 分析最近的 5 部影片

  if (publishedJobs.length === 0) {
    console.log('[KnowledgeSync] No published YouTube videos found in database.');
    return;
  }

  const pythonBin = process.env.AGENT_PYTHON_BIN || 'python3';
  const feedbackScript = IF_TV_YOUTUBE_FEEDBACK_SCRIPT;

  for (const job of publishedJobs) {
    const videoId = job.youtubeId!;
    const channel = job.channel || 'BrainHoleStudio';
    console.log(`[KnowledgeSync] Fetching feedback for video ${videoId} (channel: ${channel})...`);

    try {
      const { stdout } = await execPromise(`"${pythonBin}" "${feedbackScript}" "${videoId}" "${channel}"`);
      const feedback = JSON.parse(stdout.trim());

      if (feedback.error) {
        console.warn(`[KnowledgeSync] Failed to fetch feedback for ${videoId}: ${feedback.error}`);
        continue;
      }

      const stats = feedback.statistics || {};
      const comments = feedback.comments || [];

      // 如果有任何觀看次數或留言，交給 AI 學習
      if (stats.views > 0 || comments.length > 0) {
        console.log(`[KnowledgeSync] Video ${videoId} has ${stats.views} views and ${comments.length} comments. Running AI feedback extraction...`);

        const systemPrompt = `你是一位 If TV Station 系統的 AI 創意總監，負責分析已發布到 YouTube 的影片之觀眾反饋（包含觀看數、點讚數、留言內容），並提煉出編劇 (screenwriter)、導演 (director)、剪輯師 (editor)、配樂角色 (composer) 四個角色的學習內容。
分析的對象包含：
1. 影片原始 Prompt: "${job.prompt}"
2. 觀眾的留言（包含讚賞與吐槽）
3. 影片的數據表現（觀看數：${stats.views}、點讚數：${stats.likes}）

請為這四個角色各提煉出 0~2 條「觀眾喜好的模式（好模式，下次繼續用）」或「觀眾反感/吐槽的模式（壞模式，下次要避免）」的具體教訓。
你必須嚴格以 JSON 格式回應，格式如下：
{
  "screenwriter": {
    "good": ["觀眾稱讚的對比結構/旁白/情節描述"],
    "bad": ["觀眾吐槽的無聊情節/尷尬台詞"]
  },
  "director": {
    "good": ["觀眾稱讚的畫面風格/鏡頭張力模式"],
    "bad": ["觀眾吐槽的畫面扭曲/不合常理的提示詞模式"]
  },
  "editor": {
    "good": ["觀眾滿意的節奏/節奏合適性建議"],
    "bad": ["觀眾抱怨的轉場太快/拖沓建議"]
  },
  "composer": {
    "good": ["觀眾讚賞的背景配樂氛圍/音效"],
    "bad": ["觀眾抱怨的不合適配樂/噪音"]
  }
}

教訓請用簡短、具體的繁體中文（台灣用語）描述。如果是空的請給空陣列。`;

        const userContent = JSON.stringify({
          prompt: job.prompt,
          statistics: stats,
          comments: comments
        }, null, 2);

        const responseText = await callAI(systemPrompt, userContent);
        const parsed = JSON.parse(responseText.trim());

        const roles: RoleName[] = ['screenwriter', 'director', 'editor', 'composer'];
        for (const role of roles) {
          const lessons = parsed[role];
          if (lessons) {
            if (Array.isArray(lessons.good)) {
              for (const item of lessons.good) {
                learnFromReview(role, `[觀眾反饋] ${item}`, true);
              }
            }
            if (Array.isArray(lessons.bad)) {
              for (const item of lessons.bad) {
                learnFromReview(role, `[觀眾反饋] ${item}`, false);
              }
            }
          }
        }
        console.log(`[KnowledgeSync] Roles successfully learned from YouTube video ${videoId} feedback.`);
      } else {
        console.log(`[KnowledgeSync] Video ${videoId} has no views or comments yet. Skipping AI feedback extraction.`);
      }

    } catch (err: any) {
      console.error(`[KnowledgeSync] Error processing feedback for video ${videoId}:`, err.message);
    }
  }
}
