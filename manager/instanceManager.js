// manager/instanceManager.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('../config');
const { updateManagerQrState } = require('./qrWebSocketServer');

const ACTIVE_BOT_INSTANCES = {};

function ensureClientDataDirExists() {
    if (!fs.existsSync(config.CLIENT_DATA_BASE_DIR)) {
        fs.mkdirSync(config.CLIENT_DATA_BASE_DIR, { recursive: true });
        console.log(`[INST_MGR] Created client data base directory: ${config.CLIENT_DATA_BASE_DIR}`);
    }
}

function generateClientId(phoneNumber) {
    if (phoneNumber === 'new_linking_num' || !phoneNumber || phoneNumber.trim() === '') {
        return `client_new_linking_${Date.now()}`;
    }
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    return `client_${cleanPhone}_${Date.now()}`;
}

function getClientDataPath(clientId) {
    return path.join(config.CLIENT_DATA_BASE_DIR, clientId);
}

/**
 * Launches a new bot instance as a child process.
 * @param {string} clientId - Unique ID for this client instance.
 * @param {string} phoneNumber - The phone number associated with this client (for identifying instance).
 * @param {boolean} forceNewScan - True if we need to clear session data for a new QR scan.
 * @param {string} [apiUsername=null] - API username for this specific client bot.
 * @param {string} [apiPassword=null] - API password for this specific client bot.
 */
function launchClientInstance(clientId, phoneNumber, forceNewScan = false, apiUsername = null, apiPassword = null) {
    ensureClientDataDirExists();

    const clientDataPath = getClientDataPath(clientId);
    const authDir = path.join(clientDataPath, 'auth_info_baileys');
    const dataDir = path.join(clientDataPath, 'data');

    if (forceNewScan && fs.existsSync(authDir)) {
        try {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log(`[INST_MGR] Cleared existing auth data for ${clientId} for new scan.`);
        } catch (e) {
            console.error(`[INST_MGR_ERROR] Failed to clear auth data for ${clientId}:`, e);
        }
    } else if (fs.existsSync(authDir) && !fs.readdirSync(authDir).length && !forceNewScan) {
        console.log(`[INST_MGR] Auth data for ${clientId} is empty, setting for QR scan on launch.`);
        forceNewScan = true;
    }

    const env = {
        ...process.env,
        AUTH_DIR: authDir,
        DATA_DIR: dataDir,
        CLIENT_ID: clientId,
        OWNER_NUMBER_FOR_CLIENT: config.OWNER_NUMBER,
        MANAGER_WS_PORT: config.QR_WEBSOCKET_PORT,
        API_USERNAME_FOR_CLIENT_BOT_LOGIC: apiUsername, // Pass provided username
        API_PASSWORD_FOR_CLIENT_BOT_LOGIC: apiPassword, // Pass provided password
        API_BASE_URL: config.API_BASE_URL,
        // Removed SKIP_API_SYNC as it's no longer necessary with this flow
    };

    const clientBotEntryFile = path.join(config.CLIENT_CODE_DIR, 'clientBotApp.js');

    console.log(`[INST_MGR] Launching instance for ${clientId} (phone: ${phoneNumber}). Force new scan: ${forceNewScan}. API User: ${apiUsername ? 'Provided' : 'None'}`);

    const child = spawn('node', [clientBotEntryFile], {
        cwd: config.CLIENT_CODE_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env,
    });

    ACTIVE_BOT_INSTANCES[clientId] = {
        process: child,
        phoneNumber,
        name: 'Unknown',
        clientId,
        status: 'starting',
        lastUpdated: Date.now(),
        lastKnownQR: null,
        isLinkingClient: phoneNumber === 'new_linking_num' || clientId.startsWith('client_new_linking_'),
        apiUsername: apiUsername, // Store these for potential re-launch (e.g., if manager restarts)
        apiPassword: apiPassword,
    };

    child.stdout.on('data', (data) => {
        const logLine = data.toString().trim();
        // console.log(`[${clientId}_OUT] ${logLine}`);
    });

    child.stderr.on('data', (data) => {
        console.error(`[${clientId}_ERR] ${data.toString().trim()}`);
    });

    child.on('close', (code) => {
        console.log(`[INST_MGR] Client ${clientId} process exited with code ${code}.`);
        const instanceData = ACTIVE_BOT_INSTANCES[clientId];
        if (instanceData) {
            instanceData.status = `exited (${code})`;
            instanceData.lastUpdated = Date.now();
        }
        delete ACTIVE_BOT_INSTANCES[clientId];
        
        const currentUiLinkingClientId = require('./qrWebSocketServer').managerQrState?.linkingClientId;
        if (clientId === currentUiLinkingClientId && code !== 0) {
             updateManagerQrState('linking_failed', `QR linking process failed unexpectedly for ${clientId}.`, null, clientId, null, null, true);
        }
    });

    child.on('error', (err) => {
        console.error(`[INST_MGR_ERROR] Failed to start process for ${clientId}:`, err);
        const instanceData = ACTIVE_BOT_INSTANCES[clientId];
        if (instanceData) {
            instanceData.status = `error (${err.message})`;
            instanceData.lastUpdated = Date.now();
        }
        const currentUiLinkingClientId = require('./qrWebSocketServer').managerQrState?.linkingClientId;
        if (clientId === currentUiLinkingClientId) {
             updateManagerQrState('error', `Failed to start QR process for ${clientId}: ${err.message}`, null, clientId, null, null, true);
        }
    });

    return child;
}

