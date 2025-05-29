// client-instance/plugins/withdrawalRequests.js
const fetch = require('node-fetch');
const { getApiToken, loginToApi } = require('../lib/apiSync');
const { isWhitelisted } = require('./whitelist');
const config = require('../../config');
const fs = require('fs');
const path = require('path');

let localSock = null;
const DATA_BASE_DIR = process.env.DATA_DIR;
const PENDING_WITHDRAWALS_FILE = DATA_BASE_DIR ? path.join(DATA_BASE_DIR, 'pending_withdrawals.json') : 'pending_withdrawals.json';

const WITHDRAWAL_API_PATH = '/withdrawal-requests';
const INITIAL_WITHDRAWAL_API_ENDPOINT = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}`;
const POLLING_OTP_READY_API_ENDPOINT = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}/with-confirmation-code-unprocessed`;
const NOT_TRANSFERS_API_ENDPOINT = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}/not-transfers`; // Endpoint للطلبات التي ليست حوالات
const PROCESSED_TRANSFERS_API_ENDPOINT = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}/success-transfers`; // Endpoint للحوالات المعالجة
const CONFIRM_WITHDRAWAL_API_ENDPOINT_BASE = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}`;

let pendingWithdrawals = loadPendingWithdrawals();
let pollingIntervalId = null;
const POLLING_INTERVAL_MS = 15000; // 15 ثانية (يمكن تعديلها)
// const GENERAL_REQUEST_STALE_MS = 3 * 60 * 60 * 1000; // 3 ساعات كحد أقصى لطلب معلق بدون OTP

// --- File Operations ---
function savePendingWithdrawals() {
    if (!DATA_BASE_DIR) {
        console.error("[WITHDRAWAL_REQ_SAVE_ERROR] DATA_DIR is not set.");
        return false;
    }
    try {
        if (!fs.existsSync(DATA_BASE_DIR)) fs.mkdirSync(DATA_BASE_DIR, { recursive: true });
        fs.writeFileSync(PENDING_WITHDRAWALS_FILE, JSON.stringify(pendingWithdrawals, null, 2));
        console.log(`[WITHDRAWAL_REQ_SAVE] Saved ${Object.keys(pendingWithdrawals).length} pending requests.`);
        return true;
    } catch (error) {
        console.error('[WITHDRAWAL_REQ_SAVE_ERROR]', error);
        return false;
    }
}

function loadPendingWithdrawals() {
    if (!DATA_BASE_DIR || !fs.existsSync(PENDING_WITHDRAWALS_FILE)) {
        console.log(`[WITHDRAWAL_REQ_LOAD] Pending withdrawals file path not valid or file does not exist. Path: ${PENDING_WITHDRAWALS_FILE}`);
        return {};
    }
    try {
        const data = fs.readFileSync(PENDING_WITHDRAWALS_FILE, 'utf8');
        const parsedData = JSON.parse(data);
        console.log(`[WITHDRAWAL_REQ_LOAD] Loaded ${Object.keys(parsedData).length} pending requests.`);
        return parsedData;
    } catch (error) {
        console.error('[WITHDRAWAL_REQ_LOAD_ERROR]', error);
        return {};
    }
}

// --- Initialization ---
function init(sockInstance) {
    if (sockInstance) {
        localSock = sockInstance;
        console.log('[WITHDRAWAL_REQ_INIT] Plugin initialized with sock.');
        pendingWithdrawals = loadPendingWithdrawals();
        if (Object.keys(pendingWithdrawals).length > 0) {
            console.log('[WITHDRAWAL_REQ_INIT] Found pending requests on startup. Starting polling cycle.');
            startPolling();
        }
    } else {
        console.error('[WITHDRAWAL_REQ_INIT_ERROR] sockInstance is null or undefined. Plugin cannot function.');
    }
}

// --- Polling Management ---
function startPolling() {
    if (pollingIntervalId) {
        console.log('[WITHDRAWAL_REQ_POLL] Polling is already active.');
        return;
    }
    if (!localSock) { 
        console.warn('[WITHDRAWAL_REQ_POLL] Cannot start polling: localSock not initialized.'); 
        return; 
    }
    console.log(`[WITHDRAWAL_REQ_POLL] Starting polling cycle every ${POLLING_INTERVAL_MS / 1000}s.`);
    pollAllPendingRequests(); 
    pollingIntervalId = setInterval(pollAllPendingRequests, POLLING_INTERVAL_MS);
}

function stopPolling() {
    if (pollingIntervalId) {
        console.log('[WITHDRAWAL_REQ_POLL] Stopping polling cycle.');
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
    }
}

async function pollAllPendingRequests() {
    if (!localSock) { // تحقق إضافي هنا
        console.warn('[WITHDRAWAL_REQ_POLL_ALL] localSock not initialized. Skipping poll cycle.');
        stopPolling(); 
        return;
    }
    console.log(`[WITHDRAWAL_REQ_POLL_ALL] Polling ${Object.keys(pendingWithdrawals).length} pending withdrawal requests...`);
    let activePollingNeeded = false;

    for (const key in pendingWithdrawals) {
        const request = pendingWithdrawals[key];
        if (!request || !request.status || !request.senderJid) { // إضافة تحقق من senderJid
            console.warn(`[WITHDRAWAL_REQ_POLL_ALL] Invalid or incomplete request object for key ${key}:`, request);
            delete pendingWithdrawals[key]; // حذف الطلب غير الصالح
            savePendingWithdrawals();
            continue;
        }

       
        
        request.lastPollTimestamp = Date.now();

        activePollingNeeded = true; // افترض أننا نحتاج للـ polling طالما هناك طلبات
        switch (request.status) {
            case "pending_api_processing":
                await pollForOtpReadyOrNotTransfer(request, key, localSock); // تمرير localSock
                break;
            case "awaiting_not_transfer_note":
                await pollForNotTransferNote(request, key, localSock); // تمرير localSock
                break;
            case "awaiting_post_otp_note":
                await pollForPostOtpNote(request, key, localSock); // تمرير localSock
                break;
            case "awaiting_otp_confirmation":
                activePollingNeeded = true; // لا يزال هناك طلب ينتظر المستخدم، لذا استمر في الـ polling العام للحالات الأخرى
                break; 
            case "otp_received_processing":
                console.log(`[WITHDRAWAL_REQ_POLL_ALL] Request ${key} is processing OTP confirmation.`);
            default:
                console.warn(`[WITHDRAWAL_REQ_POLL_ALL] Unknown status for request ${key}: ${request.status}`);
                activePollingNeeded = false; // إذا كانت الحالة غير معروفة، افترض أنها لا تحتاج لـ polling نشط
                break;
        }
    }
    savePendingWithdrawals(); 

    if (!activePollingNeeded && Object.keys(pendingWithdrawals).length === 0) { // تعديل: أوقف فقط إذا لم تكن هناك حاجة نشطة وكانت القائمة فارغة
        console.log("[WITHDRAWAL_REQ_POLL_ALL] No active polling needed and no pending requests. Stopping polling.")
        stopPolling();
    } else if (!activePollingNeeded && Object.keys(pendingWithdrawals).every(k => pendingWithdrawals[k].status === "awaiting_otp_confirmation")) {
        console.log("[WITHDRAWAL_REQ_POLL_ALL] All pending requests are awaiting OTP from user. Polling will continue for other potential states.");
        // لا توقف الـ polling هنا، فقد تأتي طلبات جديدة أو تتغير حالات
    } else if (Object.keys(pendingWithdrawals).length === 0) {
        console.log("[WITHDRAWAL_REQ_POLL_ALL] All pending requests processed. Stopping polling.")
        stopPolling();
    }
    else {
        console.log(`[WITHDRAWAL_REQ_POLL_ALL] Polling cycle completed. Active requests: ${Object.keys(pendingWithdrawals).length}`);
    }
}

async function fetchWithToken(url, options = {}) {
    let apiToken = getApiToken();
    if (!apiToken) {
        apiToken = await loginToApi();
        if (!apiToken) throw new Error("Failed to login to API for polling.");
    }
    const defaultOptions = {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Accept': 'application/json' },
        timeout: 15000, // زيادة المهلة قليلاً
    };
    return fetch(url, { ...defaultOptions, ...options });
}

async function pollForOtpReadyOrNotTransfer(request, requestKey, sock) { // استقبال sock
    console.log(`[POLL_OTP_READY] Key: ${requestKey}, API_ID: ${request.apiTransferId}, OrigNum: ${request.originalTransferNumber}`);
    try {
        const response = await fetchWithToken(POLLING_OTP_READY_API_ENDPOINT);
        if (!response.ok) {
            console.error(`[POLL_OTP_READY] API error list for ${requestKey}: ${response.status}`);
            return;
        }
        const responseData = await response.json();
        if (!responseData || !Array.isArray(responseData.data)) {
            console.error(`[POLL_OTP_READY] Invalid API response for ${requestKey}. Expected data array.`, responseData);
            return;
        }
        const item = responseData.data.find(d =>
            (request.apiTransferId && d.id && d.id.toString() === request.apiTransferId.toString()) ||
            (d.contact_id && d.contact_id.toString() === request.contactId.toString() && d.original_transfer_number && d.original_transfer_number.toString() === request.originalTransferNumber.toString())
        );
        if (!item) {
            console.log(`[POLL_OTP_READY] Request ${requestKey} not found in "with-confirmation-code-unprocessed" list.`);
            return;
        }
        console.log(`[POLL_OTP_READY] Found item for ${requestKey}:`, item);
        if (item.confirmation_code && item.status === 0 && item.customer_confirmed === false) {
            request.status = "awaiting_otp_confirmation";
            request.expectedOtp = item.confirmation_code.toString();
            request.transferDetails = item.transfer_details;
            request.apiTransferId = item.id; // تحديث إذا لزم الأمر
            const userMessage = `تفاصيل الحوالة:\n${item.transfer_details}\n\nرمز التأكيد (OTP) الخاص بك هو:\n\`\`\`${item.confirmation_code}\`\`\`\n\nالرجاء إعادة إرسال رمز التأكيد فقط لتأكيد عملية السحب.`;
            await sock.sendMessage(request.senderJid, { text: userMessage }); // استخدام sock.sendMessage
        } else if (item.Note) {
            await sock.sendMessage(request.senderJid, { text: item.Note }); // استخدام sock.sendMessage
            delete pendingWithdrawals[requestKey];
        } else if (item.status === 1 && !item.confirmation_code && !item.customer_confirmed) {
            request.status = "awaiting_not_transfer_note";
            request.apiTransferId = item.id;
        } else { /* ... */ }
    } catch (error) {
        console.error(`[POLL_OTP_READY] Error polling for ${requestKey}:`, error);
    }
}

