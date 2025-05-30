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
const POST_OTP_NOTE_API_ENDPOINT = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}/successful`; // Endpoint/${apiTransferId}
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
    let activePollingNeeded = false; // This will remain true if there are any pending requests

    for (const key in pendingWithdrawals) {
        const request = pendingWithdrawals[key];
        if (!request || !request.status || !request.senderJid) { 
            console.warn(`[WITHDRAWAL_REQ_POLL_ALL] Invalid or incomplete request object for key ${key}:`, request);
            delete pendingWithdrawals[key]; 
            savePendingWithdrawals();
            continue;
        }
        
        request.lastPollTimestamp = Date.now();
        activePollingNeeded = true; // A request is being processed, so polling is needed

        switch (request.status) {
            case "pending_api_processing":
                await pollForOtpReadyOrNotTransfer(request, key, localSock); 
                break;
            case "awaiting_not_transfer_note":
                await pollForNotTransferNote(request, key, localSock); 
                break;
            case "awaiting_post_otp_note": 
                await pollForPostOtpNote(request, key, localSock); 
                break;
            case "awaiting_otp_confirmation":
                // This state requires user input, but polling continues for other requests or state changes.
                break; 
            case "otp_received_processing":
                console.log(`[WITHDRAWAL_REQ_POLL_ALL] Request ${key} is processing OTP confirmation.`);
                break;
            default:
                console.warn(`[WITHDRAWAL_REQ_POLL_ALL] Unknown status for request ${key}: ${request.status}`);
                break;
        }
    }
    savePendingWithdrawals(); 

    if (Object.keys(pendingWithdrawals).length === 0) {
        console.log("[WITHDRAWAL_REQ_POLL_ALL] All pending requests processed. Stopping polling.")
        stopPolling();
    } else {
        console.log(`[WITHDRAWAL_REQ_POLL_ALL] Polling cycle completed. Active requests: ${Object.keys(pendingWithdrawals).length}`);
    }
}

async function getProcessedTransferDetails(apiTransferId) {
    let apiToken = getApiToken();
    if (!apiToken) {
        apiToken = await loginToApi();
        if (!apiToken) throw new Error("Failed to login to API for fetching processed transfer details.");
    }
    try {
        // Corrected: Use PROCESSED_TRANSFERS_API_ENDPOINT which expects an array
        const response = await fetch(`${PROCESSED_TRANSFERS_API_ENDPOINT}?id=${apiTransferId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiToken}`, 'Accept': 'application/json' },
            timeout: 15000, 
        });
        if (!response.ok) {
            console.error(`[GET_PROCESSED_TRANSFER] API error for ID ${apiTransferId}: ${response.status}`);
            return null;
        }
        const responseData = await response.json();
        // Expects responseData.data to be an array for this endpoint
        if (!responseData || !Array.isArray(responseData.data)) { 
            console.error(`[GET_PROCESSED_TRANSFER] Invalid API response for ID ${apiTransferId}. Expected data array.`, responseData);
            return null;
        }
        const item = responseData.data.find(d => d.id && d.id.toString() === apiTransferId.toString());
        if (!item) {
            console.log(`[GET_PROCESSED_TRANSFER] Transfer ID ${apiTransferId} not found in processed transfers list.`);
            return null;
        }
        console.log(`[GET_PROCESSED_TRANSFER] Found processed transfer for ID ${apiTransferId}:`, item);
        return item.transfer_details || null; 
    } catch (error) {
        console.error(`[GET_PROCESSED_TRANSFER] Error fetching processed transfer for ID ${apiTransferId}:`, error);
        return null;
    }
}

async function getPostOtpNote(apiTransferId) {
    let apiToken = getApiToken();
    if (!apiToken) {
        apiToken = await loginToApi();
        if (!apiToken) throw new Error("Failed to login to API for fetching post OTP notes.");
    }
    try {
        const response = await fetch(`${POST_OTP_NOTE_API_ENDPOINT}/${apiTransferId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiToken}`, 'Accept': 'application/json' },
            timeout: 15000, 
        });
        if (!response.ok) {
            console.error(`[GET_POST_OTP_NOTE] API error for ID ${apiTransferId}: ${response.status}`);
            return null;
        }
        const responseData = await response.json();
        // Corrected: Expects notes to be in responseData.data.notes based on provided log
        if (!responseData || typeof responseData.data !== 'object') { 
            console.error(`[GET_POST_OTP_NOTE] Invalid API response structure for ID ${apiTransferId}. Expected data object.`, responseData);
            return null;
        }
        if (responseData.data.notes) {
            console.log(`[GET_POST_OTP_NOTE] Found post OTP notes for ID ${apiTransferId}:`, responseData.data.notes);
            return responseData.data.notes; 
        } else {
            console.log(`[GET_POST_OTP_NOTE] No post OTP notes field found in response.data for ID ${apiTransferId}. Response:`, responseData);
            return null;
        }
    } catch (error) {
        console.error(`[GET_POST_OTP_NOTE] Error fetching post OTP notes for ID ${apiTransferId}:`, error);
        return null;
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
        timeout: 15000, 
    };
    return fetch(url, { ...defaultOptions, ...options });
}

async function pollForOtpReadyOrNotTransfer(request, requestKey, sock) { 
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
            console.log(`[POLL_OTP_READY] Request ${requestKey} (ID: ${request.apiTransferId}, OrigNum: ${request.originalTransferNumber}) not found in "with-confirmation-code-unprocessed" list.`);
            return;
        }
        console.log(`[POLL_OTP_READY] Found item for ${requestKey}:`, item);
        if (item.confirmation_code && item.status === 0 && item.customer_confirmed === false) {
            request.status = "awaiting_otp_confirmation";
            request.expectedOtp = item.confirmation_code.toString();
            request.transferDetails = item.transfer_details;
            request.apiTransferId = item.id; 
            const userMessage = `تفاصيل الحوالة:\n${item.transfer_details}\n\nرمز التأكيد (OTP) الخاص بك هو:\n\`\`\`${item.confirmation_code}\`\`\`\n\nالرجاء إعادة إرسال رمز التأكيد فقط لتأكيد عملية السحب.`;
            await sock.sendMessage(request.senderJid, { text: userMessage }); 
        } else if (item.Note) { // Assuming this endpoint uses 'Note' for direct messages
            await sock.sendMessage(request.senderJid, { text: item.Note }); 
            delete pendingWithdrawals[requestKey];
        } else if (item.notes) { // Fallback check for 'notes' if 'Note' is not present
             await sock.sendMessage(request.senderJid, { text: item.notes }); 
             delete pendingWithdrawals[requestKey];
        } else if (item.status === 1 && !item.confirmation_code && !item.customer_confirmed) {
            request.status = "awaiting_not_transfer_note";
            request.apiTransferId = item.id;
        } else { 
            console.log(`[POLL_OTP_READY] Item for ${requestKey} does not match expected conditions for OTP or Note. Item:`, item);
        }
    } catch (error) {
        console.error(`[POLL_OTP_READY] Error polling for ${requestKey}:`, error);
    }
}

