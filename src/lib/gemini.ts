import { GoogleGenAI } from '@google/genai';
import { reviewWithRole, reviewAndRefineScript, loadRoleMemory } from './creative_roles';
import { generateCharacterProfile } from './character_profile';
import { generateMasterCharacterImage } from './character_visualizer';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { Client } from '@gradio/client';
import { AGENTMANAGER_ENV_PATH } from './paths';

// 取得所有可能的 API Keys
export const getApiKeys = () => {
  const keys: string[] = [];
  
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  for (let i = 1; i <= 5; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (key && !keys.includes(key)) keys.push(key);
  }

  if (fs.existsSync(AGENTMANAGER_ENV_PATH)) {
    try {
      const content = fs.readFileSync(AGENTMANAGER_ENV_PATH, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        if (trimmed.includes('=')) {
          const [k, v] = trimmed.split('=', 2);
          const keyName = k.trim();
          const keyValue = v.trim();
          if (['GEMINI_API_KEY', 'GEMINI_API_KEY_1', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'CONTINUE_GEMINI_API_KEY'].includes(keyName)) {
            if (keyValue && !keys.includes(keyValue)) {
              keys.push(keyValue);
            }
          }
        }
      });
    } catch (e) {
      console.warn('[Gemini] Failed to read agentmanager/.env:', e);
    }
  }

  return keys.filter(Boolean);
};

// 取得付費視訊生成專用 Key (GEMINI_API_PAID_KEY)
export const getPaidApiKey = () => {
  if (process.env.GEMINI_API_PAID_KEY) {
    return process.env.GEMINI_API_PAID_KEY;
  }

  if (fs.existsSync(AGENTMANAGER_ENV_PATH)) {
    try {
      const content = fs.readFileSync(AGENTMANAGER_ENV_PATH, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.includes('=')) {
          const [k, v] = trimmed.split('=', 2);
          const keyName = k.trim();
          const keyValue = v.trim();
          if (keyName === 'GEMINI_API_PAID_KEY') {
            return keyValue;
          }
        }
      }
    } catch (e) {
      console.warn('[Gemini] Failed to read agentmanager/.env for GEMINI_API_PAID_KEY:', e);
    }
  }

  return null;
};

// 取得 GCP Vertex AI 設定 (GCP_PROJECT_ID, GCP_LOCATION, GCP_SERVICE_ACCOUNT_KEY_PATH)
export const getGcpConfig = () => {
  let project = process.env.GCP_PROJECT_ID || null;
  let location = process.env.GCP_LOCATION || 'us-central1';
  let keyPath = process.env.GCP_SERVICE_ACCOUNT_KEY_PATH || null;

  if (fs.existsSync(AGENTMANAGER_ENV_PATH)) {
    try {
      const content = fs.readFileSync(AGENTMANAGER_ENV_PATH, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.includes('=')) {
          const [k, v] = trimmed.split('=', 2);
          const keyName = k.trim();
          const keyValue = v.trim();
          if (keyName === 'GCP_PROJECT_ID') project = keyValue;
          if (keyName === 'GCP_LOCATION') location = keyValue;
          if (keyName === 'GCP_SERVICE_ACCOUNT_KEY_PATH') keyPath = keyValue;
        }
      }
    } catch (e) {
      console.warn('[Gemini] Failed to read agentmanager/.env for GCP config:', e);
    }
  }

  return { project, location, keyPath };
};

const CINEMATIC_VOCABULARY = {
  lighting: [
    'Rembrandt lighting', 'Butterfly lighting', 'Rim lighting', 'High-key lighting',
    'Low-key moody lighting', 'Chiaroscuro', 'Neon-noir glow', 'Golden hour warmth',
    'Soft diffused top-down light', 'Hard harsh sunlight', 'Volumetric fog with god rays'
  ],
  lenses: [
    'Anamorphic wide-angle lens', '85mm prime portrait lens', '35mm cinematic lens',
    'Macro lens for extreme detail', 'Fish-eye distortion', 'Deep depth of field',
    'Shallow depth of field with creamy bokeh'
  ],
  cameraMovement: [
    'Dolly zoom (Vertigo effect)', 'Slow cinematic pan', 'Steadicam smooth glide',
    'Handheld shaky-cam documentary style', 'Low-angle tracking shot', 'Crane shot',
    'High-angle bird eye view', 'Fast whip-pan'
  ],
  colorGrading: [
    'Kodak Vision3 500T film stock', 'Technicolor vibrant palette', 'Bleach bypass gritty look',
    'Teal and Orange cinematic grade', 'Desaturated monochromatic noir', 'Muted pastels',
    'High-contrast saturated colors'
  ],
  atmosphere: [
    'Heavy atmospheric haze', 'Floating particle dust', 'Rain-slicked reflective surfaces',
    'Swirling ember sparks', 'Cold sterile clinical air', 'Dreamy ethereal glow'
  ]
};

// 執行有 Fallback 和 Key 輪替的內容生成 (支援 Vertex AI 第一優先與 API Key 輪替備援)
export async function executeWithFallback<T>(
  task: (ai: GoogleGenAI, apiKey: string) => Promise<T>,
  specificKeys?: string[]
): Promise<T> {
  const gcpConfig = getGcpConfig();
  if (gcpConfig.project) {
    if (gcpConfig.keyPath) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(gcpConfig.keyPath);
    }
    try {
      console.log(`[AI] Attempting execution with Vertex AI (Project: ${gcpConfig.project}, Location: ${gcpConfig.location})...`);
      const ai = new GoogleGenAI({
        vertexai: true,
        project: gcpConfig.project,
        location: gcpConfig.location
      });
      return await task(ai, '');
    } catch (vertexErr: any) {
      console.warn(`[AI] Vertex AI execution failed: ${vertexErr.message || vertexErr}. Falling back to API keys...`);
    }
  }

  const apiKeys = specificKeys || getApiKeys();
  if (apiKeys.length === 0) {
    throw new Error('No GEMINI_API_KEY found in environment or agentmanager/.env and Vertex AI execution failed.');
  }

  let lastError = null;

  for (const apiKey of apiKeys) {
    const ai = new GoogleGenAI({ apiKey });
    try {
      console.log(`[AI] Checking key starting with ${apiKey.slice(0, 8)}...`);
      return await task(ai, apiKey);
    } catch (error: any) {
      lastError = error;
      console.warn(`[AI] Key ${apiKey.slice(0, 8)} failed: ${error.message || error}. Trying next available key...`);
      continue;
    }
  }
  throw lastError || new Error('All API keys failed.');
}

