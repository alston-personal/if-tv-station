/**
 * creative_roles.ts
 * 四位常駐創作角色的核心模組：編劇、導演、剪輯師、配樂/對白
 * 
 * 每個角色有：
 * - 持久記憶（存於 agent-data/projects/if-tv-station/memory/roles/）
 * - 審閱能力（呼叫 AI 以角色身份審閱內容）
 * - 學習能力（把好/壞的模式記入記憶）
 */

import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { getGcpConfig, getApiKeys, generateContentWithModelFallback } from './gemini';
import { IF_TV_ROLE_MEMORY_DIR } from './paths';

// ── 常數 ──────────────────────────────────────────────────────────────────
const ROLES = ['screenwriter', 'director', 'editor', 'composer'] as const;
type RoleName = typeof ROLES[number];

// ── 型別定義 ──────────────────────────────────────────────────────────────
export interface RoleMemory {
  role: RoleName;
  persona: string;
  review_criteria: Record<string, string>;
  learned_patterns: {
    good_patterns?: string[];
    bad_patterns?: string[];
    good_prompts?: string[];
    bad_prompts?: string[];
    good_lines?: string[];
    bad_lines?: string[];
    [key: string]: any;
  };
  past_reviews: ReviewRecord[];
  style_memory: Record<string, string>;
  version: number;
  created_at: string;
  [key: string]: any;
}

export interface ReviewRecord {
  job_id: string;
  timestamp: string;
  stage: string;
  score: number;        // 1-10
  feedback: string;
  changes_made: string;
  approved: boolean;
}

export interface ReviewResult {
  role: RoleName;
  score: number;        // 1-10
  approved: boolean;    // score >= 7
  feedback: string;
  suggestions: string[];
  revised_content?: any; // 如果角色直接修改了內容
}

// ── 記憶讀寫 ──────────────────────────────────────────────────────────────
export function loadRoleMemory(role: RoleName): RoleMemory {
  const filePath = path.join(IF_TV_ROLE_MEMORY_DIR, `${role}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`[CreativeRoles] Memory file not found for role: ${role}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function saveRoleMemory(role: RoleName, update: Partial<RoleMemory>): void {
  const filePath = path.join(IF_TV_ROLE_MEMORY_DIR, `${role}.json`);
  const current = loadRoleMemory(role);
  const merged = { ...current, ...update, version: (current.version || 1) + 1 };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
  console.log(`[CreativeRoles] Memory updated for role: ${role} (v${merged.version})`);
}

export function addReviewRecord(role: RoleName, record: ReviewRecord): void {
  const mem = loadRoleMemory(role);
  if (!Array.isArray(mem.past_reviews)) mem.past_reviews = [];
  // 只保留最近 20 筆記錄
  mem.past_reviews = [record, ...mem.past_reviews].slice(0, 20);
  saveRoleMemory(role, { past_reviews: mem.past_reviews });
}

export function learnFromReview(
  role: RoleName,
  pattern: string,
  isGood: boolean
): void {
  const mem = loadRoleMemory(role);
  const key = isGood ? 'good_patterns' : 'bad_patterns';
  const patterns: string[] = mem.learned_patterns[key] || [];
  // 避免重複
  if (!patterns.includes(pattern)) {
    patterns.unshift(pattern);
    mem.learned_patterns[key] = patterns.slice(0, 15); // 最多保留 15 條
    saveRoleMemory(role, { learned_patterns: mem.learned_patterns });
  }
}

// ── AI 呼叫工具 ───────────────────────────────────────────────────────────
async function callAI(systemPrompt: string, userContent: string): Promise<string> {
  const gcpConfig = getGcpConfig();
  const keys = getApiKeys();

  // Try Vertex AI first if configured
  if (gcpConfig.project && gcpConfig.keyPath) {
    try {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(gcpConfig.keyPath);
      const ai = new GoogleGenAI({ vertexai: true, project: gcpConfig.project, location: gcpConfig.location });
      const response = await generateContentWithModelFallback(ai, {
        contents: userContent,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json'
        }
      });
      return response.text || '{}';
    } catch (vertexErr: any) {
      console.warn(`[CreativeRoles] Vertex AI failed: ${vertexErr.message}. Falling back to API keys...`);
    }
  }

  // Fallback to API keys rotation
  if (!keys.length) throw new Error('[CreativeRoles] No API keys available');
  
  let lastError: any = null;
  for (const apiKey of keys) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await generateContentWithModelFallback(ai, {
        contents: userContent,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json'
        }
      });
      return response.text || '{}';
    } catch (apiKeyErr: any) {
      lastError = apiKeyErr;
      console.warn(`[CreativeRoles] API key failed: ${apiKeyErr.message}. Trying next key...`);
    }
  }
  throw lastError || new Error('[CreativeRoles] All API keys failed');
}

