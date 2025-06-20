// client-instance/clientBotApp.js
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path'); // Ensure path is required correctly
const fs = require('fs');
const WebSocket = require('ws');
const { upsertBotContact, getClientBotInstanceId } = require('../database/botContactsDb');
let process = require('process');
const AUTH_DIR = process.env.AUTH_DIR;
const DATA_DIR = process.env.DATA_DIR;
const CLIENT_ID = process.env.CLIENT_ID;
console.log(`[CLIENT_APP_INIT_DEBUG] Instance started with CLIENT_ID from env: '${CLIENT_ID}' (Type: ${typeof CLIENT_ID})`);
const MANAGER_WS_PORT = parseInt(process.env.MANAGER_WS_PORT || '0');
// client-instance/clientBotApp.js

// ... after const MANAGER_WS_PORT = ...

let botInstanceId = null; // <-- ADD THIS
(async () => { // <-- ADD THIS IIFE WRAPPER
    try {
        botInstanceId = await getClientBotInstanceId(CLIENT_ID);
        if (!botInstanceId) {
            console.error(`[${CLIENT_ID}_FATAL] Could not retrieve botInstanceId from database on startup. Contact persistence will fail.`);
        } else {
            console.log(`[${CLIENT_ID}] Bot Instance ID for contact persistence: ${botInstanceId}`);
        }
    } catch (e) {
        console.error(`[${CLIENT_ID}_FATAL] Database error getting botInstanceId on startup: ${e.message}`);
    }
})();
if (!AUTH_DIR || !DATA_DIR || !CLIENT_ID || MANAGER_WS_PORT === 0) { // Ensure CLIENT_ID here is also checked
    console.error(`[${CLIENT_ID || 'UNKNOWN_CLIENT'}_FATAL] Missing required environment variables. AUTH_DIR=${AUTH_DIR}, DATA_DIR=${DATA_DIR}, CLIENT_ID=${CLIENT_ID}, MANAGER_WS_PORT=${MANAGER_WS_PORT}. Exiting.`);
    process.exit(1);
}

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

if (!global.pushNameCache) { // كاش لتخزين pushName مؤقتًا
    global.pushNameCache = new Map();
}

// const botContactsDb = require('../database/botContactsDb'); // Import the new module
const { findBestDisplayName } = require('./lib/contactUtils'); // Import the utility function
let clientConfig = {};
const clientConfigPath = path.join(path.dirname(AUTH_DIR), 'client_config.json');
if (fs.existsSync(clientConfigPath)) {
    try {
        clientConfig = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
    } catch (e) { console.error(`[${CLIENT_ID}] Error loading client_config.json:`, e.message); }
}

process.env.DATA_DIR_FOR_CLIENT = DATA_DIR;
process.env.AUTH_DIR_FOR_CLIENT = AUTH_DIR;
process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC = clientConfig.ownerNumber || process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC;
process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC = clientConfig.apiUsername || process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC;
process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC = clientConfig.apiPassword || process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC;

const { handleMessage } = require('./handler');
const { syncWhitelistFromApi } = require('./lib/apiSync');
const config = require('../config');

