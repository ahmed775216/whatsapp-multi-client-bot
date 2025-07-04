// File: client-instance/lib/receiptState.js

const fs = require('fs');
const path = require('path');
const process = require('process');

// Use the DATA_DIR environment variable set by clientBotApp.js
const PENDING_RECEIPTS_FILE = path.join(process.env.DATA_DIR || 'data', 'pending_receipts.json');
const RECEIPT_TIMEOUT_MS = 1 * 60 * 1000; // 1 minute timeout

// Initialize global state for pending receipts
if (!global.pendingReceipts) {
    global.pendingReceipts = {};
}

function ensureDataDirExists() {
    const dataDir = path.dirname(PENDING_RECEIPTS_FILE);
    if (!fs.existsSync(dataDir)) {
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            return true;
        } catch (e) {
            console.error(`[RECEIPT_STATE_ERROR] Failed to create data directory ${dataDir}:`, e.message);
            return false;
        }
    }
    return true;
}

function loadPendingReceipts() {
    if (!ensureDataDirExists() || !fs.existsSync(PENDING_RECEIPTS_FILE)) {
        return {};
    }
    try {
        const data = fs.readFileSync(PENDING_RECEIPTS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const now = Date.now();
        const cleanedData = {};
        for (const [key, entry] of Object.entries(parsed)) {
            // Check if the entry has a timestamp and is not expired
            if (entry.timestamp && (now - entry.timestamp < RECEIPT_TIMEOUT_MS)) {
                cleanedData[key] = entry;
            }
        }
        console.log(`[RECEIPT_STATE] Loaded ${Object.keys(cleanedData).length} valid pending receipts.`);
        return cleanedData;
    } catch (error) {
        console.error(`[RECEIPT_STATE_ERROR] Failed to load pending receipts:`, error.message);
        return {};
    }
}

function savePendingReceipts() {
    if (!ensureDataDirExists()) return false;
    try {
        fs.writeFileSync(PENDING_RECEIPTS_FILE, JSON.stringify(global.pendingReceipts, null, 2));
        return true;
    } catch (error) {
        console.error(`[RECEIPT_STATE_ERROR] Failed to save pending receipts:`, error.message);
        return false;
    }
}

function addPendingReceipt(senderJid, amount) {
    global.pendingReceipts[senderJid] = { amount, timestamp: Date.now() };
    savePendingReceipts();
}

function getPendingReceipt(senderJid) {
    const pending = global.pendingReceipts[senderJid];
    if (pending && (Date.now() - pending.timestamp) > RECEIPT_TIMEOUT_MS) {
        clearPendingReceipt(senderJid);
        return null; // The request has expired
    }
    return pending;
}

function clearPendingReceipt(senderJid) {
    if (global.pendingReceipts[senderJid]) {
        delete global.pendingReceipts[senderJid];
        savePendingReceipts();
    }
}

// Load state from file when the module first loads
global.pendingReceipts = loadPendingReceipts();

module.exports = {
    addPendingReceipt,
    getPendingReceipt,
    clearPendingReceipt
};