function stopClientInstance(clientId) {
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance) {
        console.log(`[INST_MGR] Stopping client ${instance.clientId}...`);
        instance.status = 'stopping';
        instance.lastUpdated = Date.now();
        
        if (instance.process.connected) {
            instance.process.disconnect();
        }
        instance.process.kill('SIGTERM');

        instance.terminateTimeout = setTimeout(() => {
            if (instance.process && instance.process.pid && !instance.process.killed) {
                console.warn(`[INST_MGR] Client ${instance.clientId} not exiting gracefully, force killing.`);
                instance.process.kill('SIGKILL');
            }
        }, 10000);

        return true;
    }
    return false;
}

function recoverExistingClientInstances() {
    ensureClientDataDirExists();
    console.log("[INST_MGR] Scanning for existing client instances to restart...");
    const existingClientFolders = fs.readdirSync(config.CLIENT_DATA_BASE_DIR);

    for (const folderName of existingClientFolders) {
        if (folderName.startsWith('client_new_linking_')) continue;

        const clientAuthPath = path.join(config.CLIENT_DATA_BASE_DIR, folderName, 'auth_info_baileys');
        // A placeholder for loading stored API credentials for recovered clients
        // This would ideally be saved in a config file alongside auth_info_baileys
        // For now, these recovered clients won't have specific API credentials unless implemented later.
        const recoveredApiUsername = null; 
        const recoveredApiPassword = null; 
        
        if (fs.existsSync(clientAuthPath) && fs.readdirSync(clientAuthPath).length > 0) {
            const phoneNumberMatch = folderName.match(/client_(\d+)_/);
            const phoneNumber = phoneNumberMatch ? phoneNumberMatch[1] : folderName;

            console.log(`[INST_MGR] Found existing session for client folder: ${folderName} (Phone: ${phoneNumber}). Attempting to launch.`);
            // Launch recovered client with any loaded API credentials
            launchClientInstance(folderName, phoneNumber, false, recoveredApiUsername, recoveredApiPassword);
        } else {
            console.log(`[INST_MGR] Folder ${folderName} does not contain an active session. Skipping restart.`);
        }
    }
}

function handleClientBotQrUpdate(clientId, qr) {
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance) {
        instance.lastKnownQR = qr;
        
        const isCurrentlyLinkingOnUI = clientId === require('./qrWebSocketServer').managerQrState?.linkingClientId;
        
        if (instance.isLinkingClient || isCurrentlyLinkingOnUI) {
            console.log(`[INST_MGR] QR received from linking client ${clientId}. Broadcasting to UI.`);
            updateManagerQrState('qr', 'Scan the QR code with WhatsApp.', qr, clientId, null, null, true);
        } else {
            console.log(`[INST_MGR] QR received from existing client ${clientId}. Not automatically shown on UI.`);
        }
    } else {
        console.warn(`[INST_MGR] Received QR update for unknown client ID: ${clientId}`);
    }
}