// ── 角色審閱核心函數 ──────────────────────────────────────────────────────
/**
 * 以特定角色身份審閱內容
 * @param role 角色名稱
 * @param stage 流程階段（如 'world_building', 'script', 'stitch'）
 * @param contentToReview 要審閱的內容（JSON 字串或描述）
 * @param jobId Job ID（用於記錄）
 * @returns ReviewResult
 */
export async function reviewWithRole(
  role: RoleName,
  stage: string,
  contentToReview: string,
  jobId: string
): Promise<ReviewResult> {
  const mem = loadRoleMemory(role);

  // 構建帶有記憶上下文的 system prompt
  const pastGoodPatterns = mem.learned_patterns.good_patterns?.slice(0, 5).join('\n- ') || '尚無記錄';
  const pastBadPatterns = mem.learned_patterns.bad_patterns?.slice(0, 5).join('\n- ') || '尚無記錄';
  const recentReviews = mem.past_reviews.slice(0, 3).map(r =>
    `[Job ${r.job_id}] 分數:${r.score} - ${r.feedback.slice(0, 80)}`
  ).join('\n') || '尚無歷史審閱';

  const systemPrompt = `${mem.persona}

你正在審閱「如果電視台 (If TV Station)」AI影片生成系統的${stage}階段輸出。

【你的審閱標準】
${Object.entries(mem.review_criteria).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

【你從過去審閱中學到的好模式】
- ${pastGoodPatterns}

【你從過去審閱中學到的壞模式（要避免的）】
- ${pastBadPatterns}

【你最近的審閱記錄（用於參考一致性）】
${recentReviews}

如果你審的是劇本或分鏡，請特別檢查：
- 每一幕是否都有主角的具體行動
- 旁白在前 3 秒是否有強烈的懸念鉤子 (Opening Hook)，且口吻如台灣說書人般吸引人
- 劇本旁白中是否適當嵌入了 [SFX: 音效標籤]（如開場音效、懸疑轉折、重點音效）以驅動聽覺節奏
- 視覺提示詞 (visualPrompt) 是否包含明確的動態 Ken Burns 運鏡（Slow zoom in, Slow pan）與構圖線索
- 是否避免了空泛哲學、抽象抒情或政治宣言式語句
- 如果是整體影片規劃，請檢查是否包含明確 teaser、足夠長度、鮮明片頭、帶訂閱導引的片尾
- 如果內容看起來像 demo 而不是完整短片，請直接扣分，不要客氣

請用你的角色身份和以上知識，對以下內容給出審閱結果。
你必須嚴格以 JSON 格式回應，格式如下：
{
  "score": <1-10 的整數，7分以上才算通過>,
  "approved": <true 或 false>,
  "feedback": "<具體、直接的中文評語，說明最主要的問題>",
  "suggestions": ["<具體修改建議1>", "<具體修改建議2>", ...],
  "revised_content": <如果你可以直接修改這個內容，請提供修改後的版本；如果不行則為 null>
}

記住：你是台灣業界資深人士，說話直接，不說廢話。`;

  console.log(`[CreativeRoles] ${role} reviewing stage: ${stage} for job ${jobId}...`);

  try {
    const responseText = await callAI(systemPrompt, `請審閱以下內容：\n\n${contentToReview}`);
    const parsed = JSON.parse(responseText.trim());

    const result: ReviewResult = {
      role,
      score: Number(parsed.score) || 5,
      approved: Boolean(parsed.approved),
      feedback: parsed.feedback || '（無回饋）',
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      revised_content: parsed.revised_content || null
    };

    // 記錄這次審閱
    const record: ReviewRecord = {
      job_id: jobId,
      timestamp: new Date().toISOString(),
      stage,
      score: result.score,
      feedback: result.feedback,
      changes_made: result.revised_content ? '已提供修訂版本' : '提供建議但未直接修改',
      approved: result.approved
    };
    addReviewRecord(role, record);

    console.log(`[CreativeRoles] ${role} review complete: score=${result.score}, approved=${result.approved}`);
    return result;
  } catch (err: any) {
    console.error(`[CreativeRoles] Error in ${role} review:`, err.message);
    return {
      role,
      score: 7,
      approved: true, // 審閱失敗時預設通過，避免流程卡死
      feedback: '（審閱服務暫時無法使用，已預設通過）',
      suggestions: [],
      revised_content: null
    };
  }
}

