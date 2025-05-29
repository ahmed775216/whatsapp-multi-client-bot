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

// Callbacks (assigned from manager.js)
let onQrRequestedCallback = null;
let onManualRelinkCallback = null;
let onIncomingClientDataCallback = null; // هذا هو الكولباك العام للبيانات الأخرى (status, qr, lidResolved)
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
            console.log(`[MGR_QR_WS_DEBUG] Received initial message string: ${msgStr.substring(0, 250)}`);

            let parsedMsg;
            try {
                parsedMsg = JSON.parse(msgStr);
                console.log(`[MGR_QR_WS_DEBUG] Parsed initial message object:`, parsedMsg);
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
            const botDataMessageTypes = ['status', 'qr', 'lidResolved']; // أنواع البيانات التي يجب تمريرها إلى instanceManager
            const botInternalReplyType = 'internalReply'; // نوع الرد الداخلي يُعالج بشكل خاص

            if (csharpCommandTypes.includes(parsedMsg.type)) {
                if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN && csharpClientWs !== ws) {
                    console.warn(`[MGR_QR_WS] Another C# UI client (${clientIP}) attempted to connect while one is active. Closing new connection.`);
                    ws.close(1008, "Only one UI client allowed at a time"); return;
                }
                csharpClientWs = ws;
                console.log(`[MGR_QR_WS] Designated C# UI client connected from ${clientIP}. Processing initial command: ${parsedMsg.type}`);
                csharpClientWs.send(JSON.stringify({ type: 'status', ...managerQrState }));
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
            // تحديد رسائل البوت (بيانات أو ردود داخلية)
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

                // ** تعديل منطق التوجيه **
                if (type === botInternalReplyType) {
                    handleClientBotInternalReply(clientId, parsedMsg); // عالج الردود الداخلية مباشرة
                } else if (botDataMessageTypes.includes(type) && onIncomingClientDataCallback) {
                    onIncomingClientDataCallback(clientId, type, dataPayload); // مرر أنواع البيانات الأخرى إلى instanceManager
                } else {
                    console.warn(`[MGR_QR_WS] Unhandled message type '${type}' or missing callback for bot ${clientId}.`);
                }

                ws.on('message', (subsequentMessage) => {
                    try {
                        const subParsedMsg = JSON.parse(subsequentMessage.toString());
                        if (subParsedMsg.clientId === clientId) { 
                            const { type: subType, data: subDataPayload } = subParsedMsg;
                            // ** تعديل منطق التوجيه للرسائل اللاحقة **
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
            if (ws === csharpClientWs) {
                csharpClientWs = null;
                console.log('[MGR_QR_WS] C# UI client disconnected.');
            } else {
                for (let [clientIdFromMap, clientWsInMap] of clientBotWsMap.entries()) {
                    if (clientWsInMap === ws) {
                        clientBotWsMap.delete(clientIdFromMap);
                        console.log(`[MGR_QR_WS] Client bot ${clientIdFromMap} disconnected.`);
                        if (onIncomingClientDataCallback) { // إبلاغ instanceManager بانقطاع اتصال البوت
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

function handleCSharpUiCommand(ws, parsedMsg) {
    const { type, clientId, apiUsername, apiPassword, ownerNumber, groupId, participantJid } = parsedMsg;
    // التأكد من أن الكولباكات معرفة قبل استدعائها
    const callCallback = (callback, ...args) => {
        if (callback) callback(...args);
        else console.warn(`[MGR_QR_WS] Callback not defined for C# command type: ${type}`);
    };

    switch (type) {
        case 'requestQr': callCallback(onQrRequestedCallback, apiUsername, apiPassword, ownerNumber); break;
        case 'manualRelink': callCallback(onManualRelinkCallback, apiUsername, apiPassword, ownerNumber); break;
        case 'listInstances': callCallback(onListInstancesCallback, ws); break;
        case 'startInstance': if(clientId) callCallback(onStartInstanceCallback, clientId); break;
        case 'stopInstance': if(clientId) callCallback(onStopInstanceCallback, clientId); break;
        case 'restartInstance': if(clientId) callCallback(onRestartInstanceCallback, clientId); break;
        case 'deleteInstance': if(clientId) callCallback(onDeleteInstanceCallback, clientId); break;
        case 'getLogs': if(clientId) callCallback(onGetLogsCallback, ws, clientId); break;
        case 'fetchGroups': if(clientId) callCallback(onFetchGroupsCallback, clientId); break;
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

function handleClientBotInternalReply(clientId, parsedMsgFromBot) {
    if (parsedMsgFromBot.clientId !== clientId) {
        console.warn(`[MGR_QR_WS] ClientId mismatch in internalReply. Expected ${clientId}, got ${parsedMsgFromBot.clientId}. Ignoring.`);
        return;
    }
    // parsedMsgFromBot.data هو الكائن الذي أرسله clientBotApp.js كـ dataForReply
    const actualPayloadForCSharp = parsedMsgFromBot.data; 
    if (actualPayloadForCSharp && actualPayloadForCSharp.type) {
        console.log(`[MGR_QR_WS] Received internalReply from bot ${clientId}. Forwarding data (type: ${actualPayloadForCSharp.type}) to C# UI.`);
        if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
            try {
                csharpClientWs.send(JSON.stringify(actualPayloadForCSharp));
            } catch (e) {
                console.error(`[MGR_QR_WS_ERROR] Failed to forward internalReply (type: ${actualPayloadForCSharp.type}) to C# UI: ${e.message}`);
            }
        } else {
            console.warn(`[MGR_QR_WS] C# UI not connected. Cannot forward internalReply from bot ${clientId} (type: ${actualPayloadForCSharp.type}).`);
        }
    } else {
        console.warn(`[MGR_QR_WS] Invalid internalReply structure from bot ${clientId}:`, parsedMsgFromBot);
    }
}

function updateManagerQrState(status, message, qr = null, clientId = null, phoneNumber = null, clientName = null, isLinkingProcess = false) {
    if (isLinkingProcess) managerQrState.linkingClientId = clientId;
    managerQrState.status = status; managerQrState.message = message; managerQrState.qr = qr;
    const payload = { type: 'status', status, message, qr, clientId: (status === 'connected' || isLinkingProcess) ? clientId : null, phoneNumber: status === 'connected' ? phoneNumber : null, name: status === 'connected' ? clientName : null };
    if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
        try { csharpClientWs.send(JSON.stringify(payload)); }
        catch (sendError) { console.error(`[MGR_QR_WS_ERROR] Failed to send status to C# UI: ${sendError.message}`); }
    }
    if (managerQrState.linkingClientId && clientId === managerQrState.linkingClientId && (status === 'connected' || status === 'disconnected_logout' || status === 'error_whatsapp_permanent' || status === 'linking_failed' || status === 'error_startup')) {
        if (status !== 'connected') managerQrState.linkingClientId = null;
    }
}

function notifyInstanceStatusChange(clientId, status, phoneNumber = null, name = null) {
    const payload = { type: 'instanceStatusUpdate', clientId, status, phoneNumber, name, timestamp: new Date().toISOString() };
    if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
        try { csharpClientWs.send(JSON.stringify(payload)); }
        catch (sendError) { console.error(`[MGR_QR_WS_ERROR] Failed instanceStatusUpdate send: ${sendError.message}`);}
    } else { console.warn(`[MGR_QR_WS_WARN] No C# UI for instanceStatusUpdate (Client: ${clientId})`); }
}

function notifyParticipantDetailsUpdate(forClientId, originalLid, resolvedPhoneJid, displayName) {
    const payload = { type: 'participantDetailsUpdate', clientId: forClientId, originalLid, resolvedPhoneJid, displayName };
    if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
        try {
            csharpClientWs.send(JSON.stringify(payload));
            console.log(`[MGR_QR_WS] Sent participantDetailsUpdate to C# UI for LID ${originalLid} -> ${resolvedPhoneJid}`);
        } catch (sendError) {
             console.error(`[MGR_QR_WS_ERROR] Failed to send participantDetailsUpdate to C# UI: ${sendError.message}`);
        }
    } else {
        console.warn(`[MGR_QR_WS_WARN] C# UI not connected. Cannot send participantDetailsUpdate for client ${forClientId}.`);
    }
}

function sendToClient(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(data)); }
        catch (sendError) { console.error(`[MGR_QR_WS_ERROR] Failed to send data to specific client: ${sendError.message}`); }
    } else { console.warn('[MGR_QR_WS] Cannot send message to client, WebSocket is not open.'); }
}

function resetManagerLinkingDisplay() {
    const oldLinkingId = managerQrState.linkingClientId;
    managerQrState.linkingClientId = null;
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
    clientBotWsMap
};