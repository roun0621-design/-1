/**
 * Generate KUAF university competition mirroring KTFL events
 * Creates ~200 athletes, same event structure, with results (completed state)
 */
const Database = require('better-sqlite3');

const db = new Database('db/competition.db');
db.pragma('foreign_keys = OFF');

const KTFL_COMP_ID = 9;

// ============================================================
// 1. Create KUAF competition
// ============================================================
const compResult = db.prepare(`
    INSERT INTO competition (name, start_date, end_date, venue, status, federation)
    VALUES (?, ?, ?, ?, ?, ?)
`).run('2026 김해 KUAF 전국대학육상경기대회', '2026-03-25', '2026-03-27', '김해시', 'active', 'KUAF');

const KUAF_COMP_ID = compResult.lastInsertRowid;
console.log(`Created KUAF competition: id=${KUAF_COMP_ID}`);

// Add KUAF federation if not exists
try {
    db.prepare(`INSERT OR IGNORE INTO federation_list (code, name, badge_bg, badge_color, sort_order, gender_label_m, gender_label_f, gender_label_x)
        VALUES ('KUAF', '전국대학육상경기연맹', '#fff3e0', '#e65100', 1, '남자', '여자', '혼성')`).run();
} catch(e) {}

// ============================================================
// 2. Korean name generator for university athletes
// ============================================================
const lastNames = ['김','이','박','최','정','강','조','윤','장','임','한','오','서','신','권','황','안','송','류','전','홍','고','문','양','손','배','조','백','허','유','남','심','노','하','곽','성','차','주','우','구','민','진','나','엄','도','채','원','천','방','공','현','변','염','추','탁'];
const firstChars1 = ['민','서','지','도','현','성','우','예','수','승','재','영','하','진','준','유','태','은','건','찬','경','상','인','선','동','세','광','혁','정','호'];
const firstChars2 = ['준','호','아','우','은','서','영','진','수','현','석','미','지','연','원','경','빈','희','환','주','혁','용','나','율','하','민','걸','솔','윤','재'];

function randomName() {
    const last = lastNames[Math.floor(Math.random() * lastNames.length)];
    const f1 = firstChars1[Math.floor(Math.random() * firstChars1.length)];
    const f2 = firstChars2[Math.floor(Math.random() * firstChars2.length)];
    return last + f1 + f2;
}

// University teams
const uniTeams = [
    '고려대학교','연세대학교','서울대학교','한양대학교','성균관대학교',
    '경희대학교','중앙대학교','동국대학교','건국대학교','인하대학교',
    '국민대학교','단국대학교','부산대학교','전남대학교','충남대학교',
    '영남대학교','경북대학교','조선대학교','원광대학교','한국체육대학교',
    '용인대학교','동아대학교','계명대학교','대구대학교','우석대학교'
];

// ============================================================
// 3. Create athletes (~200)
// ============================================================
const athletes = [];
let bibNum = 1001;

const MALE_COUNT = 120;
const FEMALE_COUNT = 80;

console.log(`Creating ${MALE_COUNT + FEMALE_COUNT} athletes...`);

for (let i = 0; i < MALE_COUNT; i++) {
    const name = randomName();
    const team = uniTeams[Math.floor(Math.random() * uniTeams.length)];
    const bib = String(bibNum++);
    const barcode = `PR-${bib}`;
    
    const r = db.prepare(`INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation)
        VALUES (?, ?, ?, ?, ?, 'M', 'KUAF')`).run(KUAF_COMP_ID, name, bib, team, barcode);
    athletes.push({ id: r.lastInsertRowid, name, bib, team, gender: 'M' });
}

for (let i = 0; i < FEMALE_COUNT; i++) {
    const name = randomName();
    const team = uniTeams[Math.floor(Math.random() * uniTeams.length)];
    const bib = String(bibNum++);
    const barcode = `PR-${bib}`;
    
    const r = db.prepare(`INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation)
        VALUES (?, ?, ?, ?, ?, 'F', 'KUAF')`).run(KUAF_COMP_ID, name, bib, team, barcode);
    athletes.push({ id: r.lastInsertRowid, name, bib, team, gender: 'F' });
}

const maleAthletes = athletes.filter(a => a.gender === 'M');
const femaleAthletes = athletes.filter(a => a.gender === 'F');

console.log(`  Male: ${maleAthletes.length}, Female: ${femaleAthletes.length}`);

// ============================================================
// 4. Helper functions
// ============================================================
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function pickRandom(arr, n) {
    return shuffle(arr).slice(0, Math.min(n, arr.length));
}

function randomTime(baseSeconds, variance) {
    return +(baseSeconds + (Math.random() - 0.3) * variance).toFixed(2);
}

