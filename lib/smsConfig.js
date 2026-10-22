'use strict';
/**
 * 문자(SMS) 설정 — 조직별 한 행 (멀티테넌시 2단계, 2026-10-02)
 *   예전엔 sms_config 가 id=1 한 행뿐이었다(CHECK(id=1)). 이제 organization_id 로 조직마다 한 행을 두고,
 *   없으면 기본값 행을 만들어 돌려준다. 기본 조직(1)은 예전 id=1 행을 그대로 쓴다.
 */
async function getSmsConfig(db, orgId) {
    const o = Number(orgId || 1);
    let row = await db.get('SELECT * FROM sms_config WHERE organization_id=?', o);
    if (row) return row;
    try { await db.run('INSERT INTO sms_config (organization_id) VALUES (?)', o); } catch (e) { /* 동시 생성 — 아래에서 다시 읽는다 */ }
    row = await db.get('SELECT * FROM sms_config WHERE organization_id=?', o);
    return row || null;
}
module.exports = { getSmsConfig };
