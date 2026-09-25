process.env.SQLITE_PATH = process.argv[2]; process.env.DB_BACKEND = 'sqlite'; process.env.INTL_SYNC = 'off'; process.env.NODE_ENV = 'test'; process.env.VITEST = '1';
(async () => {
  const mod = require('/Users/morae_mac/-1/server.js'); await mod.ready; const db = mod.db;
  const nr = require('./nr.json');
  for (const r of nr) { try { await db.run("INSERT OR IGNORE INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, holder_team, record_year, approved) VALUES ('national',?,?,NULL,NULL,?,?,?,?,1)", r.event_name, r.gender, r.record_value, r.holder_name || '', r.holder_team || '', r.record_year || ''); } catch (e) {} }
  const sync = require('/Users/morae_mac/-1/lib/intl/sync');
  const comp = await db.get('SELECT * FROM competition WHERE id=2');
  const t0 = Date.now();
  const st = await sync.runOnce(db, comp, { all: true });
  console.log('runOnce', Math.round((Date.now() - t0) / 1000) + 's', JSON.stringify({ results: st.results && { checked: st.results.checked, updated: st.results.updated, results: st.results.results, unknown: st.results.unknown.length } }));
  console.log('completed:', (await db.all("SELECT gender, name, round_type FROM event WHERE competition_id=2 AND round_status='completed'")).map(x => `${x.gender} ${x.name} ${x.round_type}`).join(' | '));
  console.log('NR/PB tags:', (await db.all("SELECT a.name, e.name ev, r.remark FROM result r JOIN heat h ON h.id=r.heat_id JOIN event e ON e.id=h.event_id JOIN event_entry ee ON ee.id=r.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE e.competition_id=2 AND a.team='KOR' AND r.remark<>'' AND r.attempt_number IS NULL")).map(x => `${x.name}/${x.ev}: ${x.remark}`).join(' | '));
  console.log('height_attempts:', (await db.get('SELECT COUNT(*) c FROM height_attempt')).c, 'dist attempts:', (await db.get('SELECT COUNT(*) c FROM result WHERE attempt_number IS NOT NULL')).c);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
