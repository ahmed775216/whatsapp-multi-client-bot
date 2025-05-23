// manager/manager.js
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const config = require('../config');
const qrWebSocketServer = require('./qrWebSocketServer');
const instanceManager = require('./instanceManager');

console.log('--- Starting WhatsApp Bot Manager ---');

// Modified handleQrRequest to accept API credentials
function handleQrRequest(apiUsername, apiPassword) {
    const linkingClientId = instanceManager.generateClientId('new_linking_num');
    
    console.log(`[MANAGER] C# app requested QR. Launching temporary client: ${linkingClientId} with API user: ${apiUsername ? 'Provided' : 'None'}`);
    
    qrWebSocketServer.updateManagerQrState(
        'linking_in_progress', 
        'Generating QR code for new WhatsApp link...', 
        null, 
        linkingClientId, 
        null, null, 
        true
    );
    
    // Pass the API credentials received from C# directly to launchClientInstance
    instanceManager.launchClientInstance(linkingClientId, 'new_linking_num', true, apiUsername, apiPassword);
}

const wsCallbacks = {
    // onQrRequested and onManualRelink will now receive API credentials from C#
    onQrRequested: (apiUsername, apiPassword) => handleQrRequest(apiUsername, apiPassword),
    onManualRelink: (apiUsername, apiPassword) => { // Manual relink also sends credentials
        console.log('[MANAGER] C# app requested manual re-link (logout/new QR).');
        const currentUiLinkingClientId = qrWebSocketServer.managerQrState?.linkingClientId;
        if (currentUiLinkingClientId) {
            instanceManager.stopClientInstance(currentUiLinkingClientId);
            console.log(`[MANAGER] Stopped existing temporary linking client: ${currentUiLinkingClientId}`);
        }
        qrWebSocketServer.resetManagerLinkingDisplay();
        setTimeout(() => { // Give a moment for cleanup
            handleQrRequest(apiUsername, apiPassword); // Trigger a new linking process with credentials
        }, 1000);
    },
    onIncomingClientStatus: (clientId, data) => {
        instanceManager.handleClientBotStatusUpdate(clientId, data);
    },
    onIncomingClientQr: (clientId, qrData) => {
        instanceManager.handleClientBotQrUpdate(clientId, qrData);
    },
    // Removed onActivateClientWithApi callback as it's no longer part of this flow
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