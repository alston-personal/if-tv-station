import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { normalizeMainCharacterDescription } from '../../../lib/db';
import { IF_TV_MEMORY_DIR as MEMORY_DIR } from '../../../lib/paths';

const WORLDS_FILE = path.join(MEMORY_DIR, 'saved_worlds.json');

interface SavedWorld {
  id: string;
  prompt: string;
  worldName: string;
  worldDescription: string;
  visualStyle: string;
  mainCharacterDescription: string;
  createdAt: string;
}

function readSavedWorlds(): SavedWorld[] {
  if (!fs.existsSync(WORLDS_FILE)) {
    // 確保目錄存在
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    fs.writeFileSync(WORLDS_FILE, JSON.stringify({ worlds: [] }, null, 2));
    return [];
  }
  try {
    const data = fs.readFileSync(WORLDS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return (parsed.worlds || []).map((world: SavedWorld) => ({
      ...world,
      mainCharacterDescription: normalizeMainCharacterDescription(world.mainCharacterDescription)
    }));
  } catch (error) {
    console.error('Error reading saved worlds:', error);
    return [];
  }
}

function writeSavedWorlds(worlds: SavedWorld[]): void {
  try {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    fs.writeFileSync(WORLDS_FILE, JSON.stringify({ worlds }, null, 2));
  } catch (error) {
    console.error('Error writing saved worlds:', error);
  }
}

export async function GET() {
  try {
    const worlds = readSavedWorlds();
    return NextResponse.json({ worlds });
  } catch (error: any) {
    console.error('[API][Worlds] GET error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const worldData = await request.json();
    const { prompt, worldName, worldDescription, visualStyle, mainCharacterDescription } = worldData;

    if (!worldName || !worldDescription) {
      return NextResponse.json({ error: 'worldName and worldDescription are required' }, { status: 400 });
    }

    const worlds = readSavedWorlds();
    
    // 檢查是否已存在同名世界，如果存在則更新，否則新增
    const existingIndex = worlds.findIndex(w => w.worldName === worldName);
    
    const newWorld: SavedWorld = {
      id: worldData.id || 'world_' + Math.random().toString(36).substring(2, 11),
      prompt: prompt || '',
      worldName,
      worldDescription,
      visualStyle: visualStyle || '',
      mainCharacterDescription: normalizeMainCharacterDescription(mainCharacterDescription),
      createdAt: worldData.createdAt || new Date().toISOString()
    };

    if (existingIndex > -1) {
      worlds[existingIndex] = {
        ...worlds[existingIndex],
        ...newWorld,
        createdAt: worlds[existingIndex].createdAt // 保留原始建立時間
      };
      console.log(`[API][Worlds] Updated existing world: ${worldName}`);
    } else {
      worlds.unshift(newWorld); // 加到最前面
      console.log(`[API][Worlds] Saved new world: ${worldName}`);
    }

    writeSavedWorlds(worlds);

    return NextResponse.json({ success: true, world: newWorld });
  } catch (error: any) {
    console.error('[API][Worlds] POST error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
