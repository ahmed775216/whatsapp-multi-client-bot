// client-instance/plugins/withdrawalRequests.js
const fetch = require('node-fetch');
const { getApiToken, syncWhitelistFromApi, loginToApi } = require('../lib/apiSync');
const { isWhitelisted } = require('./whitelist');
const config = require('../../config');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const DATA_BASE_DIR = process.env.DATA_DIR;
const PENDING_WITHDRAWALS_FILE = path.join(DATA_BASE_DIR, 'pending_withdrawals.json');
const WITHDRAWAL_API_PATH = '/withdrawal-requests';
const INITIAL_WITHDRAWAL_API_ENDPOINT = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}`;
const POLLING_API_ENDPOINT = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}/with-confirmation-code-unprocessed`;
const CONFIRM_WITHDRAWAL_API_ENDPOINT_BASE = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}`;

// --- State Management ---
let localSock = null;
let pendingWithdrawals = loadPendingWithdrawals();
let pollingIntervalId = null;
const POLLING_INTERVAL_MS = 30000; // 30 seconds
const MAX_OTP_ATTEMPTS = 3;
const OTP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// --- File Operations ---
function savePendingWithdrawals() {
    if (!DATA_BASE_DIR) {
        console.error("[WITHDRAWAL_REQ_SAVE_ERROR] DATA_DIR is not set. Cannot save pending withdrawals.");
        return false;
    }
    
    try {
        // Ensure directory exists
        if (!fs.existsSync(DATA_BASE_DIR)) {
            fs.mkdirSync(DATA_BASE_DIR, { recursive: true });
        }
        
        fs.writeFileSync(PENDING_WITHDRAWALS_FILE, JSON.stringify(pendingWithdrawals, null, 2));
        console.log(`[WITHDRAWAL_REQ_SAVE] Successfully saved ${Object.keys(pendingWithdrawals).length} pending withdrawal requests.`);
        return true;
    } catch (error) {
        console.error('[WITHDRAWAL_REQ_SAVE_ERROR] Error saving pending_withdrawals.json:', error);
        return false;
    }
}

function loadPendingWithdrawals() {
    if (!DATA_BASE_DIR) {
        console.error("[WITHDRAWAL_REQ_LOAD_ERROR] DATA_DIR is not set. Cannot load pending withdrawals.");
        return {};
    }
    
    if (fs.existsSync(PENDING_WITHDRAWALS_FILE)) {
        try {
            const data = fs.readFileSync(PENDING_WITHDRAWALS_FILE, 'utf8');
            const parsedData = JSON.parse(data);
            
            // Clean up expired requests
            const now = Date.now();
            const cleanedData = {};
            let expiredCount = 0;
            
            for (const [key, request] of Object.entries(parsedData)) {
                if (now - request.requestTimestamp < OTP_TIMEOUT_MS) {
                    cleanedData[key] = request;
                } else {
                    expiredCount++;
                }
            }
            
            if (expiredCount > 0) {
                console.log(`[WITHDRAWAL_REQ_LOAD] Cleaned up ${expiredCount} expired requests.`);
            }
            
            console.log(`[WITHDRAWAL_REQ_LOAD] Loaded ${Object.keys(cleanedData).length} pending withdrawal requests.`);
            return cleanedData;
        } catch (error) {
            console.error('[WITHDRAWAL_REQ_LOAD_ERROR] Error reading or parsing pending_withdrawals.json:', error);
            return {};
        }
    }
    
    return {};
}

// --- Initialization ---
function init(sockInstance) {
    localSock = sockInstance;
    console.log('[WITHDRAWAL_REQ_INIT] WithdrawalRequests plugin initialized with sock.');
    
    // Start polling if there are pending requests from previous runs
    if (Object.values(pendingWithdrawals).some(req => req.status === "pending_api_processing")) {
        console.log('[WITHDRAWAL_REQ_INIT] Found pending_api_processing requests on startup. Starting polling.');
        startPolling();
    }
}

// --- Polling Management ---
function startPolling() {
    if (pollingIntervalId) {
        return; // Already polling
    }
    
    if (!localSock) {
        console.warn('[WITHDRAWAL_REQ_POLL] Cannot start polling: localSock not initialized yet.');
        return;
    }
    
    console.log(`[WITHDRAWAL_REQ_POLL] Starting polling every ${POLLING_INTERVAL_MS / 1000} seconds.`);
    pollingIntervalId = setInterval(pollForUnprocessedWithdrawals, POLLING_INTERVAL_MS);
    
    // Initial poll
    pollForUnprocessedWithdrawals();
}

function stopPolling() {
    if (pollingIntervalId) {
        console.log('[WITHDRAWAL_REQ_POLL] Stopping polling.');
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
    }
}

// --- API Polling ---
async function pollForUnprocessedWithdrawals() {
    console.log('[WITHDRAWAL_REQ_POLL] Polling for unprocessed withdrawals with confirmation codes...');
    
    const apiToken = getApiToken();
    if (!apiToken) {
        console.error('[WITHDRAWAL_REQ_POLL_ERROR] No API token for polling.');
        try {
            await loginToApi();
        } catch (error) {
            console.error('[WITHDRAWAL_REQ_POLL_ERROR] Failed to re-login:', error);
        }
        return;
    }

    try {
        const response = await fetch(POLLING_API_ENDPOINT, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Accept': 'application/json',
            },
            timeout: 10000, // 10 second timeout
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[WITHDRAWAL_REQ_POLL_ERROR] Failed to fetch unprocessed withdrawals: ${response.status} - ${errorText.substring(0, 200)}`);
            
            if (response.status === 401 || response.status === 403) {
                console.warn('[WITHDRAWAL_REQ_POLL_ERROR] API Token might be invalid. Attempting re-login.');
                try {
                    await loginToApi();
                } catch (error) {
                    console.error('[WITHDRAWAL_REQ_POLL_ERROR] Re-login failed:', error);
                }
            }
            return;
        }

        const responseData = await response.json();
        
        if (!responseData || typeof responseData !== 'object' || !Array.isArray(responseData.data)) {
            console.error('[WITHDRAWAL_REQ_POLL_ERROR] API response for unprocessed withdrawals is missing "data" array:', JSON.stringify(responseData).substring(0, 500));
            return;
        }

        const unprocessedList = responseData.data;
        console.log(`[WITHDRAWAL_REQ_POLL] Received ${unprocessedList.length} items from unprocessed list.`);

        for (const item of unprocessedList) {
            await processUnprocessedItem(item);
        }
        
    } catch (error) {
        console.error('[WITHDRAWAL_REQ_POLL_ERROR] Error during polling:', error);
    }
    
    // Stop polling if no more pending requests
    if (Object.values(pendingWithdrawals).every(req => req.status !== "pending_api_processing")) {
        stopPolling();
    }
}

