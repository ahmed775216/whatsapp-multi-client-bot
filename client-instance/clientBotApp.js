// client-instance/clientBotApp.js
// This is the entry point for each individual client bot instance
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// Config is loaded from parent process env vars (manager passes these)
const AUTH_DIR = process.env.AUTH_DIR; // e.g., client_data/client_12345/auth_info_baileys
const DATA_DIR = process.env.DATA_DIR; // e.g., client_data/client_12345/data
const CLIENT_ID = process.env.CLIENT_ID;
// BOT_OWNER_NUMBER, API_USERNAME_FOR_CLIENT, API_PASSWORD_FOR_CLIENT are passed from manager as env vars,
// but we will try to load them from client_config.json first if available.
// Keep these consts as they are what the manager _might_ have explicitly passed.
const MANAGER_WS_PORT = parseInt(process.env.MANAGER_WS_PORT || '0');

if (!AUTH_DIR || !DATA_DIR || !CLIENT_ID || MANAGER_WS_PORT === 0) {
    console.error(`[${CLIENT_ID}_FATAL] Missing required environment variables (AUTH_DIR, DATA_DIR, CLIENT_ID, MANAGER_WS_PORT). Exiting.`);
    process.exit(1);
}

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --- NEW: Load client_config.json for persistent credentials ---
let clientConfig = {};
const clientConfigPath = path.join(path.dirname(AUTH_DIR), 'client_config.json'); // client_data/client_ID/client_config.json

if (fs.existsSync(clientConfigPath)) {
    try {
        clientConfig = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
        console.log(`[${CLIENT_ID}] Loaded client_config.json from ${clientConfigPath}.`);
    } catch (e) {
        console.error(`[${CLIENT_ID}] Error loading client_config.json:`, e.message);
        // Fallback to environment variables if config file is corrupted
        clientConfig = {};
    }
} else {
    console.log(`[${CLIENT_ID}] No client_config.json found at ${clientConfigPath}. Relying on environment variables.`);
}

// --- Set up process.env for modules within this client instance ---
// Prioritize values from client_config.json if available, otherwise use what manager passed via env.
// This is critical for whitelist.js and apiSync.js to use the correct paths and credentials.
process.env.DATA_DIR_FOR_CLIENT = DATA_DIR;
process.env.AUTH_DIR_FOR_CLIENT = AUTH_DIR;
process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC = clientConfig.ownerNumber || process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC;
process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC = clientConfig.apiUsername || process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC;
process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC = clientConfig.apiPassword || process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC;

// Now, re-declare these consts to reflect the values set in process.env
const BOT_OWNER_NUMBER = process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC;
const API_USERNAME_FOR_CLIENT = process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC;
const API_PASSWORD_FOR_CLIENT = process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC;

// --- DEBUG LOG START ---
console.log(`[${CLIENT_ID}_ENV_CHECK] Instance starting with:`);
console.log(`[${CLIENT_ID}_ENV_CHECK]   CLIENT_ID: ${CLIENT_ID}`);
console.log(`[${CLIENT_ID}_ENV_CHECK]   AUTH_DIR: ${AUTH_DIR}`);
console.log(`[${CLIENT_ID}_ENV_CHECK]   DATA_DIR: ${DATA_DIR}`);
console.log(`[${CLIENT_ID}_ENV_CHECK]   OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC: ${BOT_OWNER_NUMBER ? BOT_OWNER_NUMBER.substring(0,3) + '***' : 'NULL'}`);
console.log(`[${CLIENT_ID}_ENV_CHECK]   API_USERNAME_FOR_CLIENT_BOT_LOGIC: ${API_USERNAME_FOR_CLIENT ? API_USERNAME_FOR_CLIENT.substring(0,3) + '***' : 'NULL'}`);
console.log(`[${CLIENT_ID}_ENV_CHECK]   API_PASSWORD_FOR_CLIENT_BOT_LOGIC: ${API_PASSWORD_FOR_CLIENT ? '*** (Set)' : 'NULL'}`);
console.log(`[${CLIENT_ID}_ENV_CHECK]   API_BASE_URL: ${process.env.API_BASE_URL}`);
// --- DEBUG LOG END ---

// --- Manager WebSocket Client ---
let managerWsClient = null;
let reconnectManagerWsInterval = null;

