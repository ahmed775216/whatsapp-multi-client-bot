// manager/qrWebSocketServer.js
const WebSocket = require('ws');

let wss = null;
const csharpUiClients = new Set(); // MODIFIED: Use a Set to store C# UI WebSocket clients
const clientBotWsMap = new Map();

let managerQrState = {
    qr: null,
    status: 'disconnected', // Overall status of any ongoing linking process
    message: 'Waiting for linking attempt...',
    linkingClientId: null // The clientId of the bot instance currently being linked (requested by any UI)
};

// Callbacks (assigned from manager.js)
let onQrRequestedCallback = null;
let onManualRelinkCallback = null;
let onIncomingClientDataCallback = null;
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
    onIncomingClientDataCallback = callbacks.onIncomingClientData;
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
            ws.removeListener('message', initialMessageHandler);
            const msgStr = message.toString();
            // console.log(`[MGR_QR_WS_DEBUG] Received initial message string: ${msgStr.substring(0, 250)}`); // Can be verbose

            let parsedMsg;
            try {
                parsedMsg = JSON.parse(msgStr);
                if (parsedMsg.type && typeof parsedMsg.type === 'string') {
                    parsedMsg.type = parsedMsg.type.trim();
                }
            }
            catch (e) {
                console.error(`[MGR_QR_WS_ERROR] Error parsing initial message from ${clientIP}, closing connection: ${e.message}. Raw: ${msgStr.substring(0, 250)}`);
                ws.close(1008, "Invalid initial message format"); return;
            }

            if (!parsedMsg || typeof parsedMsg.type !== 'string') {
                console.warn(`[MGR_QR_WS] Parsed message or its type is invalid from ${clientIP}. Msg content: ${msgStr.substring(0,100)}. Closing.`);
                ws.close(1008, "Invalid message structure or type");
                return;
            }

            const csharpCommandTypes = [
                'requestQr', 'manualRelink', 'listInstances', 'startInstance',
                'stopInstance', 'restartInstance', 'deleteInstance', 'getLogs',
                'fetchGroups', 'addChatToWhitelist', 'removeFromChatWhitelist', 'fetchParticipants'
            ];
            const botDataMessageTypes = ['status', 'qr', 'lidResolved'];
            const botInternalReplyType = 'internalReply';

            if (csharpCommandTypes.includes(parsedMsg.type)) {
                // MODIFIED: Add client to the set of C# UI clients
                if (!csharpUiClients.has(ws)) {
                    csharpUiClients.add(ws);
                    console.log(`[MGR_QR_WS] C# UI client connected from ${clientIP} and added to active set. Total UI clients: ${csharpUiClients.size}`);
                    // Send current managerQrState and instance list to the newly connected C# UI
                    sendToClient(ws, { type: 'status', ...managerQrState }); // Current linking status
                    if (callbacks.onListInstances) {
                        callbacks.onListInstances(ws); // Send current instance list to this specific UI
                    }
                }
                // Process command
                handleCSharpUiCommand(ws, parsedMsg);
                ws.on('message', (subsequentMessage) => {
                    try {
                        const subParsedMsg = JSON.parse(subsequentMessage.toString());
                        if (subParsedMsg.type && typeof subParsedMsg.type === 'string') {
                            handleCSharpUiCommand(ws, subParsedMsg);
                        } else {
                             console.warn(`[MGR_QR_WS_WARN] C# UI Subsequent message invalid type from ${clientIP}. Raw: ${subsequentMessage.toString().substring(0,100)}`);
                        }
                    } catch (jsonErr) {
                        console.error(`[MGR_QR_WS_ERROR] C# UI Subsequent message JSON parse error from ${clientIP}: ${jsonErr.message}. Raw: ${subsequentMessage.toString().substring(0,100)}`);
                    }
                });
            }
            else if (parsedMsg.clientId && (botDataMessageTypes.includes(parsedMsg.type) || parsedMsg.type === botInternalReplyType)) {
                const { clientId, type, data: dataPayload } = parsedMsg;

                if (!clientBotWsMap.has(clientId) || clientBotWsMap.get(clientId) !== ws) {
                    console.log(`[MGR_QR_WS] Client Bot Instance ${clientId} connected/reconnected from ${clientIP}.`);
                    const oldWs = clientBotWsMap.get(clientId);
                    if (oldWs && oldWs !== ws && oldWs.readyState === WebSocket.OPEN) {
                        console.warn(`[MGR_QR_WS] Old WebSocket for bot ${clientId} was still open. Closing it.`);
                        oldWs.close(1001, "Replaced by new connection");
                    }
                    clientBotWsMap.set(clientId, ws);
                }

                if (type === botInternalReplyType) {
                    handleClientBotInternalReply(clientId, parsedMsg); // This will now broadcast
                } else if (botDataMessageTypes.includes(type) && onIncomingClientDataCallback) {
                    // onIncomingClientDataCallback is expected to call functions like notifyInstanceStatusChange,
                    // which will then broadcast to C# UIs.
                    onIncomingClientDataCallback(clientId, type, dataPayload);
                } else {
                    console.warn(`[MGR_QR_WS] Unhandled message type '${type}' or missing callback for bot ${clientId}.`);
                }

                ws.on('message', (subsequentMessage) => {
                    try {
                        const subParsedMsg = JSON.parse(subsequentMessage.toString());
                        if (subParsedMsg.clientId === clientId) {
                            const { type: subType, data: subDataPayload } = subParsedMsg;
                            if (subType === botInternalReplyType) {
                                handleClientBotInternalReply(clientId, subParsedMsg);
                            } else if (botDataMessageTypes.includes(subType) && onIncomingClientDataCallback) {
                                onIncomingClientDataCallback(clientId, subType, subDataPayload);
                            } else {
                                console.warn(`[MGR_QR_WS] Unhandled subsequent message type '${subType}' from bot ${clientId}.`);
                            }
                        } else {
                             console.warn(`[MGR_QR_WS] Subsequent message clientId mismatch from ${clientIP}. Expected ${clientId}, got ${subParsedMsg.clientId}.`);
                        }
                    } catch (jsonErr) {
                        console.error(`[MGR_QR_WS_ERROR] Bot subsequent message JSON parse error from ${clientIP} (BotID: ${clientId}): ${jsonErr.message}.`);
                    }
                });
            } else {
                console.warn(`[MGR_QR_WS] Unidentified connection type from ${clientIP} after first message. Parsed type: '${parsedMsg.type}'. Closing.`);
                ws.close(1008, "Unidentified client type after first message");
            }
        };

        ws.on('message', initialMessageHandler);

        ws.on('close', () => {
            console.log(`[MGR_QR_WS] Client disconnected from ${clientIP}.`);
            // MODIFIED: Remove from C# UI clients set if it was one
            if (csharpUiClients.has(ws)) {
                csharpUiClients.delete(ws);
                console.log(`[MGR_QR_WS] C# UI client disconnected. Remaining UI clients: ${csharpUiClients.size}`);
            } else {
                for (let [clientIdFromMap, clientWsInMap] of clientBotWsMap.entries()) {
                    if (clientWsInMap === ws) {
                        clientBotWsMap.delete(clientIdFromMap);
                        console.log(`[MGR_QR_WS] Client bot ${clientIdFromMap} disconnected.`);
                        if (onIncomingClientDataCallback) {
                            onIncomingClientDataCallback(clientIdFromMap, 'status', { status: 'disconnected_manager_ws', message: `Client ${clientIdFromMap} WS connection to manager closed.` });
                        }
                        break;
                    }
                }
            }
        });
        ws.on('error', (error) => console.error(`[MGR_QR_WS_ERROR] WebSocket client error from ${clientIP}:`, error.message));
    });
    wss.on('error', (error) => console.error('[MGR_QR_WS_FATAL_ERROR] WebSocket Server Error (fatal):', error));
}