// 執行有 Model Fallback 的生成
export async function generateContentWithModelFallback(
  ai: GoogleGenAI,
  options: {
    contents: any;
    config?: any;
  }
) {
  const models = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite'
  ];
  let lastError = null;

  for (const model of models) {
    try {
      console.log(`[Gemini] Attempting generation with model: ${model}...`);
      const response = await ai.models.generateContent({
        model: model,
        contents: options.contents,
        config: options.config
      });
      console.log(`[Gemini] Model ${model} generation succeeded!`);
      return response;
    } catch (error: any) {
      lastError = error;
      const errorMsg = error.message || String(error);
      const isQuotaOrModelError = 
        errorMsg.includes('429') || 
        errorMsg.includes('RESOURCE_EXHAUSTED') || 
        errorMsg.includes('quota') || 
        errorMsg.includes('Quota') || 
        errorMsg.includes('limit') ||
        errorMsg.includes('not found') || 
        errorMsg.includes('not supported');
      
      console.warn(`[Gemini] Model ${model} failed: ${errorMsg}`);
      if (isQuotaOrModelError) {
        console.warn(`[Gemini] Falling back from ${model} to next model in sequence...`);
        continue;
      }
    }
  }
  throw lastError || new Error('All models in the fallback sequence failed.');
}

// 1. 世界觀發想 (導入 EVOLUTION_SOP 階段一：世界觀大綱)
export async function brainstormWorld(prompt: string, jobId = 'unknown', productPlacement?: string, productPlacementImgDesc?: string) {
  let activeProductPlacement = productPlacement;
  let activeProductPlacementImgDesc = productPlacementImgDesc;
  if (jobId && jobId !== 'unknown') {
    try {
      const { getJob } = require('./db');
      const job = getJob(jobId);
      if (job) {
        if (job.productPlacement) {
          activeProductPlacement = job.productPlacement;
        }
        if (job.productPlacementImgDesc) {
          activeProductPlacementImgDesc = job.productPlacementImgDesc;
        }
      }
    } catch (e) {
      console.warn('[BrainstormWorld] Could not load product placement details from job:', e);
    }
  }

  return executeWithFallback(async (ai) => {
    let systemPrompt = `You are the Creative Director of "If TV Station". 
    Your task is to take a "What if" prompt and expand it into a detailed parallel world-view according to our EVOLUTION_SOP.
    Provide:
    1. worldName (Traditional Chinese, Taiwan terminology, extremely catchy)
    2. worldDescription (Traditional Chinese, detailed atmosphere, rules/physics of this world, social structures, and potential underlying conflicts. Use immersive, descriptive, and world-building narratives. IMPORTANT: Must include at least one clear CONFLICT or tension that can drive a story.)
    3. visualStyle (English, Style Layer): Define the technical cinematic execution of this world. You MUST specify:
       - Lighting: (e.g., Chiaroscuro, Neon-noir, Golden hour, Soft-box lighting)
       - Lens & Camera: (e.g., Anamorphic wide-angle, 85mm portrait lens, Handheld shaky-cam)
       - Color & Stock: (e.g., Kodak Vision3 500T, Bleach bypass, Muted pastels)
       - Atmosphere: (e.g., Heavy haze, Particle dust, Rain-slicked surfaces)
       STRICTLY FORBIDDEN: Words like "photorealistic", "8k", "hyper-detailed", "masterpiece", "ultra-high resolution". Use technical cinematic terms instead.
    4. mainCharacterDescription (English, describe the character's visually distinctive features. IMPORTANT: If the character is an animal or non-human, they MUST be anthropomorphic (human-like posture and behavior) and WEARING detailed clothing/costumes appropriate to the world (e.g., a steampunk vest, a royal robe, a futuristic tactical suit). Describe hair/fur style, 2-3 key clothing items with specific colors, and 1-2 unique visual markers. Keep under 100 words for Veo consistency.)
    Reference Vocabulary for Style Layer:
    - Lighting: ${CINEMATIC_VOCABULARY.lighting.join(', ')}
    - Lenses: ${CINEMATIC_VOCABULARY.lenses.join(', ')}
    - Movement: ${CINEMATIC_VOCABULARY.cameraMovement.join(', ')}
    - Grading: ${CINEMATIC_VOCABULARY.colorGrading.join(', ')}
    - Atmosphere: ${CINEMATIC_VOCABULARY.atmosphere.join(', ')}
    `;

    if (activeProductPlacement) {
      let desc = activeProductPlacement;
      if (activeProductPlacementImgDesc) {
        desc += ` (Visual appearance/details: ${activeProductPlacementImgDesc})`;
      }
      systemPrompt += `\n[PRODUCT PLACEMENT REQUIREMENT]: You MUST integrate the following product placement item naturally as an essential background element or custom of this world: "${desc}".`;
    }

    systemPrompt += `\nRespond STRICTLY in JSON format as an object. Do not include markdown code fences in your raw response.`;

    const response = await generateContentWithModelFallback(ai, {
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json'
      }
    });

    const text = response.text || '{}';
    const worldInfo = JSON.parse(text.trim());

    // ── 編劇審閱：世界觀必須有衝突點 ──────────────────────────────────
    try {
      const review = await reviewWithRole(
        'screenwriter',
        '世界觀審閱',
        JSON.stringify(worldInfo, null, 2),
        jobId
      );
      console.log(`[BrainstormWorld] Screenwriter review: ${review.score}/10 - ${review.feedback}`);
      // 如果編劇直接提供了修訂版世界觀，優先使用
      if (!review.approved && review.revised_content && typeof review.revised_content === 'object') {
        console.log('[BrainstormWorld] Using screenwriter\'s revised world info');
        return { ...worldInfo, ...review.revised_content };
      }
    } catch (err) {
      console.warn('[BrainstormWorld] Screenwriter review skipped:', err);
    }

    return worldInfo;
  });
}

