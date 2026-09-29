'use strict';
/**
 * 종목 사전(event catalog) — 종목을 이름이 아니라 코드로 식별한다 (2026-09-30, 해외 대회 대비 B2)
 *   event.name 은 그대로(한글 정식명, 부 접미 포함) 두고 event.code 를 옆에 채운다. 표시 이름·정렬·풍속 규제·영문 표기는 코드로 찾는다.
 *   코드는 WA/현장 약어: 100 · 110H · 3000SC · 5000W · LJ · SP · DEC · 4X100 · 4X400X(혼성 계주) · HM · MAR · 20KW …
 *
 *   codeOf(name)        이름(한글·영문·약어·연맹 표기·Bornan 표기) → 코드. 모르면 null
 *   label(code, lang)   'ko' | 'en' 표시 이름 (모르면 code 그대로)
 *   entry(code)         { code, ko, en, category, wind, order }
 *   isWindAffected(code) 100·200·100H·110H·LJ·TJ
 *   sortIndex(code)     WA 종목 순서(트랙 → 허들 → 장애물 → 경보 → 도로 → 도약 → 투척 → 혼성 → 계주). 모르면 999
 *   nameEn(name)        이름 → 영문 표시(코드를 모르면 이름 그대로)
 */
const { recordKey } = require('./eventName');

// order 는 배열 순서. wind 는 풍속 규제 종목(WA TR 17.11 / 29.7)
const LIST = [
    // 트랙
    ['60', '60m', '60m', 'track'], ['80', '80m', '80m', 'track'], ['100', '100m', '100m', 'track', true], ['150', '150m', '150m', 'track'], ['200', '200m', '200m', 'track', true],
    ['300', '300m', '300m', 'track'], ['400', '400m', '400m', 'track'], ['600', '600m', '600m', 'track'], ['800', '800m', '800m', 'track'], ['1000', '1000m', '1000m', 'track'],
    ['1500', '1500m', '1500m', 'track'], ['MILE', '1마일', 'Mile', 'track'], ['2000', '2000m', '2000m', 'track'], ['3000', '3000m', '3000m', 'track'], ['5000', '5000m', '5000m', 'track'], ['10000', '10,000m', '10,000m', 'track'],
    // 허들·장애물
    ['60H', '60mH', '60m Hurdles', 'track'], ['80H', '80mH', '80m Hurdles', 'track'], ['100H', '100mH', '100m Hurdles', 'track', true], ['110H', '110mH', '110m Hurdles', 'track', true],
    ['200H', '200mH', '200m Hurdles', 'track'], ['300H', '300mH', '300m Hurdles', 'track'], ['400H', '400mH', '400m Hurdles', 'track'],
    ['2000SC', '2000mSC', '2000m Steeplechase', 'track'], ['3000SC', '3000mSC', '3000m Steeplechase', 'track'],
    // 경보(트랙)·경보(도로)
    ['3000W', '3000mW', '3000m Race Walk', 'track'], ['5000W', '5000mW', '5000m Race Walk', 'track'], ['10000W', '10,000mW', '10,000m Race Walk', 'track'],
    ['10KW', '10kmW', '10km Race Walk', 'road'], ['20KW', '20kmW', '20km Race Walk', 'road'], ['35KW', '35kmW', '35km Race Walk', 'road'], ['50KW', '50kmW', '50km Race Walk', 'road'],
    ['HMW', '하프마라톤경보', 'Half Marathon Race Walk', 'road'], ['MARW', '마라톤경보', 'Marathon Race Walk', 'road'],
    // 도로
    ['5K', '5K', '5km Road Race', 'road'], ['10K', '10K', '10km Road Race', 'road'], ['HM', '하프마라톤', 'Half Marathon', 'road'], ['MAR', '마라톤', 'Marathon', 'road'],
    // 도약
    ['HJ', '높이뛰기', 'High Jump', 'field_height'], ['PV', '장대높이뛰기', 'Pole Vault', 'field_height'],
    ['LJ', '멀리뛰기', 'Long Jump', 'field_distance', true], ['TJ', '세단뛰기', 'Triple Jump', 'field_distance', true],
    // 투척
    ['SP', '포환던지기', 'Shot Put', 'field_distance'], ['DT', '원반던지기', 'Discus Throw', 'field_distance'], ['HT', '해머던지기', 'Hammer Throw', 'field_distance'], ['JT', '창던지기', 'Javelin Throw', 'field_distance'],
    // 혼성
    ['PEN', '5종경기', 'Pentathlon', 'combined'], ['HEP', '7종경기', 'Heptathlon', 'combined'], ['DEC', '10종경기', 'Decathlon', 'combined'],
    // 계주
    ['4X100', '4X100mR', '4x100m Relay', 'relay'], ['4X200', '4X200mR', '4x200m Relay', 'relay'], ['4X400', '4X400mR', '4x400m Relay', 'relay'],
    ['4X400X', '4X400mR(Mixed)', '4x400m Mixed Relay', 'relay'], ['4X800', '4X800mR', '4x800m Relay', 'relay'], ['4X1500', '4X1500mR', '4x1500m Relay', 'relay'],
    ['MEDLEY', '메들리릴레이', 'Medley Relay', 'relay'],
];
const BY_CODE = new Map();
LIST.forEach(([code, ko, en, category, wind], order) => BY_CODE.set(code, { code, ko, en, category, wind: !!wind, order }));

