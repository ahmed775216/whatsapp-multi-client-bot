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
    // Log the request
    console.log(`[MANAGER] QR request received - API User: ${apiUsername}, Owner: ${ownerNumber}`);
    
    // Check if there's already an active linking process
    const activeLinkingInstances = Object.values(instanceManager.ACTIVE_BOT_INSTANCES).filter(inst => 
        inst.isLinkingClient && inst.process && !inst.process.killed
    );
    
    if (activeLinkingInstances.length > 0) {
        console.warn(`[MANAGER] Linking already in progress with ${activeLinkingInstances[0].clientId}`);
        qrWebSocketServer.updateManagerQrState(
            'error', 
            'A linking process is already in progress. Please complete or cancel it first.', 
            null, 
            activeLinkingInstances[0].clientId, 
            null, 
            null, 
            true
        );
        return;
    }

    const linkingClientId = instanceManager.generateClientId('new_linking_num');
    console.log(`[MANAGER] UI requested QR. Launching temporary client: ${linkingClientId}`);
    
    // Send initial status
    qrWebSocketServer.updateManagerQrState(
        'linking_in_progress', 
        'Generating QR code for new WhatsApp link...', 
        null, 
        linkingClientId, 
        null, 
        null, 
        true
    );
    
    // Launch the instance
    const childProcess = instanceManager.launchClientInstance(
        linkingClientId, 
        'new_linking_num', 
        true, 
        apiUsername, 
        apiPassword, 
        ownerNumber
    );
    
    if (!childProcess) {
        console.error(`[MANAGER] Failed to launch linking instance ${linkingClientId}`);
        qrWebSocketServer.updateManagerQrState(
            'error', 
            'Failed to start linking process. Please try again.', 
            null, 
            linkingClientId, 
            null, 
            null, 
            true
        );
    }
}

const wsCallbacks = {
    onQrRequested: (apiUsername, apiPassword, ownerNumber) => handleQrRequest(apiUsername, apiPassword, ownerNumber),
    onManualRelink: (apiUsername, apiPassword, ownerNumber) => {
        console.log('[MANAGER] UI requested manual re-link (logout/new QR).');
        
        // Stop any existing linking processes first
        const activeLinkingInstances = Object.values(instanceManager.ACTIVE_BOT_INSTANCES).filter(inst => 
            inst.isLinkingClient && inst.process && !inst.process.killed
        );
        
        activeLinkingInstances.forEach(inst => {
            console.log(`[MANAGER] Stopping existing linking instance: ${inst.clientId}`);
            instanceManager.stopClientInstance(inst.clientId);
        });
        
        const currentUiLinkingClientId = qrWebSocketServer.managerQrState?.linkingClientId;
        if (currentUiLinkingClientId && !activeLinkingInstances.find(inst => inst.clientId === currentUiLinkingClientId)) {
            instanceManager.stopClientInstance(currentUiLinkingClientId);
            console.log(`[MANAGER] Stopped existing temporary linking client: ${currentUiLinkingClientId} for manual relink.`);
        }
        
        qrWebSocketServer.resetManagerLinkingDisplay();
        setTimeout(() => {
            handleQrRequest(apiUsername, apiPassword, ownerNumber);
        }, 1500);
    },
    
    onIncomingClientData: instanceManager.handleClientBotDataUpdate,
    
    onListInstances: (ws) => {
        const instances = instanceManager.listInstances();
        qrWebSocketServer.sendToClient(ws, { type: 'instancesList', instances: instances }); // Fixed typo: instanceList -> instancesList
    },
    onStartInstance: (clientId) => {
        instanceManager.restartClientInstance(clientId);
    },
    onStopInstance: (clientId) => {
        instanceManager.stopClientInstance(clientId);
    },
    onRestartInstance: (clientId) => {
        instanceManager.restartClientInstance(clientId);
    },
    onDeleteInstance: (clientId) => {
        instanceManager.deleteClientInstance(clientId);
    },
    onGetLogs: (ws, clientId) => {
        const logs = instanceManager.getInstanceLogs(clientId);
        qrWebSocketServer.sendToClient(ws, { type: 'instanceLogs', clientId: clientId, logs: logs });
    },
    onFetchGroups: (clientId) => {
        instanceManager.sendInternalCommandToClient(clientId, { command: 'fetchGroups' });
    },
    onAddChatToWhitelist: (clientId, jidToWhitelist) => {
        const payload = { command: 'addChatToWhitelist' };
        if (jidToWhitelist.endsWith('@g.us')) payload.groupId = jidToWhitelist;
        else payload.participantJid = jidToWhitelist;
        instanceManager.sendInternalCommandToClient(clientId, payload);
    },
    onRemoveFromChatWhitelist: (clientId, jidToRemove) => {
        const payload = { command: 'removeFromChatWhitelist' };
        if (jidToRemove.endsWith('@g.us')) payload.groupId = jidToRemove;
        else payload.participantJid = jidToRemove;
        instanceManager.sendInternalCommandToClient(clientId, payload);
    },
    onFetchParticipants: (clientId, groupId) => {
        instanceManager.sendInternalCommandToClient(clientId, { command: 'fetchParticipants', groupId: groupId });
    }
};

qrWebSocketServer.startWebSocketServer(config.QR_WEBSOCKET_PORT, wsCallbacks);
instanceManager.recoverExistingClientInstances();

process.on('uncaughtException', (err, origin) => {
    console.error(`[MANAGER_FATAL] Uncaught Exception at: ${origin}. Error: ${err.stack || err}`);
    if (qrWebSocketServer && qrWebSocketServer.updateManagerQrState) {
        qrWebSocketServer.updateManagerQrState('error', `Manager internal error: ${err.message}`, null, null, null, null, false);
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[MANAGER_FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    const message = (reason instanceof Error) ? reason.message : String(reason);
    if (qrWebSocketServer && qrWebSocketServer.updateManagerQrState) {
        qrWebSocketServer.updateManagerQrState('error', `Manager unhandled rejection: ${message}`, null, null, null, null, false);
    }
    process.exit(1);
});

const shutdown = () => {
    console.log("[MANAGER] Shutdown signal received, stopping instances...");
    Object.keys(instanceManager.ACTIVE_BOT_INSTANCES).forEach(clientId => {
        instanceManager.stopClientInstance(clientId);
    });
    setTimeout(() => {
        console.log("[MANAGER] Exiting.");
        process.exit(0);
    }, 3000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);