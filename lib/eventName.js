'use strict';
/**
 * 종목명 표기 — 시스템 전체가 쓰는 단 하나의 정의 (2026-09 Phase 4)
 *   같은 계산이 recordCompare.js(기록 대조), server.js(엑셀 가져오기 저장명), fullRecordExcel.js, fieldCardImport.js 에
 *   따로 있었고 서로 조금씩 달랐다(계주 X/×, 콤마, 한글 단위). 비교·저장에 쓰는 두 함수를 여기로 모은다.
 *
 *   storedName(raw)  — 엑셀·연맹 파일에서 들어온 이름을 DB 에 저장하는 표기로 (예: '4x100mR' → '4X100mR', '10000m' → '10,000m')
 *   recordKey(name)  — 기록표(event_record.event_name)와 대조하는 비교 키. ※ 저장된 기록표가 이 함수의 결과로 정규화돼 있으므로
 *                      출력을 바꾸면 안 된다. 바꿔야 하면 server.js 의 기록표 재정규화(/api/event-records/renormalize)와 함께.
 *   sameEvent(a, b)  — 표기가 달라도 같은 종목인가 (recordKey 가 같은가)
 *
 *   문서 생성기(fullRecordExcel)는 양식 셀 이름('4x100mR', 'MIXED 4x400mR')이 따로 있어 자기 표를 유지하되, 판정은 sameEvent 로 한다.
 */

// ── 저장 표기 (server.js 에서 이동) ──────────────────────────────
function storedName(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    // Map common variations
    const map = {
        '10000m': '10,000m', '10000mW': '10,000mW',
        '4x100mR': '4X100mR', '4X100mR': '4X100mR', '4 x 100mR': '4X100mR',
        '4x400mR': '4X400mR', '4X400mR': '4X400mR', '4 x 400mR': '4X400mR',
        '4x400mR(Mixed)': '4X400mR(Mixed)', 'Mixed 4x400mR': '4X400mR(Mixed)', 'Mixed4x400mR': '4X400mR(Mixed)',
        '4x400mR Mixed': '4X400mR(Mixed)', '4X400mR Mixed': '4X400mR(Mixed)', '4 x 400mR Mixed': '4X400mR(Mixed)',
        '4x1500mR': '4X1500mR', '4X1500mR': '4X1500mR', '4 x 1500mR': '4X1500mR', '4×1500mR': '4X1500mR',
        '4x800mR': '4X800mR', '4X800mR': '4X800mR', '4 x 800mR': '4X800mR', '4×800mR': '4X800mR',
    };
    return map[s] || s;
}


// ── 비교 키 (recordCompare.js 에서 이동 — 출력 고정) ─────────────
// ─── 종목명 정규화 ────────────────────────────────────────────
// event.name이 매트릭스의 정식 종목명과 다를 수 있어 best-effort 매칭.
// 예: "100m 예선" → "100m", "남자 100미터" → "100m"
function recordKey(name) {
    if (!name) return '';
    let s = String(name).trim();
    // 라운드 토큰 제거
    s = s.replace(/\s*(예선|준결승|결승|preliminary|semifinal|final)\s*/gi, ' ').trim();
    // 성별 토큰 제거 (정식명에 성별 prefix 없음)
    s = s.replace(/^(남자|여자|남|여|M|F)\s+/i, '').trim();
    // 천단위 콤마/공백 제거: "10,000m" / "10 000m" → "10000m" (DB는 보통 콤마 없이 저장)
    // 한글 콤마(，) 도 함께 제거
    s = s.replace(/[,，]/g, '');
    // 숫자 사이 공백 제거 (천단위 구분): "10 000m" → "10000m"
    s = s.replace(/(\d)\s+(\d)/g, '$1$2');
    // 한글 단위 통일
    s = s.replace(/미터\s*허들/g, 'mH')
         .replace(/미터\s*장애물/g, 'mSC')
         .replace(/미터\s*경보/g, 'mW')
         .replace(/미터/g, 'm');
    // 'm허들'·'m장애물'·'m경보' 도 같은 뜻 (연맹 기록표·시간표 표기). 예전엔 이 표기가 그대로 남아 '110mH' 와 대조되지 않았다
    s = s.replace(/m\s*허들/g, 'mH').replace(/m\s*장애물/g, 'mSC').replace(/m\s*경보/g, 'mW');
    // 혼성 계주: 'Mixed 4x400mR' · 'MIXED 4×400mR' · '혼성 4x400mR' · '4x400mR Mixed' → '4x400mR(Mixed)' 로 통일 (예전엔 앞에 붙은 Mixed 가 그대로 남아 다른 종목이 됐다)
    s = s.replace(/^(mixed|혼성)\s*/i, '').replace(/\s*\(?(mixed|혼성)\)?\s*$/i, '').trim();
    const _mixed = /mixed|혼성/i.test(String(name));
    // 릴레이 표기 통일: 4×100m, 4x100M, 400×4 → 4x100mR
    s = s.replace(/×/g, 'x').replace(/X/g, 'x');
    s = s.replace(/(\d+)\s*x\s*(\d+)\s*m(?:\s*릴레이|\s*계주|\s*R)?/gi, '$1x$2mR');
    // 숫자와 단위 사이 공백 제거: "10000 m" → "10000m", "10 ,000m" → "10000m"
    s = s.replace(/(\d)\s+(m\b|mH\b|mSC\b|mW\b|mR\b)/gi, '$1$2');
    // 공백 정리
    s = s.replace(/\s+/g, ' ').trim();
    if (_mixed && /mR$/.test(s)) s += '(Mixed)';
    return s;
}


function sameEvent(a, b) { return recordKey(a) === recordKey(b) && recordKey(a) !== ''; }

module.exports = { storedName, recordKey, sameEvent };
