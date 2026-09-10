import { Client } from "@gradio/client";

async function inspect() {
  try {
    const client = await Client.connect("Wan-AI/Wan2.1");
    // Print all routes and their details
    const view = await client.view_api();
    console.log("API DETAILS:");
    console.log(JSON.stringify(view, null, 2));
  } catch (err) {
    console.error("Error inspecting:", err);
  }
}

inspect();
