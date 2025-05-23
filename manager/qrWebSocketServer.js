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
let onListInstancesCallback = null;
let onStartInstanceCallback = null;
let onStopInstanceCallback = null;
let onRestartInstanceCallback = null;
let onGetLogsCallback = null;


function startWebSocketServer(port, callbacks = {}) {
    onQrRequestedCallback = callbacks.onQrRequested;
    onManualRelinkCallback = callbacks.onManualRelink;
    onIncomingClientStatusCallback = callbacks.onIncomingClientStatus;
    onIncomingClientQrCallback = callbacks.onIncomingClientQr;
    onListInstancesCallback = callbacks.onListInstances;
    onStartInstanceCallback = callbacks.onStartInstance;
    onStopInstanceCallback = callbacks.onStopInstance;
    onRestartInstanceCallback = callbacks.onRestartInstance;
    onGetLogsCallback = callbacks.onGetLogs;

    if (wss) { console.warn("[MGR_QR_WS] WebSocket server already running."); return; }

    // --- CRITICAL FIX: Explicitly bind to '0.0.0.0' for external access ---
    wss = new WebSocket.Server({ port: port, host: '0.0.0.0' }); // Added host option
    // --- END CRITICAL FIX ---

    console.log(`[MGR_QR_WS] WebSocket server for QR started on port ${port} and binding to 0.0.0.0`); // Updated log

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

            if (parsedMsg.type === 'requestQr' || parsedMsg.type === 'manualRelink' ||
                parsedMsg.type === 'listInstances' || parsedMsg.type === 'startInstance' ||
                parsedMsg.type === 'stopInstance' || parsedMsg.type === 'restartInstance' ||
                parsedMsg.type === 'getLogs')
            {
                if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN && csharpClientWs !== ws) {
                    console.warn(`[MGR_QR_WS] Another C# UI client (${clientIP}) attempted to connect. Closing extra.`);
                    ws.close(1008, "Only one UI client allowed"); return;
                }
                csharpClientWs = ws;
                console.log(`[MGR_QR_WS] Designated C# UI client connected from ${clientIP}.`);
                csharpClientWs.send(JSON.stringify({ type: 'status', ...managerQrState }));

                handleCSharpUiCommand(ws, parsedMsg);
                
                ws.on('message', (subsequentMessage) => handleCSharpUiCommand(ws, JSON.parse(subsequentMessage.toString())));
            }
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

function handleCSharpUiCommand(ws, parsedMsg) {
    const { type, clientId, apiUsername, apiPassword, ownerNumber, ...otherData } = parsedMsg;

    switch (type) {
        case 'requestQr':
            if (onQrRequestedCallback) onQrRequestedCallback(apiUsername, apiPassword, ownerNumber);
            break;
        case 'manualRelink':
            if (onManualRelinkCallback) onManualRelinkCallback(apiUsername, apiPassword, ownerNumber);
            break;
        case 'listInstances':
            if (onListInstancesCallback) onListInstancesCallback(ws);
            break;
        case 'startInstance':
            if (onStartInstanceCallback && clientId) onStartInstanceCallback(clientId);
            break;
        case 'stopInstance':
            if (onStopInstanceCallback && clientId) onStopInstanceCallback(clientId);
            break;
        case 'restartInstance':
            if (onRestartInstanceCallback && clientId) onRestartInstanceCallback(clientId);
            break;
        case 'getLogs':
            if (onGetLogsCallback && clientId) onGetLogsCallback(ws, clientId);
            break;
        default:
            console.warn(`[MGR_QR_WS] Unhandled message type from C# UI: ${type}`);
            break;
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

function notifyInstanceStatusChange(clientId, status, phoneNumber = null, name = null) {
    const payload = {
        type: 'instanceStatusUpdate',
        clientId: clientId,
        status: status,
        phoneNumber: phoneNumber,
        name: name,
        timestamp: new Date().toISOString()
    };
    if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
        csharpClientWs.send(JSON.stringify(payload));
        console.log(`[MGR_QR_WS] Notified C# UI about instance ${clientId} status: ${status}`);
    } else {
        console.warn(`[MGR_QR_WS] C# UI client not connected, cannot send instance status update for ${clientId}.`);
    }
}

function sendToClient(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    } else {
        console.warn('[MGR_QR_WS] Cannot send message to client, WebSocket is not open.');
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
    notifyInstanceStatusChange,
    sendToClient,
};