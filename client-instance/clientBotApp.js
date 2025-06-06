// client-instance/clientBotApp.js
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path'); // Ensure path is required correctly
const fs = require('fs');
const WebSocket = require('ws');
let process = require('process');
const AUTH_DIR = process.env.AUTH_DIR;
const DATA_DIR = process.env.DATA_DIR;
const CLIENT_ID = process.env.CLIENT_ID;
const MANAGER_WS_PORT = parseInt(process.env.MANAGER_WS_PORT || '0');

if (!AUTH_DIR || !DATA_DIR || !CLIENT_ID || MANAGER_WS_PORT === 0) {
    console.error(`[${CLIENT_ID}_FATAL] Missing required environment variables. Exiting.`);
    process.exit(1);
}

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

if (!global.pushNameCache) { // كاش لتخزين pushName مؤقتًا
    global.pushNameCache = new Map();
}

const botContactsDb = require('../database/botContactsDb'); // Import the new module
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
// Function to fetch and save contacts (ADD THIS NEW FUNCTION)
async function fetchAndSaveContacts() {
    console.log(`[${CLIENT_ID}] Fetching and saving contacts...`);
    const botInstanceId = await botContactsDb.getClientBotInstanceId(); // Use the local method to get instance ID
    if (!botInstanceId) {
        console.error(`[${CLIENT_ID}_CONTACTS_SYNC_ERROR] Could not get bot instance ID for contact sync.`);
        return;
    }

    try {
        // Correctly access contacts. It is typically a Map.
        // Using `sock.contacts` directly may not contain all contacts.
        // A more robust way is to listen to 'contacts.update' or use an IQ query.
        // For initial sync, `sock.store.contacts.all()` might be more reliable
        // if you are using a store that caches contacts.
        // However, based on how `sock.contacts` is usually used, it refers to a Map-like structure.

        // Let's assume `sock.contacts` will be a Map once populated.
        // If it's not yet populated, it might be undefined/null, or an empty Map.
        const contactsMap = sock.contacts || new Map(); // Initialize as empty Map if null/undefined

        const jidsToKeep = [];

        // Correct way to iterate over a Map
        console.log(`[${CLIENT_ID}_CONTACTS_SYNC] Processing ${contactsMap.size} contacts.`);

        for (const [jid, contact] of contactsMap.entries()) { // Iterate Map directly
            // Ensure the JID is valid and a primary JID type if needed, e.g. 's.whatsapp.net'
            if (!jid || !jid.includes('@') || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) {
                continue; // Skip group JIDs or invalid JIDs in contact list for bot_contacts
            }

            const name = contact.name || contact.notify || contact.verifiedName || contact.vname || contact.short || contact.pushName || jid.split('@')[0];
            const phoneNumber = jid.includes('@s.whatsapp.net') ? jid.split('@')[0] : (contact.number || null);

            jidsToKeep.push(jid);

            await botContactsDb.upsertBotContact(
                botInstanceId,
                jid, // This is the contact's JID
                phoneNumber, // This is the raw phone number (without @s.whatsapp.net)
                name,
                contact.pushName // pushName can be stored as whatsapp_name
            );
        }

        await botContactsDb.deleteStaleContactsForInstance(botInstanceId, jidsToKeep);

        console.log(`[${CLIENT_ID}_CONTACTS_SYNC] Contacts sync completed. Kept ${jidsToKeep.length} contacts.`);

    } catch (error) {
        console.error(`[${CLIENT_ID}_CONTACTS_SYNC_ERROR] Error fetching or saving contacts: ${error.message}`, error.stack);
        // Added explicit TypeError check, as the `contacts = await sock.contacts` line can throw an error
        // if `sock` itself is undefined/null before `connection.update` 'open'
        if (error instanceof TypeError && error.message.includes('Cannot convert undefined or null to object')) {
            console.error(`[${CLIENT_ID}_CONTACTS_SYNC_ERROR] Likely, sock.contacts was not ready. Ensure this runs AFTER WhatsApp connection is 'open'.`);
        }
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

    sock.ev.on('messages.upsert', async (upsert) => {
        if (upsert.type !== 'notify') return;
        // console.log(`[${CLIENT_ID}] Received ${upsert.messages.length} new messages.`); // Can be very noisy
        for (const m of upsert.messages) {
            if (m.key.remoteJid && m.pushName && m.pushName !== "UnknownPN") {
                const senderJidForCache = jidNormalizedUser(m.key.participant || m.key.remoteJid);
                if (senderJidForCache) {
                    global.pushNameCache.set(senderJidForCache, m.pushName);
                }
            }
            if (!m.key.fromMe) {
                await handleMessage(sock, m, { clientId: CLIENT_ID });
            }
        }
    });// NEW: Listen for when contacts are first populated or updated by Baileys store
    // This is the more reliable way to know when contacts are ready.
    let initialContactsSet = false; // Flag to ensure initial sync runs only once per session
    sock.ev.on('contacts.set', async ({ contacts, is }) => {
        console.log(`[${CLIENT_ID}] contacts.set event received. Total: ${contacts.length}. Initial sync: ${!initialContactsSet}`);
        // If this is the initial full set of contacts, or a subsequent large update.
        // We'll run fetchAndSaveContacts when a full set is received.
        if (!initialContactsSet) {
            console.log(`[${CLIENT_ID}] Running initial contact sync due to contacts.set event.`);
            await fetchAndSaveContacts();
            initialContactsSet = true;
        }
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