// 별칭(정규화 뒤 비교): 영문 풀네임·연맹 표기·Bornan 코드·흔한 오타
const ALIASES = {
    '100': ['100M', '100미터'], '200': ['200M'], '400': ['400M'], '800': ['800M'], '1500': ['1500M'], '5000': ['5000M'], '10000': ['10000M', '10000m', '10 000m'],
    'MILE': ['1mile', 'mile', '1600m'],
    '100H': ['100MHURD', '100m hurdles', '100mhurdles', '100허들'], '110H': ['110MHURD', '110m hurdles', '110허들'], '400H': ['400MHURD', '400m hurdles', '400허들'],
    '80H': ['80m hurdles'], '60H': ['60m hurdles'], '300H': ['300m hurdles'], '200H': ['200m hurdles'],
    '3000SC': ['3000MST', '3000m steeplechase', '3000msteeple', '3000m장애물', '3000장애물', 'steeplechase'], '2000SC': ['2000m steeplechase', '2000m장애물'],
    '5000W': ['5000m walk', '5000m race walk', '5000경보', '5000m경보'], '10000W': ['10000m walk', '10000mW', '10000m race walk', '10000m경보'], '3000W': ['3000m walk', '3000m경보'],
    '20KW': ['WALK20K', '20KmW', '20km walk', '20km race walk', '20km경보', '20k walk', '20kmw'], '35KW': ['WALK35K', '35km walk', '35km race walk', '35km경보'], '50KW': ['50km walk', '50km경보'], '10KW': ['10km walk', '10km경보', '10kmw'],
    'HMW': ['WALKHM', 'half marathon walk', 'half marathon race walk', '하프마라톤 경보'], 'MARW': ['WALKM', 'marathon walk', 'marathon race walk', '마라톤 경보'],
    '5K': ['5km', '5 km', '5000m road', '5km road race', '5킬로'], '10K': ['10km', '10 km', '10km road race', '10킬로', '10K로드레이스'],
    'HM': ['half marathon', 'halfmarathon', 'half-marathon', '하프', '21.0975km', '21km'], 'MAR': ['MARATHON', 'marathon', '풀마라톤', '42.195km', '42km'],
    'HJ': ['HIGHJUMP', 'high jump', 'highjump', '높이'], 'PV': ['PLEVAULT', 'pole vault', 'polevault', '장대'], 'LJ': ['LONGJUMP', 'long jump', 'longjump', '멀리'], 'TJ': ['TRPLJUMP', 'triple jump', 'triplejump', '세단'],
    'SP': ['SHOTPUT', 'shot put', 'shotput', 'shot', '포환'], 'DT': ['DISCUS', 'discus throw', 'discus', '원반'], 'HT': ['HAMMER', 'hammer throw', 'hammer', '해머'], 'JT': ['JAVELIN', 'javelin throw', 'javelin', '창'],
    'PEN': ['pentathlon', '펜타슬론', '5종'], 'HEP': ['HEPTATH', 'heptathlon', '헵타슬론', '7종'], 'DEC': ['DECATH', 'decathlon', '데카슬론', '10종'],
    '4X100': ['4X100M', '4x100m relay', '400m릴레이', '4x100m계주'], '4X400': ['4X400M', '4x400m relay', '1600m릴레이', '4x400m계주'],
    '4X400X': ['4x400mR(혼성)', '4x400mR(믹스)', '혼성 4x400mR', '4x400m혼성계주'],
    '4X200': ['4x200'], '4X800': ['4x800'], '4X1500': ['4x1500'], 'MEDLEY': ['medley relay', '메들리'],
};
// 비교용 정규화: recordKey(라운드·성별·부 접미·콤마·단위 통일) → 소문자 → 공백·괄호·하이픈 제거
function norm(name) {
    // 영문 계주 표기를 recordKey 가 아는 모양으로: '4x400m Relay' → '4x400mR', '4x100 relay' → '4x100mR', 'Mixed 4x400m Relay' → '4x400mR(Mixed)'
    let s = String(name || '').replace(/\s*relay\b/ig, 'R').replace(/(\d+)\s*[x×X]\s*(\d+)(?!\d)(?!\s*m)/g, '$1x$2m');
    s = recordKey(s);
    s = s.toLowerCase().replace(/[\s\-_()（）]/g, '').replace(/racewalk$/, 'w').replace(/hurdles$/, 'h');
    return s;
}
const INDEX = new Map();
for (const e of BY_CODE.values()) {
    INDEX.set(norm(e.ko), e.code); INDEX.set(norm(e.en), e.code); INDEX.set(e.code.toLowerCase(), e.code);
    for (const a of ALIASES[e.code] || []) INDEX.set(norm(a), e.code);
}
// '4x400mR(Mixed)' 는 recordKey 가 '4x400mR(Mixed)' 로 주므로 norm → '4x400mrmixed'
INDEX.set('4x400mrmixed', '4X400X'); INDEX.set('4x400mr혼성', '4X400X');

