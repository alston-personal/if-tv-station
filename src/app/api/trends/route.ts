import { NextResponse } from 'next/server';

interface TrendItem {
  title: string;
  traffic: string;
  newsTitle: string;
  newsUrl: string;
}

export async function GET() {
  try {
    const response = await fetch('https://trends.google.com/trending/rss?geo=TW', {
      next: { revalidate: 3600 } // cache for 1 hour
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch Trends RSS: ${response.statusText}`);
    }
    const xml = await response.text();

    const items: TrendItem[] = [];
    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g);
    
    if (itemMatches) {
      for (const item of itemMatches) {
        const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
        const trafficMatch = item.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/);
        const newsTitleMatch = item.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/);
        const newsUrlMatch = item.match(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/);

        if (titleMatch) {
          const cleanText = (str: string) => str.trim().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
          items.push({
            title: cleanText(titleMatch[1]),
            traffic: trafficMatch ? cleanText(trafficMatch[1]) : 'Unknown',
            newsTitle: newsTitleMatch ? cleanText(newsTitleMatch[1]) : '',
            newsUrl: newsUrlMatch ? cleanText(newsUrlMatch[1]) : ''
          });
        }
      }
    }

    return NextResponse.json({ trends: items });
  } catch (error: any) {
    console.error('[API][Trends] Failed to fetch trends:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