// 2. 劇本五幕劇段生成 (導入創作角色審閱機制)
export async function generateScriptSegments(worldInfo: any, jobId = 'unknown', productPlacement?: string, productPlacementImgDesc?: string, refinementFeedback?: string) {
  let segmentCount = 5;
  let activeProductPlacement = productPlacement;
  let activeProductPlacementImgDesc = productPlacementImgDesc;
  try {
    const { getJob } = require('./db');
    const job = getJob(jobId);
    if (job) {
      if (job.segmentCount) {
        segmentCount = Number(job.segmentCount);
      }
      if (job.productPlacement) {
        activeProductPlacement = job.productPlacement;
      }
      if (job.productPlacementImgDesc) {
        activeProductPlacementImgDesc = job.productPlacementImgDesc;
      }
    }
  } catch (e) {
    console.warn('[GenerateScript] Could not load details from job:', e);
  }

  // 讀取角色記憶，注入到 prompt 中
  let screenwriterGuidance = '';
  let directorGuidance = '';
  let composerGuidance = '';
  try {
    const swMem = loadRoleMemory('screenwriter');
    const dirMem = loadRoleMemory('director');
    const compMem = loadRoleMemory('composer');
    screenwriterGuidance = swMem.learned_patterns.good_structures?.join('; ') || '';
    directorGuidance = dirMem.learned_patterns.good_prompt_structures?.join('; ') || '';
    composerGuidance = compMem.learned_patterns.narration_styles?.join('; ') || '';
  } catch (e) {
    console.warn('[GenerateScript] Could not load role memories, proceeding without guidance');
  }

  // 暫存最新的 teaserAdvice
  let latestTeaserAdvice: any = {
    targetSegmentId: Math.min(4, segmentCount),
    startSecond: 1.0,
    endSecond: 4.0,
    caption: '精彩預告'
  };

  let placementInstruction = '';
  if (activeProductPlacement) {
    let desc = activeProductPlacement;
    if (activeProductPlacementImgDesc) {
      desc += ` (Visual details: ${activeProductPlacementImgDesc})`;
    }
    placementInstruction = `\n- [PRODUCT PLACEMENT]: You MUST naturally integrate this product/item: "${desc}" into at least one segment's action and description of the scene. The director MUST describe this product explicitly in visualPrompt so that the image generator can render it.`;
  }

  const generateSegments = async (ai: GoogleGenAI, refinementFeedback?: string): Promise<any[]> => {
    const refinementNote = refinementFeedback
      ? `\n\n[REVISION REQUIRED] The previous version was rejected. Key issues to fix:\n${refinementFeedback}\nPlease address ALL of these issues in this revision.`
      : '';

    let charDesc = '';
    if (worldInfo.mainCharacterDescription) {
      if (typeof worldInfo.mainCharacterDescription === 'object') {
        const char = worldInfo.mainCharacterDescription as any;
        const parts: string[] = [];
        if (char.gender) parts.push(`Gender: ${char.gender}`);
        if (char.age) parts.push(`Age: ${char.age}`);
        if (char.hair) parts.push(`Hair: ${char.hair}`);
        if (char.clothing) parts.push(`Clothing: ${char.clothing}`);
        if (char.uniqueMarkers) parts.push(`Features: ${char.uniqueMarkers}`);
        if (parts.length === 0) {
          for (const [k, v] of Object.entries(char)) {
            parts.push(`${k}: ${v}`);
          }
        }
        charDesc = parts.join(', ');
      } else {
        charDesc = String(worldInfo.mainCharacterDescription);
      }
    }

    const systemPrompt = `Based on the parallel world: ${JSON.stringify(worldInfo)},
    determine the optimal number of segments (typically between 3 to 7 acts/segments) required to tell this story effectively with a proper dramatic arc. Do not feel constrained to a fixed number; choose the act/segment count that best serves the narrative pace and complexity of this world.
    Each segment should feel like a full beat in a short film, targeting roughly 15-20 seconds of runtime.
    The script must feel like a film, not a lecture: every segment needs a concrete protagonist action, a specific place, and a visible camera-friendly moment.

    SCREENWRITER RULES (from memory):
    - ${screenwriterGuidance || 'Every act needs a concrete CHARACTER ACTION (what does the protagonist DO?)'}
    - THREE-ACT DRAMATIC CONTINUITY: The script MUST follow a coherent, continuous story with cause-and-effect logic from Segment 1 to the end. Segment 1 sets up a mystery/danger, Segment 2 escalates the conflict/obstacle, and the final Segment delivers a shocking twist climax and resolution!
    - CHARISMATIC TAIWANESE STORYTELLER VOICE: The narration must sound like an authentic, dramatic Taiwanese street storyteller (帶有江湖味與戲劇感說書口吻). Use dramatic hooks, vivid colloquialisms ("你敢信？", "事情這才剛開始...", "結果你猜怎麼著？"), and rhythmic cadence!
    - FIRST 3 SECONDS HOOK: Segment 1 MUST open with a suspenseful question, startling event, or high-stakes dilemma.
    - EMBEDDED SOUND CUES: You MUST embed sound effect markers directly into audioScript to direct audio pacing. Format strictly as [SFX: 音效描述].
    - SHOW, DON'T TELL: Jump straight into concrete actions, sensory details, or dramatic dialogue.
    ${placementInstruction}

    DIRECTOR RULES (from memory):
    - STRICT AUDIO-VISUAL MATCHING: Each shot's visualPrompt MUST EXACTLY match the physical action, objects, and characters described in its corresponding narrationSubstring! If narration mentions an object, action, or character reaction, the shot MUST visually show that exact object or action!
    - DYNAMIC SHOT VARIETY: Vary the camera framing across shots (Shot 1: Wide Establishing, Shot 2: Medium Character Action, Shot 3: Extreme Detail Close-Up).
    - DYNAMIC KEN BURNS MOTION: Every visualPrompt MUST explicitly specify camera motion (e.g., "Slow push-in zoom", "Smooth tracking pan", "Low-angle tracking shot").
    - Keep each shot's visualPrompt under 85 words.

    VISUAL PROMPT STRUCTURE:
    - SEGMENT visualPrompt: High-level visual essence of the segment mood.
    - SHOT visualPrompt: Specific visual rendering of that shot's narrationSubstring with explicit subject, action, and camera motion.

    COMPOSER RULES (from memory):
    - ${composerGuidance || 'Narration must have a distinct VOICE and personality'}
    - GOLD HOOK & SHARP RHYTHM: Focus on high information density and dramatic rhythm. Sentences should be punchy (short-to-medium clauses of 4-15 chars) with strong punctuation and clear emotional beats.
    - Narrative continuity is mandatory: segment 1 must plant a concrete unresolved clue and the final segment must pay it off.

    For each segment, provide:
    1. segmentVisualEssence (English, a high-level, holistic visual description of the entire segment's mood, lighting, and core motif. This will be used as the top-level visualPrompt. Max 50 words.)
    2. audioScript (Traditional Chinese/Taiwan, roughly 90-120 chars with embedded SFX sound cues, storyteller voice with personality, must be long and detailed, at least 3-4 clauses)
    3. shots: An array of 2 to 4 shot objects. Divide the segment's narration/scenes into sequential shots of 5-6 seconds each (so if the segment is 15-18 seconds, output 3 shots). For each shot, provide:
       - id: shot index (1, 2, 3, etc.)
       - visualPrompt: English, max 85 words, single emotional intention, specify camera motion (zoom/pan), identify character using key traits.
       - narrationSubstring: The specific part of the audioScript that this shot covers.
    4. act (one of: hook | inciting_incident | rising_action | climax | resolution)
    5. emotionalGoal (English, what emotion should audience feel? e.g. 'curiosity', 'dread', 'awe')
    6. characterAction (English, what does the protagonist DO in this scene?)
    7. foreshadowing (Traditional Chinese, a concrete unresolved clue; required in segment 1)
    8. payoff (Traditional Chinese, the concrete resolution of an earlier clue; required in the final segment)
    
    In addition, you MUST select the most exciting and visually hooky segment from the generated segments to serve as the "Teaser Highlight" (精彩預告) at the beginning of the video. Provide:
    - teaserAdvice: an object containing:
      - "targetSegmentId": (integer representing the segment ID to extract the teaser from, between 1 and the total number of segments generated)
      - "startSecond": (number, e.g. 1.0, where the best highlight action starts in that segment. Usually keep it at least 0.5s into the clip)
      - "endSecond": (number, e.g. 4.0, where the highlight action ends. The teaser can be flexible: 3 to 8 seconds is acceptable if the moment needs it. Choose the shortest length that still feels like a proper hook.)
      - "caption": (string, Traditional Chinese, a short catchy text card to overlay on the teaser, e.g. "精彩預告" or "精彩亮點")
    The teaser must be a true hook, not a random clip: choose the most surprising image, strongest character reaction, or highest-stakes moment.

    HARD FAIL CONDITIONS:
    - If a segment has no protagonist action, rewrite it.
    - If a segment sounds like a thesis statement or commentary, rewrite it.
    - If a visualPrompt cannot be filmed, rewrite it.
${refinementNote}

    Respond STRICTLY as JSON: { "segments": [...], "teaserAdvice": { "targetSegmentId": 1, "startSecond": 1.0, "endSecond": 4.0, "caption": "精彩預告" } }. No markdown fences.`;

    const response = await generateContentWithModelFallback(ai, {
      contents: `Create a dynamically-sized screenplay (typically 3 to 7 acts/segments based on world narrative complexity) for: ${worldInfo.worldName}`,
      config: { systemInstruction: systemPrompt, responseMimeType: 'application/json' }
    });

    const text = response.text || '{"segments": [], "teaserAdvice": {}}';
    const data = JSON.parse(text.trim());
    if (data.teaserAdvice) {
      latestTeaserAdvice = data.teaserAdvice;
    }
    
    const segments = data.segments || data;
    if (Array.isArray(segments)) {
      segments.forEach((seg: any) => {
        if (seg.segmentVisualEssence) {
          seg.visualPrompt = seg.segmentVisualEssence;
        } else if (seg.shots && Array.isArray(seg.shots)) {
          seg.visualPrompt = seg.shots.map((s: any) => s.visualPrompt).join(' | ');
        } else if (seg.visualPrompt) {
          // Wrap in a single shot fallback
          seg.shots = [{ id: 1, visualPrompt: seg.visualPrompt, narrationSubstring: seg.audioScript || '' }];
        }
        if (seg.shots && Array.isArray(seg.shots)) {
          seg.shots.forEach((s: any) => {
            if (s.narrationSubstring) {
              const { cleanScript } = cleanAudioScriptForTTS(s.narrationSubstring);
              s.narrationSubstring = cleanScript;
            }
          });
        }
      });
    }
    return segments;
  };

  return executeWithFallback(async (ai) => {
    // 第一次生成
    let segments = await generateSegments(ai, refinementFeedback);

    // ── 三角色審閱 + 最多 2 次重試 ────────────────────────────────────
    const { segments: refinedSegments, reviews, attempts } = await reviewAndRefineScript(
      segments,
      worldInfo,
      jobId,
      async (feedback) => {
        const segs = await generateSegments(ai, feedback);
        return segs;
      }
    );

    const avgScore = reviews.length > 0
      ? Math.round(reviews.reduce((s, r) => s + r.score, 0) / reviews.length)
      : 0;
    console.log(`[GenerateScript] Final script approved after ${attempts} attempt(s). Avg score: ${avgScore}/10`);

    return {
      segments: refinedSegments,
      teaserAdvice: latestTeaserAdvice
    };
  });
}

