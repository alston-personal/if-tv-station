import { Client } from "@gradio/client";
import fs from 'fs';

async function testSpace2() {
  try {
    console.log("Connecting to Space 2 (Wan-AI/Wan2.1)...");
    const client = await Client.connect("Wan-AI/Wan2.1");
    console.log("Connected successfully!");

    const imgBuffer = fs.readFileSync("/home/ubuntu/youtube-ai-manager/diablo4_traces_of_hatred.png");
    const imgBlob = new Blob([imgBuffer], { type: 'image/png' });

    console.log("Submitting to /i2v_generation_async...");
    const submission = client.submit("/i2v_generation_async", [
      "test animation, smooth motion, wind blowing, Formosan leopard cat", // prompt
      imgBlob, // image
      false, // watermark
      42 // seed
    ]);

    for await (const event of submission) {
      console.log("EVENT TYPE:", event.type);
      if (event.type === "data") {
        console.log("DATA EVENT:", JSON.stringify(event.data, null, 2));
      } else if (event.type === "status") {
        console.log("STATUS EVENT:", JSON.stringify(event.status, null, 2));
      }
    }
    console.log("Finished streaming events.");
  } catch (err) {
    console.error("❌ Space 2 test failed:", err.message || err);
  }
}

testSpace2();