async function pollForNotTransferNote(request, requestKey, sock) { // استقبال sock
    console.log(`[POLL_NOT_TRANSFER] Key: ${requestKey}, API_ID: ${request.apiTransferId}`);
    if (!request.apiTransferId) { delete pendingWithdrawals[requestKey]; return; }
    try {
        const response = await fetchWithToken(`${NOT_TRANSFERS_API_ENDPOINT}?id=${request.apiTransferId}`);
        if (!response.ok) {
            if (response.status === 404) {
                await sock.sendMessage(request.senderJid, { text: `تعذر العثور على تفاصيل الطلب ${request.originalTransferNumber} (NT404).`});
                delete pendingWithdrawals[requestKey];
            }
            return;
        }
        const responseData = await response.json();
        const item = Array.isArray(responseData.data) ? responseData.data.find(d => d.id && d.id.toString() === request.apiTransferId.toString()) : 
                     (responseData.id && responseData.id.toString() === request.apiTransferId.toString() ? responseData : null);
        if (item && item.Note) {
            await sock.sendMessage(request.senderJid, { text: item.Note }); // استخدام sock.sendMessage
            delete pendingWithdrawals[requestKey];
        } else { /* ... */ }
    } catch (error) { console.error(`[POLL_NOT_TRANSFER] Error for ${requestKey}:`, error); }
}