// 3. 影片片段生成與下載 (Veo 3.1)
export async function generateVideoSegment(
  visualPrompt: string,
  style: string,
  character: string,
  outputPath: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const paidKey = getPaidApiKey();
  const normalKeys = getApiKeys();
  const videoKeys = paidKey
    ? [paidKey, ...normalKeys.filter(k => k !== paidKey)]
    : normalKeys;

  return executeWithFallback(async (ai, apiKey) => {
    let cleanPrompt = visualPrompt.trim();
    if (cleanPrompt.endsWith('.')) {
      cleanPrompt = cleanPrompt.slice(0, -1);
    }
    
    // Check duplication to prevent bloated prompts
    let styleStr = '';
    if (style && style.trim().length > 0 && !cleanPrompt.toLowerCase().includes(style.toLowerCase().slice(0, 20))) {
      styleStr = `. Style: ${style.trim()}`;
    }
    
    const mentionsCharacter = /character|protagonist|storyteller|man|woman|person|face|eye|portrait|close-up|說書人|主角|人物|男人|女人/i.test(cleanPrompt);
    let charStr = '';
    if (mentionsCharacter && character && character.trim().length > 0 && !cleanPrompt.toLowerCase().includes(character.toLowerCase().slice(0, 20))) {
      charStr = `. Character details: ${character.trim()}`;
    }
    
    const fullPrompt = `${cleanPrompt}${styleStr}${charStr}. Award-winning documentary cinematography, shot on ARRI Alexa Mini LF, 35mm lens, realistic physical lighting, smooth natural motion, cinematic color grading, photorealistic. Avoid 3D render, cartoon, anime, plastic skin.`;
    
    if (onProgress) onProgress('Initiating video generation on Google Veo 3.1...');
    console.log(`[Veo] Creating video with prompt: "${fullPrompt.slice(0, 100)}..."`);

    const gcpConfig = getGcpConfig();
    const modelName = (gcpConfig.project && !apiKey) ? 'veo-3.1-generate-001' : 'veo-3.1-generate-preview';
    console.log(`[Veo] Using model: ${modelName}`);

    const operation = await (ai.models as any).generateVideos({
      model: modelName,
      prompt: fullPrompt,
      config: {
        aspectRatio: '16:9',
        durationSeconds: 6,
        resolution: '1080p'
      }
    });

    let op = operation;
    let pollAttempts = 0;
    const maxPolls = 60;

    if (onProgress) onProgress('Waiting for video synthesis (polling)...');
    
    while (!op.done && pollAttempts < maxPolls) {
      pollAttempts++;
      console.log(`[Veo] Polling operation ${op.name}... Attempt ${pollAttempts}`);
      if (onProgress) onProgress(`Synthesizing frames... (${pollAttempts * 10}s elapsed)`);
      
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      try {
        op = await (ai.operations as any).get({ operation: op });
      } catch (err) {
        console.error('[Veo] Error reloading operation status:', err);
      }
    }

    if (!op.done) {
      throw new Error('Video generation timed out on Google server.');
    }

    if (op.error) {
      throw new Error(`Google Veo generation failed: ${op.error.message || JSON.stringify(op.error)}`);
    }

    console.log('[Veo] Raw Operation Response:', JSON.stringify(op.response || op.result, null, 2));
    const resultObj = op.response || op.result || {};
    
    // Check if video is returned inline as base64 videoBytes (common in Vertex AI)
    const findVideoBytes = (obj: any): string => {
      if (!obj || typeof obj !== 'object') return '';
      if (obj.videoBytes && typeof obj.videoBytes === 'string') return obj.videoBytes;
      for (const k in obj) {
        const res = findVideoBytes(obj[k]);
        if (res) return res;
      }
      return '';
    };

    const videoBytes = findVideoBytes(resultObj);
    if (videoBytes) {
      console.log('[Veo] Video bytes detected in response. Decoding base64...');
      const buffer = Buffer.from(videoBytes, 'base64');
      fs.writeFileSync(outputPath, buffer);
      console.log(`[Veo] Saved video from inline videoBytes to: ${outputPath}`);
      return outputPath;
    }

    let videoUri = '';
    
    if (resultObj.generatedVideos?.[0]?.video?.uri) {
      videoUri = resultObj.generatedVideos[0].video.uri;
    } else if (resultObj.generatedSamples?.[0]?.video?.uri) {
      videoUri = resultObj.generatedSamples[0].video.uri;
    } else if (resultObj.video?.uri) {
      videoUri = resultObj.video.uri;
    } else {
      const findUri = (obj: any): string => {
        if (!obj || typeof obj !== 'object') return '';
        if (obj.uri && typeof obj.uri === 'string' && obj.uri.includes('http')) return obj.uri;
        for (const k in obj) {
          const res = findUri(obj[k]);
          if (res) return res;
        }
        return '';
      };
      videoUri = findUri(resultObj);
    }

    if (!videoUri) {
      throw new Error(`Failed to find generated video URL in response: ${JSON.stringify(resultObj)}`);
    }

    console.log(`[Veo] Video successfully generated! Download URL: ${videoUri}`);
    if (onProgress) onProgress('Downloading video asset to local server...');

    const writer = fs.createWriteStream(outputPath);
    
    let downloadUrl = videoUri;
    if (downloadUrl.includes('googleapis.com') && !downloadUrl.includes('key=')) {
      downloadUrl = downloadUrl.includes('?') ? `${downloadUrl}&key=${apiKey}` : `${downloadUrl}?key=${apiKey}`;
    }

    const response = await axios({
      method: 'get',
      url: downloadUrl,
      responseType: 'stream'
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`[Veo] Downloaded segment successfully: ${outputPath}`);
        resolve(outputPath);
      });
      writer.on('error', (err) => {
        console.error('[Veo] File download error:', err);
        reject(err);
      });
    });
  }, videoKeys);
}