function connectToManagerWebSocket() {
    if (reconnectManagerWsInterval) {
        clearInterval(reconnectManagerWsInterval);
        reconnectManagerWsInterval = null;
    }

    managerWsClient = new WebSocket(`ws://localhost:${MANAGER_WS_PORT}`);

    managerWsClient.onopen = () => {
        console.log(`[${CLIENT_ID}] Connected to manager WS.`);
        reportStatusToManager('status', {
            status: 'connecting',
            message: `Client ${CLIENT_ID} bot instance started, attempting WhatsApp connection.`,
        });
    };
    managerWsClient.onmessage = (event) => {
        console.log(`[${CLIENT_ID}] Received command from manager: ${event.data}`);
    };

    managerWsClient.onclose = () => {
        console.log(`[${CLIENT_ID}] Disconnected from manager WS. Attempting to reconnect...`);
        if (!reconnectManagerWsInterval) {
            reconnectManagerWsInterval = setInterval(() => {
                if (managerWsClient.readyState === WebSocket.CLOSED || managerWsClient.readyState === WebSocket.CLOSING) {
                    connectToManagerWebSocket();
                }
            }, 5000);
        }
    };

    managerWsClient.onerror = (error) => {
        console.error(`[${CLIENT_ID}] Manager WS Error:`, error.message);
        managerWsClient.close();
    };
}

function reportStatusToManager(type, data = {}) {
    if (managerWsClient && managerWsClient.readyState === WebSocket.OPEN) {
        const payload = { type: type, clientId: CLIENT_ID, data: data };
        managerWsClient.send(JSON.stringify(payload));
    } else {
        console.warn(`[${CLIENT_ID}] Manager WS not open, cannot report ${type}.`);
    }
}

const { handleMessage } = require('./handler');
const { syncWhitelistFromApi } = require('./lib/apiSync');
const config = require('../config');


async function startClientBot() {
    console.log(`[${CLIENT_ID}] Initializing Baileys connection...`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'info' }),
        auth: state,
        browser: [`Client-${CLIENT_ID}`, 'Chrome', '1.0'],
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[${CLIENT_ID}] New QR received from Baileys. QR Data Length: ${qr.length}`);
            reportStatusToManager('qr', qr);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[${CLIENT_ID}] WhatsApp connection closed (reason: ${DisconnectReason[statusCode] || statusCode}). Reconnecting: ${shouldReconnect}`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[${CLIENT_ID}] Logged out. Clearing auth and exiting process.`);
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) { console.error(`[${CLIENT_ID}] Error cleaning auth dir:`, e.message); }
                reportStatusToManager('status', {
                    status: 'disconnected_logout',
                    message: `Client ${CLIENT_ID} logged out.`,
                    clientId: CLIENT_ID,
                });
                process.exit(0);
            } else if (shouldReconnect) {
                reportStatusToManager('status', {
                    status: 'reconnecting',
                    message: `Client ${CLIENT_ID} reconnecting...`,
                    clientId: CLIENT_ID,
                });
                setTimeout(() => startClientBot(), 5000);
            } else {
                console.error(`[${CLIENT_ID}] Permanent connection error (not logged out). Error: ${lastDisconnect?.error?.message}`);
                reportStatusToManager('status', {
                    status: 'error',
                    message: `Client ${CLIENT_ID} permanent connection error.`,
                    clientId: CLIENT_ID,
                });
                process.exit(1);
            }
        } else if (connection === 'open') {
            const phoneNumber = jidNormalizedUser(sock.user?.id || '').split('@')[0];
            const clientName = sock.user?.name || `Client-${phoneNumber}`;
            console.log(`[${CLIENT_ID}] Connected to WhatsApp! Phone: ${phoneNumber}, Name: ${clientName}`);

            reportStatusToManager('status', {
                status: 'connected',
                message: `Client ${phoneNumber} connected.`,
                clientId: CLIENT_ID,
                phoneNumber: phoneNumber,
                name: clientName,
            });

            console.log(`[${CLIENT_ID}] Starting API sync for client-specific whitelist. Checking credentials.`);
            await syncWhitelistFromApi();
            setInterval(syncWhitelistFromApi, config.API_SYNC_INTERVAL_MS);
            
        } else if (connection === 'connecting') {
            console.log(`[${CLIENT_ID}] WhatsApp connecting... Current credentials: API User: ${API_USERNAME_FOR_CLIENT ? 'Set' : 'Not Set'}, Owner: ${BOT_OWNER_NUMBER ? 'Set' : 'Not Set'}`);
            reportStatusToManager('status', {
                status: 'connecting',
                message: `Client ${CLIENT_ID} connecting...`,
                clientId: CLIENT_ID,
            });
        }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async (upsert) => {
        if (upsert.type !== 'notify') return;
        console.log(`[${CLIENT_ID}] Received ${upsert.messages.length} new messages.`);
        for (const m of upsert.messages) {
            await handleMessage(sock, m);
        }
    });
}

connectToManagerWebSocket();
startClientBot().catch(err => {
    console.error(`[${CLIENT_ID}] Critical Error starting client bot:`, err);
    reportStatusToManager('status', {
        status: 'error',
        message: `Client bot failed to start: ${err.message}`,
        clientId: CLIENT_ID,
    });
    process.exit(1);
});