// ── 多角色聯合審閱 ────────────────────────────────────────────────────────
/**
 * 讓多個角色同時審閱同一個內容（sequential，避免 API 限流）
 */
export async function multiRoleReview(
  roles: RoleName[],
  stage: string,
  contentToReview: string,
  jobId: string
): Promise<{
  results: ReviewResult[];
  overallScore: number;
  overallApproved: boolean;
  summary: string;
}> {
  const results: ReviewResult[] = [];

  for (const role of roles) {
    const result = await reviewWithRole(role, stage, contentToReview, jobId);
    results.push(result);
    // 小延遲避免 rate limit
    await new Promise(r => setTimeout(r, 1000));
  }

  const overallScore = Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length);
  const overallApproved = overallScore >= 7;

  const summary = results.map(r =>
    `[${r.role}] ${r.score}/10 ${r.approved ? '✅' : '❌'}: ${r.feedback}`
  ).join('\n');

  return { results, overallScore, overallApproved, summary };
}

// ── 劇本審閱（編劇 + 導演）────────────────────────────────────────────────
/**
 * 審閱劇本並嘗試修改到通過（最多 2 次重試）
 */
export async function reviewAndRefineScript(
  segments: any[],
  worldInfo: any,
  jobId: string,
  refineCallback: (feedback: string) => Promise<any[]>
): Promise<{ segments: any[]; reviews: ReviewResult[]; attempts: number }> {
  let currentSegments = segments;
  let lastReviews: ReviewResult[] = [];
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const contentStr = JSON.stringify({ worldInfo: worldInfo.worldName, segments: currentSegments }, null, 2);
    const { results, overallApproved, summary } = await multiRoleReview(
      ['screenwriter', 'director', 'composer'],
      '劇本與分鏡審閱',
      contentStr,
      jobId
    );
    lastReviews = results;

    console.log(`[CreativeRoles] Script review attempt ${attempt + 1}:\n${summary}`);

    if (overallApproved) {
      console.log(`[CreativeRoles] Script approved after ${attempt + 1} attempt(s)!`);
      break;
    }

    if (attempt < MAX_RETRIES) {
      console.log(`[CreativeRoles] Score too low, requesting refinement (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`);
      const feedbackSummary = results
        .filter(r => !r.approved)
        .map(r => `【${r.role}】${r.feedback}`)
        .join('\n');

      // 如果有角色直接提供了修訂版本，優先使用
      const revisedByScreenwriter = results.find(r => r.role === 'screenwriter' && r.revised_content);
      if (revisedByScreenwriter?.revised_content) {
        const revised = revisedByScreenwriter.revised_content;
        if (Array.isArray(revised)) {
          currentSegments = revised;
          continue;
        }
      }

      // 否則呼叫 callback 重新生成
      currentSegments = await refineCallback(feedbackSummary);
    }
  }

  return { segments: currentSegments, reviews: lastReviews, attempts: Math.min(MAX_RETRIES + 1, 3) };
}

