
import { GoogleGenerativeAI } from "@google/generative-ai";

// 取得所有可能的 API Keys
const getApiKeys = () => {
  const keys = [process.env.GEMINI_API_KEY];
  for (let i = 2; i <= 5; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (key) keys.push(key);
  }
  return keys.filter(Boolean) as string[];
};

async function executeWithFallback(task: (genAI: GoogleGenerativeAI, modelName: string) => Promise<any>) {
  const apiKeys = getApiKeys();
  const models = ["gemini-2.0-flash", "gemini-1.5-flash"];

  let lastError = null;

  // 嘗試每個 API Key
  for (const apiKey of apiKeys) {
    const genAI = new GoogleGenerativeAI(apiKey);

    // 每個 Key 嘗試不同模型
    for (const modelName of models) {
      try {
        console.log(`[AI] Checking ${modelName} with key starting with ${apiKey.slice(0, 8)}...`);
        return await task(genAI, modelName);
      } catch (error: any) {
        lastError = error;
        const msg = error.message?.toLowerCase() || "";

        // 如果是 429 或是 額度問題，就換下一個
        if (msg.includes("429") || msg.includes("quota") || msg.includes("limit")) {
          console.warn(`[AI] ${modelName} quota exceeded, switching...`);
          continue;
        }
        // 如果是其他嚴重錯誤，直接跳出
        throw error;
      }
    }
  }
  throw lastError || new Error("All models and keys failed.");
}

export async function brainstormWorld(prompt: string) {
  return executeWithFallback(async (genAI, modelName) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: "application/json" }
    });

    const systemPrompt = `You are the Creative Director of "If TV Station". 
    Your task is to take a "What if" prompt and expand it into a detailed world-view.
    Provide:
    1. worldName
    2. worldDescription (Atmosphere, logic, society)
    3. visualStyle (Cyberpunk, Ghibli-esque, Realistic, etc.)
    4. mainCharacterDescription (Detailed visual attributes for consistency)
    
    Respond in JSON format.`;

    const result = await model.generateContent([systemPrompt, prompt]);
    return JSON.parse(result.response.text());
  });
}

export async function generateScriptSegments(worldInfo: any) {
  return executeWithFallback(async (genAI, modelName) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: "application/json" }
    });

    const systemPrompt = `Based on the world: ${JSON.stringify(worldInfo)}, 
    create a video script of 5 segments. Each segment should be 5-8 seconds long.
    For each segment, provide:
    1. visualPrompt (for AI video generation, focusing on movement and character consistency)
    2. audioScript (Voiceover narration)
    3. backgroundAtmosphere (Sound effects or music cues)
    
    Respond in JSON format as an object with a "segments" array.`;

    const result = await model.generateContent(systemPrompt);
    const text = result.response.text();
    const data = JSON.parse(text);
    return data.segments || data;
  });
}
