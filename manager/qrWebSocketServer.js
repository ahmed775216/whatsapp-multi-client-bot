// manager/qrWebSocketServer.js
const WebSocket = require('ws');

let wss = null;
let csharpClientWs = null; // Stricter: ONLY for the C# UI client
const clientBotWsMap = new Map(); // Map: clientId -> ws

let managerQrState = { // Tracks current state of the linking process displayed to C# UI
    qr: null,
    status: 'disconnected',
    message: 'Waiting for linking attempt...',
    linkingClientId: null // ID of the client bot instance currently trying to link (showing QR)
};

let onQrRequestedCallback = null;
let onManualRelinkCallback = null;
let onIncomingClientStatusCallback = null;
let onIncomingClientQrCallback = null;

function startWebSocketServer(port, callbacks = {}) {
    onQrRequestedCallback = callbacks.onQrRequested;
    onManualRelinkCallback = callbacks.onManualRelink;
    onIncomingClientStatusCallback = callbacks.onIncomingClientStatus;
    onIncomingClientQrCallback = callbacks.onIncomingClientQr;

    if (wss) { console.warn("[MGR_QR_WS] WebSocket server already running."); return; }

    wss = new WebSocket.Server({ port });
    console.log(`[MGR_QR_WS] WebSocket server for QR started on port ${port}`);

    wss.on('connection', (ws, req) => {
        const clientIP = req.socket.remoteAddress;
        console.log(`[MGR_QR_WS] Incoming connection from ${clientIP}.`);

        // Temporary handler for the FIRST message to identify the client type
        const initialMessageHandler = (message) => {
            ws.removeListener('message', initialMessageHandler); // Remove self after first message

            const msgStr = message.toString();
            let parsedMsg;
            try { parsedMsg = JSON.parse(msgStr); }
            catch (e) {
                console.error('[MGR_QR_WS] Error parsing initial message, closing connection:', e.message);
                ws.close(1008, "Invalid initial message format"); return;
            }

            // --- If it's a C# UI app connection ---
            if (parsedMsg.type === 'requestQr' || parsedMsg.type === 'manualRelink') {
                if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN && csharpClientWs !== ws) {
                    console.warn(`[MGR_QR_WS] Another C# UI client (${clientIP}) attempted to connect. Closing extra.`);
                    ws.close(1008, "Only one UI client allowed"); return;
                }
                csharpClientWs = ws;
                console.log(`[MGR_QR_WS] Designated C# UI client connected from ${clientIP}.`);
                // Send current manager state immediately
                csharpClientWs.send(JSON.stringify({ type: 'status', ...managerQrState }));
                // Process the C# UI's request
                if (parsedMsg.type === 'requestQr' && onQrRequestedCallback) onQrRequestedCallback();
                else if (parsedMsg.type === 'manualRelink' && onManualRelinkCallback) onManualRelinkCallback();
                
                // Set up permanent message handler for C# UI (if it sends more commands)
                ws.on('message', handleCSharpUiMessage);
            }
            // --- If it's a Client Bot Instance connection ---
            else if (parsedMsg.clientId && parsedMsg.type === 'status' && parsedMsg.data && parsedMsg.data.status) {
                const { clientId, data } = parsedMsg;
                console.log(`[MGR_QR_WS] Client Bot Instance ${clientId} connected from ${clientIP}.`);
                clientBotWsMap.set(clientId, ws); // Store its WebSocket
                if (onIncomingClientStatusCallback) onIncomingClientStatusCallback(clientId, data); // Process initial status
                // Set up permanent message handler for this client bot
                ws.on('message', (subsequentMessage) => handleClientBotMessage(clientId, subsequentMessage));
            } else {
                console.warn(`[MGR_QR_WS] Unidentified connection from ${clientIP} after first message. Msg: ${msgStr}. Closing.`);
                ws.close(1008, "Unidentified client type after first message");
            }
        };

        ws.on('message', initialMessageHandler); // Attach the initial handler

        ws.on('close', () => {
            console.log(`[MGR_QR_WS] Client disconnected from ${clientIP}.`);
            if (ws === csharpClientWs) {
                csharpClientWs = null;
                console.log('[MGR_QR_WS] C# UI client disconnected. Manager QR state is now floating.');
            } else { // Check if it was a client bot
                for (let [clientId, clientWsInMap] of clientBotWsMap.entries()) {
                    if (clientWsInMap === ws) {
                        clientBotWsMap.delete(clientId);
                        console.log(`[MGR_QR_WS] Client bot ${clientId} disconnected.`);
                        // If the disconnected client was the one currently linking, update UI
                        if (clientId === managerQrState.linkingClientId) {
                            updateManagerQrState('linking_failed', 'QR linking process disconnected unexpectedly.', null, clientId, null, null, true);
                        }
                        break;
                    }
                }
            }
        });
        ws.on('error', (error) => console.error('[MGR_QR_WS] WebSocket client error:', error.message));
    });
    wss.on('error', (error) => console.error('[MGR_QR_WS] WebSocket Server Error (fatal):', error));
}