function randomDistance(baseMeter, variance) {
    return +(baseMeter + (Math.random() - 0.3) * variance).toFixed(2);
}

function createEvent(name, category, gender, roundType, sortOrder, parentId = null) {
    const r = db.prepare(`INSERT INTO event (competition_id, name, category, gender, round_type, round_status, sort_order, parent_event_id)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`).run(KUAF_COMP_ID, name, category, gender, roundType, sortOrder, parentId);
    return r.lastInsertRowid;
}

function createEventEntry(eventId, athleteId) {
    const r = db.prepare(`INSERT OR IGNORE INTO event_entry (event_id, athlete_id, status) VALUES (?, ?, 'checked_in')`).run(eventId, athleteId);
    return r.lastInsertRowid;
}

function createHeat(eventId, heatNumber, scoreboardKey = null) {
    const r = db.prepare(`INSERT INTO heat (event_id, heat_number, scoreboard_key) VALUES (?, ?, ?)`).run(eventId, heatNumber, scoreboardKey);
    return r.lastInsertRowid;
}

function createHeatEntry(heatId, eventEntryId, lane) {
    db.prepare(`INSERT OR IGNORE INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)`).run(heatId, eventEntryId, lane);
}

function createResult(heatId, eventEntryId, timeSeconds, statusCode = '', attemptNum = null, distance = null) {
    db.prepare(`INSERT OR IGNORE INTO result (heat_id, event_entry_id, attempt_number, distance_meters, time_seconds, status_code)
        VALUES (?, ?, ?, ?, ?, ?)`).run(heatId, eventEntryId, attemptNum, distance, timeSeconds, statusCode);
}

// Base times for track events (seconds)
const trackBaseTimes = {
    '100m': { M: 10.5, F: 12.0, v: 0.8 },
    '200m': { M: 21.5, F: 24.5, v: 1.5 },
    '400m': { M: 48.0, F: 55.0, v: 3.0 },
    '800m': { M: 115.0, F: 130.0, v: 8.0 },
    '1500m': { M: 235.0, F: 270.0, v: 15.0 },
    '5000m': { M: 870.0, F: 1020.0, v: 60.0 },
    '10,000m': { M: 1850.0, F: 2100.0, v: 120.0 },
    '10,000mW': { M: 2700.0, F: 3100.0, v: 200.0 },
    '100mH': { F: 14.0, v: 1.2 },
    '110mH': { M: 14.5, v: 1.0 },
    '400mH': { M: 52.0, F: 60.0, v: 3.0 },
    '3000mSC': { M: 540.0, F: 620.0, v: 30.0 },
};

// Base distances for field events (meters)
const fieldBaseDistances = {
    '멀리뛰기': { M: 7.2, F: 5.8, v: 1.0 },
    '세단뛰기': { M: 15.0, F: 12.5, v: 1.5 },
    '포환던지기': { M: 16.0, F: 14.0, v: 3.0 },
    '원반던지기': { M: 48.0, F: 45.0, v: 8.0 },
    '해머던지기': { M: 60.0, F: 55.0, v: 10.0 },
    '창던지기': { M: 70.0, F: 50.0, v: 10.0 },
};

const fieldHeightBases = {
    '높이뛰기': { M: 200, F: 170, v: 20 },
    '장대높이뛰기': { M: 480, F: 380, v: 40 },
};

// ============================================================
// 5. Create events mirroring KTFL structure
// ============================================================

// Get all KTFL parent events
const ktflParents = db.prepare(`
    SELECT * FROM event WHERE competition_id = ? AND parent_event_id IS NULL ORDER BY sort_order, id
`).all(KTFL_COMP_ID);

let totalEvents = 0;
let totalEntries = 0;
let totalResults = 0;

