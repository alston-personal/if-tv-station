import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as Blob | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const filename = (formData.get('filename') as string) || (file as any).name || 'upload_file';
    const type = file.type || '';

    // Determine target directory and path
    let targetDir: string;
    let extension = '';
    const nameParts = filename.split('.');
    if (nameParts.length > 1) {
      extension = '.' + nameParts.pop();
    }

    // Clean filename to prevent traversal and remove special characters
    const baseName = nameParts.join('.').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const finalFilename = `upload_${Date.now()}_${baseName}${extension}`;

    if (type.startsWith('video/')) {
      targetDir = path.join(process.cwd(), 'public', 'assets', 'intros');
    } else if (type.startsWith('image/')) {
      targetDir = path.join(process.cwd(), 'public', 'assets', 'uploads');
    } else {
      // Fallback classification based on file extension
      const ext = extension.toLowerCase();
      if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) {
        targetDir = path.join(process.cwd(), 'public', 'assets', 'intros');
      } else if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
        targetDir = path.join(process.cwd(), 'public', 'assets', 'uploads');
      } else {
        return NextResponse.json({ error: 'Unsupported file type. Please upload a valid image or MP4 video.' }, { status: 400 });
      }
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const filePath = path.join(targetDir, finalFilename);
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    fs.writeFileSync(filePath, buffer);

    const isVideo = filePath.includes('intros');
    const relativeUrl = isVideo 
      ? `/iftv/assets/intros/${finalFilename}`
      : `/iftv/assets/uploads/${finalFilename}`;

    console.log(`[API][Upload] File uploaded successfully: ${filename} -> Saved to ${filePath}. URL: ${relativeUrl}`);

    return NextResponse.json({
      url: relativeUrl,
      path: path.relative(process.cwd(), filePath)
    });
  } catch (error: any) {
    console.error('[API][Upload] Error processing upload:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
