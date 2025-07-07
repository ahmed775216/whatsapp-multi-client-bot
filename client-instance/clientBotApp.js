// client-instance/clientBotApp.js
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');
const path = require('path'); // Ensure path is required correctly
const fs = require('fs');
const WebSocket = require('ws');
const { upsertBotContact, getClientBotInstanceId } = require('../database/botContactsDb');
let process = require('process');
const { createLogger } = require('./lib/logger');

const AUTH_DIR = process.env.AUTH_DIR;
const DATA_DIR = process.env.DATA_DIR;
const CLIENT_ID = process.env.CLIENT_ID;
const MANAGER_WS_PORT = parseInt(process.env.MANAGER_WS_PORT || '0');

if (!AUTH_DIR || !DATA_DIR || !CLIENT_ID || MANAGER_WS_PORT === 0) { // Ensure CLIENT_ID here is also checked
    // We can't use the main logger here because CLIENT_ID might be missing.
    // A simple console.error is appropriate for this fatal, pre-startup error.
    console.error(`[${CLIENT_ID || 'UNKNOWN_CLIENT'}_FATAL] Missing required environment variables. AUTH_DIR=${AUTH_DIR}, DATA_DIR=${DATA_DIR}, CLIENT_ID=${CLIENT_ID}, MANAGER_WS_PORT=${MANAGER_WS_PORT}. Exiting.`);
    process.exit(1);
}

// Initialize the logger now that we have a guaranteed CLIENT_ID
const logger = createLogger(CLIENT_ID, 'client.log');
logger.info({ clientId: CLIENT_ID, type: typeof CLIENT_ID }, 'Instance process started.');



if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

if (!global.pushNameCache) { // كاش لتخزين pushName مؤقتًا
    global.pushNameCache = new Map();
}

const { findBestDisplayName } = require('./lib/contactUtils'); // Import the utility function
let clientConfig = {};
const clientConfigPath = path.join(path.dirname(AUTH_DIR), 'client_config.json');
if (fs.existsSync(clientConfigPath)) {
    try {
        clientConfig = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
    } catch (e) { 
        logger.error({ err: e, path: clientConfigPath }, 'Error loading client_config.json'); 
    }
}

process.env.DATA_DIR_FOR_CLIENT = DATA_DIR;
process.env.AUTH_DIR_FOR_CLIENT = AUTH_DIR;
process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC = clientConfig.ownerNumber || process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC;
process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC = clientConfig.apiUsername || process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC;
process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC = clientConfig.apiPassword || process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC;

const { handleMessage } = require('./handler');
const { syncWhitelistFromApi } = require('./lib/apiSync');
const transactionProcessor = require('./lib/transactionProcessor')
const config = require('../config');

let managerWsClient = null;
let reconnectManagerWsInterval = null;
let sock = null;
async function fetchAndSaveContacts() {
    logger.info('Starting manual contact sync...');
    if (!botInstanceId) {
        logger.error('Bot Instance ID not available for contact sync. Aborting.');
        return;
    }

    try {
        const contactsMap = sock.contacts || {};
        const allSyncedUserJids = [];
        const contactCount = Object.keys(contactsMap).length;

        logger.info({ contactCount }, `Processing ${contactCount} contacts from address book.`);

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
                        isSavedContact: true
                     };

                    await upsertBotContact(botInstanceId, contactData);
                }
            }
        }

        // Mark any saved contacts that were not in this sync as inactive.
        logger.info('Finished upserting contacts. Now checking for stale contacts...');
        await require('../database/botContactsDb').deleteStaleContactsForInstance(botInstanceId, allSyncedUserJids);

        logger.info('Manual contact sync completed.');
    } catch (error) {
        logger.error({ err: error }, 'An error occurred during contact sync.');
    }
}