function handleCSharpUiMessage(message) {
    const msgStr = message.toString();
    // C# UI typically sends requestQr/manualRelink (handled by initialMessageHandler)
    // If it sends other commands, handle them here.
    // console.log(`[MGR_QR_WS] Subsequent message from C# UI: ${msgStr}`);
}

function handleClientBotMessage(clientId, message) {
    const msgStr = message.toString();
    try {
        const parsedMsg = JSON.parse(msgStr);
        // Ensure clientId matches the stored one for this ws connection (security/sanity check)
        if (parsedMsg.clientId !== clientId) {
            console.warn(`[MGR_QR_WS] ClientId mismatch in message from bot. Expected ${clientId}, got ${parsedMsg.clientId}. Ignoring.`);
            return;
        }
        if (parsedMsg.type === 'qr' && onIncomingClientQrCallback) {
            onIncomingClientQrCallback(parsedMsg.clientId, parsedMsg.data);
        } else if (parsedMsg.type === 'status' && onIncomingClientStatusCallback) {
            onIncomingClientStatusCallback(parsedMsg.clientId, parsedMsg.data);
        } else {
            console.warn(`[MGR_QR_WS] Unhandled message type from bot ${clientId}: ${parsedMsg.type}`);
        }
    } catch (e) {
        console.error(`[MGR_QR_WS] Failed to parse message from bot ${clientId}:`, e);
    }
}

// ... (updateManagerQrState and resetManagerLinkingDisplay are the same) ...
function updateManagerQrState(status, message, qr = null, clientId = null, phoneNumber = null, clientName = null, isLinkingProcess = false) {
    // Only update linkingClientId if this is an active linking process
    if (isLinkingProcess) {
        managerQrState.linkingClientId = clientId;
    }

    // Set main display state
    managerQrState.status = status;
    managerQrState.message = message;
    managerQrState.qr = qr; // QR is null for final states or non-QR states

    const payload = {
        type: 'status',
        status: status,
        message: message,
        qr: qr,
        // Only send specific client details when explicitly connected, or when part of the linking process
        clientId: (status === 'connected' || isLinkingProcess) ? clientId : null,
        phoneNumber: status === 'connected' ? phoneNumber : null,
        name: status === 'connected' ? clientName : null,
    };

    if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
        csharpClientWs.send(JSON.stringify(payload));
        console.log(`[MGR_QR_WS] Broadcasted to C# UI: status=${status}, msg=${message}, QR=${qr ? 'YES' : 'NO'}, activeLinkingCID=${managerQrState.linkingClientId}, payloadCID=${payload.clientId}`);
    } else {
        console.warn(`[MGR_QR_WS] C# UI client not connected, cannot broadcast ${status}.`);
    }

    // Clear linkingClientId if the process displayed on UI has reached a terminal state
    if (managerQrState.linkingClientId && (status === 'connected' || status === 'error' || status === 'disconnected_logout' || status === 'linking_failed')) {
        // If the status is for the *current* linking client being tracked by the UI
        if (clientId === managerQrState.linkingClientId) {
             console.log(`[MGR_QR_WS] Clearing linkingClientId: ${managerQrState.linkingClientId} as process ended with ${status}.`);
             managerQrState.linkingClientId = null;
        }
    }
}

function resetManagerLinkingDisplay() {
    managerQrState.linkingClientId = null; // Ensure this is cleared
    updateManagerQrState('disconnected', 'Waiting for new linking attempt...');
}

module.exports = {
    startWebSocketServer,
    updateManagerQrState,
    resetManagerLinkingDisplay,
};