function handleCSharpUiCommand(ws, parsedMsg) { // 'ws' here is the specific C# UI client that sent the command
    const { type, clientId, apiUsername, apiPassword, ownerNumber, groupId, participantJid } = parsedMsg;
    const callCallback = (callback, ...args) => {
        if (callback) callback(...args);
        else console.warn(`[MGR_QR_WS] Callback not defined for C# command type: ${type}`);
    };

    switch (type) {
        case 'requestQr': callCallback(onQrRequestedCallback, apiUsername, apiPassword, ownerNumber); break; // This request affects managerQrState, which is broadcasted
        case 'manualRelink': callCallback(onManualRelinkCallback, apiUsername, apiPassword, ownerNumber); break; // Also affects managerQrState
        case 'listInstances': callCallback(onListInstancesCallback, ws); break; // Specific to the requesting UI
        case 'startInstance': if(clientId) callCallback(onStartInstanceCallback, clientId); break; // Action on an instance, status changes broadcasted
        case 'stopInstance': if(clientId) callCallback(onStopInstanceCallback, clientId); break;
        case 'restartInstance': if(clientId) callCallback(onRestartInstanceCallback, clientId); break;
        case 'deleteInstance': if(clientId) callCallback(onDeleteInstanceCallback, clientId); break;
        case 'getLogs': if(clientId) callCallback(onGetLogsCallback, ws, clientId); break; // Specific to the requesting UI
        case 'fetchGroups': if(clientId) callCallback(onFetchGroupsCallback, clientId); break; // Replies will be broadcasted via handleClientBotInternalReply
        case 'addChatToWhitelist':
            const jidToAdd = groupId || participantJid;
            if(clientId && jidToAdd) callCallback(onAddChatToWhitelistCallback, clientId, jidToAdd);
            break;
        case 'removeFromChatWhitelist':
            const jidToRemove = groupId || participantJid;
            if(clientId && jidToRemove) callCallback(onRemoveFromChatWhitelistCallback, clientId, jidToRemove);
            break;
        case 'fetchParticipants':
            if(clientId && groupId) callCallback(onFetchParticipantsCallback, clientId, groupId);
            break;
        default: console.warn(`[MGR_QR_WS] Unhandled message type from C# UI: ${type}. Full message:`, parsedMsg); break;
    }
}

