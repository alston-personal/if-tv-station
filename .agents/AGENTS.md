# AgentOS — If TV Station Project Context

This is the **Logic Layer Root** of the If TV Station video automation ecosystem.
- Project data (Status, Memory, Logs) lives at: `/home/ubuntu/agent-data/projects/if-tv-station/`

---

## 🚩 Critical System Constraints
1. **Logic/Data Separation**: Never create real files/directories named `STATUS.md` or `memory/` in this repository. They MUST remain symlinks pointing to the data layer.
2. **Path Base**: The web application uses `basePath: "/iftv"`. All AJAX fetches on the frontend must use the prefix `/iftv/api/...`.
3. **Taiwan Localization**: All Chinese text, subtitles, audio scripts, and generated contents must strictly use **Traditional Chinese (Taiwan)**. Simplified Chinese and Mainland Chinese terms are prohibited.

---

## 🧠 Pipeline Roles & Rule Sets

To guarantee quality and avoid regression, the agent must enforce these constraints across all roles:

### 1. Screenwriter (編劇角色)
- **Minimum Story Duration**: The final video must pass the 75-second threshold (or 60-second fallback depending on build).
- **Segment Script Length**: To ensure the duration threshold is met, each segment script (`audioScript`) must contain **at least 80-120 characters** (usually forcing 3-4 clauses) so that reading time takes at least 15-20 seconds per segment.

### 2. Subtitle Maker & Editor (字幕與後製)
- **Punctuation Splitting**: Never display a single long subtitle block for the entire segment. Segment scripts must be split by punctuation (`，`, `。`, `！` or `？`) into shorter, line-by-line subtitles.
- **Proportional Timeline**: Subtitle start/end times within a segment must be distributed proportionally based on character weight.

### 3. Director & Visuals (導演與視覺)
- **Character Consistency**: Visual prompts must reference the established character profiles (e.g. eye wear, clothing, hair color) to maintain visual continuity.
- **Clean Starts**: When starting a \"new\" parallel world, reset the selected world state (`selectedWorldId = \"new\"`) so that the AI does not mix the visual details of past characters/worlds.

### 4. Gateway & State Controller (狀態與任務管理)
- **Automatic Restore Guard**: Page reload should **only** restore active running jobs (`pending`, `brainstorming`, `review_ready`, `generating`, `stitching`, `uploading`).
- **Ignore Finished Jobs on Reload**: Jobs in finished states like `published`, `completed`, `failed`, or `preview_ready` must **not** be restored on page reload, so that the user lands directly on a clean home page.
- **Vertex AI Fallback**: LLM calls must try GCP Vertex AI first. If it fails, catch the error and fall back to rotating API keys.

---

## 🛠️ Deploy & Build Workflow
Whenever frontend (`src/app/page.tsx`, etc.) or lib files are modified, you must build and restart:
```bash
npm run build && pm2 restart iftv
```
