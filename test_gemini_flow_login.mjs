import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

(async () => {
  console.log('🚀 Starting Antidetect Gemini login test with delay...');
  
  const cookiePath = path.resolve(process.cwd(), 'cookie.json');
  if (!fs.existsSync(cookiePath)) {
    console.error('❌ cookie.json not found!');
    return;
  }
  
  const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  console.log(`🔑 Loaded ${cookies.length} cookies`);

  const browser = await chromium.launch({ 
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

  try {
    await context.addCookies(pwCookies);
    console.log('✅ Cookies added successfully');
  } catch (err) {
    console.warn('⚠️ Cookie adding failed', err.message);
  }

  const page = await context.newPage();
  
  try {
    console.log('🌐 Navigating to https://labs.google/fx/tools/flow...');
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'load', timeout: 35000 });
    
    console.log('⏳ Waiting 12 seconds for React interface hydration...');
    await page.waitForTimeout(12000);
    
    console.log('📥 Navigated! Title:', await page.title());
    console.log('🌐 Current URL:', page.url());

    // 截圖確認是否已登入
    const screenshotPath = path.join(process.cwd(), 'public', 'renders', 'gemini_app_login_check.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`📸 Screenshot saved to ${screenshotPath}`);

    // 檢查是否有對話輸入框
    const chatInput = await page.locator('textarea, [contenteditable="true"], input[type="text"]').first();
    const count = await chatInput.count();
    console.log(`🔍 Found ${count} chat input area(s)`);

  } catch (e) {
    console.error('❌ Testing failed:', e);
  } finally {
    await browser.close();
    console.log('🏁 Browser closed');
  }
})();