// Helper function to broadcast to all connected C# UI clients
function broadcastToCSharpUIs(data) {
    if (csharpUiClients.size === 0 && data.type !== 'status') { // 'status' type for linking process should still attempt to broadcast
         // console.warn(`[MGR_QR_WS_WARN] No C# UI clients connected to broadcast message type: ${data.type}`); // Can be noisy
        return;
    }
    const messageString = JSON.stringify(data);
    // console.log(`[MGR_QR_WS_BROADCAST] Broadcasting to ${csharpUiClients.size} C# UIs: ${messageString.substring(0,150)}`);

    csharpUiClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(messageString);
            } catch (sendError) {
                console.error(`[MGR_QR_WS_ERROR] Failed to send data to a C# UI client: ${sendError.message}. Removing client.`);
                csharpUiClients.delete(client); // Remove problematic client
            }
        } else {
            // console.log('[MGR_QR_WS_INFO] Removing non-open C# UI client during broadcast.'); // Can be noisy
            csharpUiClients.delete(client);
        }
    });
}

function handleClientBotInternalReply(clientId, parsedMsgFromBot) {
    if (parsedMsgFromBot.clientId !== clientId) {
        console.warn(`[MGR_QR_WS] ClientId mismatch in internalReply. Expected ${clientId}, got ${parsedMsgFromBot.clientId}. Ignoring.`);
        return;
    }
    const actualPayloadForCSharp = parsedMsgFromBot.data;
    if (actualPayloadForCSharp && actualPayloadForCSharp.type) {
        console.log(`[MGR_QR_WS] Received internalReply from bot ${clientId}. Forwarding data (type: ${actualPayloadForCSharp.type}) to C# UIs.`);
        // MODIFIED: Broadcast to all connected C# UI clients
        broadcastToCSharpUIs(actualPayloadForCSharp);
    } else {
        console.warn(`[MGR_QR_WS] Invalid internalReply structure from bot ${clientId}:`, parsedMsgFromBot);
    }
}

