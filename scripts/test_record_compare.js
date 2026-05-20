// Phase C1 unit tests for lib/recordCompare.js (pure functions only)
const {
    normalizeEventName, parseRecordValue, isBetter,
    getCompareDirection, formatValueForDisplay
} = require('../lib/recordCompare');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
    if (cond) { pass++; console.log('  ✅', name); }
    else { fail++; console.log('  ❌', name, detail ? '— ' + detail : ''); }
}
function eq(a, b) { return a === b || (Number.isNaN(a) && Number.isNaN(b)); }

console.log('\n▶ normalizeEventName');
assert('100m 그대로', eq(normalizeEventName('100m'), '100m'));
assert('"100m 예선" → "100m"', eq(normalizeEventName('100m 예선'), '100m'));
assert('"남자 100m" → "100m"', eq(normalizeEventName('남자 100m'), '100m'));
assert('"여자 400미터 허들" → "400mH"', eq(normalizeEventName('여자 400미터 허들'), '400mH'));
assert('"4x100m 결승" → "4x100mR"', eq(normalizeEventName('4x100m 결승'), '4x100mR'));
assert('"4×400m" → "4x400mR"', eq(normalizeEventName('4×400m'), '4x400mR'));
assert('빈 입력', eq(normalizeEventName(''), ''));

console.log('\n▶ parseRecordValue');
assert('"10.34" → 10.34', eq(parseRecordValue('10.34'), 10.34));
assert('"8.21m" → 8.21', eq(parseRecordValue('8.21m'), 8.21));
assert('"2:05.12" → 125.12', eq(parseRecordValue('2:05.12'), 125.12));
assert('"1:23:45.67" → 5025.67', Math.abs(parseRecordValue('1:23:45.67') - 5025.67) < 0.001);
assert('숫자 그대로', eq(parseRecordValue(9.99), 9.99));
assert('빈 문자열 → null', parseRecordValue('') === null);
assert('null → null', parseRecordValue(null) === null);
assert('"abc" → null', parseRecordValue('abc') === null);

console.log('\n▶ isBetter');
assert('10.07 < 10.34 lower → true', isBetter(10.07, 10.34, 'lower') === true);
assert('10.34 < 10.07 lower → false', isBetter(10.34, 10.07, 'lower') === false);
assert('8.50 > 8.21 higher → true', isBetter(8.50, 8.21, 'higher') === true);
assert('8.00 > 8.21 higher → false', isBetter(8.00, 8.21, 'higher') === false);
assert('기존 기록 없음 → true (lower)', isBetter(10.07, null, 'lower') === true);
assert('기존 기록 없음 → true (higher)', isBetter(8.21, null, 'higher') === true);
assert('newVal null → false', isBetter(null, 10.34, 'lower') === false);
assert('동일값 → false (lower)', isBetter(10.07, 10.07, 'lower') === false);

console.log('\n▶ getCompareDirection');
assert('track → lower', getCompareDirection('track') === 'lower');
assert('road → lower', getCompareDirection('road') === 'lower');
assert('relay → lower', getCompareDirection('relay') === 'lower');
assert('field_distance → higher', getCompareDirection('field_distance') === 'higher');
assert('field_height → higher', getCompareDirection('field_height') === 'higher');
assert('combined → null', getCompareDirection('combined') === null);

console.log('\n▶ formatValueForDisplay');
assert('필드 8.21 → "8.21"', eq(formatValueForDisplay(8.21, 'higher'), '8.21'));
// JS 부동소수 표현 한계: 8.215는 실제로 8.2149999...라 toFixed(2)=="8.21"
// 이는 JS 표준 동작이므로 기대값 그대로 사용
assert('필드 8.215 → JS toFixed 결과', eq(formatValueForDisplay(8.215, 'higher'), (8.215).toFixed(2)));
assert('트랙 10.07 → "10.07"', eq(formatValueForDisplay(10.07, 'lower'), '10.07'));
assert('트랙 125.12 → "2:05.12"', eq(formatValueForDisplay(125.12, 'lower'), '2:05.12'));
assert('null → ""', eq(formatValueForDisplay(null, 'lower'), ''));

console.log('\n═══════════════════════════════════════════');
console.log(`  결과: ${pass} pass / ${fail} fail`);
console.log('═══════════════════════════════════════════');
if (fail > 0) process.exit(1);
