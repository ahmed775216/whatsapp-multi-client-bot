// manager/qrWebSocketServer.js
const WebSocket = require('ws');
const clientRegistry = require('./clientRegistry');

let wss = null;
const csharpUiClients = new Set();
const clientBotWsMap = new Map();
const csharpClientWsMap = new Map();
let process = require('process');
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
let onManualLidEntryCallback = null;

function startWebSocketServer(port, callbacks = {}) {
    // Assign callbacks from manager.js
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
    onManualLidEntryCallback = callbacks.onManualLidEntry; // Assign the manualLidEntry callback

    if (wss) { 
        console.warn("[MGR_QR_WS] WebSocket server already running."); 
        return; 
    }

    wss = new WebSocket.Server({ port: port, host: '0.0.0.0' });
    console.log(`[MGR_QR_WS] WebSocket server for QR started on port ${port} and binding to 0.0.0.0`);

    wss.on('connection', (ws, req) => {
        const clientIP = req.socket.remoteAddress;
        console.log(`[MGR_QR_WS] Incoming connection from ${clientIP}.`);

        const initialMessageHandler = (message) => {
            ws.removeListener('message', initialMessageHandler);
            const msgStr = message.toString();

            let parsedMsg;
            try {
                parsedMsg = JSON.parse(msgStr);
                if (parsedMsg.type && typeof parsedMsg.type === 'string') {
                    parsedMsg.type = parsedMsg.type.trim();
                }
            }
            catch (e) {
                console.error(`[MGR_QR_WS_ERROR] Error parsing initial message from ${clientIP}, closing connection: ${e.message}. Raw: ${msgStr.substring(0, 250)}`);
                ws.close(1008, "Invalid initial message format"); 
                return;
            }

            if (!parsedMsg || typeof parsedMsg.type !== 'string') {
                console.warn(`[MGR_QR_WS] Parsed message or its type is invalid from ${clientIP}. Msg content: ${msgStr.substring(0, 100)}. Closing.`);
                ws.close(1008, "Invalid message structure or type");
                return;
            }

            const csharpCommandTypes = [
                'requestQr', 'manualRelink', 'listInstances', 'startInstance',
                'stopInstance', 'restartInstance', 'deleteInstance', 'getLogs',
                'fetchGroups', 'addChatToWhitelist', 'removeFromChatWhitelist', 'fetchParticipants',
                'manualLidEntry' // Include manualLidEntry in the list of C# command types
            ];
            const botDataMessageTypes = ['status', 'qr', 'lidResolved'];
            const botInternalReplyType = 'internalReply';

            if (csharpCommandTypes.includes(parsedMsg.type)) {
                // Handle C# UI client connection
                if (!csharpUiClients.has(ws)) {
                    csharpUiClients.add(ws);
                    // If csharpClientId is provided, map it to this WebSocket
                    const csharpClientId = parsedMsg.csharpClientId;
                    if (csharpClientId) {
                        csharpClientWsMap.set(csharpClientId, ws);
                        console.log(`[MGR_QR_WS] C# UI client '${csharpClientId}' connected from ${clientIP} and added to active set. Total UI clients: ${csharpUiClients.size}`);
                        // Update last seen timestamp
                        clientRegistry.updateClientLastSeen(csharpClientId);
                    } else {
                        console.log(`[MGR_QR_WS] C# UI client connected from ${clientIP} and added to active set. Total UI clients: ${csharpUiClients.size}`);
                    }
                    
                    // Send current status to the newly connected client
                    sendToClient(ws, { type: 'status', ...managerQrState });
                    if (callbacks.onListInstances) {
                        callbacks.onListInstances(ws);
                    }
                }
                
                // Process the command
                handleCSharpUiCommand(ws, parsedMsg);
                
                // Set up handlers for subsequent messages
                ws.on('message', (subsequentMessage) => {
                    try {
                        const subParsedMsg = JSON.parse(subsequentMessage.toString());
                        if (subParsedMsg.csharpClientId) {
                            clientRegistry.updateClientLastSeen(subParsedMsg.csharpClientId);
                        }
                        if (subParsedMsg.type && typeof subParsedMsg.type === 'string') {
                            handleCSharpUiCommand(ws, subParsedMsg);
                        } else {
                            console.warn(`[MGR_QR_WS_WARN] C# UI Subsequent message invalid type from ${clientIP}. Raw: ${subsequentMessage.toString().substring(0, 100)}`);
                        }
                    } catch (jsonErr) {
                        console.error(`[MGR_QR_WS_ERROR] C# UI Subsequent message JSON parse error from ${clientIP}: ${jsonErr.message}. Raw: ${subsequentMessage.toString().substring(0, 100)}`);
                    }
                });
            }
            else if (parsedMsg.clientId && (botDataMessageTypes.includes(parsedMsg.type) || parsedMsg.type === botInternalReplyType)) {
                // Handle bot client connection
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
                    handleClientBotInternalReply(clientId, parsedMsg);
                } else if (botDataMessageTypes.includes(type) && onIncomingClientDataCallback) {
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
            // Remove from C# UI clients set if it was one
            if (csharpUiClients.has(ws)) {
                csharpUiClients.delete(ws);
                // Also remove from csharpClientWsMap if present
                for (let [csharpClientId, clientWs] of csharpClientWsMap.entries()) {
                    if (clientWs === ws) {
                        csharpClientWsMap.delete(csharpClientId);
                        console.log(`[MGR_QR_WS] C# UI client '${csharpClientId}' disconnected.`);
                        break;
                    }
                }
                console.log(`[MGR_QR_WS] C# UI client disconnected. Remaining UI clients: ${csharpUiClients.size}`);
            } else {
                // Check if it was a bot client
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
    
    wss.on('listening', () => {
        console.log('[MGR_QR_WS] WebSocket server is listening.');
    });
    
    wss.on('error', (error) => {
        console.error(`[MGR_QR_WS_FATAL] WebSocket server error: ${error.message}`);
        process.exit(1); // Exit if the server itself encounters a fatal error
    });

    process.on('SIGINT', stopWebSocketServer);
    process.on('SIGTERM', stopWebSocketServer);
}

function stopWebSocketServer() {
    if (wss) {
        console.log('[MGR_QR_WS] Stopping WebSocket server...');
        wss.close(() => {
            console.log('[MGR_QR_WS] WebSocket server stopped.');
            wss = null;
        });
    }
}

function handleCSharpUiCommand(ws, parsedMsg) { // 'ws' here is the specific C# UI client that sent the command
    const { type, clientId, apiUsername, apiPassword, ownerNumber, groupId, participantJid, lid, phoneJid } = parsedMsg;
    const callCallback = (callback, ...args) => {
        if (callback) callback(...args);
        else console.warn(`[MGR_QR_WS] Callback not defined for C# command type: ${type}`);
    };

    switch (type) {
        case 'requestQr': callCallback(onQrRequestedCallback, apiUsername, apiPassword, ownerNumber); break;
        case 'manualRelink': callCallback(onManualRelinkCallback, apiUsername, apiPassword, ownerNumber); break;
        case 'listInstances': callCallback(onListInstancesCallback, ws); break;
        case 'startInstance': if (clientId) callCallback(onStartInstanceCallback, clientId); break;
        case 'stopInstance': if (clientId) callCallback(onStopInstanceCallback, clientId); break;
        case 'restartInstance': if (clientId) callCallback(onRestartInstanceCallback, clientId); break;
        case 'deleteInstance': if (clientId) callCallback(onDeleteInstanceCallback, clientId); break;
        case 'getLogs': if (clientId) callCallback(onGetLogsCallback, ws, clientId); break;
        case 'fetchGroups': if (clientId) callCallback(onFetchGroupsCallback, clientId); break;
        case 'addChatToWhitelist':
            {
                const jidToAdd = groupId || participantJid;
                if (clientId && jidToAdd) callCallback(onAddChatToWhitelistCallback, clientId, jidToAdd);
                break;
            }
        case 'removeFromChatWhitelist':
            {
                const jidToRemove = groupId || participantJid;
                if (clientId && jidToRemove) callCallback(onRemoveFromChatWhitelistCallback, clientId, jidToRemove);
                break;
            }
        case 'fetchParticipants':
            if (clientId && groupId) callCallback(onFetchParticipantsCallback, clientId, groupId);
            break;
        case 'manualLidEntry': // Handle manualLidEntry command
            if (clientId && lid && phoneJid) {
                console.log(`[MGR_QR_WS] Received manualLidEntry command for client ${clientId}: LID=${lid}, phoneJid=${phoneJid}`);
                callCallback(onManualLidEntryCallback, clientId, { lid, phoneJid });
            } else {
                console.warn(`[MGR_QR_WS] Invalid manualLidEntry command: missing clientId, lid, or phoneJid`);
            }
            break;
        case 'internalCommand': // Handle generic internalCommand from C# UI
            if (clientId && parsedMsg.command) { // Ensure clientId and nested command are present
                console.log(`[MGR_QR_WS] Routing internal command '${parsedMsg.command}' to client ${clientId}.`);
                // Use the appropriate callback based on the command type
                if (parsedMsg.command === 'manualLidEntry') {
                    callCallback(onManualLidEntryCallback, clientId, parsedMsg);
                } else {
                    // For other internal commands, use a generic handler
                    callCallback(onFetchGroupsCallback, clientId, parsedMsg);
                }
            } else {
                console.warn(`[MGR_QR_WS] Invalid internalCommand received from C# UI:`, parsedMsg);
            }
            break;
        default: console.warn(`[MGR_QR_WS] Unhandled message type from C# UI: ${type}. Full message:`, parsedMsg); break;
    }
}

function handleClientBotInternalReply(clientId, parsedMsgFromBot) {
    if (parsedMsgFromBot.clientId !== clientId) {
        console.warn(`[MGR_QR_WS] ClientId mismatch in internalReply. Expected ${clientId}, got ${parsedMsgFromBot.clientId}. Ignoring.`);
        return;
    }
    const actualPayloadForCSharp = parsedMsgFromBot.data;
    if (actualPayloadForCSharp && actualPayloadForCSharp.type) {
        console.log(`[MGR_QR_WS] Received internalReply from bot ${clientId}. Forwarding data (type: ${actualPayloadForCSharp.type}) to C# UIs.`);
        // Broadcast to all connected C# UI clients
        broadcastToCSharpUIs(actualPayloadForCSharp);
    } else {
        console.warn(`[MGR_QR_WS] Invalid internalReply structure from bot ${clientId}:`, parsedMsgFromBot);
    }
}

// Helper function to broadcast to all connected C# UI clients
function broadcastToCSharpUIs(data) {
    if (csharpUiClients.size === 0 && data.type !== 'status') { // 'status' type for linking process should still attempt to broadcast
        return;
    }
    const messageString = JSON.stringify(data);

    csharpUiClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(messageString);
            } catch (sendError) {
                console.error(`[MGR_QR_WS_ERROR] Failed to send data to a C# UI client: ${sendError.message}. Removing client.`);
                csharpUiClients.delete(client); // Remove problematic client
            }
        } else {
            csharpUiClients.delete(client);
        }
    });
}

// Send a message to a specific C# client by its ID
function sendToCsharpClient(csharpClientId, message) {
    const ws = csharpClientWsMap.get(csharpClientId);
    if (ws) {
        sendToClient(ws, message);
    } else {
        console.warn(`[MGR_QR_WS] C# client '${csharpClientId}' not found or not connected.`);
    }
}

// Send a message to a specific WebSocket client
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
    // Broadcast this global linking state to all C# UIs
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
    // Broadcast to all C# UIs
    broadcastToCSharpUIs(payload);
}

function notifyParticipantDetailsUpdate(forClientId, originalLid, resolvedPhoneJid, displayName) {
    const payload = { type: 'participantDetailsUpdate', clientId: forClientId, originalLid, resolvedPhoneJid, displayName };
    // Broadcast to all C# UIs
    broadcastToCSharpUIs(payload);
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
    sendToClient,
    sendToCsharpClient,
    broadcastToCSharpUIs,
    clientBotWsMap // Keep this for instanceManager to interact with bot instances
};