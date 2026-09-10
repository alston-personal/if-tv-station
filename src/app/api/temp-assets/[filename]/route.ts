import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  
  // Prevent directory traversal
  const safeFilename = path.basename(filename);
  
  // Check candidate locations in order
  const candidatePaths = [
    path.join('/tmp/public_assets', safeFilename),
    path.join('/tmp', safeFilename),
    path.join(process.cwd(), 'public', 'temp', safeFilename)
  ];

  let targetPath = '';
  for (const p of candidatePaths) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      targetPath = p;
      break;
    }
  }

  if (!targetPath) {
    return new NextResponse('Asset Not Found', { status: 404 });
  }

  const fileBuffer = fs.readFileSync(targetPath);
  const ext = path.extname(safeFilename).toLowerCase();
  
  let contentType = 'application/octet-stream';
  if (ext === '.mp3') contentType = 'audio/mpeg';
  if (ext === '.mp4') contentType = 'video/mp4';
  if (ext === '.wav') contentType = 'audio/wav';
  if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
  if (ext === '.png') contentType = 'image/png';

  return new NextResponse(fileBuffer, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