// 4. 詼諧的 YouTube 標題與描述重寫
export async function generateWittyMetadata(
  prompt: string,
  worldInfo: any,
  chapters?: { timestamp: string; title: string; script: string }[]
) {
  return executeWithFallback(async (ai) => {
    const systemPrompt = `You are a viral YouTube channel manager who writes hilarious, self-deprecating, and highly clickable metadata.
    Based on the "What If" prompt: "${prompt}" and the parallel world: ${JSON.stringify(worldInfo)},
    please rewrite the video's title and description for maximum virality and viewer engagement.
    
    Requirements:
    1. Title: Extremely witty, funny, and clickbait (Traditional Chinese/Taiwanese, max 100 characters). E.g. using terms like "原來這才是真相", "貓奴必看", "跪著看完".
    2. Description: An engaging, funny summary of the video settings (Traditional Chinese/Taiwanese).
    ${chapters ? `
    We have computed the exact video chapters and timestamps for this video. You MUST include these exact chapters at the bottom of your description:
    ${chapters.map(c => `${c.timestamp} - [A catchy, witty chapter title based on script: "${c.script}"]`).join('\n')}
    Do NOT write or invent any other timestamps or chapters. Use only these exact timestamps.` : ''}
    
    Respond in JSON format with keys: "title" and "description".`;

    const response = await generateContentWithModelFallback(ai, {
      contents: `Rewrite YouTube metadata for world: ${worldInfo.worldName}`,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json'
      }
    });

    const text = response.text || '{}';
    return JSON.parse(text.trim());
  });
}

// 5. 字幕翻譯邏輯
export async function translateSubtitles(baseSrt: string, targetLanguage: string) {
  return executeWithFallback(async (ai) => {
    const systemPrompt = `Translate the following Traditional Chinese SRT subtitle file into ${targetLanguage}.
    
    Requirements:
    1. Output ONLY the raw translated SRT text. Do not wrap in markdown or backticks.
    2. Keep all timestamps, sequence numbers, and formatting EXACTLY the same.
    3. Ensure the translated language sounds natural, funny, and captures the original witty narrator vibe!`;

    const response = await generateContentWithModelFallback(ai, {
      contents: baseSrt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'text/plain'
      }
    });

    let text = response.text || '';
    // Strip markdown code fences if any
    text = text.replace(/^```[a-zA-Z]*\s*/, '');
    text = text.replace(/\s*```$/, '');
    return text.trim();
  });
}

