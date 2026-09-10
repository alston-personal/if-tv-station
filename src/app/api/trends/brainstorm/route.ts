import { NextResponse } from 'next/server';
import { brainstormTrendPrompt } from '../../../../lib/gemini';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const topic = searchParams.get('topic');
    const news = searchParams.get('news') || undefined;

    if (!topic || typeof topic !== 'string') {
      return NextResponse.json({ error: 'Topic query parameter is required' }, { status: 400 });
    }

    console.log(`[API][Trends][Brainstorm] Brainstorming prompt for topic: "${topic}" (News: ${news || 'none'})`);
    const prompt = await brainstormTrendPrompt(topic, news);

    return NextResponse.json({ prompt });
  } catch (error: any) {
    console.error('[API][Trends][Brainstorm] Failed to brainstorm prompt:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