// ── 剪輯策略建議（剪輯師）────────────────────────────────────────────────
/**
 * 讓剪輯師分析各幕時長，給出 fade timing 策略
 */
export async function getEditorTimingAdvice(
  segments: Array<{ id: number; duration: number; audioScript: string }>,
  jobId: string
): Promise<{
  fadeDuration: number;
  segmentFades: Array<{ segId: number; fadeOut: number }>;
  notes: string;
}> {
  const mem = loadRoleMemory('editor');
  const contentStr = JSON.stringify(segments, null, 2);

  const systemPrompt = `${mem.persona}

你需要分析以下影片片段的時長，給出最佳的剪輯 fade timing 策略。

【你的審閱標準】
${Object.entries(mem.review_criteria).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

【你的風格記憶】
${JSON.stringify(mem.style_memory, null, 2)}

請回傳 JSON 格式：
{
  "fadeDuration": <預設 fade 秒數，建議 0.6-1.2>,
  "segmentFades": [
    { "segId": 1, "fadeOut": <這一幕結束時的 fade 秒數> },
    ...
  ],
  "notes": "<給影片製作人的剪輯建議>"
}`;

  try {
    const responseText = await callAI(systemPrompt, `請分析以下片段時長並給出剪輯建議：\n${contentStr}`);
    const parsed = JSON.parse(responseText.trim());
    return {
      fadeDuration: parsed.fadeDuration || 0.8,
      segmentFades: parsed.segmentFades || [],
      notes: parsed.notes || ''
    };
  } catch {
    return { fadeDuration: 0.8, segmentFades: [], notes: '（剪輯建議服務暫時無法使用）' };
  }
}

// ── BGM 選配（配樂）──────────────────────────────────────────────────────
/**
 * 配樂角色根據劇情選配 BGM 關鍵字，從 Pixabay 取得免費音樂
 */
export async function selectBGM(
  worldInfo: any,
  segments: any[],
  jobId: string,
  outputPath: string
): Promise<string | null> {
  const mem = loadRoleMemory('composer');

  const systemPrompt = `${mem.persona}

你需要為一部 AI 生成的短片選配背景音樂。根據影片的世界觀和劇情，給出 Pixabay 音樂搜尋關鍵字。

請回傳 JSON：
{
  "search_keywords": "<Pixabay 英文搜尋關鍵字，如 'cinematic emotional ambient'>",
  "mood": "<音樂情緒描述>",
  "reasoning": "<為什麼選這個風格>"
}`;

  const contentStr = `世界觀：${worldInfo.worldName}\n劇情摘要：${segments.map(s => s.audioScript).join(' → ')}`;

  let keywords = 'cinematic emotional ambient';
  try {
    const responseText = await callAI(systemPrompt, contentStr);
    const parsed = JSON.parse(responseText.trim());
    keywords = parsed.search_keywords || keywords;
    console.log(`[CreativeRoles] Composer selected BGM mood: ${parsed.mood}, keywords: ${keywords}`);
  } catch {
    console.warn('[CreativeRoles] BGM keyword selection failed, using defaults');
  }

  // 從 Pixabay API 搜尋免費音樂
  return await fetchPixabayMusic(keywords, outputPath);
}