let managerWsClient = null;
let reconnectManagerWsInterval = null;
let sock = null;
async function fetchAndSaveContacts() {
    console.log(`[${CLIENT_ID}] Starting manual contact sync...`);
    if (!botInstanceId) {
        console.error(`[${CLIENT_ID}_CONTACTS_SYNC_ERROR] Bot Instance ID not available. Aborting sync.`);
        return;
    }

    try {
        const contactsMap = sock.contacts || {};
        const allSyncedUserJids = [];

        console.log(`[${CLIENT_ID}_CONTACTS_SYNC] Processing ${Object.keys(contactsMap).length} contacts from address book.`);

        for (const jid in contactsMap) {
            const contact = contactsMap[jid];
            
            if (!jid || !jid.includes('@') || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) {
                continue; // Skip invalid or group JIDs
            }

            // Use our new utility to find the best possible name for the contact.
            const displayName = findBestDisplayName({ baileysContact: contact });

            // Only process contacts that have a valid, non-generic name.
            if (displayName) {
                const userJid = jid.endsWith('@s.whatsapp.net') ? jid : null;
                const lidJid = jid.endsWith('@lid') ? jid : null;

                // For the manual sync, we ONLY care about contacts that have a real phone number JID.
                // This is because the sync is for the "address book", which contains phone numbers.
                if (userJid) {
                    allSyncedUserJids.push(userJid);

                    const contactData = {
                        userJid: userJid,
                        // If the contact object also has a lid, we can add it for merging.
                        lidJid: contact.lid || lidJid,
                        phoneNumber: userJid.split('@')[0],
                        displayName: displayName,
                        whatsappName: contact.notify || contact.pushName || null,
                        isWhatsappContact: true,
                        isSavedContact: true // <<< CRITICAL: These are "saved" contacts.
                    };

                    await upsertBotContact(botInstanceId, contactData);
                }
            }
        }

        // Mark any saved contacts that were not in this sync as inactive.
        console.log(`[${CLIENT_ID}_CONTACTS_SYNC] Finished upserting contacts. Now checking for stale contacts...`);
        await require('../database/botContactsDb').deleteStaleContactsForInstance(botInstanceId, allSyncedUserJids);

        console.log(`[${CLIENT_ID}_CONTACTS_SYNC] Manual contact sync completed.`);
    } catch (error) {
        console.error(`[${CLIENT_ID}_CONTACTS_SYNC_ERROR] An error occurred during contact sync: ${error.message}`, error.stack);
    }
}


