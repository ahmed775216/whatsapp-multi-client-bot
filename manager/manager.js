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
    
    console.log(`[MANAGER_DEBUG] handleQrRequest received:`);
    console.log(`[MANAGER_DEBUG]   API Username: ${apiUsername ? apiUsername.substring(0,3) + '***' : 'NULL'}`);
    console.log(`[MANAGER_DEBUG]   API Password: ${apiPassword ? '*** (Set)' : 'NULL'}`);
    console.log(`[MANAGER_DEBUG]   Owner Number: ${ownerNumber ? ownerNumber.substring(0,3) + '***' : 'NULL'}`);

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
        console.log(`[MANAGER_DEBUG] onManualRelink received:`);
        console.log(`[MANAGER_DEBUG]   API Username: ${apiUsername ? apiUsername.substring(0,3) + '***' : 'NULL'}`);
        console.log(`[MANAGER_DEBUG]   API Password: ${apiPassword ? '*** (Set)' : 'NULL'}`);
        console.log(`[MANAGER_DEBUG]   Owner Number: ${ownerNumber ? ownerNumber.substring(0,3) + '***' : 'NULL'}`);
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
        // Find the instance to get its original launch parameters (username, password, owner)
        const instance = instanceManager.ACTIVE_BOT_INSTANCES[clientId];
        if (instance) {
             console.log(`[MANAGER] Received request to start instance: ${clientId}. Launching with stored credentials.`);
             // Pass stored credentials directly to launchClientInstance
             instanceManager.launchClientInstance(
                 clientId,
                 instance.phoneNumber, // Use stored phone number
                 false, // No force new scan on manual start
                 instance.apiUsername,
                 instance.apiPassword,
                 instance.ownerNumber
             );
        } else {
             console.warn(`[MANAGER] Attempted to start unknown or previously deleted client: ${clientId}. If folder exists, it will try to recover.`);
             // If not in ACTIVE_BOT_INSTANCES, it might be a clean restart from persistent storage.
             // Rely on `recoverExistingClientInstances` logic to pick up saved `client_config.json`.
             // We can trigger `recoverExistingClientInstances` here, but it's heavier.
             // Simpler: assume UI clicked start only on what is in list, or user knows best.
             // Relaunching an already-tracked but 'stopped' process is handled in instanceManager.
        }
    },
    onStopInstance: (clientId) => {
        instanceManager.stopClientInstance(clientId);
        console.log(`[MANAGER] Received request to stop instance: ${clientId}`);
    },
    onRestartInstance: (clientId) => {
        instanceManager.restartClientInstance(clientId);
        console.log(`[MANAGER] Received request to restart instance: ${clientId}`);
    },
    onDeleteInstance: (clientId) => { // NEW CALLBACK
        instanceManager.deleteClientInstance(clientId);
        console.log(`[MANAGER] Received request to delete instance: ${clientId}`);
    },
    onGetLogs: (ws, clientId) => {
        const logs = instanceManager.getInstanceLogs(clientId);
        qrWebSocketServer.sendToClient(ws, { type: 'instanceLogs', clientId: clientId, logs: logs });
        console.log(`[MANAGER] Sent logs for ${clientId} to C# client.`);
    },
    onFetchGroups: (clientId) => { // NEW CALLBACK FOR FETCHING GROUPS
        instanceManager.sendInternalCommandToClient(clientId, { command: 'fetchGroups' });
    },
    onAddChatToWhitelist: (clientId, groupId) => { // NEW CALLBACK FOR ADDING GROUP TO WHITELIST
        instanceManager.sendInternalCommandToClient(clientId, { command: 'addChatToWhitelist', groupId: groupId });
    },
    onFetchParticipants: (clientId, groupId) => { // NEW CALLBACK FOR FETCHING GROUP PARTICIPANTS
        instanceManager.sendInternalCommandToClient(clientId, { command: 'fetchParticipants', groupId: groupId });
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