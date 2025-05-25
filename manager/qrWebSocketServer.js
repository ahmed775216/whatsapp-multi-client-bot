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
let onDeleteInstanceCallback = null; // Added
let onGetLogsCallback = null;
let onFetchGroupsCallback = null; // Added
let onAddChatToWhitelistCallback = null; // Added
let onRemoveFromChatWhitelistCallback = null; // <-- NEW DECLARATION
let onFetchParticipantsCallback = null; // Added


function startWebSocketServer(port, callbacks = {}) {
    onQrRequestedCallback = callbacks.onQrRequested;
    onManualRelinkCallback = callbacks.onManualRelink;
    onIncomingClientStatusCallback = callbacks.onIncomingClientStatus;
    onIncomingClientQrCallback = callbacks.onIncomingClientQr;
    onListInstancesCallback = callbacks.onListInstances;
    onStartInstanceCallback = callbacks.onStartInstance;
    onStopInstanceCallback = callbacks.onStopInstance;
    onRestartInstanceCallback = callbacks.onRestartInstance;
    onDeleteInstanceCallback = callbacks.onDeleteInstance; // Added
    onGetLogsCallback = callbacks.onGetLogs;
    onFetchGroupsCallback = callbacks.onFetchGroups; // Added
    onAddChatToWhitelistCallback = callbacks.onAddChatToWhitelist; // Added
    onRemoveFromChatWhitelistCallback = callbacks.onRemoveFromChatWhitelist; // <-- NEW ASSIGNMENT
    onFetchParticipantsCallback = callbacks.onFetchParticipants; // Added

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

            // Identify C# UI client (sends commands like requestQr, listInstances, etc.)
            // The C# client sends its first message (often listInstances) to identify itself.
            // All commands from C# UI are handled here.
            if (parsedMsg.type === 'requestQr' || parsedMsg.type === 'manualRelink' ||
                parsedMsg.type === 'listInstances' || parsedMsg.type === 'startInstance' ||
                parsedMsg.type === 'stopInstance' || parsedMsg.type === 'restartInstance' ||
                parsedMsg.type === 'deleteInstance' || parsedMsg.type === 'getLogs' || // Added deleteInstance
                parsedMsg.type === 'fetchGroups' || parsedMsg.type === 'addChatToWhitelist' || // Added for group/participant management
                parsedMsg.type === 'removeFromChatWhitelist' || parsedMsg.type === 'fetchParticipants') // Added for group/participant management
            {
                if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN && csharpClientWs !== ws) {
                    console.warn(`[MGR_QR_WS] Another C# UI client (${clientIP}) attempted to connect. Closing extra.`);
                    ws.close(1008, "Only one UI client allowed"); return;
                }
                csharpClientWs = ws; // Assign this connection as the main C# UI client
                console.log(`[MGR_QR_WS] Designated C# UI client connected from ${clientIP}.`);
                // Send current QR state immediately to new UI client
                csharpClientWs.send(JSON.stringify({ type: 'status', ...managerQrState }));

                handleCSharpUiCommand(ws, parsedMsg); // Process the initial command
                
                // Set up listener for subsequent messages from C# UI
                ws.on('message', (subsequentMessage) => handleCSharpUiCommand(ws, JSON.parse(subsequentMessage.toString())));
            }
            // Identify Node.js Client Bot Instance (sends status, qr, internalReply)
            else if (parsedMsg.clientId && (parsedMsg.type === 'status' || parsedMsg.type === 'qr' || parsedMsg.type === 'internalReply')) // Added internalReply
            {
                const { clientId, data } = parsedMsg;
                // Only register if it's a new connection or re-establishing after disconnect
                if (!clientBotWsMap.has(clientId) || clientBotWsMap.get(clientId) !== ws) {
                    console.log(`[MGR_QR_WS] Client Bot Instance ${clientId} connected from ${clientIP}.`);
                    clientBotWsMap.set(clientId, ws);
                }
                
                // Process the initial message from the bot
                if (parsedMsg.type === 'status' && onIncomingClientStatusCallback) onIncomingClientStatusCallback(clientId, data);
                else if (parsedMsg.type === 'qr' && onIncomingClientQrCallback) onIncomingClientQrCallback(clientId, data);
                else if (parsedMsg.type === 'internalReply') handleClientBotMessage(clientId, parsedMsg); // Handle internal replies from bot
                
                // Set up listener for subsequent messages from this bot instance
                ws.on('message', (subsequentMessage) => handleClientBotMessage(clientId, JSON.parse(subsequentMessage.toString())));
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
                        // If this bot was the one currently linking in the UI, mark linking as failed
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
    // Extract participantJid as well for new whitelist commands
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
        case 'deleteInstance': // Added
            if (onDeleteInstanceCallback && clientId) onDeleteInstanceCallback(clientId);
            break;
        case 'getLogs':
            if (onGetLogsCallback && clientId) onGetLogsCallback(ws, clientId);
            break;
        case 'fetchGroups': // Added
            if (onFetchGroupsCallback && clientId) onFetchGroupsCallback(clientId);
            break;
        case 'addChatToWhitelist': // Handle add for both groups and participants
            const jidToAdd = groupId || participantJid;
            if (onAddChatToWhitelistCallback && clientId && jidToAdd) onAddChatToWhitelistCallback(clientId, jidToAdd);
            break;
        case 'removeFromChatWhitelist': // <-- NEW CASE
            const jidToRemove = groupId || participantJid;
            if (onRemoveFromChatWhitelistCallback && clientId && jidToRemove) onRemoveFromChatWhitelistCallback(clientId, jidToRemove);
            break;
        case 'fetchParticipants': // Added
            if (onFetchParticipantsCallback && clientId && groupId) onFetchParticipantsCallback(clientId, groupId);
            break;
        default:
            console.warn(`[MGR_QR_WS] Unhandled message type from C# UI: ${type}. Full message:`, parsedMsg); // Log full parsedMsg for debugging
            break;
    }
}

