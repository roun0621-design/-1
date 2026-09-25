const puppeteer = require('/Users/morae_mac/-1/node_modules/puppeteer'); const fs = require('fs');
(async () => {
  const out = process.argv[2]; const files = JSON.parse(fs.readFileSync(__dirname + '/page.json', 'utf8'));
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage(); await p.setViewport({ width: 1080, height: 1350 });
  await p.goto('file://' + __dirname + '/page.html', { waitUntil: 'networkidle0', timeout: 60000 }); await p.evaluate(() => document.fonts.ready); await new Promise(r => setTimeout(r, 500));
  const chk = await p.evaluate(() => [...document.querySelectorAll('.card')].map(c => { const body = c.querySelector('.body'); if (!body) return 'cover'; return (body.scrollHeight > body.clientHeight + 2 ? 'OVERFLOW' : 'ok') + ' gap=' + Math.round(c.querySelector('.foot').getBoundingClientRect().top - [...body.children].reduce((m, e) => Math.max(m, e.getBoundingClientRect().bottom), 0)); }));
  console.log(chk.join(' | '));
  const els = await p.$$('.card'); for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: out + '/' + files[i] });
  await b.close(); console.log('rendered');
})().catch(e => { console.error(e.message); process.exit(1); });