async function pollForPostOtpNote(request, requestKey, sock) { // استقبال sock
    console.log(`[POLL_POST_OTP] Key: ${requestKey}, API_ID: ${request.apiTransferId}`);
    if (!request.apiTransferId) { delete pendingWithdrawals[requestKey]; return; }
    try {
        const response = await fetchWithToken(`${CONFIRM_WITHDRAWAL_API_ENDPOINT_BASE}/${request.apiTransferId}`);
        if (!response.ok) {
            if (response.status === 404) {
                 await sock.sendMessage(request.senderJid, { text: `تعذر العثور على تفاصيل إتمام الطلب ${request.originalTransferNumber} (PO404).`});
                 delete pendingWithdrawals[requestKey];
            }
            return;
        }
        const item = await response.json();
        if (!item || typeof item !== 'object') return;
        if (item.Note && (item.customer_confirmed === true || item.status === 2 || item.status === "Completed")) {
            await sock.sendMessage(request.senderJid, { text: item.Note }); // استخدام sock.sendMessage
            delete pendingWithdrawals[requestKey];
        } else if (item.Note) { 
            await sock.sendMessage(request.senderJid, { text: item.Note }); // استخدام sock.sendMessage
            request.status = "awaiting_post_otp_note"; // تحديث الحالة للانتظار لملاحظة ما بعد OTP
            request.expectedOtp = null; // مسح رمز OTP المتوقع
            request.transferDetails = item.transfer_details || null; // حفظ تفاصيل الحوالة إذا كانت موجودة
            request.lastPollTimestamp = Date.now(); // تحديث الطابع الزمني الأخير
            savePendingWithdrawals(); // حفظ التغييرات
        }
        else { 

            console.warn(`[POLL_POST_OTP] No Note found for request ${requestKey}.`);
            request.status = "awaiting_post_otp_note"; // تحديث الحالة للانتظار لملاحظة ما بعد OTP
            request.expectedOtp = null; // مسح رمز OTP المتوقع
            request.transferDetails = item.transfer_details || null; // حفظ تفاصيل الحوالة إذا كانت موجودة
            request.lastPollTimestamp = Date.now(); // تحديث الطابع الزمني الأخير
            savePendingWithdrawals(); // حفظ التغييرات
        }
    } catch (error) { console.error(`[POLL_POST_OTP] Error for ${requestKey}:`, error); }
}