function codeOf(name) {
    if (!name) return null;
    const key = norm(name);
    if (!key) return null;
    if (INDEX.has(key)) return INDEX.get(key);
    // '100m 실업' 처럼 recordKey 가 못 뗀 낱말이 남았을 때: 낱말 단위로 가장 긴 연속 구간이 표제와 맞으면 그것 (글자 단위 부분일치는 안 한다 — '4x400m' 안의 '400m' 같은 오인 방지)
    const tokens = recordKey(String(name || '').replace(/\s*relay\b/ig, 'R')).split(' ').filter(Boolean);
    for (let len = tokens.length - 1; len >= 1; len--) {
        for (let start = 0; start + len <= tokens.length; start++) {
            const k = norm(tokens.slice(start, start + len).join(' '));
            if (k && INDEX.has(k)) return INDEX.get(k);
        }
    }
    return null;
}
function entry(code) { return BY_CODE.get(String(code || '').toUpperCase()) || null; }
function label(code, lang) { const e = entry(code); if (!e) return code || ''; return lang === 'en' ? e.en : e.ko; }
function isWindAffected(code) { const e = entry(code); return !!(e && e.wind); }
function sortIndex(code) { const e = entry(code); return e ? e.order : 999; }
function nameEn(name) { const c = codeOf(name); return c ? label(c, 'en') : String(name || ''); }
function list() { return [...BY_CODE.values()]; }

module.exports = { codeOf, entry, label, isWindAffected, sortIndex, nameEn, list, norm };
