/**
 * Recover corrupted SQLite DB - matches actual source schema
 */
const Database = require('better-sqlite3');
const fs = require('fs');

const SOURCE = process.argv[2] || 'db_import/ktfl_source.db';
const TARGET = process.argv[3] || 'db/competition.db';

if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET);

const src = new Database(SOURCE, { fileMustExist: true });
const tgt = new Database(TARGET);
tgt.pragma('journal_mode = WAL');
tgt.pragma('foreign_keys = OFF');

// Get all table names and their columns from source
const tableNames = [];
try {
    // We know the table names from our earlier scan
    const known = [
        'competition','athlete','event','event_entry','heat','heat_entry',
        'result','height_attempt','combined_score','relay_member',
        'qualification_selection','operation_key','operation_log','audit_log',
        'system_config','event_link','pacing_config','pacing_color',
        'pacing_segment','home_popup','home_popup_section','federation_list',
        'timetable','doc_template','event_records'
    ];
    
    for (const name of known) {
        try {
            const cols = src.prepare(`PRAGMA table_info("${name}")`).all();
            if (cols.length > 0) {
                tableNames.push({ name, cols });
            }
        } catch(e) {
            console.log(`  Skipping ${name}: ${e.message.substring(0,80)}`);
        }
    }
} catch(e) {
    console.log('Error getting tables:', e.message);
}

console.log(`Found ${tableNames.length} tables to recover`);

// For each table, create it in target and copy data
for (const { name, cols } of tableNames) {
    // Build CREATE TABLE from column info
    const colDefs = cols.map(c => {
        let def = `"${c.name}" ${c.type || 'TEXT'}`;
        if (c.pk) def += ' PRIMARY KEY';
        if (c.notnull && !c.pk) def += ' NOT NULL';
        if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
        return def;
    }).join(',\n    ');
    
    const createSQL = `CREATE TABLE IF NOT EXISTS "${name}" (\n    ${colDefs}\n)`;
    
    try {
        tgt.exec(createSQL);
    } catch(e) {
        console.log(`  CREATE ${name} failed: ${e.message.substring(0,100)}`);
        continue;
    }
    
    // Copy data
    try {
        const rows = src.prepare(`SELECT * FROM "${name}"`).all();
        if (rows.length === 0) {
            console.log(`  ${name}: 0 rows`);
            continue;
        }
        
        const colNames = cols.map(c => c.name);
        const placeholders = colNames.map(() => '?').join(',');
        const colStr = colNames.map(c => `"${c}"`).join(',');
        
        const insert = tgt.prepare(`INSERT OR IGNORE INTO "${name}" (${colStr}) VALUES (${placeholders})`);
        const insertMany = tgt.transaction((data) => {
            for (const row of data) {
                insert.run(...colNames.map(c => row[c] !== undefined ? row[c] : null));
            }
        });
        
        insertMany(rows);
        console.log(`  ${name}: ${rows.length} rows`);
    } catch(e) {
        console.log(`  ${name} data: ERROR - ${e.message.substring(0,100)}`);
    }
}

// Add AUTOINCREMENT sequences
try {
    const seqs = src.prepare('SELECT * FROM sqlite_sequence').all();
    for (const s of seqs) {
        try {
            tgt.prepare('INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES (?, ?)').run(s.name, s.seq);
        } catch(e) {}
    }
    console.log(`  sqlite_sequence: ${seqs.length} entries`);
} catch(e) {}

// Create indexes
const INDEXES = [
    'CREATE INDEX IF NOT EXISTS idx_event_competition ON event(competition_id)',
    'CREATE INDEX IF NOT EXISTS idx_event_parent ON event(parent_event_id)',
    'CREATE INDEX IF NOT EXISTS idx_event_comp_gender ON event(competition_id, gender)',
    'CREATE INDEX IF NOT EXISTS idx_athlete_competition ON athlete(competition_id)',
    'CREATE INDEX IF NOT EXISTS idx_event_entry_event ON event_entry(event_id)',
    'CREATE INDEX IF NOT EXISTS idx_event_entry_athlete ON event_entry(athlete_id)',
    'CREATE INDEX IF NOT EXISTS idx_heat_event ON heat(event_id)',
    'CREATE INDEX IF NOT EXISTS idx_heat_entry_heat ON heat_entry(heat_id)',
    'CREATE INDEX IF NOT EXISTS idx_heat_entry_event_entry ON heat_entry(event_entry_id)',
    'CREATE INDEX IF NOT EXISTS idx_result_heat ON result(heat_id)',
    'CREATE INDEX IF NOT EXISTS idx_result_event_entry ON result(event_entry_id)',
    'CREATE INDEX IF NOT EXISTS idx_height_attempt_heat ON height_attempt(heat_id)',
    'CREATE INDEX IF NOT EXISTS idx_relay_member_entry ON relay_member(event_entry_id)',
    'CREATE INDEX IF NOT EXISTS idx_operation_log_comp ON operation_log(competition_id)',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_comp ON audit_log(competition_id)',
];

for (const idx of INDEXES) {
    try { tgt.exec(idx); } catch(e) {}
}

src.close();
tgt.close();

console.log(`\nDone! Clean DB at ${TARGET}`);
console.log(`Size: ${(fs.statSync(TARGET).size / 1024 / 1024).toFixed(2)} MB`);
