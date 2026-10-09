// 临时脚本：抓取小黑盒文章正文（用 puppeteer 渲染 SPA）
import puppeteer from 'puppeteer';

const url = process.argv[2] ?? 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_session_id=fErU0j2Pwl6EeczE&h_src=YXBwX3NoYXJl&link_id=8e7f729adcb3&new_post_share_style_v2=1';

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  const title = await page.title();
  const text = await page.evaluate(() => document.body.innerText);
  console.log('TITLE:', title);
  console.log('---BODY---');
  console.log(text.slice(0, 5000));
} finally {
  await browser.close();
}
