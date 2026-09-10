import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: '/home/ubuntu/agentmanager/.env' });

const apiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_1,
  process.env.CONTINUE_GEMINI_API_KEY
].filter(Boolean);

async function run() {
  if (apiKeys.length === 0) {
    console.error("❌ No API Keys found.");
    return;
  }

  for (const apiKey of apiKeys) {
    console.log(`\n🔑 Trying GEMINI_API_KEY starting with: ${apiKey.slice(0, 10)}...`);
    const ai = new GoogleGenAI({ apiKey });

    try {
      console.log("   Initiating generateVideos with veo-3.1-generate-preview...");
      const operation = await ai.models.generateVideos({
        model: 'veo-3.1-generate-preview',
        prompt: "A close-up shot of a cute Formosan leopard cat smiling, cinematic lighting, 4k.",
        config: {
          aspectRatio: '16:9',
          durationSeconds: 6
        }
      });

      console.log("   ✅ Successfully initiated! Operation Name:", operation.name);
      console.log("   Polling for completion (this may take a minute)...");

      let op = operation;
      let attempts = 0;
      while (!op.done && attempts < 30) {
        attempts++;
        console.log(`   Polling attempt ${attempts}/30...`);
        await new Promise(r => setTimeout(r, 10000));
        op = await ai.operations.get(op);
      }

      console.log("   Final Operation Status:", op.done ? "DONE" : "NOT DONE");
      if (op.error) {
        console.error("   ❌ Operation failed:", op.error);
      } else {
        console.log("   🎉 SUCCESS! Video synthesized:", JSON.stringify(op.response || op.result, null, 2));
        return; // Success! Exit the script.
      }
    } catch (err) {
      console.error("   ❌ Failed:", err.message || err);
    }
  }
}

run();
