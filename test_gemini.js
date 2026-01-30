
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require("dotenv");
const path = require("path");

// Load env from root
dotenv.config({ path: path.join(__dirname, ".env") });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

async function testBrainstorm(prompt) {
  console.log(`\n🚀 啟動想像力引擎: "${prompt}"\n`);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-exp",
    generationConfig: { responseMimeType: "application/json" }
  });

  const systemPrompt = `You are the Creative Director of "If TV Station". 
  Your task is to take a "What if" prompt and expand it into a detailed world-view.
  Provide:
  1. worldName (Chinese)
  2. worldDescription (Chinese, Atmosphere, logic, society)
  3. visualStyle (English, e.g., Cyberpunk, Ghibli-esque, Realistic, etc.)
  4. mainCharacterDescription (English, Detailed visual attributes for consistency)
  
  Respond in JSON format.`;

  const result = await model.generateContent([systemPrompt, prompt]);
  const worldInfo = JSON.parse(result.response.text());

  console.log("🌍 --- 世界觀設定 ---");
  console.log(JSON.stringify(worldInfo, null, 2));

  console.log("\n🎬 --- 劇本片段生成 ---");
  const scriptPrompt = `Based on the world: ${JSON.stringify(worldInfo)}, 
  create a video script of 3 segments. Each segment should be 5-8 seconds long.
  For each segment, provide:
  1. visualPrompt (English, for AI video generation, focusing on movement and character consistency)
  2. audioScript (Chinese, Voiceover narration)
  
  Respond in JSON format as an object with a "segments" array.`;

  const scriptResult = await model.generateContent(scriptPrompt);
  const scriptData = JSON.parse(scriptResult.response.text());

  console.log(JSON.stringify(scriptData, null, 2));
}

testBrainstorm("如果貓主宰這世界");