// 6. 免費高質感圖像生成 (使用 Pollinations.ai 頂級 Flux 靜態生圖，100% 免費、免 Key、品質超越 Midjourney)
export async function generateImageSegment(
  prompt: string,
  style: string,
  character: string,
  outputPath: string
): Promise<string> {
  const cleanPrompt = prompt.trim();
  const lowerPrompt = cleanPrompt.toLowerCase();

  // 僅當分鏡描述涉及人物、說書人或特寫時才附帶角色細節，避免大景與環境鏡頭被強行扭曲為人物特寫
  const mentionsCharacter = /character|protagonist|storyteller|man|woman|person|face|eye|portrait|close-up|說書人|主角|人物|男人|女人/i.test(cleanPrompt);
  const charStr = (mentionsCharacter && character && character.trim().length > 0 && !lowerPrompt.includes(character.toLowerCase().slice(0, 15)))
    ? `. Character details: ${character.trim()}`
    : '';

  const styleStr = (style && style.trim().length > 0 && !lowerPrompt.includes(style.toLowerCase().slice(0, 15)))
    ? `. Style: ${style.trim()}`
    : '';

  const fullPrompt = `${cleanPrompt}${styleStr}${charStr}. Cinematic live-action film still, 35mm lens, ARRI Alexa LF color grading, volumetric lighting, highly detailed, photorealistic. Avoid 3D render, cartoon, anime, plastic skin, low quality.`;
  const gcpConfig = getGcpConfig();

  if (gcpConfig.project) {
    console.log(`[ImageGen] GCP detected. Trying Google image generation first with prompt: "${fullPrompt.slice(0, 100)}..."`);
    const googleModels = [
      { kind: 'generateImages' as const, model: 'imagen-4.0-generate-001' },
      { kind: 'generateImages' as const, model: 'imagen-3.0-generate-002' },
      { kind: 'generateContent' as const, model: 'gemini-3.1-flash-image' },
      { kind: 'generateContent' as const, model: 'gemini-2.5-flash-image' }
    ];

    for (const spec of googleModels) {
      try {
        const response = await executeWithFallback(async (ai) => {
          if (spec.kind === 'generateImages') {
            console.log(`[ImageGen][GCP] Attempting ${spec.model}...`);
            return await (ai.models as any).generateImages({
              model: spec.model,
              prompt: fullPrompt,
              config: {
                numberOfImages: 1,
                aspectRatio: '16:9'
              }
            });
          }

          console.log(`[ImageGen][GCP] Attempting ${spec.model}...`);
          return await (ai.models as any).generateContent({
            model: spec.model,
            contents: fullPrompt,
            config: {
              responseModalities: ['Image'],
              responseFormat: {
                image: {
                  aspectRatio: '16:9',
                  imageSize: '2K'
                }
              }
            }
          });
        });

        if (spec.kind === 'generateImages') {
          const generatedImage = (response as any)?.generatedImages?.[0];
          const imgBytes = generatedImage?.image?.imageBytes;
          if (imgBytes) {
            fs.writeFileSync(outputPath, Buffer.from(imgBytes, 'base64'));
            console.log(`[ImageGen][GCP] Saved generated image to: ${outputPath}`);
            return outputPath;
          }
        } else {
          const imgBuffer = extractInlineImageFromResponse(response);
          if (imgBuffer) {
            fs.writeFileSync(outputPath, imgBuffer);
            console.log(`[ImageGen][GCP] Saved generated image to: ${outputPath}`);
            return outputPath;
          }
        }

        console.warn(`[ImageGen][GCP] ${spec.model} returned no image bytes. Trying next Google model...`);
      } catch (err: any) {
        console.warn(`[ImageGen][GCP] ${spec.model} failed: ${err.message || err}. Trying next Google model...`);
      }
    }

    console.warn('[ImageGen][GCP] Google image generation did not succeed. Falling back to non-GCP sources...');
  }

  console.log(`[ImageGen] Generating high-fidelity image via Pollinations.ai (Flux) with prompt: "${fullPrompt.slice(0, 100)}..."`);

  // 嘗試 3 次，每次 timeout 逐步增加，第 3 次切換備用端點
  const MAX_RETRIES = 3;
  const TIMEOUTS = [90000, 90000, 120000]; // 90s, 90s, 120s

  const getUrl = (attempt: number) => {
    const encoded = encodeURIComponent(fullPrompt);
    if (attempt < 2) {
      // 主要端點：/p/ (Flux model)
      return `https://image.pollinations.ai/p/${encoded}?width=1920&height=1080&nologo=true&model=flux`;
    } else {
      // 備用端點：/prompt/ (older stable path)
      return `https://image.pollinations.ai/prompt/${encoded}?width=1920&height=1080&nologo=true`;
    }
  };

  let lastErr: any;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const url = getUrl(attempt);
    const timeout = TIMEOUTS[attempt];
    console.log(`[ImageGen] Attempt ${attempt + 1}/${MAX_RETRIES}, timeout ${timeout / 1000}s, url: ${url.slice(0, 80)}...`);

    try {
      const response = await axios({
        method: 'get',
        url,
        responseType: 'stream',
        timeout,
      });

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        // 若 stream 長時間靜止（pipe 卡住）也要能 reject
        response.data.on('error', reject);
      });

      console.log(`[ImageGen] Successfully saved generated image to: ${outputPath}`);
      return outputPath;
    } catch (err: any) {
      lastErr = err;
      // 清理可能的殘破檔案
      if (fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch (_) {}
      }
      const waitMs = (attempt + 1) * 3000; // 3s, 6s 退避
      console.warn(`[ImageGen] Attempt ${attempt + 1} failed: ${err.message}. ${attempt + 1 < MAX_RETRIES ? `Retrying in ${waitMs / 1000}s...` : 'No more retries.'}`);
      if (attempt + 1 < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  // ── Fallback: 使用 Hugging Face Space (Stable Diffusion 3.5 Large) ──
  console.log(`[ImageGen] Pollinations failed or IP rate-limited. Trying fallback via stabilityai/stable-diffusion-3.5-large...`);
  try {
    const client = await Client.connect("stabilityai/stable-diffusion-3.5-large");
    const result = await client.predict("/infer", {
      prompt: fullPrompt,
      negative_prompt: "",
      seed: 0,
      randomize_seed: true,
      width: 1024,
      height: 576,
      guidance_scale: 4.5,
      num_inference_steps: 28
    });
    
    const imgData = (result.data as any)?.[0];
    const imgUrl = imgData?.url;
    if (!imgUrl) {
      throw new Error('No image URL returned from Gradio space.');
    }
    
    console.log(`[ImageGen] Stable Diffusion succeeded! Downloading from: ${imgUrl}`);
    const response = await axios({
      method: 'get',
      url: imgUrl,
      responseType: 'stream',
      timeout: 60000
    });
    
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    console.log(`[ImageGen] Successfully saved fallback image to: ${outputPath}`);
    return outputPath;
  } catch (fallbackErr: any) {
    console.error(`[ImageGen] Fallback Stable Diffusion failed:`, fallbackErr.message || fallbackErr);
    throw lastErr || fallbackErr;
  }
}

// 7. 免費開源影片生成 (使用 Hugging Face multimodalart/wan2-1-fast / Wan-AI/Wan2.1 公用 Gradio 空間，讓靜態圖像動起來！)
export async function generateFreeVideoSegment(
  prompt: string,
  style: string,
  character: string,
  tempImgPath: string,
  outputPath: string
): Promise<string> {
  console.log(`[FreeVideoGen] Preparing prompt for image animation...`);
  const fullPrompt = `make this image come alive, cinematic motion, smooth animation, wind blowing, ${prompt}. Style: ${style}. Character details: ${character}`;
  
  // 讀取暫存的 Flux 圖片並轉為 Blob
  const imgBuffer = fs.readFileSync(tempImgPath);
  const imgBlob = new Blob([imgBuffer], { type: 'image/jpeg' });
  const seed = Math.floor(Math.random() * 1000000);

  let remoteVideoUrl = '';
  let lastErr: any = null;

  // 嘗試 Space 1: multimodalart/wan2-1-fast (蒸餾快速版)
  try {
    console.log(`[FreeVideoGen] Connecting to Space 1: multimodalart/wan2-1-fast...`);
    const client = await Client.connect("multimodalart/wan2-1-fast");
    console.log(`[FreeVideoGen] Connected to Space 1 successfully! Submitting generation request...`);
    
    const result = await client.predict("/generate_video", {
      input_image: imgBlob,
      prompt: fullPrompt,
      height: 512,
      width: 896,
      negative_prompt: "Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, static, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, still picture, messy background, three legs, many people in the background, walking backwards, watermark, text, signature",
      duration_seconds: 3.4,
      guidance_scale: 1,
      steps: 4,
      seed: seed,
      randomize_seed: true
    });

    console.log(`[FreeVideoGen] Space 1 prediction completed successfully.`);
    const resultData = result.data as any;
    const videoData = resultData.find((item: any) => item && (item.url || item.video?.url));
    remoteVideoUrl = videoData?.video?.url || videoData?.url;
  } catch (err: any) {
    console.warn(`[FreeVideoGen] Space 1 (wan2-1-fast) failed: ${err.message || err}. Trying Fallback Space 2: Wan-AI/Wan2.1 (Official)...`);
    lastErr = err;
  }

  // 嘗試 Space 2: Wan-AI/Wan2.1 (官方版 - 佇列式，無 ZeroGPU 額度硬限制)
  if (!remoteVideoUrl) {
    try {
      console.log(`[FreeVideoGen] Connecting to Space 2: Wan-AI/Wan2.1...`);
      const client = await Client.connect("Wan-AI/Wan2.1");
      console.log(`[FreeVideoGen] Connected to Space 2 successfully! Submitting i2v_generation_async request...`);

      const submission = client.submit("/i2v_generation_async", [
        fullPrompt,
        imgBlob,
        false,
        seed
      ]);

      console.log(`[FreeVideoGen] Space 2 submission started. Waiting for event stream...`);
      for await (const event of submission) {
        const ev = event as any;
        if (ev.type === "data") {
          console.log(`[FreeVideoGen] Space 2 received data event!`);
          const resultData = ev.data as any;
          const videoData = resultData.find((item: any) => item && (item.url || item.video?.url || item.path));
          if (videoData) {
            remoteVideoUrl = videoData.url || videoData.video?.url || (videoData.path ? `${(client as any).config?.root}/file=${videoData.path}` : '');
            if (remoteVideoUrl) {
              console.log(`[FreeVideoGen] Space 2 found video URL: ${remoteVideoUrl}`);
            }
          }
        } else if (ev.type === "status") {
          console.log(`[FreeVideoGen] Space 2 status: stage=${ev.status?.stage || 'unknown'}, queue_position=${ev.status?.queue_position ?? 'none'}, eta=${ev.status?.eta ?? 'unknown'}s`);
        }
      }
    } catch (err: any) {
      console.error(`[FreeVideoGen] Space 2 (Wan-AI/Wan2.1) failed too:`, err);
      lastErr = err;
    }
  }

  if (!remoteVideoUrl) {
    throw new Error(`All public video generation spaces failed. Last error: ${lastErr?.message || lastErr}`);
  }

  console.log(`[FreeVideoGen] Downloading generated video from: ${remoteVideoUrl}`);
  try {
    const videoResponse = await axios({
      method: 'get',
      url: remoteVideoUrl,
      responseType: 'stream',
      timeout: 180000 // 延長至 3 分鐘以應對大型視訊下載
    });

    const writer = fs.createWriteStream(outputPath);
    videoResponse.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`[FreeVideoGen] Successfully saved animated video segment to: ${outputPath}`);
        resolve(outputPath);
      });
      writer.on('error', (err) => {
        console.error('[FreeVideoGen] File download error:', err);
        reject(err);
      });
    });
  } catch (err: any) {
    console.error(`[FreeVideoGen] Video asset download failed:`, err);
    throw err;
  }
}

