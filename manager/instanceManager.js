// manager/instanceManager.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('../config');
const { updateManagerQrState } = require('./qrWebSocketServer'); // Correctly imported

const ACTIVE_BOT_INSTANCES = {};

function ensureClientDataDirExists() {
    if (!fs.existsSync(config.CLIENT_DATA_BASE_DIR)) {
        fs.mkdirSync(config.CLIENT_DATA_BASE_DIR, { recursive: true });
        console.log(`[INST_MGR] Created client data base directory: ${config.CLIENT_DATA_BASE_DIR}`);
    }
}

// Fix 1: Update generateClientId function to handle linking clients properly
function generateClientId(phoneNumber) {
    // Handle the special case for new linking attempts
    if (phoneNumber === 'new_linking_num' || !phoneNumber || phoneNumber.trim() === '') {
        return `client_new_linking_${Date.now()}`;
    }
    
    // For regular phone numbers, clean and format
    const cleanPhone = phoneNumber.replace(/\D/g, ''); // Remove non-digits
    return `client_${cleanPhone}_${Date.now()}`;
}

function getClientDataPath(clientId) {
    return path.join(config.CLIENT_DATA_BASE_DIR, clientId);
}

// Fix 3: Ensure the linking client ID is properly set when launching (via isLinkingClient flag)
function launchClientInstance(clientId, phoneNumber, forceNewScan = false, apiUsername = config.API_USERNAME, apiPassword = config.API_PASSWORD) {
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
        API_USERNAME_FOR_CLIENT_BOT_LOGIC: apiUsername,
        API_PASSWORD_FOR_CLIENT_BOT_LOGIC: apiPassword,
        FORCE_NEW_SCAN: forceNewScan ? 'true' : 'false',
        API_BASE_URL: config.API_BASE_URL, // Ensure client gets the correct API base
    };

    const clientBotEntryFile = path.join(config.CLIENT_CODE_DIR, 'clientBotApp.js');

    console.log(`[INST_MGR] Launching instance for ${clientId} (phone: ${phoneNumber}). Force new scan: ${forceNewScan}`);

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
        isLinkingClient: phoneNumber === 'new_linking_num' || clientId.startsWith('client_new_linking_') // Add this flag
    };

    child.stdout.on('data', (data) => {
        // const logLine = data.toString().trim();
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
        
        // If the process that was actively linking (according to managerQrState) just exited.
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
        
        if (instance.process.connected) { // For IPC, not directly used here but good practice
            instance.process.disconnect();
        }
        instance.process.kill('SIGTERM'); // Graceful termination

        // Set a timeout to force kill if it doesn't exit gracefully
        instance.terminateTimeout = setTimeout(() => {
            if (instance.process && instance.process.pid && !instance.process.killed) {
                console.warn(`[INST_MGR] Client ${instance.clientId} not exiting gracefully, force killing.`);
                instance.process.kill('SIGKILL');
            }
        }, 10000); // 10 seconds grace period

        // 'close' event on child process will delete from ACTIVE_BOT_INSTANCES
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
        
        if (fs.existsSync(clientAuthPath) && fs.readdirSync(clientAuthPath).length > 0) {
            const phoneNumberMatch = folderName.match(/client_(\d+)_/);
            const phoneNumber = phoneNumberMatch ? phoneNumberMatch[1] : folderName;

            console.log(`[INST_MGR] Found existing session for client folder: ${folderName} (Phone: ${phoneNumber}). Attempting to launch.`);
            launchClientInstance(folderName, phoneNumber, false /* no forceNewScan */);
        } else {
            console.log(`[INST_MGR] Folder ${folderName} does not contain an active session. Skipping restart.`);
        }
    }
}

