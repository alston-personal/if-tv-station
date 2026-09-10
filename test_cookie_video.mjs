import { generateVideoViaBrowser } from './src/lib/gemini_browser.js';
import path from 'path';

(async () => {
  const output = path.join(process.cwd(), 'public', 'renders', 'test_cookie.mp4');
  try {
    await generateVideoViaBrowser(
      'A cute Formosan leopard cat playing in a garden',
      'cinematic',
      'leopard cat',
      output,
      (msg) => console.log('[TestCookie]', msg)
    );
    console.log('✅ Finished, video at', output);
  } catch (e) {
    console.error('❌ Error:', e);
  }
})();
