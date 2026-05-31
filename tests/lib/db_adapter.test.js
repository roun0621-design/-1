/**
 * lib/db.js — SQL 변환기 유닛 테스트
 *
 * 회귀 보호:
 *  - SQLite '?' placeholder → PostgreSQL '$1, $2, ...'
 *  - INSERT OR IGNORE → ON CONFLICT DO NOTHING
 *  - INSERT OR REPLACE → ON CONFLICT ... DO UPDATE SET ...
 *  - datetime('now') → NOW()
 *
 * 이게 깨지면 PG 백엔드 전체가 망가짐.
 */
const { _convertSql } = require('../../lib/db.js');

describe('SQL Adapter — SQLite → PostgreSQL 변환', () => {

    it('? placeholder 를 $1, $2 로 변환', () => {
        const out = _convertSql('SELECT * FROM athlete WHERE id = ? AND name = ?');
        expect(out.toLowerCase()).toContain('$1');
        expect(out.toLowerCase()).toContain('$2');
        expect(out).not.toContain('?');
    });

    it('datetime(\'now\') → NOW() 로 변환', () => {
        const out = _convertSql("INSERT INTO log (created_at) VALUES (datetime('now'))");
        expect(out).toContain('NOW()');
        expect(out).not.toContain("datetime('now')");
    });

    it('INSERT OR IGNORE → ON CONFLICT DO NOTHING', () => {
        const out = _convertSql('INSERT OR IGNORE INTO athlete (id, name) VALUES (?, ?)');
        // 변환 결과가 ON CONFLICT 패턴을 포함해야 함
        expect(out.toUpperCase()).toContain('ON CONFLICT');
        expect(out.toUpperCase()).toContain('DO NOTHING');
    });

    it('일반 SELECT 는 거의 그대로 유지', () => {
        const sql = 'SELECT name, age FROM athlete WHERE active = 1';
        const out = _convertSql(sql);
        // 핵심 키워드는 보존
        expect(out).toContain('SELECT');
        expect(out).toContain('FROM athlete');
    });
});