function extractInlineAudioFromResponse(response: any): Buffer | null {
  const candidates = response?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (part?.inlineData?.data) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }
  }

  const topLevelParts = response?.parts || [];
  for (const part of topLevelParts) {
    if (part?.inline_data?.data) {
      return Buffer.from(part.inline_data.data, 'base64');
    }
    if (part?.inlineData?.data) {
      return Buffer.from(part.inlineData.data, 'base64');
    }
  }

  return null;
}

function extractInlineImageFromResponse(response: any): Buffer | null {
  const candidates = response?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (part?.inlineData?.data) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
      if (part?.inline_data?.data) {
        return Buffer.from(part.inline_data.data, 'base64');
      }
    }
  }

  const topLevelParts = response?.parts || [];
  for (const part of topLevelParts) {
    if (part?.inlineData?.data) {
      return Buffer.from(part.inlineData.data, 'base64');
    }
    if (part?.inline_data?.data) {
      return Buffer.from(part.inline_data.data, 'base64');
    }
  }

  return null;
}

// 8. Google Music (Lyria-3) 音樂生成
export async function generateLyriaMusic(prompt: string, outputPath: string): Promise<string | null> {
  return executeWithFallback(async (ai) => {
    console.log(`[MusicGen] Attempting Google Lyria-3 music generation: "${prompt}"...`);
    try {
      const musicPrompt = [
        'Create instrumental background music for a cinematic YouTube video.',
        'No vocals, no lyrics, no spoken words.',
        'Make it rich, modern, emotionally supportive, and easy to loop under narration.',
        'Use clear structure with intro, build, and tail-out so it can be layered under a video edit.',
        prompt
      ].join(' ');

      const response = await (ai.models as any).generateContent({
        model: 'lyria-3-pro-preview',
        contents: musicPrompt,
      });

      const audioBuffer = extractInlineAudioFromResponse(response);
      if (audioBuffer) {
        console.log('[MusicGen] Audio bytes detected. Writing MP3...');
        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`[MusicGen] Saved Lyria music to: ${outputPath}`);
        return outputPath;
      }
      console.warn('[MusicGen] No inline audio found in response parts.');
      return null;
    } catch (err: any) {
      console.warn(`[MusicGen] Lyria API failed: ${err.message || err}`);
      return null;
    }
  });
}