async function processUnprocessedItem(item) {
    // Check if item meets criteria for OTP sending
    if (!item.confirmation_code || item.status !== 0 || item.customer_confirmed !== false || !item.contact_id) {
        return;
    }
    
    // Check for "transfer not found" in transfer_details
    if (item.transfer_details && item.transfer_details.includes('لا توجد حوالة بهذا الرقم')) {
        console.log(`[WITHDRAWAL_REQ_POLL] Transfer not found for item ID ${item.id}, original_transfer_number ${item.original_transfer_number}.`);
        
        // Find and notify user about the issue
        const pendingRequestKey = findPendingRequestKey(item.contact_id, item.original_transfer_number, "pending_api_processing");
        if (pendingRequestKey) {
            const matchedRequest = pendingWithdrawals[pendingRequestKey];
            await sendMessage(matchedRequest.senderJid, "عذراً، لم يتم العثور على حوالة بالرقم المرجعي المطلوب. يرجى التحقق من الرقم والمحاولة مرة أخرى.");
            delete pendingWithdrawals[pendingRequestKey];
            savePendingWithdrawals();
        }
        return;
    }
    
    // Find matching pending request
    const pendingRequestKey = findPendingRequestKey(item.contact_id, item.original_transfer_number, "pending_api_processing");
    
    if (pendingRequestKey && pendingWithdrawals[pendingRequestKey]) {
        const matchedRequest = pendingWithdrawals[pendingRequestKey];
        console.log(`[WITHDRAWAL_REQ_POLL] Found matching pending request for API item ID ${item.id}, original_transfer_number ${item.original_transfer_number}.`);

        // Update request status
        matchedRequest.status = "awaiting_otp_confirmation";
        matchedRequest.apiTransferId = item.id;
        matchedRequest.expectedOtp = item.confirmation_code;
        matchedRequest.otpAttempts = 0;

        // Send OTP and details to user
        const userMessage = `تفاصيل الحوالة:\n${item.transfer_details}\n\nرمز التأكيد (OTP):\n\`\`\`${item.confirmation_code}\`\`\`\n\nالرجاء إعادة إرسال رمز التأكيد فقط لتأكيد عملية السحب.\n\n⚠️ انتباه: لديك ${MAX_OTP_ATTEMPTS} محاولات فقط لإدخال الرمز بشكل صحيح.`;

        await sendMessage(matchedRequest.senderJid, userMessage);
        console.log(`[WITHDRAWAL_REQ_POLL] OTP and details sent to ${matchedRequest.senderJid} for transfer ID ${item.id}.`);
        
        savePendingWithdrawals();
    }
}

