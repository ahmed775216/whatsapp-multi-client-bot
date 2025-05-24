// manager/qrWebSocketServer.js
const WebSocket = require('ws');

let wss = null;
let csharpClientWs = null;
const clientBotWsMap = new Map(); // Maps clientId to WebSocket instance

let managerQrState = {
    qr: null,
    status: 'disconnected',
    message: 'Waiting for linking attempt...',
    linkingClientId: null
};

// Callbacks (will be set by manager.js)
let onQrRequestedCallback = null;
let onManualRelinkCallback = null;
let onIncomingClientStatusCallback = null;
let onIncomingClientQrCallback = null;
let onListInstancesCallback = null;
let onStartInstanceCallback = null;
let onStopInstanceCallback = null;
let onRestartInstanceCallback = null;
let onDeleteInstanceCallback = null; // NEW: Delete instance
let onGetLogsCallback = null;
let onFetchGroupsCallback = null; // NEW: Fetch groups
let onAddChatToWhitelistCallback = null; // NEW: Add chat to whitelist
let onFetchParticipantsCallback = null; // NEW: Fetch participants

function startWebSocketServer(port, callbacks = {}) {
    onQrRequestedCallback = callbacks.onQrRequested;
    onManualRelinkCallback = callbacks.onManualRelink;
    onIncomingClientStatusCallback = callbacks.onIncomingClientStatus;
    onIncomingClientQrCallback = callbacks.onIncomingClientQr;
    onListInstancesCallback = callbacks.onListInstances;
    onStartInstanceCallback = callbacks.onStartInstance;
    onStopInstanceCallback = callbacks.onStopInstance;
    onRestartInstanceCallback = callbacks.onRestartInstance;
    onDeleteInstanceCallback = callbacks.onDeleteInstance; // Assign NEW callback
    onGetLogsCallback = callbacks.onGetLogs;
    onFetchGroupsCallback = callbacks.onFetchGroups; // Assign NEW callback
    onAddChatToWhitelistCallback = callbacks.onAddChatToWhitelist; // Assign NEW callback
    onFetchParticipantsCallback = callbacks.onFetchParticipants; // Assign NEW callback

    if (wss) { console.warn("[MGR_QR_WS] WebSocket server already running."); return; }

    wss = new WebSocket.Server({ port: port, host: '0.0.0.0' });

    console.log(`[MGR_QR_WS] WebSocket server for QR started on port ${port} and binding to 0.0.0.0`);

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
            
            // C# UI Client identification: If message type is known UI command or it's 'status' without clientId from bot
            if (['requestQr', 'manualRelink', 'listInstances', 'startInstance', 'stopInstance', 'restartInstance', 'deleteInstance', 'getLogs', 'fetchGroups', 'addChatToWhitelist', 'fetchParticipants'].includes(parsedMsg.type) || (parsedMsg.type === 'status' && !parsedMsg.clientId))
            {
                if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN && csharpClientWs !== ws) {
                    console.warn(`[MGR_QR_WS] Another C# UI client (${clientIP}) attempted to connect. Closing extra.`);
                    ws.close(1008, "Only one UI client allowed"); return;
                }
                csharpClientWs = ws;
                console.log(`[MGR_QR_WS] Designated C# UI client connected from ${clientIP}.`);
                csharpClientWs.send(JSON.stringify({ type: 'status', ...managerQrState })); // Send current manager state
                
                // Handle initial command from C#
                handleCSharpUiCommand(ws, parsedMsg);
                
                ws.on('message', (subsequentMessage) => handleCSharpUiCommand(ws, JSON.parse(subsequentMessage.toString())));
            }
            // Client Bot Instance identification: Has a clientId and a type/data structure
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
                // Remove the client bot from map
                for (let [clientId, clientWsInMap] of clientBotWsMap.entries()) {
                    if (clientWsInMap === ws) {
                        clientBotWsMap.delete(clientId);
                        console.log(`[MGR_QR_WS] Client bot ${clientId} disconnected.`);
                        
                        // If it's the currently linking client and it disconnected unexpectedly
                        if (clientId === managerQrState.linkingClientId) {
                            // Check if the current client is tracked as 'connected' before setting 'linking_failed'
                            // This prevents setting linking_failed if the client already reported 'connected' and we were promoting it.
                            const instanceManager = require('./instanceManager'); // Dynamic import to avoid circular dependency
                            const instanceData = instanceManager.ACTIVE_BOT_INSTANCES[clientId];
                            if (!instanceData || (instanceData && instanceData.status !== 'connected' && instanceData.status !== 'stopping')) {
                                updateManagerQrState('linking_failed', 'QR linking process disconnected unexpectedly.', null, clientId, null, null, true);
                            }
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
    const { type, clientId, apiUsername, apiPassword, ownerNumber, groupId, ...otherData } = parsedMsg; // Destructure groupId

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
        case 'deleteInstance': // NEW CASE
            if (onDeleteInstanceCallback && clientId) onDeleteInstanceCallback(clientId);
            break;
        case 'getLogs':
            if (onGetLogsCallback && clientId) onGetLogsCallback(ws, clientId);
            break;
        case 'fetchGroups': // NEW CASE
            if (onFetchGroupsCallback && clientId) onFetchGroupsCallback(clientId);
            break;
        case 'addChatToWhitelist': // NEW CASE
            if (onAddChatToWhitelistCallback && clientId && groupId) onAddChatToWhitelistCallback(clientId, groupId);
            break;
        case 'fetchParticipants': // NEW CASE
            if (onFetchParticipantsCallback && clientId && groupId) onFetchParticipantsCallback(clientId, groupId);
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
        if (parsedMsg.type === 'internalReply') { // NEW: Handle replies from bot
            console.log(`[MGR_QR_WS] Received internal reply from bot ${clientId}:`, parsedMsg.data);
            // Forward this data directly to the C# UI
            if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
                // The `data` property of `internalReply` already contains the `type` and `clientId` that the C# UI expects for routing.
                // So, we forward `parsedMsg.data` directly, potentially adding the main `clientId` for robustness.
                const forwardedPayload = { ...parsedMsg.data, clientId: parsedMsg.clientId }; // Ensure clientId is always in the root
                csharpClientWs.send(JSON.stringify(forwardedPayload));
            } else {
                console.warn(`[MGR_QR_WS] C# UI not connected, cannot receive internal reply from ${clientId}.`);
            }
        }
        else if (parsedMsg.type === 'qr' && onIncomingClientQrCallback) {
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
        // Only include clientId, phoneNumber, name if it's connected or explicitly a linking process.
        // This helps C# differentiate general manager status from client-specific status.
        clientId: (status === 'connected' || isLinkingProcess) ? clientId : null,
        phoneNumber: status === 'connected' ? phoneNumber : null,
        name: status === 'connected' ? clientName : null,
    };

    if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
        csharpClientWs.send(JSON.stringify(payload));
        console.log(`[MGR_QR_WS] Broadcasted to C# UI: status=${status}, msg=${message}, QR=${qr ? 'YES' : 'NO'}, activeLinkingCID=${managerQrState.linkingClientId}, payloadCID=${payload.clientId}`);
    } else {
        console.warn(`[MGR_QR_WS] C# UI client not connected, cannot report ${status}.`);
    }

    // CRITICAL FIX: Ensure linkingClientId is cleared on successful connection.
    if (managerQrState.linkingClientId && (status === 'connected' || status === 'error' || status === 'disconnected_logout' || status === 'linking_failed')) {
        if (clientId === managerQrState.linkingClientId) {
            if (status === 'connected') { // Successfully connected, clear it permanently.
                 console.log(`[MGR_QR_WS] Linked client ${clientId} is now permanently connected. Resetting managerQrState.linkingClientId.`);
            } else { // Failed/error/logout for the linking client, clear it.
                console.log(`[MGR_QR_WS] Linking for ${clientId} failed with status ${status}. Clearing managerQrState.linkingClientId.`);
            }
            managerQrState.linkingClientId = null; // Clear regardless of outcome if it was the target
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
    clientBotWsMap // Export this map so instanceManager can send direct commands
};