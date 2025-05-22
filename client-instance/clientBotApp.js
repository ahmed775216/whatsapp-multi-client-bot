// client-instance/clientBotApp.js
// This is the entry point for each individual client bot instance
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws'); // To report status back to manager

// Config is loaded from parent process env vars (manager passes these)
const AUTH_DIR = process.env.AUTH_DIR; // e.g., client_data/client_12345/auth_info_baileys
const DATA_DIR = process.env.DATA_DIR; // e.g., client_data/client_12345/data
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_NUMBER_FOR_CLIENT = process.env.OWNER_NUMBER_FOR_CLIENT; // Specific owner for this client
const MANAGER_WS_PORT = parseInt(process.env.MANAGER_WS_PORT || '0'); // Port for manager's WS server
const API_USERNAME_FOR_CLIENT = process.env.API_USERNAME_FOR_CLIENT;
const API_PASSWORD_FOR_CLIENT = process.env.API_PASSWORD_FOR_CLIENT;
const SKIP_API_SYNC = process.env.SKIP_API_SYNC === 'true'; // Used to control if client does its own API sync

if (!AUTH_DIR || !DATA_DIR || !CLIENT_ID || MANAGER_WS_PORT === 0) {
    console.error('[CLIENT_BOT_FATAL] Missing required environment variables (AUTH_DIR, DATA_DIR, CLIENT_ID, MANAGER_WS_PORT). Exiting.');
    process.exit(1);
}

// Ensure unique data directory for this client bot
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Set up global for modules within this client instance ---
// This is crucial for whitelist.js and apiSync.js to use the correct paths.
// You *must* update `plugins/whitelist.js` and `client-instance/lib/apiSync.js`
// to use these environment variables.
process.env.DATA_DIR_FOR_CLIENT = DATA_DIR; // Make it available for module internal logic
process.env.AUTH_DIR_FOR_CLIENT = AUTH_DIR; // Also for module internal logic if needed
process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC = OWNER_NUMBER_FOR_CLIENT; // For isOwner checks etc.
process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC = API_USERNAME_FOR_CLIENT;
process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC = API_PASSWORD_FOR_CLIENT;


// --- Manager WebSocket Client ---
let managerWsClient = null;
let reconnectManagerWsInterval = null;

function connectToManagerWebSocket() {
    // Clear any existing reconnect interval
    if (reconnectManagerWsInterval) {
        clearInterval(reconnectManagerWsInterval);
        reconnectManagerWsInterval = null;
    }

    managerWsClient = new WebSocket(`ws://localhost:${MANAGER_WS_PORT}`);

    managerWsClient.onopen = () => {
        console.log(`[${CLIENT_ID}] Connected to manager WS.`);
        // Report initial status to manager, manager will forward to C#
        reportStatusToManager('status', {
            status: 'connecting',
            message: `Client ${CLIENT_ID} bot instance started, attempting WhatsApp connection.`,
            clientId: CLIENT_ID,
        });
    };

    managerWsClient.onmessage = (event) => {
        // Manager might send commands back (e.g., 'stop')
        console.log(`[${CLIENT_ID}] Received command from manager: ${event.data}`);
        // Implement logic here if manager sends commands.
    };

    managerWsClient.onclose = () => {
        console.log(`[${CLIENT_ID}] Disconnected from manager WS. Attempting to reconnect...`);
        // Try to reconnect periodically
        if (!reconnectManagerWsInterval) {
            reconnectManagerWsInterval = setInterval(() => {
                if (managerWsClient.readyState === WebSocket.CLOSED || managerWsClient.readyState === WebSocket.CLOSING) {
                    connectToManagerWebSocket();
                }
            }, 5000); // Try every 5 seconds
        }
    };

    managerWsClient.onerror = (error) => {
        console.error(`[${CLIENT_ID}] Manager WS Error:`, error.message);
        managerWsClient.close(); // Force close to trigger onclose for reconnect logic
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


// --- Actual Baileys Bot Logic ---
const { handleMessage } = require('./handler'); // Your handler.js
// Dynamic require for whitelist.js and apiSync.js
const { syncWhitelistFromApi } = require('./lib/apiSync');

async function startClientBot() {
    console.log(`[${CLIENT_ID}] Initializing Baileys connection...`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR); // Use dynamic AUTH_DIR
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Keep silent for client bots, manager will aggregate/filter logs
        auth: state,
        browser: [`Client-${CLIENT_ID}`, 'Chrome', '1.0'],
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[${CLIENT_ID}] New QR received from Baileys.`);
            reportStatusToManager('qr', qr); // Send QR data to manager
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[${CLIENT_ID}] WhatsApp connection closed (reason: ${DisconnectReason[statusCode] || statusCode}). Reconnecting: ${shouldReconnect}`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[${CLIENT_ID}] Logged out. Clearing auth and exiting process.`);
                // Clean up client's auth data permanently for this instance
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
                reportStatusToManager('status', {
                    status: 'disconnected_logout',
                    message: `Client ${CLIENT_ID} logged out.`,
                    clientId: CLIENT_ID,
                });
                process.exit(0); // Exit the child process gracefully
            } else if (shouldReconnect) {
                reportStatusToManager('status', {
                    status: 'reconnecting',
                    message: `Client ${CLIENT_ID} reconnecting...`,
                    clientId: CLIENT_ID,
                });
                setTimeout(() => startClientBot(), 5000); // Retry start
            } else {
                // Permanent non-logout closure (e.g., failed to connect initially)
                reportStatusToManager('status', {
                    status: 'error',
                    message: `Client ${CLIENT_ID} permanent connection error.`,
                    clientId: CLIENT_ID,
                });
                process.exit(1); // Exit on unrecoverable error
            }
        } else if (connection === 'open') {
            const phoneNumber = jidNormalizedUser(sock.user?.id || '').split('@')[0];
            const clientName = sock.user?.name || `Client-${phoneNumber}`;
            console.log(`[${CLIENT_ID}] Connected to WhatsApp! Phone: ${phoneNumber}`);

            reportStatusToManager('status', {
                status: 'connected',
                message: `Client ${phoneNumber} connected.`,
                clientId: CLIENT_ID,
                phoneNumber: phoneNumber, // Send actual linked phone number
                name: clientName,
            });

            if (!SKIP_API_SYNC) {
                console.log(`[${CLIENT_ID}] Starting API sync for client-specific whitelist.`);
                // This clientBotApp's `apiSync.js` will use its own environment variables.
                await syncWhitelistFromApi();
                setInterval(syncWhitelistFromApi, 3600000); // 1 hour interval
            }
        } else if (connection === 'connecting') {
            console.log(`[${CLIENT_ID}] WhatsApp connecting...`);
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
        for (const m of upsert.messages) {
            await handleMessage(sock, m); // Pass control to generic message handler
        }
    });
}

// Initial setup: Connect to manager then start bot
connectToManagerWebSocket();
startClientBot().catch(err => {
    console.error(`[${CLIENT_ID}] Error starting client bot:`, err);
    reportStatusToManager('status', {
        status: 'error',
        message: `Client bot failed to start: ${err.message}`,
        clientId: CLIENT_ID,
    });
    process.exit(1); // Exit if initial start fails
});