function findPendingRequestKey(contactId, originalTransferNumber, status) {
    return Object.keys(pendingWithdrawals).find(key => {
        const req = pendingWithdrawals[key];
        return req.contactId === contactId && 
               req.originalTransferNumber === originalTransferNumber && 
               req.status === status;
    });
}

async function sendMessage(jid, message) {
    if (!localSock) {
        console.error(`[WITHDRAWAL_REQ_ERROR] localSock is not available to send message to ${jid}.`);
        return false;
    }
    
    try {
        await localSock.sendMessage(jid, { text: message });
        return true;
    } catch (error) {
        console.error(`[WITHDRAWAL_REQ_ERROR] Failed to send message to ${jid}:`, error);
        return false;
    }
}

// --- Message Handlers ---
async function handleWithdrawalRequest(m, sender, originalTransferNumber, isOwner) {
    console.log(`[WITHDRAWAL_REQ] Detected withdrawal request command from ${sender}.`);

    // Authorization check
    if (!isOwner && !isWhitelisted(sender)) {
        m.reply("عذراً، لا يمكنك استخدام هذا الأمر. يرجى التواصل مع المسؤول.");
        return;
    }

    // Sync whitelist and get user info
    await syncWhitelistFromApi();
    const senderInfo = global.userGroupPermissions?.[sender];

    if (!senderInfo || (senderInfo.contact_id === undefined || senderInfo.contact_id === null)) {
        m.reply("عذراً، لم أتمكن من العثور على معلومات حسابك (CI). يرجى التأكد من بياناتك في النظام.");
        return;
    }

    const contactId = senderInfo.contact_id;
    const apiToken = getApiToken();
    
    if (!apiToken) {
        m.reply("عذراً، لا يمكنني معالجة طلبك الآن بسبب مشكلة فنية (T). يرجى المحاولة لاحقاً.");
        return;
    }

    // Check for existing pending request
    const existingRequestKey = `${sender}_${originalTransferNumber}`;
    if (pendingWithdrawals[existingRequestKey]) {
        m.reply("لديك طلب سحب نشط بالفعل لهذا الرقم المرجعي. يرجى انتظار المعالجة أو إلغاء الطلب الحالي.");
        return;
    }

    const payload = {
        contact_id: contactId,
        customer_request: "سحب",
        original_transfer_number: originalTransferNumber,
    };

    try {
        const response = await fetch(INITIAL_WITHDRAWAL_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiToken}`
            },
            body: JSON.stringify(payload),
            timeout: 10000,
        });

        if (response.ok) {
            console.log(`[WITHDRAWAL_REQ] Initial withdrawal request for ${originalTransferNumber} sent to API successfully.`);
            m.reply(`تم استلام طلب السحب الخاص بك بالرقم المرجعي ${originalTransferNumber}. سيتم إعلامك عند جاهزية رمز التأكيد.`);

            // Store pending request
            pendingWithdrawals[existingRequestKey] = {
                senderJid: sender,
                originalTransferNumber: originalTransferNumber,
                contactId: contactId,
                status: "pending_api_processing",
                apiTransferId: null,
                expectedOtp: null,
                otpAttempts: 0,
                requestTimestamp: Date.now(),
            };
            
            savePendingWithdrawals();
            startPolling();
            
        } else if (response.status === 422) {
            const errorText = await response.text();
            console.log(`[WITHDRAWAL_REQ] Duplicate transfer number detected: ${originalTransferNumber}`);
            
            if (errorText.includes('مستخدمة بالفعل')) {
                m.reply(`الرقم المرجعي ${originalTransferNumber} مستخدم بالفعل. يرجى استخدام رقم مرجعي آخر.`);
            } else {
                m.reply("الرقم المرجعي المدخل غير صالح أو مستخدم بالفعل. يرجى التحقق والمحاولة مرة أخرى.");
            }
        } else {
            const errorText = await response.text();
            console.error(`[WITHDRAWAL_REQ_ERROR] Failed to send initial withdrawal request: ${response.status} - ${errorText}`);
            m.reply("عذراً، حدث خطأ أثناء إرسال طلب السحب الأولي. يرجى المحاولة مرة أخرى.");
        }
    } catch (error) {
        console.error(`[WITHDRAWAL_REQ_ERROR] Error sending initial withdrawal request:`, error);
        m.reply("عذراً، حدث خطأ غير متوقع أثناء إرسال طلب السحب الأولي.");
    }
}

async function handleOtpConfirmation(m, sender, receivedOtp) {
    console.log(`[WITHDRAWAL_REQ] Received OTP: ${receivedOtp} from ${sender}.`);

    // Find pending request awaiting OTP
    const pendingRequestKey = Object.keys(pendingWithdrawals).find(key => {
        const req = pendingWithdrawals[key];
        return req.senderJid === sender && req.status === "awaiting_otp_confirmation";
    });

    if (!pendingRequestKey || !pendingWithdrawals[pendingRequestKey]) {
        m.reply("لم يتم العثور على طلب سحب نشط ينتظر رمز تأكيد منك. قد يكون الطلب انتهت صلاحيته أو تم إدخال الرمز مسبقاً.");
        return;
    }

    const pendingRequest = pendingWithdrawals[pendingRequestKey];

    // Check if request has expired
    if (Date.now() - pendingRequest.requestTimestamp > OTP_TIMEOUT_MS) {
        m.reply("انتهت صلاحية طلب السحب. يرجى تقديم طلب جديد.");
        delete pendingWithdrawals[pendingRequestKey];
        savePendingWithdrawals();
        return;
    }

    // Increment attempt counter
    pendingRequest.otpAttempts = (pendingRequest.otpAttempts || 0) + 1;

    if (pendingRequest.expectedOtp === receivedOtp) {
        console.log(`[WITHDRAWAL_REQ] OTP correct for sender ${sender}, transfer ID ${pendingRequest.apiTransferId}. Confirming with API.`);
        pendingRequest.status = "otp_received_processing";

        const success = await confirmWithdrawalWithApi(pendingRequest, m);
        if (success) {
            delete pendingWithdrawals[pendingRequestKey];
        } else {
            pendingRequest.status = "awaiting_otp_confirmation";
        }
    } else {
        const remainingAttempts = MAX_OTP_ATTEMPTS - pendingRequest.otpAttempts;
        
        if (remainingAttempts > 0) {
            m.reply(`رمز التأكيد الذي أدخلته غير صحيح. لديك ${remainingAttempts} محاولة متبقية.`);
        } else {
            m.reply("تم استنفاد عدد المحاولات المسموحة. تم إلغاء طلب السحب. يرجى تقديم طلب جديد.");
            delete pendingWithdrawals[pendingRequestKey];
        }
    }
    
    savePendingWithdrawals();
}

async function confirmWithdrawalWithApi(pendingRequest, m) {
    const apiToken = getApiToken();
    if (!apiToken) {
        m.reply("عذراً، لا يمكنني تأكيد طلبك الآن بسبب مشكلة فنية (T2). يرجى المحاولة لاحقاً.");
        return false;
    }

    const confirmPayload = {
        customer_confirmed: true,
    };

    try {
        const confirmResponse = await fetch(`${CONFIRM_WITHDRAWAL_API_ENDPOINT_BASE}/${pendingRequest.apiTransferId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiToken}`,
            },
            body: JSON.stringify(confirmPayload),
            timeout: 10000,
        });

        if (confirmResponse.ok) {
            const responseData = await confirmResponse.json();
            console.log(`[WITHDRAWAL_REQ] Successfully confirmed withdrawal with API for transfer ID ${pendingRequest.apiTransferId}.`);
            console.log(`[WITHDRAWAL_REQ] API Response:`, JSON.stringify(responseData));
            
            // Extract and send the Note from API response to the client
            let finalMessage = "تم تأكيد عملية السحب بنجاح."; // Default fallback message
            
            if (responseData && responseData.Note) {
                finalMessage = responseData.Note;
                console.log(`[WITHDRAWAL_REQ] Sending API Note to client: ${responseData.Note}`);
            } else if (responseData && responseData.message) {
                finalMessage = responseData.message;
                console.log(`[WITHDRAWAL_REQ] Sending API message to client: ${responseData.message}`);
            } else {
                console.log(`[WITHDRAWAL_REQ] No Note or message field found in API response, using default message.`);
            }
            
            // Send the final message (Note from API) to the WhatsApp client
            m.reply(finalMessage);
            
            return true;
        } else {
            const errorText = await confirmResponse.text();
            console.error(`[WITHDRAWAL_REQ_ERROR] Failed to confirm withdrawal with API: ${confirmResponse.status} - ${errorText}`);
            m.reply("عذراً، حدث خطأ أثناء تأكيد السحب مع النظام. يرجى المحاولة لاحقاً أو التواصل مع الدعم.");
            return false;
        }
    } catch (error) {
        console.error(`[WITHDRAWAL_REQ_ERROR] Error confirming withdrawal with API:`, error);
        m.reply("عذراً، حدث خطأ غير متوقع أثناء تأكيد السحب.");
        return false;
    }
}

// --- Cleanup Functions ---
function cleanupExpiredRequests() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [key, request] of Object.entries(pendingWithdrawals)) {
        if (now - request.requestTimestamp > OTP_TIMEOUT_MS) {
            delete pendingWithdrawals[key];
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`[WITHDRAWAL_REQ_CLEANUP] Cleaned up ${cleanedCount} expired requests.`);
        savePendingWithdrawals();
    }
}

// --- Main Export ---
module.exports = {
    init,
    
    all: async function (m, { sock, chatId, sender, isGroup, text, isOwner }) {
        const cleanedText = text.trim();
        const withdrawalRegex = /^سحب\s*[\r\n]+\s*([\w\d]+)\s*$/m;
        const otpRegex = /^\d{4,}$/;

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

        // Clean up expired requests periodically
        if (Math.random() < 0.1) { // 10% chance on each message
            cleanupExpiredRequests();
        }

        return; // Not a withdrawal or OTP message
    },
    
    // Shutdown handlers
    stopPollingOnShutdown: stopPolling,
    savePendingOnShutdown: savePendingWithdrawals,
    
    // Utility functions for external use
    getPendingWithdrawalsCount: () => Object.keys(pendingWithdrawals).length,
    clearExpiredRequests: cleanupExpiredRequests,
};