// Function to handle messages coming from Node.js client bots
function handleClientBotMessage(clientId, parsedMsg) {
    // This function receives parsedMsg directly, not raw message string.
    // Ensure this is called from `managerWsClient.onmessage` where it receives `internalReply` type.
    if (parsedMsg.clientId !== clientId) { // Safety check
        console.warn(`[MGR_QR_WS] ClientId mismatch in message from bot. Expected ${clientId}, got ${parsedMsg.clientId}. Ignoring.`);
        return;
    }

    if (parsedMsg.type === 'internalReply') {
        // This is a reply from a bot instance for a command previously sent by the manager (from C# UI)
        // Forward this reply directly to the main C# UI client.
        console.log(`[MGR_QR_WS] Received internal reply from bot ${clientId} for command type: ${parsedMsg.data?.type || 'unknown'}.`);
        if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
            // parsedMsg.data already contains {type, details, clientId}.
            // Ensure parsedMsg.data is forwarded as the main payload for C# UI
            // It already has 'clientId' within parsedMsg.data, so C# can filter.
            csharpClientWs.send(JSON.stringify(parsedMsg.data));
        } else {
            console.warn(`[MGR_QR_WS] C# UI not connected, cannot forward internal reply from bot ${clientId}.`);
        }
    }
    // Other types (status, qr) are handled directly by their respective callbacks already.
    // For example, when clientBotApp sends { type: 'status', data: {...} }, it's routed by `onIncomingClientStatusCallback`
    // when clientBotApp sends { type: 'qr', data: 'qr_string' }, it's routed by `onIncomingClientQrCallback`
    // This `handleClientBotMessage` specifically processes `internalReply` type.
}

function updateManagerQrState(status, message, qr = null, clientId = null, phoneNumber = null, clientName = null, isLinkingProcess = false) {
    if (isLinkingProcess) {
        managerQrState.linkingClientId = clientId;
    }

    managerQrState.status = status;
    managerQrState.message = message;
    managerQrState.qr = qr;

    const payload = {
        type: 'status', // Type for C# UI
        status: status,
        message: message,
        qr: qr,
        // Only provide clientId, phoneNumber, name if it's a connected/linking client.
        clientId: (status === 'connected' || isLinkingProcess) ? clientId : null,
        phoneNumber: status === 'connected' ? phoneNumber : null,
        name: status === 'connected' ? clientName : null,
    };

    if (csharpClientWs && csharpClientWs.readyState === WebSocket.OPEN) {
        csharpClientWs.send(JSON.stringify(payload));
        // console.log(`[MGR_QR_WS] Broadcasted to C# UI: status=${status}, msg=${message}, QR=${qr ? 'YES' : 'NO'}, activeLinkingCID=${managerQrState.linkingClientId}, payloadCID=${payload.clientId}`); // Can be noisy
    } else {
        // console.warn(`[MGR_QR_WS] C# UI client not connected, cannot broadcast ${status}.`); // Can be noisy
    }

    // Critical: Clear linkingClientId after a successful connection or terminal linking state
    if (managerQrState.linkingClientId && clientId === managerQrState.linkingClientId) {
        if (status === 'connected_whatsapp') { // If the linking client successfully connected
            console.log(`[MGR_QR_WS] Linked client ${clientId} is now permanently connected. Resetting linkingClientId.`);
            managerQrState.linkingClientId = null;
        } else if (status === 'disconnected_logout' || status === 'error_whatsapp_permanent' || status === 'linking_failed') {
            console.log(`[MGR_QR_WS] Linking for ${clientId} failed with status ${status}. Clearing linkingClientId.`);
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
        // console.log(`[MGR_QR_WS] Notified C# UI about instance ${clientId} status: ${status}`); // Can be noisy
    } else {
        // console.warn(`[MGR_QR_WS] C# UI client not connected, cannot send instance status update for ${clientId}.`); // Can be noisy
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
    clientBotWsMap // Export this map for instanceManager to use
};