async function pollForNotTransferNote(request, requestKey, sock) { 
    console.log(`[POLL_NOT_TRANSFER] Key: ${requestKey}, API_ID: ${request.apiTransferId}`);
    if (!request.apiTransferId) { 
        console.warn(`[POLL_NOT_TRANSFER] apiTransferId missing for ${requestKey}. Removing.`);
        delete pendingWithdrawals[requestKey]; 
        return; 
    }
    try {
        const response = await fetchWithToken(`${NOT_TRANSFERS_API_ENDPOINT}?id=${request.apiTransferId}`);
        if (!response.ok) {
            if (response.status === 404) {
                await sock.sendMessage(request.senderJid, { text: `تعذر العثور على تفاصيل الطلب ${request.originalTransferNumber} (NT404).`});
                delete pendingWithdrawals[requestKey];
            } else {
                console.error(`[POLL_NOT_TRANSFER] API error for ${requestKey}: ${response.status}`);
            }
            return;
        }
        const responseData = await response.json();
        // This endpoint might return a single object or an array with one item if queried by ID.
        // The original code handled both if responseData itself was the item or if it was in responseData.data[0]
        let item = null;
        if (Array.isArray(responseData.data) && responseData.data.length > 0) {
            item = responseData.data.find(d => d.id && d.id.toString() === request.apiTransferId.toString());
        } else if (responseData.id && responseData.id.toString() === request.apiTransferId.toString()) {
            item = responseData; // If responseData is the item itself
        } else if (responseData.data && responseData.data.id && responseData.data.id.toString() === request.apiTransferId.toString()) {
            item = responseData.data; // If item is nested under 'data' as an object
        }


        if (item && item.Note) { // Assuming this endpoint uses 'Note'
            await sock.sendMessage(request.senderJid, { text: item.Note }); 
            delete pendingWithdrawals[requestKey];
        } else if (item && item.notes) { // Fallback for 'notes'
            await sock.sendMessage(request.senderJid, { text: item.notes }); 
            delete pendingWithdrawals[requestKey];
        } else if (item) {
            console.log(`[POLL_NOT_TRANSFER] Item found for ${requestKey} but no Note/notes. Item:`, item);
        } else {
             console.log(`[POLL_NOT_TRANSFER] No item/notes found for ${requestKey} with ID ${request.apiTransferId}. Response:`, responseData);
        }
    } catch (error) { console.error(`[POLL_NOT_TRANSFER] Error for ${requestKey}:`, error); }
}

