'use strict';
/**
 * 이메일 발송 (D12, 2026-10-12) — 문자(smsSender)와 같은 모양의 어댑터.
 *   조직별 email_config 한 행(SMTP 호스트·포트·계정·보내는 사람·시뮬레이션). sim_mode 이거나 호스트가 없으면 실제로 보내지 않고 로그만 남긴다.
 *   SMTP 는 nodemailer. 해외 조직은 문자 대신 이메일로 기록증·결과 링크를 보낸다(한국 문자 서비스는 국내 번호만).
 *   반환 { status: 'sent'|'simulated'|'skipped'|'failed', provider_msg_id, error_message }
 */
let _nodemailer = null;
function nodemailer() { if (!_nodemailer) _nodemailer = require('nodemailer'); return _nodemailer; }

const DEFAULT_SUBJECT = '[{competition_name}] {event_name} {rank_label} — {athlete_name}';
const DEFAULT_BODY = '{athlete_name} 님,\n\n{competition_name} {event_name} 결과: {rank_label} {record_value}\n기록증·상장: {cert_url}\n\n참가해 주셔서 감사합니다.\n{org_name}';

async function getEmailConfig(db, orgId) {
    const o = Number(orgId || 1);
    let row = await db.get('SELECT * FROM email_config WHERE organization_id=?', o);
    if (row) return row;
    try { await db.run('INSERT INTO email_config (organization_id) VALUES (?)', o); } catch (e) { /* 동시 생성 */ }
    return await db.get('SELECT * FROM email_config WHERE organization_id=?', o);
}

function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()); }

function fillTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : ''));
}

let _transports = new Map();   // 설정 해시 → transport (설정이 바뀌면 새로 만든다)
function transportFor(cfg) {
    const key = [cfg.smtp_host, cfg.smtp_port, cfg.smtp_secure, cfg.smtp_user, cfg.smtp_pass].join('|');
    if (!_transports.has(key)) {
        _transports.set(key, nodemailer().createTransport({
            host: cfg.smtp_host, port: Number(cfg.smtp_port || 587), secure: !!Number(cfg.smtp_secure),
            auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass || '' } : undefined,
            connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
        }));
    }
    return _transports.get(key);
}

/** 한 통 보내기. params { to, subject, text, html?, attachments? } */
async function sendOne(cfg, params) {
    const to = String(params.to || '').trim();
    if (!isValidEmail(to)) return { status: 'skipped', provider_msg_id: '', error_message: to ? `이메일 형식이 아닙니다: ${to}` : '이메일 없음 (선수 이메일 미등록)' };
    if (!params.subject || !params.text) return { status: 'failed', provider_msg_id: '', error_message: '제목·본문 없음' };
    if (Number(cfg.sim_mode) || !cfg.smtp_host) {
        return { status: 'simulated', provider_msg_id: 'SIM-' + Date.now() + '-' + Math.floor(Math.random() * 1000), error_message: '' };
    }
    try {
        const from = cfg.from_name ? `"${String(cfg.from_name).replace(/"/g, '')}" <${cfg.from_address}>` : cfg.from_address;
        const info = await transportFor(cfg).sendMail({ from, to, subject: params.subject, text: params.text, html: params.html, attachments: params.attachments });
        return { status: 'sent', provider_msg_id: String(info.messageId || ''), error_message: '' };
    } catch (e) {
        return { status: 'failed', provider_msg_id: '', error_message: String(e && e.message || e).slice(0, 300) };
    }
}

/** 발송 이력 한 줄 */
async function logSend(db, row) {
    await db.run(`INSERT INTO email_log (organization_id, competition_id, athlete_id, event_id, to_address, subject, status, provider_msg_id, error_message, sent_at, triggered_by)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        row.organization_id || 1, row.competition_id || null, row.athlete_id || null, row.event_id || null, row.to_address || '', row.subject || '',
        row.status, row.provider_msg_id || '', row.error_message || '', new Date().toISOString(), row.triggered_by || '');
}

module.exports = { getEmailConfig, isValidEmail, fillTemplate, sendOne, logSend, DEFAULT_SUBJECT, DEFAULT_BODY, _resetTransports: () => _transports.clear() };
