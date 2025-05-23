// manager/instanceManager.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('../config');
const { updateManagerQrState, notifyInstanceStatusChange } = require('./qrWebSocketServer');

const ACTIVE_BOT_INSTANCES = {};
const INSTANCE_LOG_BUFFERS = {};
const MAX_LOG_LINES = 100;

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
 * @param {string} phoneNumber - The phone number associated with this client.
 * @param {boolean} forceNewScan - True if we need to clear session data.
 * @param {string} [apiUsername=null] - API username for this client.
 * @param {string} [apiPassword=null] - API password for this client.
 * @param {string} [ownerNumber=null] - Owner number for this client's bot logic.
 */
function launchClientInstance(clientId, phoneNumber, forceNewScan = false, apiUsername = null, apiPassword = null, ownerNumber = null) {
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

    if (ACTIVE_BOT_INSTANCES[clientId] && ACTIVE_BOT_INSTANCES[clientId].process && !ACTIVE_BOT_INSTANCES[clientId].process.killed) {
        console.warn(`[INST_MGR] Attempted to launch already running instance: ${clientId}. Aborting.`);
        return ACTIVE_BOT_INSTANCES[clientId].process;
    }

    // --- DEBUG LOG START ---
    console.log(`[INST_MGR_DEBUG] For client ${clientId}:`);
    console.log(`[INST_MGR_DEBUG]   API Username to be passed: ${apiUsername ? apiUsername.substring(0, 3) + '***' : 'NULL'}`);
    console.log(`[INST_MGR_DEBUG]   API Password to be passed: ${apiPassword ? '*** (Set)' : 'NULL'}`);
    console.log(`[INST_MGR_DEBUG]   Owner Number to be passed: ${ownerNumber ? ownerNumber.substring(0, 3) + '***' : 'NULL'}`);
    // --- DEBUG LOG END ---

    const env = {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PATH: process.env.PATH,
        
        AUTH_DIR: authDir,
        DATA_DIR: dataDir,
        CLIENT_ID: clientId,
        OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC: ownerNumber,
        MANAGER_WS_PORT: config.QR_WEBSOCKET_PORT,
        API_USERNAME_FOR_CLIENT_BOT_LOGIC: apiUsername,
        API_PASSWORD_FOR_CLIENT_BOT_LOGIC: apiPassword,
        API_BASE_URL: config.API_BASE_URL,
    };

    const clientBotEntryFile = path.join(config.CLIENT_CODE_DIR, 'clientBotApp.js');

    console.log(`[INST_MGR] Launching instance for ${clientId} (phone: ${phoneNumber}). Force new scan: ${forceNewScan}. API User: ${apiUsername ? 'Provided' : 'None'}, Owner: ${ownerNumber ? 'Provided' : 'None'}`);

    const child = spawn('node', [clientBotEntryFile], {
        cwd: config.CLIENT_CODE_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env,
    });

    INSTANCE_LOG_BUFFERS[clientId] = [];

    ACTIVE_BOT_INSTANCES[clientId] = {
        process: child,
        phoneNumber,
        name: 'Unknown',
        clientId,
        status: 'starting',
        lastUpdated: Date.now(),
        lastKnownQR: null,
        isLinkingClient: phoneNumber === 'new_linking_num' || clientId.startsWith('client_new_linking_'),
        apiUsername: apiUsername,
        apiPassword: apiPassword,
        ownerNumber: ownerNumber,
        startTime: new Date().toISOString(),
        wsConnected: false,
    };

    child.stdout.on('data', (data) => {
        const logLine = data.toString().trim();
        if (logLine) {
            INSTANCE_LOG_BUFFERS[clientId].push(`[OUT] ${logLine}`);
            if (INSTANCE_LOG_BUFFERS[clientId].length > MAX_LOG_LINES) {
                INSTANCE_LOG_BUFFERS[clientId].shift();
            }
        }
    });

    child.stderr.on('data', (data) => {
        const logLine = data.toString().trim();
        if (logLine) {
            INSTANCE_LOG_BUFFERS[clientId].push(`[ERR] ${logLine}`);
            if (INSTANCE_LOG_BUFFERS[clientId].length > MAX_LOG_LINES) {
                INSTANCE_LOG_BUFFERS[clientId].shift();
            }
            console.error(`[${clientId}_ERR] ${logLine}`);
        }
    });

    child.on('close', (code) => {
        console.log(`[INST_MGR] Client ${clientId} process exited with code ${code}.`);
        const instanceData = ACTIVE_BOT_INSTANCES[clientId];
        if (instanceData) {
            instanceData.status = `exited (${code})`;
            instanceData.lastUpdated = Date.now();
            instanceData.wsConnected = false;
        }
        
        require('./qrWebSocketServer').notifyInstanceStatusChange(clientId, instanceData ? instanceData.status : `exited (${code})`);

        const currentUiLinkingClientId = require('./qrWebSocketServer').managerQrState?.linkingClientId;
        if (clientId === currentUiLinkingClientId && code !== 0) {
             updateManagerQrState('linking_failed', `QR linking process for ${clientId} failed unexpectedly.`, null, clientId, null, null, true);
        }
        delete ACTIVE_BOT_INSTANCES[clientId];
    });

    child.on('error', (err) => {
        console.error(`[INST_MGR_ERROR] Failed to start process for ${clientId}:`, err);
        const instanceData = ACTIVE_BOT_INSTANCES[clientId];
        if (instanceData) {
            instanceData.status = `error (${err.message})`;
            instanceData.lastUpdated = Date.now();
            instanceData.wsConnected = false;
        }
        require('./qrWebSocketServer').notifyInstanceStatusChange(clientId, instanceData ? instanceData.status : `error (${err.message})`);

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
        notifyInstanceStatusChange(clientId, 'stopping');

        if (instance.terminateTimeout) {
            clearTimeout(instance.terminateTimeout);
            instance.terminateTimeout = null;
        }

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
    console.warn(`[INST_MGR] Attempted to stop unknown client: ${clientId}`);
    return false;
}

function restartClientInstance(clientId) {
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance) {
        console.log(`[INST_MGR] Restarting client ${clientId}...`);
        require('./qrWebSocketServer').notifyInstanceStatusChange(clientId, 'restarting');

        stopClientInstance(clientId);
        setTimeout(() => {
            if (!ACTIVE_BOT_INSTANCES[clientId]) {
                launchClientInstance(
                    clientId,
                    instance.phoneNumber,
                    false, 
                    instance.apiUsername, // Use stored
                    instance.apiPassword, // Use stored
                    instance.ownerNumber  // Use stored
                );
            } else {
                console.warn(`[INST_MGR] Client ${clientId} was not removed after stop, relaunching directly.`);
                launchClientInstance(
                    clientId,
                    instance.phoneNumber,
                    false,
                    instance.apiUsername,
                    instance.apiPassword,
                    instance.ownerNumber
                );
            }
        }, config.RECONNECT_DELAY_MS);

        return true;
    }
    console.warn(`[INST_MGR] Attempted to restart unknown client: ${clientId}`);
    return false;
}

function recoverExistingClientInstances() {
    ensureClientDataDirExists();
     console.log("[INST_MGR] Scanning for existing client instances to restart...");

    const existingClientFolders = fs.readdirSync(config.CLIENT_DATA_BASE_DIR);

    for (const folderName of existingClientFolders) {
        if (folderName.startsWith('client_new_linking_')) continue;

        const clientAuthPath = path.join(config.CLIENT_DATA_BASE_DIR, folderName, 'auth_info_baileys');
        
        // Placeholder: Load API credentials and Owner number for recovered clients
        // This requires you to save these details when a client is successfully linked
        // e.g., in client_data/CLIENT_ID/client_config.json
        // For now, recovered clients will start without API credentials or a specific owner.
        let recoveredApiUsername = null; 
        let recoveredApiPassword = null; 
        let recoveredOwnerNumber = null;

        // Example: Try to load from a hypothetical client_config.json
        const clientConfigPath = path.join(config.CLIENT_DATA_BASE_DIR, folderName, 'client_config.json');
        if (fs.existsSync(clientConfigPath)) {
            try {
                const clientConfigData = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
                recoveredApiUsername = clientConfigData.apiUsername;
                recoveredApiPassword = clientConfigData.apiPassword;
                recoveredOwnerNumber = clientConfigData.ownerNumber;
                console.log(`[INST_MGR] Loaded config for recovered client ${folderName}: API User: ${recoveredApiUsername ? 'Set' : 'None'}, Owner: ${recoveredOwnerNumber ? 'Set' : 'None'}`);
            } catch (e) {
                console.error(`[INST_MGR_ERROR] Failed to parse client_config.json for ${folderName}:`, e.message);
            }
        } else {
            console.warn(`[INST_MGR] No client_config.json found for recovered client ${folderName}. It will start without API/Owner specific settings unless updated via UI.`);
        }
        
        if (fs.existsSync(clientAuthPath) && fs.readdirSync(clientAuthPath).length > 0) {
            const phoneNumberMatch = folderName.match(/client_(\d+)_/);
            const phoneNumber = phoneNumberMatch ? phoneNumberMatch[1] : folderName;

            console.log(`[INST_MGR] Found existing session for client folder: ${folderName} (Phone: ${phoneNumber}). Attempting to launch.`);
            launchClientInstance(folderName, phoneNumber, false, recoveredApiUsername, recoveredApiPassword, recoveredOwnerNumber);
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
        instance.wsConnected = true;
    } else if (status !== 'connecting') {
        console.warn(`[INST_MGR] Received status update for unknown/stopped client ID: ${clientId}, status: ${status}`);
        return;
    }

    require('./qrWebSocketServer').notifyInstanceStatusChange(clientId, status, phoneNumber, name);

    const currentUiLinkingClientId = require('./qrWebSocketServer').managerQrState?.linkingClientId;

    if (status === 'connected') {
        if (instance && (instance.isLinkingClient || clientId === currentUiLinkingClientId)) {
            const oldLinkingClientId = clientId;
            const newPermanentClientId = generateClientId(phoneNumber);

            const oldClientPath = getClientDataPath(oldLinkingClientId);
            const newClientPath = getClientDataPath(newPermanentClientId);
            let renameSuccess = false;

            // Store the credentials that were used for this successful linking attempt
            const linkedApiUsername = instance.apiUsername;
            const linkedApiPassword = instance.apiPassword;
            const linkedOwnerNumber = instance.ownerNumber;

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
                // Save the credentials for this new permanent client
                const clientConfigPath = path.join(newClientPath, 'client_config.json');
                try {
                    const clientConfigData = {
                        clientId: newPermanentClientId,
                        phoneNumber: phoneNumber,
                        name: name,
                        apiUsername: linkedApiUsername,
                        apiPassword: linkedApiPassword,
                        ownerNumber: linkedOwnerNumber,
                        linkedAt: new Date().toISOString()
                    };
                    fs.writeFileSync(clientConfigPath, JSON.stringify(clientConfigData, null, 2));
                    console.log(`[INST_MGR] Saved client_config.json for ${newPermanentClientId}.`);
                } catch (e) {
                    console.error(`[INST_MGR_ERROR] Failed to save client_config.json for ${newPermanentClientId}:`, e.message);
                }


                if (oldLinkingClientId !== newPermanentClientId) {
                    stopClientInstance(oldLinkingClientId);
                    if (ACTIVE_BOT_INSTANCES[oldLinkingClientId]) delete ACTIVE_BOT_INSTANCES[oldLinkingClientId];
                }

                console.log(`[INST_MGR] Client ${newPermanentClientId} (${phoneNumber}) successfully linked. (Re)Launching as permanent.`);

                if (!ACTIVE_BOT_INSTANCES[newPermanentClientId]) {
                    launchClientInstance(newPermanentClientId, phoneNumber, false, linkedApiUsername, linkedApiPassword, linkedOwnerNumber);
                } else {
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].isLinkingClient = false;
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].apiUsername = linkedApiUsername;
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].apiPassword = linkedApiPassword;
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].ownerNumber = linkedOwnerNumber;
                    if (ACTIVE_BOT_INSTANCES[newPermanentClientId].process && ACTIVE_BOT_INSTANCES[newPermanentClientId].process.connected) {
                         console.warn(`[INST_MGR] Client ${newPermanentClientId} already active. Forcing restart to update credentials.`);
                         stopClientInstance(newPermanentClientId);
                         launchClientInstance(newPermanentClientId, phoneNumber, false, linkedApiUsername, linkedApiPassword, linkedOwnerNumber);
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

function listInstances() {
    const instances = Object.values(ACTIVE_BOT_INSTANCES).map(inst => ({
        clientId: inst.clientId,
        phoneNumber: inst.phoneNumber,
        name: inst.name,
        status: inst.status,
        lastUpdated: inst.lastUpdated,
        startTime: inst.startTime,
        wsConnected: inst.wsConnected,
    }));
    const exitedClientIds = Object.keys(INSTANCE_LOG_BUFFERS).filter(id => !ACTIVE_BOT_INSTANCES[id]);
    exitedClientIds.forEach(id => {
        if (!instances.some(inst => inst.clientId === id)) {
            instances.push({
                clientId: id,
                phoneNumber: 'N/A',
                name: 'N/A',
                status: 'exited_no_process',
                lastUpdated: Date.now(),
                startTime: 'N/A',
                wsConnected: false,
            });
        }
    });

    return instances;
}

function getInstanceLogs(clientId) {
    return INSTANCE_LOG_BUFFERS[clientId] || [];
}


module.exports = {
    launchClientInstance,
    stopClientInstance,
    restartClientInstance,
    recoverExistingClientInstances,
    generateClientId,
    handleClientBotQrUpdate,
    handleClientBotStatusUpdate,
    listInstances,
    getInstanceLogs,
};