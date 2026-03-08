/**
 * Pace Rise Competition OS — Database Initialization v3
 * Multi-competition support
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'competition.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

function initDatabase() {
    const exists = fs.existsSync(DB_PATH);

    const db = new Database(DB_PATH);

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Performance optimizations
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB cache
    db.pragma('temp_store = MEMORY');

    if (!exists) {
        // Fresh DB — execute full schema
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        db.exec(schema);

        // Create a sample competition
        db.prepare(`INSERT INTO competition (name, start_date, end_date, venue, status)
            VALUES ('2026 Pace Rise Invitational', '2026-02-19', '2026-02-21', 'PACE RISE 종합운동장', 'upcoming')`).run();

        // Try loading seed data - skip on error (data can be uploaded via Excel)
        const SEED_PATH = path.join(__dirname, '..', 'db', 'seed_clean.sql');
        if (fs.existsSync(SEED_PATH)) {
            try {
                const seed = fs.readFileSync(SEED_PATH, 'utf8');
                // Strip SQL comments first, then split on semicolons
                // Remove -- line comments (outside of string literals)
                let cleaned = '';
                let inStr = false, i = 0;
                while (i < seed.length) {
                    if (seed[i] === "'") {
                        // Handle SQL escaped quotes: '' means literal quote inside string
                        if (inStr && i + 1 < seed.length && seed[i + 1] === "'") {
                            cleaned += "''";
                            i += 2;
                            continue;
                        }
                        inStr = !inStr;
                    }
                    if (!inStr && seed[i] === '-' && i + 1 < seed.length && seed[i + 1] === '-') {
                        // Skip to end of line
                        while (i < seed.length && seed[i] !== '\n') i++;
                        continue;
                    }
                    cleaned += seed[i];
                    i++;
                }
                // Split on semicolons (now safe, no comments)
                const stmts = cleaned.split(';').map(s => s.trim()).filter(s => s.length > 0);
                let ok = 0, skip = 0;
                for (const s of stmts) {
                    try { db.exec(s + ';'); ok++; } catch(e) { skip++; }
                }
                console.log(`[DB] Seed data: ${ok} statements OK, ${skip} skipped`);
            } catch (e) {
                console.error('[DB] Seed data error:', e.message);
            }
        }

        console.log('[DB] Database created with schema (multi-competition v3)');
    } else {
        // Existing DB — ensure schema tables exist (IF NOT EXISTS handles this)
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        db.exec(schema);
        console.log('[DB] Database loaded (existing, multi-competition v3)');
    }

    return db;
}

module.exports = { initDatabase, DB_PATH };
