/**
 * SMS Sender — Aligo API + Simulation Mode
 *
 * 알리고(Aligo) API:
 *   - 단건 발송: POST https://apis.aligo.in/send/
 *   - 파라미터: key, user_id, sender, receiver, msg, msg_type(SMS/LMS), title
 *   - 가입 전엔 sim_mode=1 로 두면 DB에만 기록 (실제 발송 안 함)
 *
 * 메시지 종류:
 *   - SMS: 90바이트 이하 (한글 ~45자)
 *   - LMS: 2000바이트 이하 (한글 ~1000자) — 상장 링크 포함 메시지는 보통 LMS
 */

const https = require('https');
const querystring = require('querystring');

/**
 * 한국 휴대폰 번호 정규화 (010-1234-5678 / 01012345678 / +821012345678 → 01012345678)
 */
function normalizePhone(phone) {
    if (!phone) return '';
    let p = String(phone).replace(/[^0-9+]/g, '');
    if (p.startsWith('+82')) p = '0' + p.slice(3);
    if (p.startsWith('82')) p = '0' + p.slice(2);
    return p;
}

/**
 * 한글 메시지 바이트 수 계산 (EUC-KR 기준, 한글 2바이트)
 */
function getMessageBytes(msg) {
    if (!msg) return 0;
    let bytes = 0;
    for (const ch of msg) {
        // ASCII 1바이트, 그 외 한글/기타 2바이트
        bytes += (ch.charCodeAt(0) < 128) ? 1 : 2;
    }
    return bytes;
}

/**
 * SMS 종류 자동 판별
 */
function detectMessageType(msg) {
    const bytes = getMessageBytes(msg);
    if (bytes <= 90) return 'SMS';
    if (bytes <= 2000) return 'LMS';
    return 'LMS'; // 잘리더라도 LMS
}

/**
 * 메시지 템플릿 변수 치환
 */
function fillMessageTemplate(tpl, vars) {
    if (!tpl) return '';
    return String(tpl).replace(/\{(\w+)\}/g, (m, k) => {
        const v = vars[k];
        return (v === undefined || v === null) ? '' : String(v);
    });
}

/**
 * 알리고 API 호출 (Promise)
 */
function callAligoApi(config, payload) {
    return new Promise((resolve, reject) => {
        const postData = querystring.stringify(payload);
        const opts = {
            hostname: 'apis.aligo.in',
            port: 443,
            path: '/send/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
            },
            timeout: 10000,
        };
        const req = https.request(opts, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    resolve({ ok: res.statusCode === 200 && data.result_code > 0, raw: data, statusCode: res.statusCode });
                } catch (e) {
                    resolve({ ok: false, raw: { error: 'parse_failed', body }, statusCode: res.statusCode });
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('aligo timeout')); });
        req.write(postData);
        req.end();
    });
}

/**
 * 단일 SMS 발송 시도
 * @param {Object} config sms_config row
 * @param {Object} params { phone, message, title?, sender? }
 * @returns {Promise<{status, provider_msg_id, error_message, cost}>}
 */
async function sendOne(config, params) {
    const phone = normalizePhone(params.phone);
    const msg = String(params.message || '').trim();
    const title = (params.title || '').slice(0, 44);
    const sender = normalizePhone(params.sender || config.sender_number);

    if (!phone) return { status: 'failed', provider_msg_id: '', error_message: '수신번호 없음', cost: 0 };
    if (!msg) return { status: 'failed', provider_msg_id: '', error_message: '메시지 없음', cost: 0 };
    if (!sender) return { status: 'failed', provider_msg_id: '', error_message: '발신번호 미설정', cost: 0 };

    const msgType = detectMessageType(msg);
    // 시뮬레이션 모드 — 실제 발송 안 함
    if (config.sim_mode || !config.api_key) {
        return {
            status: 'simulated',
            provider_msg_id: 'SIM-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            error_message: '',
            cost: 0,
            msg_type: msgType,
        };
    }

    // 알리고 실제 발송
    if (config.provider !== 'aligo') {
        return { status: 'failed', provider_msg_id: '', error_message: '지원하지 않는 provider: ' + config.provider, cost: 0 };
    }

    try {
        const payload = {
            key: config.api_key,
            user_id: config.user_id,
            sender,
            receiver: phone,
            msg,
            msg_type: msgType,
        };
        if (msgType === 'LMS' && title) payload.title = title;

        const result = await callAligoApi(config, payload);
        if (result.ok) {
            return {
                status: 'sent',
                provider_msg_id: String(result.raw.msg_id || ''),
                error_message: '',
                cost: msgType === 'LMS' ? 35 : 13, // 대략적인 알리고 단가 (실제는 정산 시점 기준)
                msg_type: msgType,
            };
        }
        return {
            status: 'failed',
            provider_msg_id: '',
            error_message: (result.raw && (result.raw.message || result.raw.result_code)) || JSON.stringify(result.raw).slice(0, 200),
            cost: 0,
            msg_type: msgType,
        };
    } catch (err) {
        return {
            status: 'failed',
            provider_msg_id: '',
            error_message: err.message || String(err),
            cost: 0,
            msg_type: msgType,
        };
    }
}

module.exports = {
    normalizePhone,
    getMessageBytes,
    detectMessageType,
    fillMessageTemplate,
    sendOne,
};
