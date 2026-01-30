
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config({ path: path.join(__dirname, ".env") });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

async function run(prompt) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-exp",
    generationConfig: { responseMimeType: "application/json" }
  });

  const worldPrompt = `You are the Creative Director of "If TV Station". 
  Expand this "What if" prompt: "${prompt}"
  Provide:
  1. worldName (Chinese)
  2. worldDescription (Chinese)
  3. visualStyle (English)
  4. mainCharacterDescription (English, visual descriptors)
  Respond in JSON.`;

  const worldResult = await model.generateContent(worldPrompt);
  const worldInfo = JSON.parse(worldResult.response.text());

  const scriptPrompt = `Based on: ${JSON.stringify(worldInfo)}, create 3 video segments (5s each).
  Each segment needs:
  1. visualPrompt (English, for AI video)
  2. audioScript (Chinese, narration)
  Respond in JSON with a "segments" array.`;

  const scriptResult = await model.generateContent(scriptPrompt);
  const scriptInfo = JSON.parse(scriptResult.response.text());

  const finalOutput = { world: worldInfo, segments: scriptInfo.segments };
  fs.writeFileSync("result.json", JSON.stringify(finalOutput, null, 2));
}

run("如果貓主宰這世界");
