// client-instance/clientBotApp.js
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path'); // Ensure path is required correctly
const fs = require('fs');
const WebSocket = require('ws');
const withdrawalRequestsPlugin = require('./plugins/withdrawalRequests');


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
const config = require('../config'); // Main project config

let managerWsClient = null;
let reconnectManagerWsInterval = null;
let sock = null; // Make sock accessible in connectToManagerWebSocket scope if needed for immediate actions
const lidToJidCache = new Map();
function connectToManagerWebSocket() {
    if (reconnectManagerWsInterval) {
        clearInterval(reconnectManagerWsInterval);
        reconnectManagerWsInterval = null;
    }

    managerWsClient = new WebSocket(`ws://localhost:${MANAGER_WS_PORT}`);

    managerWsClient.onopen = () => {
        console.log(`[${CLIENT_ID}] Connected to manager WS.`);
        reportStatusToManager('status', {
            status: 'connecting_whatsapp', // More specific initial status
            message: `Client ${CLIENT_ID} bot instance started, attempting WhatsApp connection.`,
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
                    clientId: CLIENT_ID,
                });
            } else if (parsedMsg.clientId === CLIENT_ID) {
                console.log(`[${CLIENT_ID}] Manager message (type: ${parsedMsg.type}): ${event.data.toString().substring(0, 150)}`); // Can be noisy
            } else if (parsedMsg.type !== 'internalCommand') { // General messages not for this client specifically
                console.log(`[${CLIENT_ID}] Received general manager message: ${event.data.toString().substring(0, 100)}`);
            }
        } catch (error) {
            console.error(`[${CLIENT_ID}] Error processing manager message: ${error.message}. Raw: ${event.data.toString().substring(0, 200)}`);
        }
    };

    managerWsClient.onclose = () => {
        console.log(`[${CLIENT_ID}] Disconnected from manager WS. Attempting to reconnect...`);
        reportStatusToManager('status', { status: 'disconnected_manager_ws', message: `Client ${CLIENT_ID} lost connection to manager.` });
        if (!reconnectManagerWsInterval) {
            reconnectManagerWsInterval = setInterval(() => {
                if (!managerWsClient || managerWsClient.readyState === WebSocket.CLOSED || managerWsClient.readyState === WebSocket.CLOSING) {
                    console.log(`[${CLIENT_ID}] Retrying manager WS connection...`);
                    connectToManagerWebSocket();
                } else {
                    clearInterval(reconnectManagerWsInterval); // Clear if somehow connected
                    reconnectManagerWsInterval = null;
                }
            }, 5000);
        }
    };

    managerWsClient.onerror = (error) => {
        console.error(`[${CLIENT_ID}] Manager WS Error:`, error.message);
        // No need to call managerWsClient.close() here, onclose will handle it.
    };
}

function reportStatusToManager(type, data = {}) {
    if (managerWsClient && managerWsClient.readyState === WebSocket.OPEN) {
        const payload = { type: type, clientId: CLIENT_ID, data: data };
        try {
            managerWsClient.send(JSON.stringify(payload));
        } catch (e) {
            console.error(`[${CLIENT_ID}] Error sending status to manager: `, e.message);
        }
    } else {
        console.warn(`[${CLIENT_ID}] Manager WS not open, cannot report ${type}.`); // Can be noisy
    }
}

