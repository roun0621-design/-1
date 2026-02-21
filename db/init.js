/**
 * Pace Rise Competition Operation OS — Database Initialization
 * SQLite (demo) with PostgreSQL-compatible structure
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'competition.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');
const SEED_PATH = path.join(__dirname, '..', 'db', 'seed_clean.sql');

function initDatabase() {
    // Remove existing DB for clean demo start
    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
    }

    const db = new Database(DB_PATH);

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Execute schema
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);

    // Execute seed
    const seed = fs.readFileSync(SEED_PATH, 'utf8');
    db.exec(seed);

    console.log('[DB] Database initialized with schema and seed data');

    return db;
}

module.exports = { initDatabase, DB_PATH };
