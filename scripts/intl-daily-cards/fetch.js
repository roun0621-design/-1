// 운영 서버(또는 BASE) 에서 roster.json · events.json 을 받아 DATA 폴더에 둔다
const fs = require('fs'), path = require('path');
const base = process.env.BASE || 'https://pace-rise-node.com', COMP = process.env.COMP || '63';
const S = process.env.DATA || path.join(__dirname, 'work');
(async () => {
  fs.mkdirSync(S, { recursive: true });
  for (const [name, url] of [['roster.json', `/api/competitions/${COMP}/roster`], ['events.json', `/api/events?competition_id=${COMP}`]]) {
    const r = await fetch(base + url); if (!r.ok) throw new Error(url + ' ' + r.status);
    fs.writeFileSync(path.join(S, name), await r.text()); console.log('saved', name);
  }
})();
