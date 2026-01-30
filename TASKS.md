# Tasks: If TV Station (如果電視台)

## 🏗️ Foundation
- [x] Initialize Next.js project in `projects/if-tv-station` <!-- id: 0 -->
- [ ] Configure environment variables (OpenAI, Luma, YouTube API) <!-- id: 1 -->
- [x] Set up project folder structure (src/lib, src/components, src/app/api) <!-- id: 2 -->

## 🧠 Brainstorming & Scripting (Gemini)
- [x] Implement `brainstormWorld` utility to expand prompts (using Gemini) <!-- id: 3 -->
- [x] Implement `generateScriptSegments` with length constraints (using Gemini) <!-- id: 4 -->
- [ ] Create a "Character Profile" generator (visual descriptors) <!-- id: 5 -->

## 🎨 Asset Generation
- [ ] Integrate with DALL-E 3 / Midjourney for character reference images <!-- id: 6 -->
- [ ] Implement Luma/Kling/Runway API wrapper for video generation <!-- id: 7 -->
- [ ] Develop logic for "Sequential Generation" (tracking seed/cref) <!-- id: 8 -->

## 🎬 Video Processing
- [ ] Implement FFmpeg wrapper for concatenating MP4 segments <!-- id: 9 -->
- [ ] Add background music generation / selection logic <!-- id: 10 -->
- [ ] Implement Voiceover (TTS) integration (OpenAI TTS or ElevenLabs) <!-- id: 11 -->

## 📺 YouTube Integration
- [ ] Set up YouTube OAuth flow <!-- id: 12 -->
- [ ] Implement video upload utility with title/description generation <!-- id: 13 -->

## 💻 UI / UX
- [x] Design Premium Dashboard (Glassmorphism style) <!-- id: 14 -->
- [ ] Create "What if" prompt input and world-building preview <!-- id: 15 -->
- [ ] Add real-time generation progress tracker <!-- id: 16 -->
- [ ] Implement segment editor / previewer <!-- id: 17 -->

## 🚀 Final Polish
- [ ] End-to-end testing of the "Prompt-to-Upload" pipeline <!-- id: 18 -->
- [ ] Add error handling and retry logic for heavy API calls <!-- id: 19 -->