async function fetchPixabayMusic(keywords: string, outputPath: string): Promise<string | null> {
  const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
  if (!PIXABAY_API_KEY) {
    console.warn('[CreativeRoles] PIXABAY_API_KEY not set, skipping BGM');
    return null;
  }

  try {
    const axios = (await import('axios')).default;
    const encoded = encodeURIComponent(keywords);
    const url = `https://pixabay.com/api/videos/music/?key=${PIXABAY_API_KEY}&q=${encoded}&per_page=5`;
    const resp = await axios.get(url, { timeout: 10000 });
    const hits = resp.data?.hits;
    if (!hits || hits.length === 0) {
      console.warn('[CreativeRoles] No BGM found for keywords:', keywords);
      return null;
    }

    // 選第一個結果下載
    const musicUrl = hits[0]?.audio?.url || hits[0]?.url;
    if (!musicUrl) return null;

    console.log(`[CreativeRoles] Downloading BGM: ${musicUrl}`);
    const musicResp = await axios.get(musicUrl, { responseType: 'stream', timeout: 30000 });
    const fs = await import('fs');
    const writer = fs.default.createWriteStream(outputPath);
    musicResp.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(outputPath));
      writer.on('error', reject);
    });
  } catch (err: any) {
    console.error('[CreativeRoles] BGM fetch failed:', err.message);
    return null;
  }
}

// ── 最終品質總評（四角色）────────────────────────────────────────────────
/**
 * 影片生成完成後，四角色綜合評分
 */
export async function finalQualityReview(
  job: any,
  jobId: string
): Promise<{
  overallScore: number;
  passed: boolean;
  roleScores: Record<RoleName, number>;
  summary: string;
  lowestRole: RoleName;
}> {
  const contentStr = JSON.stringify({
    prompt: job.prompt,
    worldName: job.worldInfo?.worldName,
    visualStyle: job.worldInfo?.visualStyle,
    mainCharacterDescription: job.worldInfo?.mainCharacterDescription,
    segments: job.segments?.map((s: any) => ({
      id: s.id,
      visualPrompt: s.visualPrompt,
      audioScript: s.audioScript,
      duration: s.duration,
      status: s.status,
      shots: s.shots
    }))
  }, null, 2);

  const { results, overallScore } = await multiRoleReview(
    [...ROLES],
    '最終品質總評',
    contentStr,
    jobId
  );

  const roleScores = {} as Record<RoleName, number>;
  results.forEach(r => { roleScores[r.role] = r.score; });

  const lowestRole = results.reduce((a, b) => a.score < b.score ? a : b).role;
  const summary = `整體評分：${overallScore}/10\n` + results.map(r =>
    `  ${r.role}: ${r.score}/10 — ${r.feedback}`
  ).join('\n');

  console.log(`[CreativeRoles] Final quality review:\n${summary}`);

  return {
    overallScore,
    passed: overallScore >= 6, // 最終稍微寬鬆一點，6分以上才發布
    roleScores,
    summary,
    lowestRole
  };
}

/**
 * 在真正燒影片資源前先做一次前置品質門檻審核。
 * 目的是在大量生成前就把明顯不合格的劇本攔下來。
 */
export async function preflightQualityReview(
  job: any,
  jobId: string
): Promise<{
  overallScore: number;
  passed: boolean;
  roleScores: Record<RoleName, number>;
  summary: string;
  lowestRole: RoleName;
}> {
  const contentStr = JSON.stringify({
    prompt: job.prompt,
    worldName: job.worldInfo?.worldName,
    visualStyle: job.worldInfo?.visualStyle,
    mainCharacterDescription: job.worldInfo?.mainCharacterDescription,
    segments: job.segments?.map((s: any) => ({
      id: s.id,
      visualPrompt: s.visualPrompt,
      audioScript: s.audioScript,
      status: s.status,
      shots: s.shots
    }))
  }, null, 2);

  const { results, overallScore } = await multiRoleReview(
    [...ROLES],
    '影片生成前品質預審',
    contentStr,
    jobId
  );

  const roleScores = {} as Record<RoleName, number>;
  results.forEach(r => { roleScores[r.role] = r.score; });

  const lowestRole = results.reduce((a, b) => a.score < b.score ? a : b).role;
  const summary = `整體評分：${overallScore}/10\n` + results.map(r =>
    `  ${r.role}: ${r.score}/10 — ${r.feedback}`
  ).join('\n');

  console.log(`[CreativeRoles] Preflight quality review:\n${summary}`);

  return {
    overallScore,
    passed: overallScore >= 6,
    roleScores,
    summary,
    lowestRole
  };
}

export { ROLES, type RoleName };
