// manager/manager.js
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const config = require('../config');
const qrWebSocketServer = require('./qrWebSocketServer');
const instanceManager = require('./instanceManager');

console.log('--- Starting WhatsApp Bot Manager ---');

// Fix 4: Update the manager's QR request handler to use consistent ID generation
function handleQrRequest() {
    // Generate the client ID for the new linking attempt.
    // This will create an ID like 'client_new_linking_TIMESTAMP'
    const linkingClientId = instanceManager.generateClientId('new_linking_num');
    
    console.log(`[MANAGER] C# app requested QR. Launching temporary client: ${linkingClientId}`);
    
    // Update qrWebSocketServer's state to track this new linking client ID for the UI
    // Pass `isLinkingProcess = true`
    qrWebSocketServer.updateManagerQrState(
        'linking_in_progress', 
        'Generating QR code for new WhatsApp link...', 
        null, // No QR yet
        linkingClientId, // The ID of the client bot that will provide the QR
        null, null, // No phone/name yet
        true  // This is for an active linking process on the UI
    );
    
    // Launch the instance. It will connect back and send its QR.
    // Pass default API credentials for now; Stage 4 will handle client-specific ones.
    instanceManager.launchClientInstance(linkingClientId, 'new_linking_num', true, config.API_USERNAME, config.API_PASSWORD);
}

const wsCallbacks = {
    onQrRequested: handleQrRequest, // Use the updated handler
    onManualRelink: () => {
        console.log('[MANAGER] C# app requested manual re-link (logout/new QR).');
        const currentUiLinkingClientId = qrWebSocketServer.managerQrState?.linkingClientId;
        if (currentUiLinkingClientId) {
            instanceManager.stopClientInstance(currentUiLinkingClientId);
            console.log(`[MANAGER] Stopped existing temporary linking client: ${currentUiLinkingClientId}`);
        }
        qrWebSocketServer.resetManagerLinkingDisplay();
        setTimeout(() => { // Give a moment for cleanup
            handleQrRequest(); // Trigger a new linking process
        }, 1000);
    },
    onIncomingClientStatus: (clientId, data) => {
        instanceManager.handleClientBotStatusUpdate(clientId, data);
    },
    onIncomingClientQr: (clientId, qrData) => {
        instanceManager.handleClientBotQrUpdate(clientId, qrData);
    }
};

qrWebSocketServer.startWebSocketServer(config.QR_WEBSOCKET_PORT, wsCallbacks);
instanceManager.recoverExistingClientInstances();

process.on('uncaughtException', (err) => {
    console.error('[MANAGER_FATAL] Uncaught Exception:', err);
    // Use a generic client ID or null if it's a manager-level error not tied to a specific linking op
    qrWebSocketServer.updateManagerQrState('error', `Manager internal error: ${err.message}`, null, null, null, null, false);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[MANAGER_FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    qrWebSocketServer.updateManagerQrState('error', `Manager unhandled rejection: ${reason.message || reason}`, null, null, null, null, false);
    process.exit(1);
});