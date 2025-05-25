// manager/manager.js
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const config = require('../config');
const qrWebSocketServer = require('./qrWebSocketServer');
const instanceManager = require('./instanceManager');

console.log('--- Starting WhatsApp Bot Manager ---');
console.log(`[MANAGER_CONFIG] API_BASE_URL: ${config.API_BASE_URL}`);
console.log(`[MANAGER_CONFIG] QR_WEBSOCKET_PORT: ${config.QR_WEBSOCKET_PORT}`);

function handleQrRequest(apiUsername, apiPassword, ownerNumber) {
    const linkingClientId = instanceManager.generateClientId('new_linking_num');
    console.log(`[MANAGER] UI requested QR. Launching temporary client: ${linkingClientId} with API User: ${apiUsername ? 'Provided' : 'None'}, Owner: ${ownerNumber ? 'Provided' : 'None'}`);
    
    qrWebSocketServer.updateManagerQrState(
        'linking_in_progress', 
        'Generating QR code for new WhatsApp link...', 
        null, linkingClientId, null, null, true
    );
    instanceManager.launchClientInstance(linkingClientId, 'new_linking_num', true, apiUsername, apiPassword, ownerNumber);
}

const wsCallbacks = {
    onQrRequested: (apiUsername, apiPassword, ownerNumber) => handleQrRequest(apiUsername, apiPassword, ownerNumber),
    onManualRelink: (apiUsername, apiPassword, ownerNumber) => {
        console.log('[MANAGER] UI requested manual re-link (logout/new QR).');
        const currentUiLinkingClientId = qrWebSocketServer.managerQrState?.linkingClientId;
        if (currentUiLinkingClientId) {
            instanceManager.stopClientInstance(currentUiLinkingClientId);
            console.log(`[MANAGER] Stopped existing temporary linking client: ${currentUiLinkingClientId} for manual relink.`);
        }
        qrWebSocketServer.resetManagerLinkingDisplay(); // Clear old QR from UI
        setTimeout(() => { // Give a moment for stop to process
            handleQrRequest(apiUsername, apiPassword, ownerNumber);
        }, 1500); // Increased delay
    },
    onIncomingClientStatus: (clientId, data) => {
        instanceManager.handleClientBotStatusUpdate(clientId, data);
    },
    onIncomingClientQr: (clientId, qrData) => {
        instanceManager.handleClientBotQrUpdate(clientId, qrData);
    },
    onListInstances: (ws) => {
        const instances = instanceManager.listInstances();
        qrWebSocketServer.sendToClient(ws, { type: 'instanceList', instances: instances });
    },
    onStartInstance: (clientId) => {
        instanceManager.restartClientInstance(clientId); // Restart implies start if not running
    },
    onStopInstance: (clientId) => {
        instanceManager.stopClientInstance(clientId);
    },
    onRestartInstance: (clientId) => {
        instanceManager.restartClientInstance(clientId);
    },
    onDeleteInstance: (clientId) => { // Handler for deleteInstance command
        instanceManager.deleteClientInstance(clientId);
    },
    onGetLogs: (ws, clientId) => {
        const logs = instanceManager.getInstanceLogs(clientId);
        qrWebSocketServer.sendToClient(ws, { type: 'instanceLogs', clientId: clientId, logs: logs });
    },
    // Callbacks for group/participant management
    onFetchGroups: (clientId) => {
        if (instanceManager.sendInternalCommandToClient(clientId, { command: 'fetchGroups' })) {
            console.log(`[MANAGER] Sent 'fetchGroups' command to client ${clientId}.`);
        } else { console.warn(`[MANAGER] Failed to send 'fetchGroups' to ${clientId} (not connected/found).`); }
    },
    onAddChatToWhitelist: (clientId, jidToWhitelist) => {
        const payload = { command: 'addChatToWhitelist' };
        if (jidToWhitelist.endsWith('@g.us')) payload.groupId = jidToWhitelist;
        else payload.participantJid = jidToWhitelist;
        
        if (instanceManager.sendInternalCommandToClient(clientId, payload)) {
            console.log(`[MANAGER] Sent 'addChatToWhitelist' for ${jidToWhitelist} to client ${clientId}.`);
        } else { console.warn(`[MANAGER] Failed to send 'addChatToWhitelist' for ${jidToWhitelist} to ${clientId}.`); }
    },
    onRemoveFromChatWhitelist: (clientId, jidToRemove) => {
        const payload = { command: 'removeFromChatWhitelist' };
        if (jidToRemove.endsWith('@g.us')) payload.groupId = jidToRemove;
        else payload.participantJid = jidToRemove;

        if (instanceManager.sendInternalCommandToClient(clientId, payload)) {
            console.log(`[MANAGER] Sent 'removeFromChatWhitelist' for ${jidToRemove} to client ${clientId}.`);
        } else { console.warn(`[MANAGER] Failed to send 'removeFromChatWhitelist' for ${jidToRemove} to ${clientId}.`); }
    },
    onFetchParticipants: (clientId, groupId) => {
        if (instanceManager.sendInternalCommandToClient(clientId, { command: 'fetchParticipants', groupId: groupId })) {
            console.log(`[MANAGER] Sent 'fetchParticipants' for group ${groupId} to client ${clientId}.`);
        } else { console.warn(`[MANAGER] Failed to send 'fetchParticipants' for group ${groupId} to ${clientId}.`); }
    }
};

qrWebSocketServer.startWebSocketServer(config.QR_WEBSOCKET_PORT, wsCallbacks);
instanceManager.recoverExistingClientInstances();

process.on('uncaughtException', (err, origin) => {
    console.error(`[MANAGER_FATAL] Uncaught Exception at: ${origin}. Error: ${err.stack || err}`);
    qrWebSocketServer.updateManagerQrState('error', `Manager internal error: ${err.message}`, null, null, null, null, false);
    // Consider if process.exit(1) is too harsh or if it should try to stay alive for other instances.
    // For now, keeping exit as it indicates a severe manager issue.
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[MANAGER_FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    const message = (reason instanceof Error) ? reason.message : String(reason);
    qrWebSocketServer.updateManagerQrState('error', `Manager unhandled rejection: ${message}`, null, null, null, null, false);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log("[MANAGER] SIGINT received, shutting down all instances...");
    instanceManager.stopAllInstances(); // Implement this if needed
    setTimeout(() => process.exit(0), 2000); // Give time for instances to shut down
});
process.on('SIGTERM', () => {
    console.log("[MANAGER] SIGTERM received, shutting down all instances...");
    instanceManager.stopAllInstances(); // Implement this if needed
    setTimeout(() => process.exit(0), 2000);
});