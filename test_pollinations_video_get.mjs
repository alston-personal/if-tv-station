import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';

// Load .env from agentmanager
dotenv.config({ path: '/home/ubuntu/agentmanager/.env' });

const apiKey = process.env.POLLINATIONS_API_KEY;
console.log("Using Pollinations API Key:", apiKey ? `${apiKey.slice(0, 10)}...` : 'None');

async function testVideoGet() {
  const prompt = "A cute Formosan leopard cat blinking and smiling, warm golden hour sunlight, highly detailed, Studio Ghibli, 8K";
  const url = `https://gen.pollinations.ai/video/${encodeURIComponent(prompt)}?key=${apiKey}`;
  
  console.log("Sending GET request to Pollinations:", url);
  try {
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 180000 // 3 minutes timeout
    });

    console.log("RESPONSE STATUS:", response.status);
    
    const writer = fs.createWriteStream('/tmp/pollinations_test.mp4');
    response.data.pipe(writer);

    return new Promise((resolve) => {
      writer.on('finish', () => {
        console.log("✅ Video successfully saved to /tmp/pollinations_test.mp4!");
        resolve(true);
      });
    });
  } catch (err) {
    console.error("❌ Pollinations video generation failed:", err.message);
  }
}

testVideoGet();
