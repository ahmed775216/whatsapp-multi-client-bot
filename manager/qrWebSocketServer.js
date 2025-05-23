// manager/qrWebSocketServer.js
const WebSocket = require('ws');

let wss = null;
let csharpClientWs = null;
const clientBotWsMap = new Map();

let managerQrState = {
    qr: null,
    status: 'disconnected',
    message: 'Waiting for linking attempt...',
    linkingClientId: null
};

let onQrRequestedCallback = null;
let onManualRelinkCallback = null;
let onIncomingClientStatusCallback = null;
let onIncomingClientQrCallback = null;
// Removed onActivateClientWithApiCallback

function startWebSocketServer(port, callbacks = {}) {
    onQrRequestedCallback = callbacks.onQrRequested;
    onManualRelinkCallback = callbacks.onManualRelink;
    onIncomingClientStatusCallback = callbacks.onIncomingClientStatus;
    onIncomingClientQrCallback = callbacks.onIncomingClientQr;
    // Removed onActivateClientWithApiCallback assignment

    if (wss) { console.warn("[MGR_QR_WS] WebSocket server already running."); return; }

    wss = new WebSocket.Server({ port });
    console.log(`[MGR_QR_WS] WebSocket server for QR started on port ${port}`);

    wss.on('connection', (ws, req) => {
        const clientIP = req.socket.remoteAddress;
        console.log(`[MGR_QR_WS] Incoming connection from ${clientIP}.`);

        const initialMessageHandler = (message) => {
            ws.removeListener('message', initialMessageHandler);

            const msgStr = message.toString();
            let parsedMsg;
            try { parsedMsg = JSON.parse(msgStr); }
            catch (e) {
                console.error('[MGR_QR_WS] Error parsing initial message, closing connection:', e.message);
                ws.close(1008, "Invalid initial message format"); return;
            }

            // C# UI app connection
            if (parsedMsg.type === 'requestQr' || parsedMsg.type === 'manualRelink') {
                if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN && csharpClientWs !== ws) {
                    console.warn(`[MGR_QR_WS] Another C# UI client (${clientIP}) attempted to connect. Closing extra.`);
                    ws.close(1008, "Only one UI client allowed"); return;
                }
                csharpClientWs = ws;
                console.log(`[MGR_QR_WS] Designated C# UI client connected from ${clientIP}.`);
                csharpClientWs.send(JSON.stringify({ type: 'status', ...managerQrState }));

                // Extract API credentials from the message
                const apiUsername = parsedMsg.apiUsername || null;
                const apiPassword = parsedMsg.apiPassword || null;

                if (parsedMsg.type === 'requestQr' && onQrRequestedCallback) {
                    onQrRequestedCallback(apiUsername, apiPassword); // Pass credentials
                } else if (parsedMsg.type === 'manualRelink' && onManualRelinkCallback) {
                    onManualRelinkCallback(apiUsername, apiPassword); // Pass credentials
                }
                
                ws.on('message', handleCSharpUiMessage);
            }
            // Client Bot Instance connection
            else if (parsedMsg.clientId && parsedMsg.type && parsedMsg.data) {
                const { clientId, data } = parsedMsg;
                console.log(`[MGR_QR_WS] Client Bot Instance ${clientId} connected from ${clientIP}.`);
                clientBotWsMap.set(clientId, ws);
                if (parsedMsg.type === 'status' && onIncomingClientStatusCallback) onIncomingClientStatusCallback(clientId, data);
                else if (parsedMsg.type === 'qr' && onIncomingClientQrCallback) onIncomingClientQrCallback(clientId, data);
                
                ws.on('message', (subsequentMessage) => handleClientBotMessage(clientId, subsequentMessage));
            } else {
                console.warn(`[MGR_QR_WS] Unidentified connection from ${clientIP} after first message. Msg: ${msgStr}. Closing.`);
                ws.close(1008, "Unidentified client type after first message");
            }
        };

        ws.on('message', initialMessageHandler);

        ws.on('close', () => {
            console.log(`[MGR_QR_WS] Client disconnected from ${clientIP}.`);
            if (ws === csharpClientWs) {
                csharpClientWs = null;
                console.log('[MGR_QR_WS] C# UI client disconnected. Manager QR state is now floating.');
            } else {
                for (let [clientId, clientWsInMap] of clientBotWsMap.entries()) {
                    if (clientWsInMap === ws) {
                        clientBotWsMap.delete(clientId);
                        console.log(`[MGR_QR_WS] Client bot ${clientId} disconnected.`);
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
    try {
        const parsedMsg = JSON.parse(msgStr);
        // If C# UI sends subsequent commands other than initial request/relink
        // They would be handled here. No new commands needed for this flow.
        console.warn(`[MGR_QR_WS] Unhandled subsequent message type from C# UI: ${parsedMsg.type}`);
    } catch (e) {
        console.error(`[MGR_QR_WS] Failed to parse subsequent message from C# UI:`, e);
    }
}

function handleClientBotMessage(clientId, message) {
    const msgStr = message.toString();
    try {
        const parsedMsg = JSON.parse(msgStr);
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

function updateManagerQrState(status, message, qr = null, clientId = null, phoneNumber = null, clientName = null, isLinkingProcess = false) {
    if (isLinkingProcess) {
        managerQrState.linkingClientId = clientId;
    }

    managerQrState.status = status;
    managerQrState.message = message;
    managerQrState.qr = qr;

    const payload = {
        type: 'status',
        status: status,
        message: message,
        qr: qr,
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

    if (managerQrState.linkingClientId && (status === 'connected' || status === 'error' || status === 'disconnected_logout' || status === 'linking_failed')) {
        if (clientId === managerQrState.linkingClientId) {
            console.log(`[MGR_QR_WS] Clearing linkingClientId: ${managerQrState.linkingClientId} as process ended with ${status}.`);
            managerQrState.linkingClientId = null;
        }
    }
}

function resetManagerLinkingDisplay() {
    managerQrState.linkingClientId = null;
    updateManagerQrState('disconnected', 'Waiting for new linking attempt...');
}

module.exports = {
    startWebSocketServer,
    updateManagerQrState,
    resetManagerLinkingDisplay,
    managerQrState,
};