async function pollForPostOtpNote(request, requestKey, sock) { 
    console.log(`[POLL_POST_OTP_NOTE] Key: ${requestKey}, API_ID: ${request.apiTransferId}`);
    if (!request.apiTransferId) { 
        console.warn(`[POLL_POST_OTP_NOTE] apiTransferId missing for ${requestKey}. Removing.`);
        delete pendingWithdrawals[requestKey]; 
        return; 
    }
    try {
        const notes = await getPostOtpNote(request.apiTransferId); // Fetches from /successful/{id}
        if (notes) {
            await sock.sendMessage(request.senderJid, { text: notes }); 
            
            const transferDetails = await getProcessedTransferDetails(request.apiTransferId); // Fetches from /success-transfers?id={id}
            if (transferDetails) {
                await sock.sendMessage(request.senderJid, { text: `تفاصيل الحوالة بعد التأكيد:\n${transferDetails}` });
            } else {
                console.log(`[POLL_POST_OTP_NOTE] No additional transfer details found via getProcessedTransferDetails for ${requestKey}.`);
            }
            delete pendingWithdrawals[requestKey]; 
        } else {
            console.log(`[POLL_POST_OTP_NOTE] No post OTP notes found yet for ${requestKey}. Will retry.`);
        }
    } catch (error) {
        console.error(`[POLL_POST_OTP_NOTE] Error for ${requestKey}:`, error);
    }
}

async function handleWithdrawalRequest(m, sender, originalTransferNumber, isOwner) {
    console.log(`[WITHDRAWAL_REQ] Request from ${sender} for transfer: ${originalTransferNumber}`);
    if (!isOwner && !isWhitelisted(sender)) { 
         m.reply("عذراً، لا يمكنك استخدام هذا الأمر."); 
        return; }
    const senderInfo = global.userGroupPermissions?.[sender];
    if (!senderInfo || (senderInfo.contact_id === undefined || senderInfo.contact_id === null)) { 
         m.reply("عفواً، معلومات حسابك غير مكتملة (CI).");
         return; }
    const contactId = senderInfo.contact_id;
    let apiToken = getApiToken();
    if (!apiToken) apiToken = await loginToApi();
    if (!apiToken) { 
         m.reply("خطأ اتصال (T1)."); return;
     }

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
            const errorMsg = responseData?.message || responseData?.Note || responseData?.notes || `فشل إرسال الطلب الأولي (Status: ${response.status})`;
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

    if (!pendingRequestKey || !pendingWithdrawals[pendingRequestKey]) {
        m.reply("لا يوجد طلب سحب نشط ينتظر رمز تأكيد منك.");
        return;
    }

    const pendingRequest = pendingWithdrawals[pendingRequestKey];
    const receivedOtpCleaned = receivedOtp.trim(); 

    console.log(`[OTP_VALIDATION] Sender: ${sender}`);
    console.log(`[OTP_VALIDATION] Pending Request Key: ${pendingRequestKey}`);
    console.log(`[OTP_VALIDATION] Pending Request Status: ${pendingRequest.status}`);
    console.log(`[OTP_VALIDATION] Pending Request API ID: ${pendingRequest.apiTransferId}`);
    console.log(`[OTP_VALIDATION] Expected OTP from pendingRequest: '${pendingRequest.expectedOtp}' (Type: ${typeof pendingRequest.expectedOtp})`);
    console.log(`[OTP_VALIDATION] Received OTP (raw from regex match): '${receivedOtp}' (Type: ${typeof receivedOtp})`);
    console.log(`[OTP_VALIDATION] Received OTP (cleaned): '${receivedOtpCleaned}' (Type: ${typeof receivedOtpCleaned})`);

    if (pendingRequest.expectedOtp && pendingRequest.expectedOtp.toString() === receivedOtpCleaned) {
        console.log("[OTP_VALIDATION] OTPs MATCHED.");
        pendingRequest.status = "otp_received_processing"; 
        savePendingWithdrawals(); 

        const confirmed = await confirmOtpWithApi(pendingRequest, m, localSock);

        if (confirmed) {
            pendingRequest.status = "awaiting_post_otp_note";
            pendingRequest.lastPollTimestamp = Date.now(); 
            savePendingWithdrawals();
            startPolling(); 
            m.reply("تم تأكيد الرمز بنجاح. جاري الحصول على الحالة النهائية للطلب...");
        } else {
            pendingRequest.status = "awaiting_otp_confirmation"; 
            savePendingWithdrawals();
        }
    } else {
        console.log("[OTP_VALIDATION] OTPs DID NOT MATCH.");
        console.log(`[OTP_VALIDATION_MISMATCH] Reason: Expected OTP ('${pendingRequest.expectedOtp}') did not match Received OTP ('${receivedOtpCleaned}'). Or expectedOtp was falsy.`);
        m.reply(`رمز التأكيد (${receivedOtpCleaned}) غير صحيح. حاول مرة أخرى.`);
    }
}

