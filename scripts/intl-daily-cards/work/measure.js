const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] }); const p = await b.newPage(); await p.setViewport({ width: 1080, height: 1350 });
  await p.goto('file://' + process.cwd() + '/work/page.html', { waitUntil: 'networkidle0' });
  const r = await p.evaluate(() => { const c = document.querySelectorAll('.card')[1]; return { fs: getComputedStyle(c.querySelector('.srow')).fontSize, rows: [...c.querySelectorAll('.srow')].map(r => Math.round(r.getBoundingClientRect().height)), pbsb: [...c.querySelectorAll('.pbsb')].map(e => Math.round(e.getBoundingClientRect().height)), bodyTop: Math.round(c.querySelector('.body').getBoundingClientRect().top), footTop: Math.round(c.querySelector('.foot').getBoundingClientRect().top) }; });
  console.log(JSON.stringify(r)); await b.close();
})();
