import { Client } from "@gradio/client";
import fs from 'fs';

async function run() {
  try {
    console.log("Connecting to Space...");
    const client = await Client.connect("Wan-AI/Wan2.1");
    console.log("Connected! Reading test image...");
    
    const imgBuffer = fs.readFileSync("/home/ubuntu/youtube-ai-manager/diablo4_traces_of_hatred.png");
    const imgBlob = new Blob([imgBuffer], { type: 'image/png' });
    
    console.log("Submitting test predict to i2v_generation_async...");
    const result = await client.predict("/i2v_generation_async", [
      "test animation, minimal motion, wind blowing", // prompt
      imgBlob, // image
      false, // watermark
      42 // seed
    ]);
    
    console.log("PREDICTION RESULT DATA:", JSON.stringify(result.data, null, 2));
  } catch (err) {
    console.error("❌ Prediction failed:", err.message || err);
  }
}

run();