function connectToManagerWebSocket() {
    if (reconnectManagerWsInterval) {
        clearInterval(reconnectManagerWsInterval);
        reconnectManagerWsInterval = null;
    }

    managerWsClient = new WebSocket(`ws://localhost:${MANAGER_WS_PORT}`);

    managerWsClient.onopen = () => {
        console.log(`[${CLIENT_ID}] Connected to manager WS.`);
        reportToManager('status', {
            status: 'connecting_whatsapp', // More specific initial status
            message: `Client ${CLIENT_ID} bot instance started, attempting WhatsApp connection.`,
        });
        startClientBot().catch(err => {
            console.error(`[${CLIENT_ID}] Critical Error starting client bot:`, err.message, err.stack);
            reportToManager('status', {
                status: 'error_startup', message: `Client bot ${CLIENT_ID} failed to start: ${err.message}`,
            });
            process.exit(1);
        });

    };

    managerWsClient.onmessage = async (event) => {
        try {
            const parsedMsg = JSON.parse(event.data.toString()); // Ensure it's a string
            if (parsedMsg.type === 'internalCommand' && parsedMsg.clientId === CLIENT_ID) {
                console.log(`[${CLIENT_ID}] Received internal command from manager: ${parsedMsg.command} with payload:`, { groupId: parsedMsg.groupId, participantJid: parsedMsg.participantJid });

                const internalReply = (dataForReply) => {
                    if (managerWsClient && managerWsClient.readyState === WebSocket.OPEN) {
                        managerWsClient.send(JSON.stringify({ type: 'internalReply', clientId: CLIENT_ID, data: dataForReply }));
                    } else {
                        console.warn(`[${CLIENT_ID}] Manager WS not open, cannot send internal reply for command ${parsedMsg.command}.`);
                    }
                };

                if (!sock) {
                    console.error(`[${CLIENT_ID}] Sock is not initialized. Cannot process internal command ${parsedMsg.command}.`);
                    internalReply({ type: 'error', message: 'WhatsApp connection not ready.', clientId: CLIENT_ID });
                    return;
                }

                const dummyM = { key: { remoteJid: `${CLIENT_ID}@s.whatsapp.net`, fromMe: true }, messageTimestamp: Date.now() / 1000 };

                await handleMessage(sock, dummyM, {
                    isInternalCommand: true,
                    internalReply: internalReply,
                    command: parsedMsg.command,
                    groupId: parsedMsg.groupId,
                    participantJid: parsedMsg.participantJid,
                    lid: parsedMsg.lid, // ADDED: Pass lid to handler
                    phoneJid: parsedMsg.phoneJid, // ADDED: Pass phoneJid to handler
                    clientId: CLIENT_ID,
                });
            } else if (parsedMsg.clientId === CLIENT_ID) {
                // console.log(`[${CLIENT_ID}] Manager message (type: ${parsedMsg.type}): ${event.data.toString().substring(0,150)}`); // Can be noisy
            } else if (parsedMsg.type !== 'internalCommand') { // General messages not for this client specifically
                // console.log(`[${CLIENT_ID}] Received general manager message: ${event.data.toString().substring(0,100)}`);
            }
        } catch (error) {
            console.error(`[${CLIENT_ID}] Error processing manager message: ${error.message}. Raw: ${event.data.toString().substring(0, 200)}`);
        }
    };

    // In clientBotApp.js, update the reconnection logic:
    managerWsClient.onclose = () => {
        console.log(`[${CLIENT_ID}] Disconnected from manager WS. Attempting to reconnect...`);
        reportToManager('status', { status: 'disconnected_manager_ws', message: `Client ${CLIENT_ID} lost connection to manager.` });

        // Clear any existing interval first
        if (reconnectManagerWsInterval) {
            clearInterval(reconnectManagerWsInterval);
            reconnectManagerWsInterval = null;
        }

        // Set up reconnection with proper check
        reconnectManagerWsInterval = setInterval(() => {
            if (!managerWsClient || managerWsClient.readyState === WebSocket.CLOSED || managerWsClient.readyState === WebSocket.CLOSING) {
                console.log(`[${CLIENT_ID}] Retrying manager WS connection...`);
                connectToManagerWebSocket();
            } else if (managerWsClient.readyState === WebSocket.OPEN) {
                // Already connected, clear the interval
                clearInterval(reconnectManagerWsInterval);
                reconnectManagerWsInterval = null;
            }
        }, 5000);
    };

    managerWsClient.onerror = (error) => {
        console.error(`[${CLIENT_ID}] Manager WS Error:`, error.message);
        // No need to call managerWsClient.close() here, onclose will handle it.
    };
}

function reportToManager(type, data = {}) { // تغيير اسم الدالة ليكون عامًا أكثر
    if (managerWsClient && managerWsClient.readyState === WebSocket.OPEN) {
        const payload = { type: type, clientId: CLIENT_ID, data: data };
        try {
            managerWsClient.send(JSON.stringify(payload));
            console.log(`[${CLIENT_ID}] Reported to manager: type=${type}, data keys: ${Object.keys(data).join(', ')}`);
        } catch (e) {
            console.error(`[${CLIENT_ID}] Error sending to manager (type: ${type}): `, e.message);
        }
    } else {
        console.warn(`[${CLIENT_ID}] Manager WS not open, cannot report ${type}.`);
    }
}

// دالة جديدة لإرسال تحديث حل @lid
function reportLidResolution(originalLid, resolvedPhoneJid, pushName) {
    reportToManager('lidResolved', {
        originalLid: originalLid,
        resolvedPhoneJid: resolvedPhoneJid,
        displayName: pushName // استخدام pushName كاسم عرض
    });
}
module.exports = { reportLidResolution }; // تصدير الدالة


