/**
 * Create joint groups linking KTFL and KUAF events
 * Matches events by name + gender + round_type
 */
const Database = require('better-sqlite3');

const db = new Database('db/competition.db');
db.pragma('foreign_keys = OFF');

const KTFL_ID = 9;
const KUAF_ID = 10;

// Get all parent events from both competitions
const ktflEvents = db.prepare(`
    SELECT id, name, category, gender, round_type 
    FROM event WHERE competition_id = ? AND parent_event_id IS NULL
    ORDER BY sort_order, id
`).all(KTFL_ID);

const kuafEvents = db.prepare(`
    SELECT id, name, category, gender, round_type 
    FROM event WHERE competition_id = ? AND parent_event_id IS NULL
    ORDER BY sort_order, id
`).all(KUAF_ID);

console.log(`KTFL events: ${ktflEvents.length}`);
console.log(`KUAF events: ${kuafEvents.length}`);

let matched = 0;
let created = 0;

const insertGroup = db.prepare(`
    INSERT INTO joint_group (name, joint_scoreboard_key) VALUES (?, ?)
`);

const insertMember = db.prepare(`
    INSERT INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?, ?, ?, ?)
`);

// Also update heat scoreboard keys for joint events
const updateHeatJointKey = db.prepare(`
    UPDATE heat SET joint_scoreboard_key = ? WHERE event_id = ?
`);

const transaction = db.transaction(() => {
    for (const ktfl of ktflEvents) {
        // Find matching KUAF event
        const kuaf = kuafEvents.find(e => 
            e.name === ktfl.name && e.gender === ktfl.gender && e.round_type === ktfl.round_type
        );
        
        if (!kuaf) continue;
        matched++;
        
        // Create joint scoreboard key
        const gLabel = ktfl.gender === 'M' ? '남자' : ktfl.gender === 'F' ? '여자' : '혼성';
        const rLabel = ktfl.round_type === 'preliminary' ? '예선' : ktfl.round_type === 'semifinal' ? '준결승' : '결승';
        const jointKey = `합동 ${gLabel} ${ktfl.name} ${rLabel}`;
        
        // Create group
        const groupResult = insertGroup.run(ktfl.name, jointKey);
        const groupId = groupResult.lastInsertRowid;
        
        // Add members
        insertMember.run(groupId, ktfl.id, KTFL_ID, 0);
        insertMember.run(groupId, kuaf.id, KUAF_ID, 1);
        
        // Update heat joint_scoreboard_key
        updateHeatJointKey.run(jointKey, ktfl.id);
        updateHeatJointKey.run(jointKey, kuaf.id);
        
        created++;
        console.log(`  ✅ ${ktfl.name} (${gLabel} ${rLabel}) → group ${groupId}`);
    }
});

transaction();

console.log(`\n=== Joint Groups Created ===`);
console.log(`Matched: ${matched}`);
console.log(`Groups created: ${created}`);

// Verify
const groups = db.prepare('SELECT COUNT(*) as c FROM joint_group').get();
const members = db.prepare('SELECT COUNT(*) as c FROM joint_group_member').get();
console.log(`Total groups in DB: ${groups.c}`);
console.log(`Total members in DB: ${members.c}`);

db.close();
console.log('Done!');
