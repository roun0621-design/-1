'use strict';
/**
 * 요청 문맥 — 멀티테넌시 3단계 (2026-10-09)
 *   isOperationKey() 같은 키 검사 함수는 req 를 받지 않는다(호출부 ~300곳). 요청마다 조직 번호를
 *   AsyncLocalStorage 에 실어 두면 그 함수들이 "지금 요청의 조직"을 알 수 있다.
 *   요청 밖(부팅·테스트 직접 호출)에서는 기본 조직 1.
 */
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
function run(store, fn) { return als.run(store, fn); }
function get() { return als.getStore() || null; }
function orgId() { const s = als.getStore(); return (s && Number(s.orgId)) || 1; }
module.exports = { run, get, orgId };