async function startClientBot() {
    console.log(`[${CLIENT_ID}] Initializing Baileys connection...`);
    // reportToManager('status', { status: 'initializing_baileys', message: `Client ${CLIENT_ID} initializing WhatsApp.` });


    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({ // Assign to the higher-scoped sock
        version,
        logger: pino({ level: process.env.LOG_LEVEL }), // Default to silent to reduce noise
        auth: state,
        browser: [`Client-${CLIENT_ID.substring(0, 10)}`, 'Chrome', '1.0'],
        printQRInTerminal: false, // We send QR to manager
        // SyncFullHistory: false, // Consider disabling if not needed for performance
        // ConnectTimeoutMs: 60000, // Longer timeout
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[${CLIENT_ID}] New QR code received. Reporting to manager.`);
            reportToManager('qr', qr); // Send QR data (string)
            reportToManager('status', { status: 'qr_received', message: `Client ${CLIENT_ID} QR ready. Scan needed.` });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const reason = DisconnectReason[statusCode] || `Unknown (${statusCode})`;
            console.log(`[${CLIENT_ID}] WhatsApp connection closed. Reason: ${reason}. Should Reconnect: ${shouldReconnect}`);
            reportToManager('status', { status: 'disconnected_whatsapp', message: `Client ${CLIENT_ID} disconnected from WhatsApp (${reason}).` });


            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[${CLIENT_ID}] Logged out by WhatsApp. Clearing auth and exiting.`);
                try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) { console.error(`[${CLIENT_ID}] Error cleaning auth dir:`, e.message); }
                reportToManager('status', { status: 'disconnected_logout', message: `Client ${CLIENT_ID} logged out by WhatsApp.` });
                process.exit(0); // Exit cleanly
            } else if (shouldReconnect) {
                console.log(`[${CLIENT_ID}] Attempting to reconnect to WhatsApp in 5s...`);
                reportToManager('status', { status: 'reconnecting_whatsapp', message: `Client ${CLIENT_ID} reconnecting to WhatsApp...` });
                setTimeout(() => startClientBot(), config.RECONNECT_DELAY_MS); // Use configured delay
            } else {
                console.error(`[${CLIENT_ID}] Unrecoverable WhatsApp connection error. Error: ${lastDisconnect?.error?.message}`);
                reportToManager('status', { status: 'error_whatsapp_permanent', message: `Client ${CLIENT_ID} permanent WhatsApp connection error.` });
                process.exit(1); // Exit with error
            }
        } else if (connection === 'open') {
            const phoneNumber = jidNormalizedUser(sock.user?.id || '').split('@')[0];
            const clientName = sock.user?.name || `Client-${phoneNumber || CLIENT_ID.substring(0, 10)}`;
            console.log(`[${CLIENT_ID}] Connected to WhatsApp! Phone: ${phoneNumber}, Name: ${clientName}`);
            reportToManager('status', {
                status: 'connected_whatsapp', message: `Client ${phoneNumber || CLIENT_ID} connected to WhatsApp.`,
                phoneNumber: phoneNumber, name: clientName,
            });
            // await fetchAndSaveContacts();
            if (!config.SKIP_API_SYNC_ON_RECONNECT || !global.initialApiSyncDone) { // Allow skipping if configured
                console.log(`[${CLIENT_ID}] Starting API sync for client-specific whitelist.`);
                await syncWhitelistFromApi();
                global.initialApiSyncDone = true;
            }
            if (global.apiSyncInterval) clearInterval(global.apiSyncInterval);
            global.apiSyncInterval = setInterval(syncWhitelistFromApi, config.API_SYNC_INTERVAL_MS);

        } else if (connection === 'connecting') {
            console.log(`[${CLIENT_ID}] WhatsApp connecting...`);
            reportToManager('status', { status: 'connecting_whatsapp', message: `Client ${CLIENT_ID} connecting to WhatsApp...` });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // client-instance/clientBotApp.js

    sock.ev.on('messages.upsert', async (upsert) => {
        if (upsert.type !== 'notify') return;
    
        for (const msg of upsert.messages) {
            // We no longer need any contact creation logic here.
            // The _whitelistFilter handles it perfectly.
    
            // All we need to do is pass the message to the main handler if it's not from us.
            if (!msg.key.fromMe) {
                await handleMessage(sock, msg, { clientId: CLIENT_ID });
            }
        }
    });
    // NEW: Listen for when contacts are first populated or updated by Baileys store
    // This is the more reliable way to know when contacts are ready.
    let initialContactsSet = false; // Flag to ensure initial sync runs only once per session
    sock.ev.on('contacts.set', async ({ contacts }) => {
        console.log(`[${CLIENT_ID}] contacts.set event received. Total: ${contacts.length}. Initial sync: ${!initialContactsSet}`);
        // If this is the initial full set of contacts, or a subsequent large update.
        // We'll run fetchAndSaveContacts when a full set is received.
        if (!initialContactsSet) {
            console.log(`[${CLIENT_ID}] Running initial contact sync due to contacts.set event.`);
            await fetchAndSaveContacts();
            initialContactsSet = true;
        }
        /* try {
            const botInstanceIdForContact = await botContactsDb.getClientBotInstanceId();
            if (botInstanceIdForContact && !m.key.fromMe) {
                const isGroup = (m.key.remoteJid || '').endsWith('@g.us');
                await botContactsDb.handleMessageContactAutoAdd(
                    botInstanceIdForContact,
                    m,
                    isGroup
                );
            }
        } catch (contactError) {
            console.error(`[HANDLER_ERROR] Failed during contact auto-add: ${contactError.message}`, contactError.stack);
        } */
        // If you want to continuously update on every contact change, you'd call fetchAndSaveContacts() here
        // or process 'contacts.update' which streams individual changes.
        // For now, this `contacts.set` listener for the initial big sync is good.
    });

    sock.ev.on('contacts.update', async updates => {
        // This fires for individual contact updates (e.g., someone changes their name)
        // If you want to keep contacts highly synchronized, you'd handle granular updates here.
        // For simplicity and initial implementation, contacts.set handles the full sync.
        console.log(`[${CLIENT_ID}] contacts.update event received for ${updates.length} contacts.`);
        // For now, let's trigger a full refresh on any update, as it's easier than granular updates.
        // For production, you might want to process `updates` more efficiently.
        if (sock.contacts && Object.keys(sock.contacts).length > 0) { // Only re-sync if contacts are generally available
            console.log(`[${CLIENT_ID}] Re-syncing contacts due to update event.`);
            await fetchAndSaveContacts();
        }
    });

    // Fallback: Sometimes contacts.set doesn't fire immediately, or if the bot restarts mid-session.
    // Add a small delay after 'open' for initial contacts to load, then run a check.
    // This provides a safety net if contacts.set isn't reliably triggered for initial load.
    if (!initialContactsSet) {
        console.log(`[${CLIENT_ID}] Scheduling a delayed fallback contact sync...`);
        setTimeout(async () => {
            if (!initialContactsSet) { // Only run if contacts.set hasn't triggered it yet
                console.log(`[${CLIENT_ID}] Running delayed fallback contact sync.`);
                await fetchAndSaveContacts();
                initialContactsSet = true;
            }
        }, 10000); 4
    }
}
// --- Main Execution ---
connectToManagerWebSocket(); // Connect to manager first
// startClientBot().catch(err => {
//     console.error(`[${CLIENT_ID}] Critical Error starting client bot:`, err.message, err.stack);
//     reportToManager('status', {
//         status: 'error_startup', message: `Client bot ${CLIENT_ID} failed to start: ${err.message}`,
//     });
//     process.exit(1);
// });

process.on('SIGINT', () => {
    console.log(`[${CLIENT_ID}] SIGINT received, shutting down...`);
    if (sock) sock.end(new Error('SIGINT Shutdown'));
    if (managerWsClient) managerWsClient.close();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log(`[${CLIENT_ID}] SIGTERM received, shutting down...`);
    if (sock) sock.end(new Error('SIGTERM Shutdown'));
    if (managerWsClient) managerWsClient.close();
    process.exit(0);
});