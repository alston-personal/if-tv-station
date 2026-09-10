import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load .env from agentmanager
dotenv.config({ path: '/home/ubuntu/agentmanager/.env' });

const apiKey = process.env.POLLINATIONS_API_KEY;
console.log("Using Pollinations API Key:", apiKey ? `${apiKey.slice(0, 10)}...` : 'None');

async function testVideo() {
  try {
    console.log("Sending video generation request to Pollinations...");
    // Let's call the gen.pollinations.ai API
    // According to their API, we can post to the chat-like interface or unified media generation
    const response = await axios.post('https://gen.pollinations.ai/video', {
      prompt: "A cute Formosan leopard cat blinking and smiling, warm golden hour sunlight, utopian Solarpunk tree city, highly detailed, Studio Ghibli meets cinematic realism, 8K resolution.",
      width: 896,
      height: 512,
      model: "ltx-video", // or check which model works
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 180000
    });

    console.log("POLLINATIONS RESPONSE STATUS:", response.status);
    console.log("POLLINATIONS RESPONSE DATA:", JSON.stringify(response.data, null, 2));
  } catch (err) {
    console.error("❌ Pollinations video generation failed:", err.response?.status, err.response?.data || err.message);
  }
}

testVideo();
