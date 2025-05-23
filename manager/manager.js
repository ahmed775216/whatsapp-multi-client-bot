// manager/manager.js
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const config = require('../config');
const qrWebSocketServer = require('./qrWebSocketServer');
const instanceManager = require('./instanceManager');

console.log('--- Starting WhatsApp Bot Manager ---');

function handleQrRequest(apiUsername, apiPassword, ownerNumber) {
    const linkingClientId = instanceManager.generateClientId('new_linking_num');
    
    // --- DEBUG LOG START ---
    console.log(`[MANAGER_DEBUG] handleQrRequest received:`);
    console.log(`[MANAGER_DEBUG]   API Username: ${apiUsername ? apiUsername.substring(0,3) + '***' : 'NULL'}`);
    console.log(`[MANAGER_DEBUG]   API Password: ${apiPassword ? '*** (Set)' : 'NULL'}`);
    console.log(`[MANAGER_DEBUG]   Owner Number: ${ownerNumber ? ownerNumber.substring(0,3) + '***' : 'NULL'}`);
    // --- DEBUG LOG END ---

    console.log(`[MANAGER] C# app requested QR. Launching temporary client: ${linkingClientId} with API user: ${apiUsername ? 'Provided' : 'None'}, Owner: ${ownerNumber ? 'Provided' : 'None'}`);
    
    qrWebSocketServer.updateManagerQrState(
        'linking_in_progress', 
        'Generating QR code for new WhatsApp link...', 
        null, 
        linkingClientId, 
        null, null, 
        true
    );
    
    instanceManager.launchClientInstance(linkingClientId, 'new_linking_num', true, apiUsername, apiPassword, ownerNumber);
}

const wsCallbacks = {
    onQrRequested: (apiUsername, apiPassword, ownerNumber) => handleQrRequest(apiUsername, apiPassword, ownerNumber),
    onManualRelink: (apiUsername, apiPassword, ownerNumber) => {
        console.log('[MANAGER] C# app requested manual re-link (logout/new QR).');
        // --- DEBUG LOG START ---
        console.log(`[MANAGER_DEBUG] onManualRelink received:`);
        console.log(`[MANAGER_DEBUG]   API Username: ${apiUsername ? apiUsername.substring(0,3) + '***' : 'NULL'}`);
        console.log(`[MANAGER_DEBUG]   API Password: ${apiPassword ? '*** (Set)' : 'NULL'}`);
        console.log(`[MANAGER_DEBUG]   Owner Number: ${ownerNumber ? ownerNumber.substring(0,3) + '***' : 'NULL'}`);
        // --- DEBUG LOG END ---
        const currentUiLinkingClientId = qrWebSocketServer.managerQrState?.linkingClientId;
        if (currentUiLinkingClientId) {
            instanceManager.stopClientInstance(currentUiLinkingClientId);
            console.log(`[MANAGER] Stopped existing temporary linking client: ${currentUiLinkingClientId}`);
        }
        qrWebSocketServer.resetManagerLinkingDisplay();
        setTimeout(() => {
            handleQrRequest(apiUsername, apiPassword, ownerNumber);
        }, 1000);
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
        console.log(`[MANAGER] Sent instance list to C# client.`);
    },
    onStartInstance: (clientId) => {
        instanceManager.restartClientInstance(clientId);
        console.log(`[MANAGER] Received request to start instance: ${clientId}`);
    },
    onStopInstance: (clientId) => {
        instanceManager.stopClientInstance(clientId);
        console.log(`[MANAGER] Received request to stop instance: ${clientId}`);
    },
    onRestartInstance: (clientId) => {
        instanceManager.restartClientInstance(clientId);
        console.log(`[MANAGER] Received request to restart instance: ${clientId}`);
    },
    onGetLogs: (ws, clientId) => {
        const logs = instanceManager.getInstanceLogs(clientId);
        qrWebSocketServer.sendToClient(ws, { type: 'instanceLogs', clientId: clientId, logs: logs });
        console.log(`[MANAGER] Sent logs for ${clientId} to C# client.`);
    }
};

qrWebSocketServer.startWebSocketServer(config.QR_WEBSOCKET_PORT, wsCallbacks);
instanceManager.recoverExistingClientInstances();

process.on('uncaughtException', (err) => {
    console.error('[MANAGER_FATAL] Uncaught Exception:', err);
    qrWebSocketServer.updateManagerQrState('error', `Manager internal error: ${err.message}`, null, null, null, null, false);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[MANAGER_FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    qrWebSocketServer.updateManagerQrState('error', `Manager unhandled rejection: ${reason.message || reason}`, null, null, null, null, false);
    process.exit(1);
});