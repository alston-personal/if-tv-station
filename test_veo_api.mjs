import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load env from agentmanager
dotenv.config({ path: '/home/ubuntu/agentmanager/.env' });

const apiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_1,
  process.env.CONTINUE_GEMINI_API_KEY
].filter(Boolean);

async function testVeo() {
  if (apiKeys.length === 0) {
    console.error("❌ No API Keys found.");
    return;
  }

  const prompt = "A cute Formosan leopard cat blinking and smiling, warm golden hour sunlight, dystopian Solarpunk tree city, highly detailed, Studio Ghibli, 8K.";
  const models = [
    'veo-3.1-generate-001',
    'veo-3.1-lite-generate-001',
    'veo-3.1-fast-generate-001',
    'veo-2.0-generate-001',
    'veo-3.1-generate-preview'
  ];

  for (const apiKey of apiKeys) {
    console.log(`\n🔑 Testing key starting with: ${apiKey.slice(0, 10)}...`);
    const ai = new GoogleGenAI({ apiKey });

    for (const model of models) {
      try {
        console.log(`   Trying model: "${model}"...`);
        const operation = await ai.models.generateVideos({
          model: model,
          prompt: prompt,
          config: {
            aspectRatio: '16:9',
            durationSeconds: 5
          }
        });
        
        console.log(`   ✅ SUCCESS! Operation Name: ${operation.name}`);
        console.log(`      Status done: ${operation.done}`);
        return; // Stop if we successfully initiated one!
      } catch (err) {
        console.warn(`   ❌ Failed with model "${model}":`, err.message || err);
      }
    }
  }
}

testVeo();