// 9. 多模態分析行銷置入圖片特徵
export async function describeProductImage(imagePath: string): Promise<string> {
  return executeWithFallback(async (ai) => {
    console.log(`[Gemini][describeProductImage] Analyzing image: ${imagePath}...`);
    try {
      if (!fs.existsSync(imagePath)) {
        console.warn(`[Gemini][describeProductImage] Image path not found: ${imagePath}`);
        return '';
      }

      const fileBuffer = fs.readFileSync(imagePath);
      const base64Data = fileBuffer.toString('base64');
      
      const ext = path.extname(imagePath).toLowerCase();
      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.gif') mimeType = 'image/gif';

      const response = await generateContentWithModelFallback(ai, {
        contents: [
          'Analyze this image and describe the core item or product visually in detail. Specify its color, shape, materials, text labels, logos, and style. Keep the description extremely concise, specific, concrete, and strictly in English under 40 words, suitable for text-to-image prompts. Do not include introductory phrases like "This image shows".',
          {
            inlineData: {
              data: base64Data,
              mimeType: mimeType
            }
          }
        ]
      });

      const text = (response.text || '').trim();
      console.log(`[Gemini][describeProductImage] Extracted description: "${text}"`);
      return text;
    } catch (err: any) {
      console.error(`[Gemini][describeProductImage] Failed to analyze image:`, err.message || err);
      return '';
    }
  });
}

// 動態腦力激盪發燒話題的平行宇宙「What If」開頭句
export async function brainstormTrendPrompt(topic: string, news?: string): Promise<string> {
  // 載入導演的記憶與身份
  let directorPersona = '';
  try {
    const dirMem = loadRoleMemory('director');
    directorPersona = dirMem.persona;
  } catch (e) {
    directorPersona = '你是一位曾執導多部國際獲獎短片的台灣導演，深受侯孝賢的長鏡頭美學與王家衛的色彩語言影響...';
  }

  return await executeWithFallback(async (ai) => {
    const context = news ? `\n相關新聞標題：${news}` : '';
    const systemInstruction = `${directorPersona}

你現在要以導演的身份，針對今日的發燒話題或新聞進行平行宇宙短片的「What If（如果...）」靈感發想。
你的目標是創造一個富含電影視覺張力、能夠直接在觀眾腦海中引發強烈光影畫面、甚至能馬上被畫成電影海報的超現實概念設定。

【你的發想要求】：
1. 必須是「影像與鏡頭驅動（Image-driven）的」，當聽者讀到句子時，眼前必須浮現出非常具體的視覺衝突或物理符號（例如：發光的00919綠色頭盔、鈔票鋪成的培養槽、浮空的紅黑色名牌等），不要只停留在文字概念。
2. 結合新聞的真實細節與你獲獎導演的獨特審美（如驚悚科幻、黑色幽默、王家衛式的色彩斑斕、侯孝賢式的沈穩冷冽）。
3. 句式必須以「如果...」開頭，字數控制在 50-80 字內。

例如：
- 話題：星巴克 買一送一
- 相關新聞標題：星巴克買一送一限時三天！咖啡控趕快衝一波
- 輸出：如果「星巴克買一送一」的背後，是為了全城人類強制注入發光綠色多巴胺監控藥水，凡是喝下的人雙眼都會在暗夜中泛起幽綠的光芒...

- 話題：00919 高股息
- 相關新聞標題：00919除息發紅包！股民樂翻
- 輸出：如果「00919」的高股息其實是古老文明的活體咒語，誘使股民戴上刻有代號的發光綠色頭盔，將靈魂獻祭做宇宙能量活體電池...

請直接輸出這句設定句，使用繁體中文（台灣繁中），直接輸出句子，不要有任何多餘的解釋、引言或引號。`;

    const response = await (ai.models as any).generateContent({
      model: 'gemini-2.5-flash',
      contents: `話題：${topic}${context}`,
      config: {
        systemInstruction,
        temperature: 1.0, // 提升隨機創意性
      }
    });

    const result = response.text || '';
    return result.trim().replace(/^["'「]+|["'」]+$/g, ''); // 清理首尾引號
  });
}

/**
 * 剝離劇本中用於聽覺指示的 [SFX: ...] 音效標記，
 * 回傳無標記純文字以利 TTS 語音合成，並傳回音效 cue 點。
 */
export function cleanAudioScriptForTTS(script: string): { cleanScript: string; sfxCues: Array<{ name: string; position: number }> } {
  if (!script) return { cleanScript: '', sfxCues: [] };
  const sfxCues: Array<{ name: string; position: number }> = [];
  
  const cleanScript = script
    .replace(/[\[【\(（](?:SFX|音效|sfx)?:\s*([^\]】\)\）]+)[\]】\)\）]/gi, (match, sfxName, offset) => {
      sfxCues.push({ name: sfxName.trim(), position: offset });
      return '';
    })
    .replace(/[\[【\(（][^\]】\)\）]+[\]】\)\）]/g, '') // 徹底過濾剩餘括號說明文字
    .replace(/\s+/g, ' ')
    .trim();

  return { cleanScript, sfxCues };
}