function updateManagerQrState(status, message, qr = null, clientId = null, phoneNumber = null, clientName = null, isLinkingProcess = false) {
    if (isLinkingProcess || status === 'qr') { // If it's part of any linking process, update the global linkingClientId
        managerQrState.linkingClientId = clientId;
    }
    managerQrState.status = status;
    managerQrState.message = message;
    managerQrState.qr = qr; // This QR is for the current linking attempt

    const payload = {
        type: 'status', // This message type is understood by C# UI to update its general status/QR display
        status,
        message,
        qr, // The QR string for the current linking attempt
        clientId: (status === 'connected' || isLinkingProcess || status === 'qr') ? clientId : null, // clientID of the instance being linked or just connected
        phoneNumber: status === 'connected' ? phoneNumber : null,
        name: status === 'connected' ? clientName : null
    };
    // MODIFIED: Broadcast this global linking state to all C# UIs
    broadcastToCSharpUIs(payload);

    // If the linking process is definitively over (connected or failed hard), clear the linkingClientId
    if (managerQrState.linkingClientId && clientId === managerQrState.linkingClientId) {
        if (status === 'connected' || status === 'disconnected_logout' || status === 'error_whatsapp_permanent' || status === 'linking_failed' || status === 'error_startup' || status.startsWith('exited')) {
            if (status !== 'connected') { // Keep linkingClientId if connected, for the UI that initiated it to claim.
                 // managerQrState.linkingClientId = null; // Let manager.js handle clearing this based on specific UI flows
            }
        }
    }
}

function notifyInstanceStatusChange(clientId, status, phoneNumber = null, name = null) {
    const payload = { type: 'instanceStatusUpdate', clientId, status, phoneNumber, name, timestamp: new Date().toISOString() };
    // MODIFIED: Broadcast to all C# UIs
    broadcastToCSharpUIs(payload);
}

function notifyParticipantDetailsUpdate(forClientId, originalLid, resolvedPhoneJid, displayName) {
    const payload = { type: 'participantDetailsUpdate', clientId: forClientId, originalLid, resolvedPhoneJid, displayName };
    // MODIFIED: Broadcast to all C# UIs
    broadcastToCSharpUIs(payload);
}

// This function is used to send a message to a specific C# UI client (e.g., list of instances or logs)
function sendToClient(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(data));
        }
        catch (sendError) {
            console.error(`[MGR_QR_WS_ERROR] Failed to send data to specific client: ${sendError.message}`);
        }
    } else {
        console.warn('[MGR_QR_WS_WARN] Cannot send message to client, WebSocket is not open or client is null.');
    }
}

function resetManagerLinkingDisplay() {
    const oldLinkingId = managerQrState.linkingClientId;
    managerQrState.linkingClientId = null; // Clear who was being linked globally
    // Broadcast the new "disconnected" linking state
    updateManagerQrState('disconnected', 'Waiting for new linking attempt...', null, oldLinkingId, null, null, false);
}

module.exports = {
    startWebSocketServer,
    updateManagerQrState,
    resetManagerLinkingDisplay,
    managerQrState,
    notifyInstanceStatusChange,
    notifyParticipantDetailsUpdate,
    sendToClient, // Keep this exported for specific replies
    clientBotWsMap // Keep this for instanceManager to interact with bot instances
    // csharpUiClients is not exported as it's managed internally by this module.
};