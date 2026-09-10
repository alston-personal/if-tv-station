import path from 'path';

export const PROJECT_ROOT = process.cwd();

const DEFAULT_AGENT_DATA_ROOT = '/home/ubuntu/agent-data';

export const AGENT_DATA_ROOT = path.resolve(
  process.env.AGENT_DATA_ROOT || DEFAULT_AGENT_DATA_ROOT
);

export const AGENTMANAGER_ROOT = path.resolve(
  process.env.AGENTMANAGER_ROOT || path.resolve(PROJECT_ROOT, '..', '..')
);

export const AGENTMANAGER_ENV_PATH = path.resolve(
  process.env.AGENTMANAGER_ENV_PATH || path.join(AGENTMANAGER_ROOT, '.env')
);

export const IF_TV_DATA_DIR = path.join(AGENT_DATA_ROOT, 'projects', 'if-tv-station');
export const IF_TV_STATUS_PATH = path.join(IF_TV_DATA_DIR, 'STATUS.md');
export const IF_TV_ROLE_MEMORY_DIR = path.join(IF_TV_DATA_DIR, 'memory', 'roles');
export const IF_TV_MEMORY_DIR = path.join(PROJECT_ROOT, 'memory');
export const IF_TV_JOBS_PATH = path.join(PROJECT_ROOT, 'jobs.json');
export const IF_TV_PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const IF_TV_SFX_DIR = path.join(IF_TV_PUBLIC_DIR, 'assets', 'sfx');
export const IF_TV_RENDER_DIR = path.join(IF_TV_PUBLIC_DIR, 'renders');
export const IF_TV_YOUTUBE_FEEDBACK_SCRIPT = path.join(
  PROJECT_ROOT,
  'src',
  'lib',
  'youtube_feedback.py'
);
export const IF_TV_YOUTUBE_UPLOADER_SCRIPT = path.join(
  PROJECT_ROOT,
  'src',
  'lib',
  'youtube_uploader.py'
);
export const IF_TV_FONT_PATH = path.join(
  PROJECT_ROOT,
  'src',
  'assets',
  'fonts',
  'jf-openhuninn-1.1.ttf'
);
