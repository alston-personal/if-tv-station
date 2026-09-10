import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const introsDir = path.join(process.cwd(), 'public', 'assets', 'intros');
    
    if (!fs.existsSync(introsDir)) {
      fs.mkdirSync(introsDir, { recursive: true });
    }

    const files = fs.readdirSync(introsDir);
    const intros = files
      .filter(file => file.endsWith('.mp4') || file.endsWith('.mov') || file.endsWith('.avi'))
      .map(file => {
        let name = file;
        if (file === 'default.mp4') {
          name = '✨ 系統預設片頭';
        } else if (file.startsWith('upload_')) {
          const parts = file.split('_');
          const namePart = parts.slice(2).join('_');
          name = `🎬 ${namePart.replace(/\.[^/.]+$/, '')} (已上傳)`;
        }
        
        return {
          name,
          url: `/iftv/assets/intros/${file}`,
          filename: file
        };
      });

    // Sort: Default first, then newest uploaded first
    intros.sort((a, b) => {
      if (a.filename === 'default.mp4') return -1;
      if (b.filename === 'default.mp4') return 1;
      return b.filename.localeCompare(a.filename);
    });

    return NextResponse.json({ intros });
  } catch (error: any) {
    console.error('[API][Intros] Error listing intros:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