function handleClientBotStatusUpdate(clientId, data) {
    const { status, message, phoneNumber, name, qr: qrFromStatusData } = data;
    const instance = ACTIVE_BOT_INSTANCES[clientId];

    if (instance) {
        instance.status = status;
        instance.lastUpdated = Date.now();
        if (phoneNumber) instance.phoneNumber = phoneNumber;
        if (name) instance.name = name;
    } else if (status !== 'connecting') {
        console.warn(`[INST_MGR] Received status update for unknown/stopped client ID: ${clientId}, status: ${status}`);
        return;
    }

    const currentUiLinkingClientId = require('./qrWebSocketServer').managerQrState?.linkingClientId;

    if (status === 'connected') {
        if (instance && (instance.isLinkingClient || clientId === currentUiLinkingClientId)) {
            const oldLinkingClientId = clientId;
            const newPermanentClientId = generateClientId(phoneNumber);

            const oldClientPath = getClientDataPath(oldLinkingClientId);
            const newClientPath = getClientDataPath(newPermanentClientId);
            let renameSuccess = false;

            if (fs.existsSync(oldClientPath)) {
                try {
                    if (oldClientPath !== newClientPath) {
                        fs.renameSync(oldClientPath, newClientPath);
                        console.log(`[INST_MGR] Client data folder renamed from ${oldLinkingClientId} to ${newPermanentClientId}.`);
                    } else {
                        console.log(`[INST_MGR] Client ID ${oldLinkingClientId} is already permanent. No rename needed.`);
                    }
                    renameSuccess = true;
                } catch (err) {
                    console.error(`[INST_MGR_ERROR] Failed to rename client data folder for ${oldLinkingClientId}: ${err.message}`);
                    updateManagerQrState('error', `Linked but failed to store session: ${err.message}`, null, oldLinkingClientId, phoneNumber, name, true);
                }
            } else {
                console.warn(`[INST_MGR] Old client path ${oldClientPath} not found for rename during linking. Active session might be in new path already.`);
                if (phoneNumber) renameSuccess = true;
            }

            if (renameSuccess) {
                // If it was a temporary client, stop the old process and launch the new permanent one.
                // The new permanent one will use the API credentials stored in 'instance' which came from C#.
                if (oldLinkingClientId !== newPermanentClientId) {
                    stopClientInstance(oldLinkingClientId);
                    if (ACTIVE_BOT_INSTANCES[oldLinkingClientId]) delete ACTIVE_BOT_INSTANCES[oldLinkingClientId];
                }

                console.log(`[INST_MGR] Client ${newPermanentClientId} (${phoneNumber}) successfully linked. (Re)Launching as permanent.`);
                const linkedApiUsername = instance.apiUsername; // Get API credentials that came with the linking request
                const linkedApiPassword = instance.apiPassword;

                // Launch the new permanent instance with the collected API credentials
                if (!ACTIVE_BOT_INSTANCES[newPermanentClientId]) {
                    launchClientInstance(newPermanentClientId, phoneNumber, false, linkedApiUsername, linkedApiPassword);
                } else {
                    // If the process somehow continues (unlikely after rename), update its state
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].isLinkingClient = false;
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].apiUsername = linkedApiUsername;
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].apiPassword = linkedApiPassword;
                    // If it's a running process, force a restart to ensure env vars are picked up
                    if (ACTIVE_BOT_INSTANCES[newPermanentClientId].process && ACTIVE_BOT_INSTANCES[newPermanentClientId].process.connected) {
                         console.warn(`[INST_MGR] Client ${newPermanentClientId} already active. Forcing restart to update API credentials.`);
                         stopClientInstance(newPermanentClientId);
                         launchClientInstance(newPermanentClientId, phoneNumber, false, linkedApiUsername, linkedApiPassword);
                    }
                }

                updateManagerQrState('connected', `WhatsApp Linked: ${name} (${phoneNumber})!`, null, newPermanentClientId, phoneNumber, name, false);
            }
        } else {
            console.log(`[INST_MGR] Existing client ${clientId} (${phoneNumber || instance?.phoneNumber || 'unknown'}) reported status: ${status}. Message: ${message}`);
        }
    } else if (clientId === currentUiLinkingClientId) {
        if (status === 'disconnected_logout' || status === 'error' || status === 'linking_failed') {
            updateManagerQrState(status, message, null, clientId, null, null, true);
            if (status !== 'error') {
                require('./qrWebSocketServer').resetManagerLinkingDisplay();
            }
            if (status === 'disconnected_logout' || status === 'linking_failed') {
                stopClientInstance(clientId);
            }
        } else if (status === 'qr') {
            if (qrFromStatusData) {
                handleClientBotQrUpdate(clientId, qrFromStatusData);
            }
        } else if (status === 'connecting') {
            updateManagerQrState('linking_in_progress', `WhatsApp connecting... (Client ID: ${clientId})`, null, clientId, null, null, true);
        }
    } else if (status === 'disconnected_logout' || status === 'error' || status === 'linking_failed') {
        console.log(`[INST_MGR] Non-linking client ${clientId} reported ${status}: ${message}.`);
        if (status === 'disconnected_logout' || status === 'linking_failed') {
            stopClientInstance(clientId);
        }
    }
}

// The restartClientWithApi function is no longer needed in this exact form
// because API credentials are provided upfront. We can simplify this.
// If you still need a way to update credentials for an *already running* client later,
// this pattern is correct, but the trigger will be different.
// For now, let's remove it as it's not part of the initial "before QR" flow.
// (Or keep it if you foresee a separate "update API credentials" button later)

module.exports = {
    launchClientInstance,
    stopClientInstance,
    recoverExistingClientInstances,
    generateClientId,
    handleClientBotQrUpdate,
    handleClientBotStatusUpdate,
    // restartClientWithApi, // Removed or adapted
};