async function handleWithdrawalRequest(m, sender, originalTransferNumber, isOwner) {
    console.log(`[WITHDRAWAL_REQ] Request from ${sender} for transfer: ${originalTransferNumber}`);
    if (!isOwner && !isWhitelisted(sender)) { m.reply("عذراً، لا يمكنك استخدام هذا الأمر."); return; }
    const senderInfo = global.userGroupPermissions?.[sender];
    if (!senderInfo || (senderInfo.contact_id === undefined || senderInfo.contact_id === null)) { m.reply("عفواً، معلومات حسابك غير مكتملة (CI)."); return; }
    const contactId = senderInfo.contact_id;
    let apiToken = getApiToken();
    if (!apiToken) apiToken = await loginToApi();
    if (!apiToken) { m.reply("خطأ اتصال (T1)."); return; }

    const payload = { contact_id: contactId, customer_request: "سحب", original_transfer_number: originalTransferNumber };
    try {
        const response = await fetch(INITIAL_WITHDRAWAL_API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiToken}` },
            body: JSON.stringify(payload),
            timeout: 20000,
        });
        const responseData = await response.json().catch(() => null);
        if (response.ok && responseData) {
            m.reply(`تم استلام طلب السحب (${originalTransferNumber}). جاري المعالجة...`);
            const requestKey = `${sender}_${originalTransferNumber}_${Date.now()}`;
            pendingWithdrawals[requestKey] = {
                senderJid: sender, originalTransferNumber: originalTransferNumber.toString(), contactId: contactId.toString(),
                status: "pending_api_processing", apiTransferId: responseData.id || null,
                requestTimestamp: Date.now(), lastPollTimestamp: Date.now()
            };
            savePendingWithdrawals(); startPolling();
        } else { 
            const errorMsg = responseData?.message || responseData?.Note || `فشل إرسال الطلب الأولي (Status: ${response.status})`;
            console.error(`[WITHDRAWAL_REQ_ERROR] Initial request failed: ${response.status}`, responseData);
            m.reply(`خطأ: ${errorMsg}`);
        }
    } catch (error) {
        console.error(`[WITHDRAWAL_REQ_ERROR] Sending initial request:`, error);
        m.reply("خطأ غير متوقع أثناء إرسال طلب السحب.");
    }
}

async function handleOtpConfirmation(m, sender, receivedOtp) {
    console.log(`[OTP_CONFIRM] OTP attempt: ${receivedOtp} from ${sender}.`);
    const pendingRequestKey = Object.keys(pendingWithdrawals).find(key => 
        pendingWithdrawals[key].senderJid === sender && 
        pendingWithdrawals[key].status === "awaiting_otp_confirmation"
    );
    if (!pendingRequestKey || !pendingWithdrawals[pendingRequestKey]) { m.reply("لا يوجد طلب سحب نشط ينتظر رمز تأكيد منك."); return; }
    const pendingRequest = pendingWithdrawals[pendingRequestKey];
    const receivedOtpCleaned = receivedOtp.trim();

    if (pendingRequest.expectedOtp && pendingRequest.expectedOtp.toString() === receivedOtpCleaned) {
        pendingRequest.status = "otp_received_processing"; savePendingWithdrawals();
        const confirmed = await confirmOtpWithApi(pendingRequest, m, localSock); // تمرير localSock
        if (confirmed) {
            pendingRequest.status = "awaiting_post_otp_note";
            pendingRequest.lastPollTimestamp = Date.now(); savePendingWithdrawals(); startPolling();
            m.reply("تم تأكيد الرمز. جاري الحصول على الحالة النهائية...");
        } else {
            pendingRequest.status = "awaiting_otp_confirmation"; savePendingWithdrawals();
        }
    } else { m.reply(`رمز التأكيد (${receivedOtpCleaned}) غير صحيح. حاول مرة أخرى.`); }
}

async function confirmOtpWithApi(pendingRequest, m, sock) { // استقبال sock
    let apiToken = getApiToken();
    if (!apiToken) apiToken = await loginToApi();
    if (!apiToken) { m.reply("خطأ اتصال (T2C)."); return false; }
    const confirmPayload = { customer_confirmed: true };
    try {
        const response = await fetch(`${CONFIRM_WITHDRAWAL_API_ENDPOINT_BASE}/${pendingRequest.apiTransferId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiToken}` },
            body: JSON.stringify(confirmPayload),
            timeout: 20000,
        });

        if (response.ok) {
            console.log(`[CONFIRM_OTP] API OTP confirm success for ID ${pendingRequest.apiTransferId}.`);
            const responseData = await response.json();
            if (responseData && responseData.Note) {
                await sock.sendMessage(pendingRequest.senderJid, { text: responseData.Note }); // استخدام sock.sendMessage
            } else {
                await sock.sendMessage(pendingRequest.senderJid, { text: "تم تأكيد الرمز بنجاح، ولكن لم يتم توفير ملاحظة إضافية." });
            }
            return true;
        } else {
            const errorText = await response.text();
            console.error(`[CONFIRM_OTP_ERROR] API OTP confirm failed: ${response.status} - ${errorText.substring(0,300)}`);
            m.reply("خطأ أثناء تأكيد الرمز مع النظام. حاول مرة أخرى أو تواصل مع الدعم.");
            return false;
        }
    } catch (error) {
        console.error(`[CONFIRM_OTP_ERROR] Network error:`, error);
        m.reply("خطأ شبكة أثناء تأكيد الرمز. حاول مرة أخرى.");
        return false;
    }
}

function cleanupOldStaleRequests() {
    const now = Date.now();
    const staleKeys = Object.keys(pendingWithdrawals).filter(key => {
        const request = pendingWithdrawals[key];
        return request && request.status === "awaiting_otp_confirmation" && (now - request.lastPollTimestamp > 3 * 60 * 60 * 1000); // 3 ساعات
    });
    if (staleKeys.length > 0) {
        staleKeys.forEach(key => {
            console.log(`[WITHDRAWAL_REQ_CLEANUP] Removing stale request: ${key}`);
            delete pendingWithdrawals[key];
        });
        savePendingWithdrawals();
    }
}

module.exports = {
    init,
    all: async function (m, { sock, chatId, sender, isGroup, text, isOwner }) {
        if (!localSock && sock) init(sock);
        else if (!localSock) { console.error("[WITHDRAWAL_REQ_ALL] localSock unavailable."); return; }

        const cleanedText = text.trim();
        const withdrawalRegex = /^سحب\s*[\r\n]+\s*([\w\d.-]+)\s*$/m;
        const otpRegex = /^\d{3,}$/; 

        const withdrawalMatch = cleanedText.match(withdrawalRegex);
        const otpMatch = cleanedText.match(otpRegex);

        if (withdrawalMatch) {
            const originalTransferNumber = withdrawalMatch[1];
            await handleWithdrawalRequest(m, sender, originalTransferNumber, isOwner);
            return {};
        } else if (otpMatch) {
            const receivedOtp = otpMatch[0];
            await handleOtpConfirmation(m, sender, receivedOtp);
            return {};
        }
        if (Math.random() < 0.01) cleanupOldStaleRequests();
        return;
    },
    stopPollingOnShutdown: stopPolling,
    savePendingOnShutdown: savePendingWithdrawals,
};