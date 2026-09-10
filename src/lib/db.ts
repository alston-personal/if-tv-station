import fs from 'fs';
import { IF_TV_JOBS_PATH as DB_FILE } from './paths';

export function normalizeMainCharacterDescription(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const char = value as Record<string, unknown>;
  const parts: string[] = [];

  if (char.gender) parts.push(`Gender: ${char.gender}`);
  if (char.age) parts.push(`Age: ${char.age}`);
  if (char.hair) parts.push(`Hair: ${char.hair}`);
  if (char.clothing) parts.push(`Clothing: ${char.clothing}`);
  if (char.uniqueMarkers) parts.push(`Features: ${char.uniqueMarkers}`);

  if (parts.length === 0) {
    try {
      return JSON.stringify(char);
    } catch {
      return '';
    }
  }

  return parts.join(', ');
}

function normalizeJob(job: any): Job {
  if (!job || typeof job !== 'object') {
    return job;
  }

  if (job.worldInfo && typeof job.worldInfo === 'object') {
    job.worldInfo = {
      ...job.worldInfo,
      mainCharacterDescription: normalizeMainCharacterDescription(job.worldInfo.mainCharacterDescription)
    };
  }

  if (Array.isArray(job.segments)) {
    job.segments = job.segments.map((segment: any) => {
      if (!segment || typeof segment !== 'object') return segment;
      return {
        ...segment,
        visualPrompt: typeof segment.visualPrompt === 'string' ? segment.visualPrompt : String(segment.visualPrompt || ''),
        audioScript: typeof segment.audioScript === 'string' ? segment.audioScript : String(segment.audioScript || '')
      };
    });
  }

  return job;
}

export interface QualityCheck {
  passed: boolean;
  details: string;
}

export interface Segment {
  id: number;
  visualPrompt: string;
  audioScript: string;
  foreshadowing?: string;
  payoff?: string;
  videoUrl?: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  error?: string;
  duration?: number;
  sfxApplied?: boolean;
  shots?: Array<{
    id: number;
    visualPrompt: string;
    videoUrl?: string;
    status: 'pending' | 'generating' | 'completed' | 'failed';
    duration?: number;
    lipSyncApplied?: boolean;
  }>;
}

export interface Job {
  id: string;
  status: 'pending' | 'brainstorming' | 'review_ready' | 'generating' | 'stitching' | 'completed' | 'failed' | 'quality_failed' | 'uploading' | 'published' | 'preview_ready';
  prompt: string;
  worldInfo?: {
    worldName: string;
    worldDescription: string;
    visualStyle: string;
    mainCharacterDescription: string;
  };
  characterProfiles?: CharacterProfile[];
  segments?: Segment[];
  finalVideoUrl?: string;
  error?: string;
  youtubeUrl?: string;
  youtubeId?: string;
  channel?: string; // Target YouTube channel profile
  productPlacement?: string; // Product placement description
  introUrl?: string; // Custom intro URL if selected
  productPlacementImg?: string; // Path to product placement image on disk
  productPlacementImgDesc?: string; // Gemini's visually described product characteristics
  previewOnly?: boolean;
  segmentCount?: number;
  teaserAdvice?: {
    targetSegmentId: number;
    startSecond: number;
    endSecond: number;
    caption: string;
  };
  qualityChecks?: Record<string, QualityCheck>;
  hookOverlayApplied?: boolean;
  outroLipSyncApplied?: boolean;
  progress: number; // 0 to 100
  createdAt: string;
  updatedAt: string;
}

/**
 * Character Profile — 角色視覺描述檔案
 * 用於在所有影像/影片生成中維持角色視覺一致性
 */
export interface CharacterProfile {
  id: string;
  characterName: string;         // 角色名稱
  roleInWorld: string;           // 在世界中的定位/身份
  appearance: string;            // 外貌特徵 (English, detailed, for image/video prompts)
  facialFeatures: string;        // 臉部特徵細節
  bodyType: string;              // 體型與姿態
  signatureStyle: string;        // 標誌性穿搭/配件
  colorPalette: string;          // 專屬配色 (CSS hex codes or color names)
  personalityVisualCues: string; // 透過表情/肢體傳達的個性線索
  consistencyKeyphrases: string; // 用於 prompt 的固定關鍵詞 (English, comma-separated)
  generatedAt: string;           // 生成時間
  worldId?: string;              // 關聯的世界 ID (若為世界專屬角色)
}

export function readJobs(): Record<string, Job> {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({}));
    return {};
  }
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Object.fromEntries(
      Object.entries(parsed || {}).map(([id, job]) => [id, normalizeJob(job)])
    );
  } catch (error) {
    console.error('Error reading jobs DB:', error);
    return {};
  }
}

export function writeJobs(jobs: Record<string, Job>): void {
  try {
    const normalized = Object.fromEntries(
      Object.entries(jobs || {}).map(([id, job]) => [id, normalizeJob({ ...job })])
    );
    fs.writeFileSync(DB_FILE, JSON.stringify(normalized, null, 2));
  } catch (error) {
    console.error('Error writing jobs DB:', error);
  }
}

export function getJob(id: string): Job | undefined {
  const jobs = readJobs();
  return jobs[id];
}

export function saveJob(job: Job): void {
  const jobs = readJobs();
  jobs[job.id] = normalizeJob({
    ...job,
    updatedAt: new Date().toISOString()
  });
  writeJobs(jobs);
}

export function createJob(
  prompt: string,
  channel?: string,
  productPlacement?: string,
  introUrl?: string,
  productPlacementImg?: string,
  previewOnly?: boolean,
  segmentCount?: number
): Job {
  const id = 'job_' + Math.random().toString(36).substring(2, 11);
  const job: Job = {
    id,
    status: 'pending',
    prompt,
    channel,
    productPlacement,
    introUrl: introUrl !== undefined ? introUrl : '/assets/intros/default.mp4',
    productPlacementImg,
    previewOnly,
    segmentCount: segmentCount || 5,
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveJob(job);
  return job;
}
