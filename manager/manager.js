// manager/manager.js
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // تأكد من أن هذا المسار صحيح إذا كان .env في الجذر

const config = require('../config');
const qrWebSocketServer = require('./qrWebSocketServer');
const instanceManager = require('./instanceManager');

console.log('--- Starting WhatsApp Bot Manager ---');
console.log(`[MANAGER_CONFIG] API_BASE_URL: ${config.API_BASE_URL}`);
console.log(`[MANAGER_CONFIG] QR_WEBSOCKET_PORT: ${config.QR_WEBSOCKET_PORT}`);

function handleQrRequest(apiUsername, apiPassword, ownerNumber) {
    const linkingClientId = instanceManager.generateClientId('new_linking_num');
    console.log(`[MANAGER] UI requested QR. Launching temporary client: ${linkingClientId} with API User: ${apiUsername ? 'Set' : 'None'}, Owner: ${ownerNumber ? 'Set' : 'None'}`);
    
    // استخدم qrWebSocketServerModule للوصول إلى الدوال إذا كان هناك مشاكل في الاستيراد المباشر
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
        qrWebSocketServer.resetManagerLinkingDisplay();
        setTimeout(() => {
            handleQrRequest(apiUsername, apiPassword, ownerNumber);
        }, 1500);
    },
    
    // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> POINT OF INTEREST <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
    // هذا الكولباك يجب أن يشير إلى الدالة الصحيحة في instanceManager
    onIncomingClientData: instanceManager.handleClientBotDataUpdate, 
    // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< END POINT OF INTEREST <<<<<<<<<<<<<<<<<<<<<<<<<<<

    onListInstances: (ws) => {
        const instances = instanceManager.listInstances();
        qrWebSocketServer.sendToClient(ws, { type: 'instanceList', instances: instances });
    },
    onStartInstance: (clientId) => {
        instanceManager.restartClientInstance(clientId); // أو launchClientInstance إذا كان هذا هو المقصود بـ "Start"
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
    if (qrWebSocketServer && qrWebSocketServer.updateManagerQrState) { // تحقق من وجود الدالة
        qrWebSocketServer.updateManagerQrState('error', `Manager internal error: ${err.message}`, null, null, null, null, false);
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[MANAGER_FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    const message = (reason instanceof Error) ? reason.message : String(reason);
    if (qrWebSocketServer && qrWebSocketServer.updateManagerQrState) { // تحقق من وجود الدالة
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
    }, 3000); // زيادة المهلة قليلاً
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);