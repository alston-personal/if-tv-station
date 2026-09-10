import fs from 'fs';
import path from 'path';
import { generateVideoSegment } from './gemini';
import { chromium } from 'playwright';
import axios from 'axios';

/**
 * Generate a video using Google Flow (Veo) by loading cookies from `cookie.json`.
 */
export async function generateVideoViaBrowser(
  visualPrompt,
  style,
  character,
  outputPath,
  logCallback = () => {}
) {
  const cookiePath = path.resolve(process.cwd(), 'cookie.json');
  let cookies = [];
  if (fs.existsSync(cookiePath)) {
    try {
      const raw = fs.readFileSync(cookiePath, 'utf8');
      cookies = JSON.parse(raw);
      logCallback(`Loaded ${cookies.length} cookies from cookie.json`);
    } catch (e) {
      logCallback(`Failed to parse cookie.json: ${e.message}`);
    }
  } else {
    logCallback('cookie.json not found, falling back directly to Gemini API');
    await generateVideoSegment(visualPrompt, style, character, outputPath, logCallback);
    return;
  }

  // Build the same prompt as the official Veo call
  const fullPrompt = `${visualPrompt}. Style: ${style}. Character details: ${character}. Cinematic, high fidelity, smooth motion, professional rendering.`;

  let browser;
  try {
    logCallback('Launching Chromium for Google Flow automation...');
    browser = await chromium.launch({ 
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei'
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const pwCookies = [];
    const now = Date.now() / 1000;
    for (const c of cookies) {
      if (!c.name || !c.value || !c.domain) continue;
      if (c.expiry && c.expiry < now) continue;

      let sameSite = c.sameSite;
      if (sameSite) {
        sameSite = sameSite.charAt(0).toUpperCase() + sameSite.slice(1).toLowerCase();
        if (!['Strict', 'Lax', 'None'].includes(sameSite)) {
          sameSite = undefined;
        }
      }
      
      pwCookies.push({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? '/',
        expires: c.expiry ? Math.round(c.expiry) : -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
        sameSite: sameSite
      });
    }

    await context.addCookies(pwCookies);
    logCallback('Cookies injected successfully');

    const page = await context.newPage();
    logCallback('Navigating to Google Flow (https://labs.google/fx/tools/flow)...');
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(10000);

    // 1. Dismiss cookie consent banner if visible
    const agreeButton = page.locator('button:has-text("Agree"), button:has-text("我同意"), button:has-text("No thanks"), button:has-text("同意")').first();
    if (await agreeButton.isVisible()) {
      logCallback('Dismissing cookie consent banner...');
      await agreeButton.click();
      await page.waitForTimeout(3000);
    }

    // 2. Click "新建项目" (Create project)
    const newProjectBtn = page.locator('button:has-text("新建项目"), button:has-text("新增專案"), button:has-text("新建"), button:has-text("add_2")').first();
    if (await newProjectBtn.isVisible()) {
      logCallback('Clicking "新建项目" button to enter project workspace...');
      await newProjectBtn.click();
      await page.waitForTimeout(10000);
    } else {
      throw new Error('Project creation button not found or not visible.');
    }

    // 3. Dismiss onboarding modal if visible
    const startBtn = page.locator('button:has-text("開始使用"), button:has-text("开始使用"), button:has-text("Got it"), button:has-text("了解")').first();
    if (await startBtn.isVisible()) {
      logCallback('Dismissing "Maps Imagery Grounding" onboarding modal...');
      await startBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(5000);

    // 4. Click the "Video" tab
    const videoTab = page.locator('button:has-text("影片"), button:has-text("Video")').first();
    if (await videoTab.isVisible()) {
      logCallback('Selecting Video Mode...');
      await videoTab.click();
      await page.waitForTimeout(3000);
    }

    // 5. Find visible chat input
    const candidates = await page.locator('[contenteditable="true"]').all();
    let chatInput = null;
    for (const c of candidates) {
      if (await c.isVisible()) {
        chatInput = c;
        break;
      }
    }

    if (chatInput && await chatInput.isVisible()) {
      logCallback(`Filling visual prompt: "${fullPrompt.slice(0, 100)}..."`);
      await chatInput.focus();
      await chatInput.fill(fullPrompt);
      await page.waitForTimeout(2000);

      // 6. Submit prompt
      const submitBtn = page.locator('button:has-text("arrow_forward")').first();
      if (await submitBtn.isVisible()) {
        logCallback('Clicking submit button...');
        await submitBtn.click();
      } else {
        logCallback('Pressing Enter to submit prompt...');
        await chatInput.press('Enter');
      }
      await page.waitForTimeout(15000);

      // 7. Poll for generated video elements
      logCallback('Polling for video generation progress...');
      let videoUrl = '';
      for (let attempt = 1; attempt <= 12; attempt++) {
        await page.waitForTimeout(10000);
        const videos = await page.locator('video').all();
        logCallback(`Checking generation progress: attempt ${attempt}/12, found ${videos.length} video(s)`);
        
        for (let i = 0; i < videos.length; i++) {
          const src = await videos[i].getAttribute('src');
          if (src) {
            videoUrl = src;
            logCallback(`Found Video Source URL: ${videoUrl}`);
            break;
          }
        }
        if (videoUrl) break;
      }

      if (videoUrl) {
        logCallback('Downloading video stream...');
        if (videoUrl.startsWith('blob:')) {
          const base64 = await page.evaluate(async (url) => {
            const response = await fetch(url);
            const blob = await response.blob();
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                const res = reader.result;
                resolve(res.split(',')[1]);
              };
              reader.readAsDataURL(blob);
            });
          }, videoUrl);
          
          fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));
        } else {
          const response = await axios({
            method: 'get',
            url: videoUrl,
            responseType: 'stream'
          });
          const writer = fs.createWriteStream(outputPath);
          response.data.pipe(writer);
          await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
        }
        logCallback(`Successfully generated and saved video to: ${outputPath}`);
      } else {
        throw new Error('Video generation polling timed out.');
      }
    } else {
      throw new Error('Chat input area not found or not visible.');
    }

  } catch (err) {
    logCallback(`Google Flow automation failed: ${err.message}`);
    logCallback('Fallback to paid Gemini Veo API is disabled to avoid extra fees.');
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