// Fix 2: Update the QR handling logic to be more robust
function handleClientBotQrUpdate(clientId, qr) {
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance) {
        instance.lastKnownQR = qr;
        
        // Check if this is a linking client (either by prefix OR by matching current linking client ID in qrWebSocketServer)
        const isCurrentlyLinkingOnUI = clientId === require('./qrWebSocketServer').managerQrState?.linkingClientId;
        
        if (instance.isLinkingClient || isCurrentlyLinkingOnUI) { // Check our flag or if UI is tracking it
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
        if (instance && (instance.isLinkingClient || clientId === currentUiLinkingClientId)) { // Successfully linked the client UI was waiting for
            const oldLinkingClientId = clientId; // This is the temporary ID (e.g., client_new_linking_...)
            const newPermanentClientId = generateClientId(phoneNumber); // Create permanent ID based on actual phone

            const oldClientPath = getClientDataPath(oldLinkingClientId);
            const newClientPath = getClientDataPath(newPermanentClientId);
            let renameSuccess = false;

            if (fs.existsSync(oldClientPath)) {
                try {
                    if (oldClientPath !== newClientPath) { // Only rename if IDs are different
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
                if (phoneNumber) renameSuccess = true; // Assume it's okay if we have phone number
            }

            if (renameSuccess) {
                if (oldLinkingClientId !== newPermanentClientId) {
                    // Stop the old temporary process
                    stopClientInstance(oldLinkingClientId); 
                    // Delete from active instances if stopClientInstance doesn't do it immediately
                    if (ACTIVE_BOT_INSTANCES[oldLinkingClientId]) delete ACTIVE_BOT_INSTANCES[oldLinkingClientId];
                }
                
                console.log(`[INST_MGR] Client ${newPermanentClientId} (${phoneNumber}) successfully linked. (Re)Launching as permanent.`);
                // Ensure the process is running under the new permanent ID if it was renamed
                // If the same process continues, its env.CLIENT_ID is still the old one.
                // It's safer to stop the temp and launch a new permanent one.
                // (The stopClientInstance for oldLinkingClientId handles this if different)
                if (!ACTIVE_BOT_INSTANCES[newPermanentClientId]) { // If it's truly a new permanent entry
                     launchClientInstance(newPermanentClientId, phoneNumber, false, instance?.apiUsername, instance?.apiPassword);
                } else { // If the same process is to continue, update its details (less ideal)
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].isLinkingClient = false;
                }

                updateManagerQrState('connected', `WhatsApp Linked: ${name} (${phoneNumber})!`, null, newPermanentClientId, phoneNumber, name, false); // isLinkingProcess is now false
            }
        } else {
            console.log(`[INST_MGR] Existing client ${clientId} (${phoneNumber || instance?.phoneNumber || 'unknown'}) reported status: ${status}. Message: ${message}`);
        }
    } else if (clientId === currentUiLinkingClientId) { // Update UI only if it's the client being actively linked
        if (status === 'disconnected_logout' || status === 'error' || status === 'linking_failed') {
            updateManagerQrState(status, message, null, clientId, null, null, true); // Still a linking process
            if (status !== 'error') { // Linking process ends
                require('./qrWebSocketServer').resetManagerLinkingDisplay();
            }
            if (status === 'disconnected_logout' || status === 'linking_failed') {
                stopClientInstance(clientId);
            }
        } else if (status === 'qr') {
            if (qrFromStatusData) { // QR might be part of a status update
                 handleClientBotQrUpdate(clientId, qrFromStatusData);
            }
        } else if (status === 'connecting') {
            updateManagerQrState('linking_in_progress', `WhatsApp connecting... (Client ID: ${clientId})`, null, clientId, null, null, true);
        }
    } else if (status === 'disconnected_logout' || status === 'error' || status === 'linking_failed') {
        // A non-UI-focused client had an issue
        console.log(`[INST_MGR] Non-linking client ${clientId} reported ${status}: ${message}.`);
        if (status === 'disconnected_logout' || status === 'linking_failed') {
            stopClientInstance(clientId);
        }
    }
}

module.exports = {
    launchClientInstance,
    stopClientInstance,
    recoverExistingClientInstances,
    generateClientId,
    handleClientBotQrUpdate,
    handleClientBotStatusUpdate,
};