const transaction = db.transaction(() => {

for (const ktflEvt of ktflParents) {
    const { name, category, gender, round_type, sort_order } = ktflEvt;
    
    // Skip relay and combined for now (handled separately)
    if (category === 'relay' || category === 'combined') continue;
    
    // Determine athlete pool
    const pool = gender === 'M' ? maleAthletes : femaleAthletes;
    
    // Determine number of athletes based on KTFL event
    const ktflEntryCount = db.prepare('SELECT COUNT(*) as cnt FROM event_entry WHERE event_id=?').get(ktflEvt.id).cnt;
    const numAthletes = Math.min(Math.max(Math.round(ktflEntryCount * 0.6), 4), pool.length);
    const selectedAthletes = pickRandom(pool, numAthletes);
    
    // Create event
    const eventId = createEvent(name, category, gender, round_type, sort_order);
    totalEvents++;
    
    // Create entries
    const entryIds = [];
    for (const ath of selectedAthletes) {
        const eeId = createEventEntry(eventId, ath.id);
        if (eeId) entryIds.push({ eeId, ath });
        totalEntries++;
    }
    
    // Create scoreboard key
    const gLabel = gender === 'M' ? '남자' : gender === 'F' ? '여자' : '혼성';
    const rLabel = round_type === 'preliminary' ? '예선' : round_type === 'semifinal' ? '준결승' : '결승';
    const sbKey = `${gLabel} ${name} ${rLabel}`;
    
    if (category === 'track' || category === 'road') {
        // Track event: distribute into heats
        const athletesPerHeat = round_type === 'final' ? 8 : 8;
        const numHeats = Math.ceil(entryIds.length / athletesPerHeat);
        
        for (let h = 0; h < numHeats; h++) {
            const heatAthletes = entryIds.slice(h * athletesPerHeat, (h + 1) * athletesPerHeat);
            const heatSbKey = numHeats > 1 ? `${sbKey} ${h + 1}조` : sbKey;
            const heatId = createHeat(eventId, h + 1, heatSbKey);
            
            for (let lane = 0; lane < heatAthletes.length; lane++) {
                const { eeId, ath } = heatAthletes[lane];
                createHeatEntry(heatId, eeId, lane + 1);
                
                // Generate result
                const base = trackBaseTimes[name];
                if (base) {
                    const baseTime = base[gender] || base.M || 30;
                    const time = randomTime(baseTime, base.v);
                    createResult(heatId, eeId, time);
                    totalResults++;
                }
            }
        }
    } else if (category === 'field_distance') {
        // Field distance: 1 heat, multiple attempts
        const heatId = createHeat(eventId, 1, sbKey);
        
        for (let lane = 0; lane < entryIds.length; lane++) {
            const { eeId, ath } = entryIds[lane];
            createHeatEntry(heatId, eeId, lane + 1);
            
            const base = fieldBaseDistances[name];
            if (base) {
                const baseDist = base[gender] || base.M || 10;
                // 6 attempts
                for (let att = 1; att <= 6; att++) {
                    const dist = randomDistance(baseDist, base.v);
                    const isFoul = Math.random() < 0.15;
                    createResult(heatId, eeId, null, isFoul ? 'X' : '', att, isFoul ? null : dist);
                    totalResults++;
                }
            }
        }
    } else if (category === 'field_height') {
        // Field height: 1 heat, height attempts
        const heatId = createHeat(eventId, 1, sbKey);
        
        for (let lane = 0; lane < entryIds.length; lane++) {
            const { eeId, ath } = entryIds[lane];
            createHeatEntry(heatId, eeId, lane + 1);
            
            const base = fieldHeightBases[name];
            if (base) {
                const startHeight = base[gender] - 20;
                const maxHeight = base[gender] + Math.floor(Math.random() * base.v);
                
                // Generate height attempts
                for (let h = startHeight; h <= maxHeight; h += 5) {
                    const attempts = [];
                    const cleared = h <= (base[gender] + Math.floor(Math.random() * (base.v / 2)));
                    
                    if (cleared) {
                        const numFails = Math.floor(Math.random() * 2);
                        for (let f = 0; f < numFails; f++) attempts.push('X');
                        attempts.push('O');
                    } else {
                        attempts.push('X', 'X', 'X');
                    }
                    
                    for (let a = 0; a < attempts.length; a++) {
                        db.prepare(`INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark)
                            VALUES (?, ?, ?, ?, ?)`).run(heatId, eeId, h, a + 1, attempts[a]);
                    }
                    
                    if (!cleared) break;
                }
            }
        }
    }
}

// ============================================================
// 6. Create relay events
// ============================================================
const relayEvents = ktflParents.filter(e => e.category === 'relay');
for (const re of relayEvents) {
    const { name, gender, round_type, sort_order } = re;
    const pool = gender === 'M' ? maleAthletes : gender === 'F' ? femaleAthletes : [...maleAthletes, ...femaleAthletes];
    
    // Determine relay type
    const isShort = name.includes('100');
    const legsMatch = name.match(/4[X×x]/);
    const numLegs = legsMatch ? 4 : 4;
    
    // Create teams from universities
    const teamCounts = {};
    pool.forEach(a => { teamCounts[a.team] = (teamCounts[a.team] || 0) + 1; });
    const eligibleTeams = Object.entries(teamCounts).filter(([t, c]) => c >= numLegs).map(([t]) => t);
    const numTeams = Math.min(eligibleTeams.length, Math.max(4, Math.round(
        db.prepare('SELECT COUNT(*) as cnt FROM event_entry WHERE event_id=?').get(re.id).cnt * 0.7
    )));
    
    const selectedTeams = pickRandom(eligibleTeams, numTeams);
    
    const eventId = createEvent(name, 'relay', gender, round_type, sort_order);
    totalEvents++;
    
    const gLabel = gender === 'M' ? '남자' : gender === 'F' ? '여자' : '혼성';
    const sbKey = `${gLabel} ${name} 결승`;
    const heatId = createHeat(eventId, 1, sbKey);
    
    for (let t = 0; t < selectedTeams.length; t++) {
        const teamName = selectedTeams[t];
        const teamAthletes = pool.filter(a => a.team === teamName);
        
        // Create a pseudo-athlete for the team entry
        const firstAth = teamAthletes[0];
        const eeId = createEventEntry(eventId, firstAth.id);
        if (!eeId) continue;
        totalEntries++;
        
        createHeatEntry(heatId, eeId, t + 1);
        
        // Add relay members
        const members = pickRandom(teamAthletes, numLegs);
        for (let leg = 0; leg < members.length; leg++) {
            db.prepare(`INSERT INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?, ?, ?)`)
                .run(eeId, members[leg].id, leg + 1);
        }
        
        // Relay time
        const baseTimes = {
            '4X100mR': { M: 40.0, F: 46.0, X: 43.0 },
            '4X400mR': { M: 195.0, F: 225.0, X: 210.0 },
            '4X400mR(Mixed)': { X: 210.0, M: 195.0, F: 225.0 },
            '4×800mR': { F: 520.0, M: 480.0 },
            '4×1500mR': { M: 960.0, F: 1080.0 },
        };
        const bt = baseTimes[name];
        if (bt) {
            const time = randomTime(bt[gender] || bt.M || 200, 5.0);
            createResult(heatId, eeId, time);
            totalResults++;
        }
    }
}

// ============================================================
// 7. Create combined events (10종/7종)
// ============================================================
const combinedEvents = ktflParents.filter(e => e.category === 'combined');
for (const ce of combinedEvents) {
    const { name, gender, sort_order } = ce;
    const pool = gender === 'M' ? maleAthletes : femaleAthletes;
    
    const ktflEntryCount = db.prepare('SELECT COUNT(*) as cnt FROM event_entry WHERE event_id=?').get(ce.id).cnt;
    const numAthletes = Math.min(Math.max(Math.round(ktflEntryCount * 0.7), 4), 12);
    const selectedAthletes = pickRandom(pool, numAthletes);
    
    const parentId = createEvent(name, 'combined', gender, 'final', sort_order);
    totalEvents++;
    
    const entryIds = [];
    for (const ath of selectedAthletes) {
        const eeId = createEventEntry(parentId, ath.id);
        if (eeId) entryIds.push({ eeId, ath });
        totalEntries++;
    }
    
    const heatId = createHeat(parentId, 1, `${gender === 'M' ? '남자' : '여자'} ${name} 결승`);
    for (let i = 0; i < entryIds.length; i++) {
        createHeatEntry(heatId, entryIds[i].eeId, i + 1);
    }
    
    // Create sub-events from KTFL
    const ktflSubs = db.prepare('SELECT * FROM event WHERE parent_event_id = ? ORDER BY sort_order, id').all(ce.id);
    
    for (const sub of ktflSubs) {
        const subId = createEvent(sub.name, sub.category, gender, 'final', sort_order, parentId);
        totalEvents++;
        
        const subHeatId = createHeat(subId, 1);
        
        for (let i = 0; i < entryIds.length; i++) {
            const subEeId = createEventEntry(subId, entryIds[i].ath.id);
            if (subEeId) {
                createHeatEntry(subHeatId, subEeId, i + 1);
                
                // Generate combined score
                const points = Math.floor(500 + Math.random() * 500);
                db.prepare(`INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points)
                    VALUES (?, ?, ?, ?, ?)`).run(entryIds[i].eeId, sub.name, sub.sort_order, Math.random() * 10, points);
            }
        }
    }
}

}); // end transaction

transaction();

// Summary
const totalAth = db.prepare('SELECT COUNT(*) as c FROM athlete WHERE competition_id=?').get(KUAF_COMP_ID).c;
const totalEvt = db.prepare('SELECT COUNT(*) as c FROM event WHERE competition_id=?').get(KUAF_COMP_ID).c;

console.log(`\n=== KUAF Competition Created ===`);
console.log(`Competition ID: ${KUAF_COMP_ID}`);
console.log(`Athletes: ${totalAth}`);
console.log(`Events: ${totalEvt} (${totalEvents} created)`);
console.log(`Entries: ${totalEntries}`);
console.log(`Results: ${totalResults}`);

db.close();
console.log('Done!');