async function startClientBot() {
    console.log(`[${CLIENT_ID}] Initializing Baileys connection...`);
    reportStatusToManager('status', { status: 'initializing_baileys', message: `Client ${CLIENT_ID} initializing WhatsApp.` });


    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({ // Assign to the higher-scoped sock
        version,
        logger: pino({ level: process.env.LOG_LEVEL || 'silent' }), // Default to silent to reduce noise
        auth: state,
        browser: [`Client-${CLIENT_ID.substring(0, 10)}`, 'Chrome', '1.0'],
        printQRInTerminal: false, // We send QR to manager
        // SyncFullHistory: false, // Consider disabling if not needed for performance
        // ConnectTimeoutMs: 60000, // Longer timeout
    });
    if (withdrawalRequestsPlugin.init) {
        withdrawalRequestsPlugin.init(sock);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, receivedPendingNotifications, isOnline, isNewLogin } = update;
        console.log(`[${CLIENT_ID}_CONN_UPDATE] Connection: ${connection}, QR: ${!!qr}, LastDisconnect: ${lastDisconnect?.error?.message}, StatusCode: ${lastDisconnect?.error?.output?.statusCode}, ReceivedPending: ${receivedPendingNotifications}, IsOnline: ${isOnline}, IsNewLogin: ${isNewLogin}`);

        if (qr) {
            console.log(`[${CLIENT_ID}] New QR code received. Reporting to manager.`);
            reportStatusToManager('qr', qr); // Send QR data (string)
            reportStatusToManager('status', { status: 'qr_received', message: `Client ${CLIENT_ID} QR ready. Scan needed.` });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const reason = DisconnectReason[statusCode] || `Unknown (${statusCode})`;
            console.log(`[${CLIENT_ID}] WhatsApp connection closed. Reason: ${reason}. Should Reconnect: ${shouldReconnect}`);
            reportStatusToManager('status', { status: 'disconnected_whatsapp', message: `Client ${CLIENT_ID} disconnected from WhatsApp (${reason}).` });
            if (statusCode === DisconnectReason.badSession) {
                console.error(`[${CLIENT_ID}] Bad session file. Clearing auth directory and requesting new QR.`);
                try {
                    if (fs.existsSync(AUTH_DIR)) {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                        console.log(`[${CLIENT_ID}] Successfully cleared auth directory due to bad session.`);
                    }
                    // إعلام المدير بأن هناك حاجة إلى QR جديد (قد يتطلب تعديل في كيفية إرسال هذه الحالة للمدير)
                    reportStatusToManager('status', { status: 'error_bad_session', message: `Client ${CLIENT_ID} has a bad session. Please relink.` });
                    // يجب أن تتوقف العملية هنا أو أن تنتظر أمرًا جديدًا للربط من المدير
                    // قد لا يكون استدعاء startClientBot() مباشرة هو الحل الأمثل هنا
                    // لأنها ستستمر في المحاولة بجلسة فارغة.
                    // الأفضل هو أن يتخذ المدير إجراءً (مثل إيقاف وإعادة تشغيل مع forceNewScan إذا لزم الأمر).
                    process.exit(1); // أو أي رمز خطأ يشير إلى الحاجة لتدخل
                } catch (e) {
                    console.error(`[${CLIENT_ID}_ERROR] Failed to clear auth directory for bad session:`, e);
                }
            } else if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[${CLIENT_ID}] Logged out by WhatsApp. Clearing auth and exiting.`);
                try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) { console.error(`[${CLIENT_ID}] Error cleaning auth dir:`, e.message); }
                reportStatusToManager('status', { status: 'disconnected_logout', message: `Client ${CLIENT_ID} logged out by WhatsApp.` });
                process.exit(0); // Exit cleanly
            } else if (shouldReconnect) {
                console.log(`[${CLIENT_ID}] Attempting to reconnect to WhatsApp in 5s...`);
                reportStatusToManager('status', { status: 'reconnecting_whatsapp', message: `Client ${CLIENT_ID} reconnecting to WhatsApp...` });
                setTimeout(() => startClientBot(), config.RECONNECT_DELAY_MS); // Use configured delay
            } else {
                console.error(`[${CLIENT_ID}] Unrecoverable WhatsApp connection error. Error: ${lastDisconnect?.error?.message}`);
                reportStatusToManager('status', { status: 'error_whatsapp_permanent', message: `Client ${CLIENT_ID} permanent WhatsApp connection error.` });
                process.exit(1); // Exit with error
            }
        } else if (connection === 'open') {
            const phoneNumber = jidNormalizedUser(sock.user?.id || '').split('@')[0];
            const clientName = sock.user?.name || `Client-${phoneNumber || CLIENT_ID.substring(0, 10)}`;
            console.log(`[${CLIENT_ID}] Connected to WhatsApp! Phone: ${phoneNumber}, Name: ${clientName}`);
            reportStatusToManager('status', {
                status: 'connected', message: `Client ${phoneNumber || CLIENT_ID} connected to WhatsApp.`,
                phoneNumber: phoneNumber, name: clientName,
            });

            if (!config.SKIP_API_SYNC_ON_RECONNECT || !global.initialApiSyncDone) { // Allow skipping if configured
                console.log(`[${CLIENT_ID}] Starting API sync for client-specific whitelist.`);
                await syncWhitelistFromApi();
                global.initialApiSyncDone = true;
            }
            if (global.apiSyncInterval) clearInterval(global.apiSyncInterval);
            global.apiSyncInterval = setInterval(syncWhitelistFromApi, config.API_SYNC_INTERVAL_MS);

        } else if (connection === 'connecting') {
            console.log(`[${CLIENT_ID}] WhatsApp connecting...`);
            reportStatusToManager('status', { status: 'connecting_whatsapp', message: `Client ${CLIENT_ID} connecting to WhatsApp...` });
        }
        // عند الاتصال، حاول ملء الذاكرة المؤقتة من جهات الاتصال الحالية (إذا كانت متوفرة)
        // هذه الخطوة اختيارية وقد تكون ثقيلة إذا كان هناك عدد كبير جداً من جهات الاتصال.
        // الاعتماد على 'contacts.upsert' أكثر فعالية للتحديثات المستمرة.
        if (sock.contacts) { // Check if sock.contacts is available and populated
            let initialCacheCount = 0;
            for (const jid in sock.contacts) {
                const contact = sock.contacts[jid];
                if (contact.id && contact.lid && contact.lid.user) {
                    const normalizedJid = jidNormalizedUser(contact.id);
                    const normalizedLid = jidNormalizedUser(`${contact.lid.user}@lid`);
                    if (normalizedJid.endsWith('@s.whatsapp.net')) {
                        lidToJidCache.set(normalizedLid, normalizedJid);
                        initialCacheCount++;
                    }
                }
            }
            if (initialCacheCount > 0) {
                console.log(`[${CLIENT_ID}_CACHE] Initialized LID-JID cache with ${initialCacheCount} contacts from sock.contacts. Cache size: ${lidToJidCache.size}`);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (upsert) => {
        if (upsert.type !== 'notify') return;
        console.log(`[${CLIENT_ID}] Received ${upsert.messages.length} new messages.`); // Can be very noisy
        for (const m of upsert.messages) {
            if (!m.key.fromMe) { // Process only incoming messages, not self-sent for commands
                //  await handleMessage(sock, m, { clientId: CLIENT_ID });
                // ---> مرر الذاكرة المؤقتة إلى معالج الرسائل
                await handleMessage(sock, m, { clientId: CLIENT_ID, lidToJidCache: lidToJidCache });
            }
        }

    });
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
            if (contact.id && contact.lid && contact.lid.user) { // تأكد من وجود JID و LID
                const jid = jidNormalizedUser(contact.id);
                const lid = jidNormalizedUser(`${contact.lid.user}@lid`); // توحيد صيغة LID
                if (jid.endsWith('@s.whatsapp.net')) { // تأكد أنه JID مستخدم وليس مجموعة
                    lidToJidCache.set(lid, jid);
                    // يمكنك أيضًا إنشاء jidToLidCache إذا احتجت للبحث العكسي
                    console.log(`[${CLIENT_ID}_CACHE] Cached LID ${lid} -> JID ${jid}`);
                }
            }
        }
        if (contacts.length > 0) {
            console.log(`[${CLIENT_ID}_CACHE] Updated LID-JID cache with ${contacts.length} contacts. Cache size: ${lidToJidCache.size}`);
        }
    });
}

// --- Main Execution ---
connectToManagerWebSocket(); // Connect to manager first
startClientBot().catch(err => {
    console.error(`[${CLIENT_ID}] Critical Error starting client bot:`, err.message, err.stack);
    reportStatusToManager('status', {
        status: 'error_startup', message: `Client bot ${CLIENT_ID} failed to start: ${err.message}`,
    });
    process.exit(1);
});
let isShuttingDown = false; // متغير لمنع عمليات الإغلاق المتعددة

const gracefulShutdown = async (signal) => {
console.log(`!!!!!!!!!!!!!!!!!!!!!!!! [${CLIENT_ID}] GRACEFUL SHUTDOWN CALLED WITH SIGNAL: ${signal} !!!!!!!!!!!!!!!!!!!!!!!!`); // <<-- سجل واضح جدًا
    if (isShuttingDown) {
        console.log(`[${CLIENT_ID}] Shutdown already in progress, ignoring duplicate ${signal}.`);
        return;
    }
    isShuttingDown = true;

    console.log(`[${CLIENT_ID}] Received ${signal}. Initiating graceful shutdown...`);

    // 1. إيقاف أي عمليات دورية (مثل polling)
    if (withdrawalRequestsPlugin && withdrawalRequestsPlugin.stopPollingOnShutdown) {
        withdrawalRequestsPlugin.stopPollingOnShutdown();
        console.log(`[${CLIENT_ID}] Polling stopped.`);
    }

    // 2. حفظ أي حالة معلقة (مثل pendingWithdrawals)
    if (withdrawalRequestsPlugin && withdrawalRequestsPlugin.savePendingOnShutdown) {
        try {
            await withdrawalRequestsPlugin.savePendingOnShutdown(); // افترض أنها قد تكون async
            console.log(`[${CLIENT_ID}] Pending state saved.`);
        } catch (e) {
            console.error(`[${CLIENT_ID}_ERROR] Failed to save pending state during shutdown:`, e);
        }
    }

    try {
        if (sock) {
            console.log(`[${CLIENT_ID}] Attempting to call sock.end()...`);
            sock.end(new Error(`Shutdown on ${signal}`));
            console.log(`[${CLIENT_ID}] sock.end() called.`);
        }
    } catch (e) {
        console.error(`[${CLIENT_ID}_SHUTDOWN_ERROR] Error during sock.end():`, e);
    }

    // 5. إعطاء مهلة قصيرة جداً لعمليات الحفظ والكتابة غير المتزامنة المحتملة
    //    قبل إنهاء العملية بشكل قسري.
    //    دالة saveCreds من Baileys هي غير متزامنة.
setTimeout(() => {
    console.log(`[${CLIENT_ID}] Graceful shutdown timeout reached. Exiting.`);
    process.exit(0);
}, 5000);  // زد هذه القيمة إذا لزم الأمر، ولكن لا تجعلها طويلة جدًا
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));