function connectToManagerWebSocket() {
    if (reconnectManagerWsInterval) {
        clearInterval(reconnectManagerWsInterval);
        reconnectManagerWsInterval = null;
    }

    managerWsClient = new WebSocket(`ws://localhost:${MANAGER_WS_PORT}`);

    managerWsClient.onopen = async () => {
        logger.info('Connected to manager WS.');

        try {
            botInstanceId = await getClientBotInstanceId(CLIENT_ID);
            if (!botInstanceId) {
                logger.error('Could not retrieve botInstanceId from database on startup. Contact persistence will fail.');
            } else {
                logger.info({ botInstanceId }, 'Bot Instance ID for contact persistence retrieved.');
            }
        } catch (e) {
            logger.error({ err: e }, 'Database error getting botInstanceId on startup.');
        }

        reportToManager('status', {
            status: 'connecting_whatsapp', // More specific initial status
            message: `Client ${CLIENT_ID} bot instance started, attempting WhatsApp connection.`,
        });
        startClientBot().catch(err => {
            logger.fatal({ err }, `Critical Error starting client bot. Exiting.`);
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
                logger.info({ command: parsedMsg.command, payload: { groupId: parsedMsg.groupId, participantJid: parsedMsg.participantJid } }, 'Received internal command from manager');

                const internalReply = (dataForReply) => {
                    if (managerWsClient && managerWsClient.readyState === WebSocket.OPEN) {
                        managerWsClient.send(JSON.stringify({ type: 'internalReply', clientId: CLIENT_ID, data: dataForReply }));
                    } else {
                        logger.warn({ command: parsedMsg.command }, `Manager WS not open, cannot send internal reply for command ${parsedMsg.command}.`);
                    }
                };

                if (!sock) {
                    logger.error({ command: parsedMsg.command }, `Sock is not initialized. Cannot process internal command ${parsedMsg.command}.`);
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
                // logger.debug({ type: parsedMsg.type, data: event.data.toString().substring(0,150) }, 'Manager message'); // Can be noisy
            } else if (parsedMsg.type !== 'internalCommand') { // General messages not for this client specifically
                // logger.debug({ data: event.data.toString().substring(0,100) }, 'Received general manager message');
            }
        } catch (error) {
            logger.error({ err: error, rawData: event.data.toString().substring(0, 200) }, 'Error processing manager message');
        }
    };

    // In clientBotApp.js, update the reconnection logic:
    managerWsClient.onclose = () => {
        logger.warn('Disconnected from manager WS. Attempting to reconnect...');
        reportToManager('status', { status: 'disconnected_manager_ws', message: `Client ${CLIENT_ID} lost connection to manager.` });

        // Clear any existing interval first
        if (reconnectManagerWsInterval) {
            clearInterval(reconnectManagerWsInterval);
            reconnectManagerWsInterval = null;
        }

        // Set up reconnection with proper check
        reconnectManagerWsInterval = setInterval(() => {
            if (!managerWsClient || managerWsClient.readyState === WebSocket.CLOSED || managerWsClient.readyState === WebSocket.CLOSING) {
                logger.info('Retrying manager WS connection...');
                connectToManagerWebSocket();
            } else if (managerWsClient.readyState === WebSocket.OPEN) {
                // Already connected, clear the interval
                clearInterval(reconnectManagerWsInterval);
                reconnectManagerWsInterval = null;
            }
        }, 5000);
    };

    managerWsClient.onerror = (error) => {
        logger.error({ err: error }, 'Manager WS Error');
        // No need to call managerWsClient.close() here, onclose will handle it.
    };
}

function reportToManager(type, data = {}) { // تغيير اسم الدالة ليكون عامًا أكثر
    if (managerWsClient && managerWsClient.readyState === WebSocket.OPEN) {
        const payload = { type: type, clientId: CLIENT_ID, data: data };
        try {
            managerWsClient.send(JSON.stringify(payload));
            // Use debug level for this frequent operation to avoid noisy logs in production.
            logger.debug({ reportType: type, dataKeys: Object.keys(data) }, 'Reported to manager');
        } catch (e) {
            logger.error({ err: e, reportType: type }, 'Error sending report to manager');
        }
    } else {
        logger.warn({ reportType: type }, 'Manager WS not open, cannot send report.');
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
    logger.info('Initializing Baileys connection...');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    // Create a child logger for Baileys, so its logs are integrated into our system.
    // It will be silent by default unless you set a specific LOG_LEVEL.
    const baileysLogger = logger.child({ module: 'baileys' });
    baileysLogger.level = process.env.LOG_LEVEL || 'silent';

    sock = makeWASocket({ // Assign to the higher-scoped sock
        version,
        logger: baileysLogger,
        auth: state,
        browser: [`Client-${CLIENT_ID.substring(0, 10)}`, 'Chrome', '1.0'],
        printQRInTerminal: false, // We send QR to manager
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info('New QR code received. Reporting to manager.');
            reportToManager('qr', qr); // Send QR data (string)
            reportToManager('status', { status: 'qr_received', message: `Client ${CLIENT_ID} QR ready. Scan needed.` });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const reason = DisconnectReason[statusCode] || `Unknown (${statusCode})`;
            logger.warn({ reason, statusCode, shouldReconnect }, 'WhatsApp connection closed.');
            reportToManager('status', { status: 'disconnected_whatsapp', message: `Client ${CLIENT_ID} disconnected from WhatsApp (${reason}).` });


            if (statusCode === DisconnectReason.loggedOut) {
                logger.warn('Logged out by WhatsApp. Clearing auth and exiting.');
                try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) { logger.error({ err: e }, 'Error cleaning auth dir during logout.'); }
                reportToManager('status', { status: 'disconnected_logout', message: `Client ${CLIENT_ID} logged out by WhatsApp.` });
                process.exit(0); // Exit cleanly
            } else if (shouldReconnect) {
                logger.info(`Attempting to reconnect to WhatsApp in ${config.RECONNECT_DELAY_MS / 1000}s...`);
                reportToManager('status', { status: 'reconnecting_whatsapp', message: `Client ${CLIENT_ID} reconnecting to WhatsApp...` });
                setTimeout(() => startClientBot(), config.RECONNECT_DELAY_MS); // Use configured delay
            } else {
                logger.error({ err: lastDisconnect?.error }, 'Unrecoverable WhatsApp connection error.');
                reportToManager('status', { status: 'error_whatsapp_permanent', message: `Client ${CLIENT_ID} permanent WhatsApp connection error.` });
                process.exit(1); // Exit with error
            }
        } else if (connection === 'open') {
            const phoneNumber = jidNormalizedUser(sock.user?.id || '').split('@')[0];
            const clientName = sock.user?.name || `Client-${phoneNumber || CLIENT_ID.substring(0, 10)}`;
            logger.info({ phoneNumber, clientName }, 'Connected to WhatsApp!');
            reportToManager('status', {
                status: 'connected_whatsapp', message: `Client ${phoneNumber || CLIENT_ID} connected to WhatsApp.`,
                phoneNumber: phoneNumber, name: clientName,
            });
            // await fetchAndSaveContacts();
            const safeSyncWhitelist = async () => {
                try {
                    await syncWhitelistFromApi();
                } catch (err) {
                    logger.error({ err }, "An error occurred during the whitelist sync. The process will continue and retry later.");
                }
            };

            if (!config.SKIP_API_SYNC_ON_RECONNECT || !global.initialApiSyncDone) {
                logger.info('Starting initial API sync for client-specific whitelist.');
                // Run the initial sync, but don't let it crash the app on failure.
                await safeSyncWhitelist();
                global.initialApiSyncDone = true; // Mark as done even on failure to prevent re-running on every reconnect.
            }

            if (global.apiSyncInterval) clearInterval(global.apiSyncInterval);
            // Periodically sync in the background, safely.
            global.apiSyncInterval = setInterval(safeSyncWhitelist, config.API_SYNC_INTERVAL_MS);

            transactionProcessor.start(CLIENT_ID);
        } else if (connection === 'connecting') {
            logger.info('WhatsApp connecting...');
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
        logger.info({ total: contacts.length, initialSync: !initialContactsSet }, 'contacts.set event received.');
        // If this is the initial full set of contacts, or a subsequent large update.
        // We'll run fetchAndSaveContacts when a full set is received.
        if (!initialContactsSet) {
            logger.info('Running initial contact sync due to contacts.set event.');
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
        logger.info({ count: updates.length }, 'contacts.update event received.');
        // For now, let's trigger a full refresh on any update, as it's easier than granular updates.
        // For production, you might want to process `updates` more efficiently.
        if (sock.contacts && Object.keys(sock.contacts).length > 0) { // Only re-sync if contacts are generally available
            logger.info('Re-syncing contacts due to update event.');
            await fetchAndSaveContacts();
        }
    });

    // Fallback: Sometimes contacts.set doesn't fire immediately, or if the bot restarts mid-session.
    // Add a small delay after 'open' for initial contacts to load, then run a check.
    // This provides a safety net if contacts.set isn't reliably triggered for initial load.
    if (!initialContactsSet) {
        logger.info('Scheduling a delayed fallback contact sync...');
        setTimeout(async () => {
            if (!initialContactsSet) { // Only run if contacts.set hasn't triggered it yet
                logger.info('Running delayed fallback contact sync.');
                await fetchAndSaveContacts();
                initialContactsSet = true;
            }
        }, 10000); 4
    }
}
connectToManagerWebSocket(); // Connect to manager first

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down...');
    if (sock) sock.end(new Error('SIGINT Shutdown'));
    if (managerWsClient) managerWsClient.close();
    process.exit(0);
});
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down...');
    if (sock) sock.end(new Error('SIGTERM Shutdown'));
    if (managerWsClient) managerWsClient.close();
    process.exit(0);
});