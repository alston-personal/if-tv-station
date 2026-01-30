# Project Spec: If TV Station (如果電視台)

## 📌 Overview
**If TV Station** is an automated video creation platform that transforms a simple "What If" prompt into a high-quality, continuous narrative video. It leverages AI to brainstorm alternative realities, write scripts, and generate video segments that maintain visual and character consistency.

## 🎯 Core Features
- **Intelligent World Building**: Expands a single "What if" sentence into a detailed world-view and set of recurring elements.
- **Narrative Segmentation**: Automatically breaks down long scripts into 5-10 second segments optimized for current AI video generators.
- **Visual Consistency Engine**: Uses character reference sheets (image-to-video) or consistent seed/style prompts to ensure characters look the same across segments.
- **Automated Assembler**: Merges video segments, adds background music/voiceover, and exports the final file.
- **YouTube Integration**: Direct upload to a YouTube channel via API.

## 🛠️ Technical Stack
- **Frontend**: Next.js (React) + Tailwind CSS + Lucide Icons.
- **Backend Logic**: Node.js / Python (for heavy video processing).
- **AI Models**:
  - **Brainstorming/Scripting**: OpenAI GPT-4o.
  - **Character/Style Reference**: Midjourney / DALL-E 3.
  - **Video Generation**: Luma API / Kling AI / Runway Gen-3.
- **Video Editing**: FFmpeg.
- **API**: YouTube Data API v3.

## 🏗️ System Architecture

### 1. The Imagination Engine (Brain)
- Receives the prompt: *"What if cats ruled the world and humans were pets?"*
- Generates:
  - World Setting (Rules of this world).
  - Main Character Profile (Appearance descriptors for consistency).
  - Storyboard (Scene-by-scene breakdown).

### 2. The Continuity Engine
- Generates a "Master Character Image" for each protagonist.
- Uses this image as a "Character Reference" (Cref) for video generation.
- Tracks "Story State" to ensure environmental consistency.

### 3. The Production Pipeline
- `Segment 01`: Generate 5s video -> Save.
- `Segment 02`: Generate 5s video -> Save.
- `...`
- `Concatenate`: Use FFmpeg to join segments with cross-fades.

## 🚀 Roadmap
- [ ] **Phase 1: CLI Prototype**: Basic "Prompt -> Script -> Segments" flow.
- [ ] **Phase 2: Video Gen Integration**: Connect to Luma/Runway API.
- [ ] **Phase 3: Continuity Polish**: Implement character reference logic.
- [ ] **Phase 4: Web Dashboard**: Premium UI for managing "What if" projects.
- [ ] **Phase 5: Automation**: One-click upload to YouTube.