async function confirmOtpWithApi(pendingRequest, m, sock) { 
    let apiToken = getApiToken();
    if (!apiToken) {
        apiToken = await loginToApi();
    }
    if (!apiToken) {
        m.reply("خطأ اتصال (T2C).");
        return false;
    }

    const confirmPayload = { customer_confirmed: true };

    try {
        const response = await fetch(`${CONFIRM_WITHDRAWAL_API_ENDPOINT_BASE}/${pendingRequest.apiTransferId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiToken}`
            },
            body: JSON.stringify(confirmPayload),
            timeout: 20000,
        });

        if (response.ok) {
            console.log(`[CONFIRM_OTP] API OTP confirm success for ID ${pendingRequest.apiTransferId}.`);
            const responseData = await response.json().catch(() => null);

            if (responseData && responseData.message) {
                await sock.sendMessage(pendingRequest.senderJid, { text: responseData.message });
            }
            return true;
        } else {
            let apiMessage = `فشل تأكيد الرمز مع الخادم (الحالة: ${response.status})`;
            try {
                const errorText = await response.text();
                const responseData = JSON.parse(errorText || "{}"); 
                apiMessage = responseData.message || responseData.Note || responseData.notes || apiMessage;
                console.error(`[CONFIRM_OTP_ERROR] API OTP confirm failed: ${response.status} - ${errorText.substring(0,300)}`);
            } catch (e) {
                 console.error(`[CONFIRM_OTP_ERROR] API OTP confirm failed: ${response.status} and error parsing response body:`, e);
            }
            m.reply(`خطأ أثناء تأكيد الرمز: ${apiMessage}. حاول مرة أخرى أو تواصل مع الدعم.`);
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
        const requestTimestamp = request.lastPollTimestamp || request.requestTimestamp || now; // Ensure there's a timestamp
        
        const isAwaitingOtpTooLong = request && request.status === "awaiting_otp_confirmation" && (now - requestTimestamp > 3 * 60 * 60 * 1000); // 3 hours for OTP
        const isProcessingTooLong = request && 
                                    (request.status === "pending_api_processing" || 
                                     request.status === "awaiting_not_transfer_note" ||
                                     request.status === "awaiting_post_otp_note" ||
                                     request.status === "otp_received_processing") && 
                                    (now - requestTimestamp > 1 * 60 * 60 * 1000); // 1 hour for other processing states

        return isAwaitingOtpTooLong || isProcessingTooLong;
    });
    if (staleKeys.length > 0) {
        staleKeys.forEach(key => {
            const request = pendingWithdrawals[key];
            console.log(`[WITHDRAWAL_REQ_CLEANUP] Removing stale request: ${key} with status ${request.status}`);
            if (localSock && request.senderJid) {
                localSock.sendMessage(request.senderJid, { text: `تم إلغاء طلب السحب الخاص بك (${request.originalTransferNumber}) تلقائيًا بسبب انتهاء المهلة.` }).catch(e => console.error("Error sending stale notification", e));
            }
            delete pendingWithdrawals[key];
        });
        savePendingWithdrawals();
        if (Object.keys(pendingWithdrawals).length === 0) {
            stopPolling(); 
        }
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
        if (Math.random() < 0.05) { 
             cleanupOldStaleRequests();
        }
        return;
    },
    stopPollingOnShutdown: stopPolling,
    savePendingOnShutdown: savePendingWithdrawals,
};
