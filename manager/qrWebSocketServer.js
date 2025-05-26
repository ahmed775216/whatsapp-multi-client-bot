// manager/qrWebSocketServer.js
const WebSocket = require('ws');

let wss = null;
let csharpClientWs = null;
const clientBotWsMap = new Map(); // Maps clientId to WebSocket connection of the bot instance

let managerQrState = {
    qr: null,
    status: 'disconnected',
    message: 'Waiting for linking attempt...',
    linkingClientId: null
};

// Callbacks (assigned from manager.js)
let onQrRequestedCallback = null;
let onManualRelinkCallback = null;
let onIncomingClientStatusCallback = null;
let onIncomingClientQrCallback = null;
let onListInstancesCallback = null;
let onStartInstanceCallback = null;
let onStopInstanceCallback = null;
let onRestartInstanceCallback = null;
let onDeleteInstanceCallback = null;
let onGetLogsCallback = null;
let onFetchGroupsCallback = null;
let onAddChatToWhitelistCallback = null;
let onRemoveFromChatWhitelistCallback = null;
let onFetchParticipantsCallback = null;


function startWebSocketServer(port, callbacks = {}) {
    onQrRequestedCallback = callbacks.onQrRequested;
    onManualRelinkCallback = callbacks.onManualRelink;
    onIncomingClientStatusCallback = callbacks.onIncomingClientStatus;
    onIncomingClientQrCallback = callbacks.onIncomingClientQr;
    onListInstancesCallback = callbacks.onListInstances;
    onStartInstanceCallback = callbacks.onStartInstance;
    onStopInstanceCallback = callbacks.onStopInstance;
    onRestartInstanceCallback = callbacks.onRestartInstance;
    onDeleteInstanceCallback = callbacks.onDeleteInstance;
    onGetLogsCallback = callbacks.onGetLogs;
    onFetchGroupsCallback = callbacks.onFetchGroups;
    onAddChatToWhitelistCallback = callbacks.onAddChatToWhitelist;
    onRemoveFromChatWhitelistCallback = callbacks.onRemoveFromChatWhitelist;
    onFetchParticipantsCallback = callbacks.onFetchParticipants;

    if (wss) { console.warn("[MGR_QR_WS] WebSocket server already running."); return; }

    wss = new WebSocket.Server({ port: port, host: '0.0.0.0' });
    console.log(`[MGR_QR_WS] WebSocket server for QR started on port ${port} and binding to 0.0.0.0`);

    wss.on('connection', (ws, req) => {
        const clientIP = req.socket.remoteAddress;
        console.log(`[MGR_QR_WS] Incoming connection from ${clientIP}.`);

        const initialMessageHandler = (message) => {
            ws.removeListener('message', initialMessageHandler); // Process only the first message with this handler

            const msgStr = message.toString();
            let parsedMsg;
            try { parsedMsg = JSON.parse(msgStr); }
            catch (e) {
                console.error('[MGR_QR_WS] Error parsing initial message, closing connection:', e.message);
                ws.close(1008, "Invalid initial message format"); return;
            }

            // Identify C# UI client
            if (parsedMsg.type === 'requestQr' || parsedMsg.type === 'manualRelink' ||
                parsedMsg.type === 'listInstances' || parsedMsg.type === 'startInstance' ||
                parsedMsg.type === 'stopInstance' || parsedMsg.type === 'restartInstance' ||
                parsedMsg.type === 'deleteInstance' || parsedMsg.type === 'getLogs' ||
                parsedMsg.type === 'fetchGroups' || parsedMsg.type === 'addChatToWhitelist' ||
                parsedMsg.type === 'removeFromChatWhitelist' || parsedMsg.type === 'fetchParticipants')
            {
                if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN && csharpClientWs !== ws) {
                    console.warn(`[MGR_QR_WS] Another C# UI client (${clientIP}) attempted to connect. Closing extra.`);
                    ws.close(1008, "Only one UI client allowed"); return;
                }
                csharpClientWs = ws;
                console.log(`[MGR_QR_WS] Designated C# UI client connected from ${clientIP}.`);
                csharpClientWs.send(JSON.stringify({ type: 'status', ...managerQrState }));
                handleCSharpUiCommand(ws, parsedMsg); // Process the initial command
                ws.on('message', (subsequentMessage) => {
                    try {
                        handleCSharpUiCommand(ws, JSON.parse(subsequentMessage.toString()));
                    } catch (jsonErr) {
                        console.error(`[MGR_QR_WS_ERROR] C# UI Subsequent message JSON parse error: ${jsonErr.message}. Raw: ${subsequentMessage.toString().substring(0,100)}`);
                    }
                });
            }
            // Identify Node.js Client Bot Instance
            else if (parsedMsg.clientId && (parsedMsg.type === 'status' || parsedMsg.type === 'qr' || parsedMsg.type === 'internalReply'))
            {
                const { clientId } = parsedMsg; // clientId is at top level of parsedMsg
                const dataPayload = parsedMsg.data; // The actual content (QR string, status object) is in parsedMsg.data

                if (!clientBotWsMap.has(clientId) || clientBotWsMap.get(clientId) !== ws) {
                    console.log(`[MGR_QR_WS] Client Bot Instance ${clientId} connected from ${clientIP}.`);
                    clientBotWsMap.set(clientId, ws);
                }

                // Process the initial message from the bot using its data payload
                if (parsedMsg.type === 'status' && onIncomingClientStatusCallback) {
                    onIncomingClientStatusCallback(clientId, dataPayload);
                } else if (parsedMsg.type === 'qr' && onIncomingClientQrCallback) {
                    onIncomingClientQrCallback(clientId, dataPayload); // dataPayload here is the QR string
                } else if (parsedMsg.type === 'internalReply') {
                    handleClientBotInternalReply(clientId, parsedMsg); // Pass the whole parsedMsg for internalReply
                }

                // Set up listener for SUBSEQUENT messages from this bot instance
                ws.on('message', (subsequentMessage) => {
                    try {
                        const subParsedMsg = JSON.parse(subsequentMessage.toString());
                        if (subParsedMsg.clientId === clientId) { // Ensure message is from the expected client
                            const subDataPayload = subParsedMsg.data; // Content is in subParsedMsg.data
                            if (subParsedMsg.type === 'status' && onIncomingClientStatusCallback) {
                                onIncomingClientStatusCallback(clientId, subDataPayload);
                            } else if (subParsedMsg.type === 'qr' && onIncomingClientQrCallback) {
                                onIncomingClientQrCallback(clientId, subDataPayload); // subDataPayload is the QR string
                            } else if (subParsedMsg.type === 'internalReply') {
                                handleClientBotInternalReply(clientId, subParsedMsg);
                            } else {
                                console.warn(`[MGR_QR_WS] Unhandled subsequent message type ${subParsedMsg.type} from bot ${clientId}. Raw: ${subsequentMessage.toString().substring(0,100)}`);
                            }
                        } else {
                             console.warn(`[MGR_QR_WS] Subsequent message clientId mismatch. Expected ${clientId}, got ${subParsedMsg.clientId}. Raw: ${subsequentMessage.toString().substring(0,100)}`);
                        }
                    } catch (jsonErr) {
                        console.error(`[MGR_QR_WS_ERROR] Bot subsequent message JSON parse error: ${jsonErr.message}. Raw: ${subsequentMessage.toString().substring(0,100)}`);
                    }
                });
            } else {
                console.warn(`[MGR_QR_WS] Unidentified connection from ${clientIP} after first message. Msg: ${msgStr.substring(0,100)}. Closing.`);
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
                             // Don't immediately update to linking_failed if bot disconnects.
                             // The manager instance will determine the final status (e.g. if it's a graceful exit or error)
                             // updateManagerQrState('linking_failed', 'QR linking process disconnected unexpectedly.', null, clientId, null, null, true);
                             console.log(`[MGR_QR_WS] Linking client ${clientId} WebSocket disconnected. Manager will handle status.`);
                        }
                        // Notify instanceManager that the WS for this client is gone
                        if (onIncomingClientStatusCallback) { // Use a generic status or specific 'ws_disconnected'
                            onIncomingClientStatusCallback(clientId, { status: 'disconnected_manager_ws', message: `Client ${clientId} WS connection to manager closed.` });
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
    const { type, clientId, apiUsername, apiPassword, ownerNumber, groupId, participantJid, ...otherData } = parsedMsg;

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
        case 'deleteInstance':
            if (onDeleteInstanceCallback && clientId) onDeleteInstanceCallback(clientId);
            break;
        case 'getLogs':
            if (onGetLogsCallback && clientId) onGetLogsCallback(ws, clientId);
            break;
        case 'fetchGroups':
            if (onFetchGroupsCallback && clientId) onFetchGroupsCallback(clientId);
            break;
        case 'addChatToWhitelist':
            const jidToAdd = groupId || participantJid;
            if (onAddChatToWhitelistCallback && clientId && jidToAdd) onAddChatToWhitelistCallback(clientId, jidToAdd);
            break;
        case 'removeFromChatWhitelist':
            const jidToRemove = groupId || participantJid;
            if (onRemoveFromChatWhitelistCallback && clientId && jidToRemove) onRemoveFromChatWhitelistCallback(clientId, jidToRemove);
            break;
        case 'fetchParticipants':
            if (onFetchParticipantsCallback && clientId && groupId) onFetchParticipantsCallback(clientId, groupId);
            break;
        default:
            console.warn(`[MGR_QR_WS] Unhandled message type from C# UI: ${type}. Full message:`, parsedMsg);
            break;
    }
}

// Renamed to be specific for internal replies from bot client
function handleClientBotInternalReply(clientId, parsedMsg) {
    if (parsedMsg.clientId !== clientId) {
        console.warn(`[MGR_QR_WS] ClientId mismatch in internalReply from bot. Expected ${clientId}, got ${parsedMsg.clientId}. Ignoring.`);
        return;
    }

    if (parsedMsg.type === 'internalReply') {
        console.log(`[MGR_QR_WS] Received internal reply from bot ${clientId} for command type: ${parsedMsg.data?.type || 'unknown'}. Forwarding to C# UI.`);
        if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
            // Forward the 'data' part of the internalReply, which contains the actual response payload for UI
            csharpClientWs.send(JSON.stringify(parsedMsg.data));
        } else {
            console.warn(`[MGR_QR_WS] C# UI not connected, cannot forward internal reply from bot ${clientId}.`);
        }
    } else {
        // This function is now more specific. Other types are handled by callbacks.
        console.warn(`[MGR_QR_WS] handleClientBotInternalReply received unexpected type: ${parsedMsg.type} from bot ${clientId}.`)
    }
}

function updateManagerQrState(status, message, qr = null, clientId = null, phoneNumber = null, clientName = null, isLinkingProcess = false) {
    if (isLinkingProcess) {
        managerQrState.linkingClientId = clientId; // Track which client is currently being linked on the UI
    }

    managerQrState.status = status;
    managerQrState.message = message;
    managerQrState.qr = qr; // Store the latest QR in manager's state

    const payload = {
        type: 'status', // All UI updates regarding linking flow through 'status' type
        status: status, // The specific sub-status (e.g., 'qr', 'connected', 'linking_in_progress')
        message: message,
        qr: qr,         // The actual QR string, or null
        clientId: (status === 'connected' || isLinkingProcess) ? clientId : null, // Relevant for linking or connected state
        phoneNumber: status === 'connected' ? phoneNumber : null,
        name: status === 'connected' ? clientName : null,
    };
    
    console.log(`[MGR_QR_WS_DEBUG] Broadcasting to C# UI: payload=`, JSON.stringify(payload).substring(0,200));


    if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
        try {
            csharpClientWs.send(JSON.stringify(payload));
        } catch (sendError) {
            console.error(`[MGR_QR_WS_ERROR] Failed to send to C# UI: ${sendError.message}`);
        }
    }

    // Logic for clearing linkingClientId after a terminal linking state.
    // This should ideally be signaled by instanceManager once the permanent client is confirmed.
    if (managerQrState.linkingClientId && clientId === managerQrState.linkingClientId) {
        if (status === 'connected') { // 'connected' is the status sent by clientBotApp upon successful WA connection
            console.log(`[MGR_QR_WS] Client ${clientId} successfully linked and reported 'connected'. Manager may reset linking state soon.`);
            // instanceManager will call resetManagerLinkingDisplay() after finalizing the permanent client.
        } else if (status === 'disconnected_logout' || status === 'error_whatsapp_permanent' || status === 'linking_failed' || status === 'error_startup') {
            console.log(`[MGR_QR_WS] Linking for ${clientId} ended with status ${status}. Resetting linkingClientId.`);
            managerQrState.linkingClientId = null; // Reset here for immediate UI update on failure
            // Consider if an additional specific message should be sent to UI for linking_failed reset.
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
        try {
            csharpClientWs.send(JSON.stringify(payload));
        } catch (sendError) {
             console.error(`[MGR_QR_WS_ERROR] Failed to send instanceStatusUpdate to C# UI: ${sendError.message}`);
        }
    }
}

function sendToClient(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(data));
        } catch (sendError) {
            console.error(`[MGR_QR_WS_ERROR] Failed to send data to specific client: ${sendError.message}`);
        }
    } else {
        console.warn('[MGR_QR_WS] Cannot send message to client, WebSocket is not open.');
    }
}

function resetManagerLinkingDisplay() {
    console.log(`[MGR_QR_WS] Resetting manager linking display. Current linkingClientId: ${managerQrState.linkingClientId}`);
    const oldLinkingId = managerQrState.linkingClientId;
    managerQrState.linkingClientId = null;
    // Send a clear state to UI, indicating no active linking process.
    // The 'status' being 'disconnected' here means the "linking process" is disconnected/reset.
    updateManagerQrState('disconnected', 'Waiting for new linking attempt...', null, oldLinkingId, null, null, false);
}

module.exports = {
    startWebSocketServer,
    updateManagerQrState,
    resetManagerLinkingDisplay,
    managerQrState, // Export for instanceManager to check linkingClientId
    notifyInstanceStatusChange,
    sendToClient,
    clientBotWsMap
};