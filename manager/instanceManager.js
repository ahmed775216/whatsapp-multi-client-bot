// manager/instanceManager.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws'); // Required for sendInternalCommandToClient

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
        forceNewScan = true; // Ensure QR scan is attempted if auth folder is empty
    }

    if (ACTIVE_BOT_INSTANCES[clientId] && ACTIVE_BOT_INSTANCES[clientId].process && !ACTIVE_BOT_INSTANCES[clientId].process.killed) {
        console.warn(`[INST_MGR] Attempted to launch already running instance: ${clientId}. Aborting.`);
        return ACTIVE_BOT_INSTANCES[clientId].process;
    }

    console.log(`[INST_MGR_DEBUG] For client ${clientId}:`);
    console.log(`[INST_MGR_DEBUG]   API Username to be passed: ${apiUsername ? apiUsername.substring(0, 3) + '***' : 'NULL'}`);
    console.log(`[INST_MGR_DEBUG]   API Password to be passed: ${apiPassword ? '*** (Set)' : 'NULL'}`);
    console.log(`[INST_MGR_DEBUG]   Owner Number to be passed: ${ownerNumber ? ownerNumber.substring(0, 3) + '***' : 'NULL'}`);

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
        if (clientId === currentUiLinkingClientId && code !== 0) { // If it's the linking client and failed
             updateManagerQrState('linking_failed', `QR linking process for ${clientId} failed unexpectedly.`, null, clientId, null, null, true);
        }

        // ONLY delete from ACTIVE_BOT_INSTANCES if it's truly exited and not about to be restarted (e.g. by stopClientInstance)
        // However, delete operation below handles cleanup.
        // For general exits, remove only if not explicitly "stopping" state before this.
        if (instanceData && !instanceData.status.startsWith('stopping')) { // If it didn't exit due to an explicit stop command
            delete ACTIVE_BOT_INSTANCES[clientId];
        }
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
        instance.status = 'stopping'; // Set status to stopping first
        instance.lastUpdated = Date.now();
        notifyInstanceStatusChange(clientId, 'stopping');

        // Clear any previous terminate timeout if it exists
        if (instance.terminateTimeout) {
            clearTimeout(instance.terminateTimeout);
            instance.terminateTimeout = null;
        }
        
        // Terminate the process
        if (instance.process.connected) {
            try {
                 instance.process.disconnect(); // Attempt graceful disconnect first
            } catch (e) {
                 console.warn(`[INST_MGR] Error disconnecting child process ${clientId}: ${e.message}`);
            }
        }
        instance.process.kill('SIGTERM'); // Send graceful termination signal

        // Set a timeout to force kill if it doesn't exit gracefully
        instance.terminateTimeout = setTimeout(() => {
            if (instance.process && instance.process.pid && !instance.process.killed) {
                console.warn(`[INST_MGR] Client ${instance.clientId} not exiting gracefully, force killing.`);
                instance.process.kill('SIGKILL'); // Force kill
            }
        }, 10000); // 10 seconds to gracefully exit

        return true;
    }
    console.warn(`[INST_MGR] Attempted to stop unknown client: ${clientId}`);
    return false;
}

function deleteClientInstance(clientId) { // NEW FUNCTION
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance) {
        console.log(`[INST_MGR] Deleting client ${instance.clientId}...`);
        // Stop the instance first, then delete its folder after a short delay
        stopClientInstance(clientId); // This will mark instance status as 'stopping' and eventually exit.

        setTimeout(() => {
            const clientDataPath = getClientDataPath(clientId);
            if (fs.existsSync(clientDataPath)) {
                try {
                    fs.rmSync(clientDataPath, { recursive: true, force: true });
                    console.log(`[INST_MGR] Successfully deleted client data for ${clientId}: ${clientDataPath}`);
                    // Ensure the instance is removed from our active list
                    if (ACTIVE_BOT_INSTANCES[clientId]) {
                         delete ACTIVE_BOT_INSTANCES[clientId];
                    }
                    if (INSTANCE_LOG_BUFFERS[clientId]) {
                         delete INSTANCE_LOG_BUFFERS[clientId];
                    }
                    notifyInstanceStatusChange(clientId, 'deleted'); // Notify UI of deletion
                    return true;
                } catch (e) {
                    console.error(`[INST_MGR_ERROR] Failed to delete client data for ${clientId}: ${e.message}`);
                    notifyInstanceStatusChange(clientId, 'deletion_failed');
                    return false;
                }
            } else {
                console.log(`[INST_MGR] Client data path for ${clientId} not found (${clientDataPath}), assumed already deleted or never existed.`);
                if (ACTIVE_BOT_INSTANCES[clientId]) { // If it was tracked but folder gone, remove it.
                     delete ACTIVE_BOT_INSTANCES[clientId];
                }
                if (INSTANCE_LOG_BUFFERS[clientId]) {
                     delete INSTANCE_LOG_BUFFERS[clientId];
                }
                notifyInstanceStatusChange(clientId, 'already_deleted_or_not_found');
                return true; // Consider successful if path doesn't exist.
            }
        }, 1000); // Wait 1 second after signaling stop before attempting deletion
    } else {
        console.warn(`[INST_MGR] Attempted to delete unknown or non-running client: ${clientId}`);
        // If the instance wasn't actively tracked, check if its directory exists and delete it.
        const clientDataPath = getClientDataPath(clientId);
        if (fs.existsSync(clientDataPath)) {
             try {
                fs.rmSync(clientDataPath, { recursive: true, force: true });
                console.log(`[INST_MGR] Deleted residual data for non-tracked client ${clientId}.`);
                if (INSTANCE_LOG_BUFFERS[clientId]) {
                    delete INSTANCE_LOG_BUFFERS[clientId];
                }
                notifyInstanceStatusChange(clientId, 'deleted_residual');
                return true;
             } catch (e) {
                console.error(`[INST_MGR_ERROR] Failed to delete residual data for ${clientId}: ${e.message}`);
                notifyInstanceStatusChange(clientId, 'deletion_failed_residual');
                return false;
             }
        }
        notifyInstanceStatusChange(clientId, 'not_found_for_delete'); // Notify if it wasn't there at all
        return false;
    }
}


function restartClientInstance(clientId) {
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance) {
        console.log(`[INST_MGR] Restarting client ${clientId}...`);
        notifyInstanceStatusChange(clientId, 'restarting');

        // Capture current credentials before stopping
        const currentApiUsername = instance.apiUsername;
        const currentApiPassword = instance.apiPassword;
        const currentOwnerNumber = instance.ownerNumber;
        const currentPhoneNumber = instance.phoneNumber; // Keep phone number for relaunch

        stopClientInstance(clientId);
        
        // Use a timeout to ensure the process fully exits before relaunching
        setTimeout(() => {
            // Ensure the old entry is truly gone before relaunching, or it might re-add on restart
            if (!ACTIVE_BOT_INSTANCES[clientId]) { // Check if it was removed by its 'close' handler
                 launchClientInstance(
                    clientId, // Keep same clientId for restart
                    currentPhoneNumber,
                    false, // No force new scan on restart, unless explicitly desired
                    currentApiUsername, 
                    currentApiPassword, 
                    currentOwnerNumber  
                );
            } else {
                console.warn(`[INST_MGR] Client ${clientId} was not removed after stop, forcing relaunch directly.`);
                // If it's still somehow in ACTIVE_BOT_INSTANCES, it might mean the 'close' event
                // hasn't fired yet or its status wasn't 'stopping'. Relaunching might double-spawn.
                // For robustness, ensure previous process is truly gone.
                // Forcing SIGKILL earlier might be needed if processes often hang.
                // For now, let's relaunch directly, assuming graceful stop is intended path.
                 launchClientInstance(
                    clientId,
                    currentPhoneNumber,
                    false,
                    currentApiUsername,
                    currentApiPassword,
                    currentOwnerNumber
                );
            }
        }, config.RECONNECT_DELAY_MS); // Use a small delay for restart

        return true;
    }
    console.warn(`[INST_MGR] Attempted to restart unknown client: ${clientId}`);
    return false;
}

function recoverExistingClientInstances() {
    ensureClientDataDirExists();
     console.log("[INST_MGR] Scanning for existing client instances to restart...");

    const existingClientFolders = fs.readdirSync(config.CLIENT_DATA_BASE_DIR, { withFileTypes: true })
                                   .filter(dirent => dirent.isDirectory())
                                   .map(dirent => dirent.name);

    for (const folderName of existingClientFolders) {
        if (folderName.startsWith('client_new_linking_')) continue;

        const clientAuthPath = path.join(config.CLIENT_DATA_BASE_DIR, folderName, 'auth_info_baileys');
        const clientConfigPath = path.join(config.CLIENT_DATA_BASE_DIR, folderName, 'client_config.json');

        let recoveredApiUsername = null; 
        let recoveredApiPassword = null; 
        let recoveredOwnerNumber = null;
        let recoveredPhoneNumber = folderName; // Default phone to folder name initially

        if (fs.existsSync(clientConfigPath)) {
            try {
                const clientConfigData = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
                recoveredApiUsername = clientConfigData.apiUsername;
                recoveredApiPassword = clientConfigData.apiPassword;
                recoveredOwnerNumber = clientConfigData.ownerNumber;
                recoveredPhoneNumber = clientConfigData.phoneNumber || folderName; // Use number from config if available
                console.log(`[INST_MGR] Loaded config for recovered client ${folderName}: API User: ${recoveredApiUsername ? 'Set' : 'None'}, Owner: ${recoveredOwnerNumber ? 'Set' : 'None'}, Phone: ${recoveredPhoneNumber}`);
            } catch (e) {
                console.error(`[INST_MGR_ERROR] Failed to parse client_config.json for ${folderName}:`, e.message);
            }
        } else {
            console.warn(`[INST_MGR] No client_config.json found for recovered client ${folderName}. It will start without API/Owner specific settings unless updated via UI.`);
            const phoneNumberMatch = folderName.match(/client_(\d+)_/); // Extract phone from folder name
            recoveredPhoneNumber = phoneNumberMatch ? phoneNumberMatch[1] : folderName;
        }
        
        // Only try to launch if auth folder exists and has contents
        if (fs.existsSync(clientAuthPath) && fs.readdirSync(clientAuthPath).length > 0) {
            console.log(`[INST_MGR] Found existing session for client folder: ${folderName} (Phone: ${recoveredPhoneNumber}). Attempting to launch.`);
            launchClientInstance(folderName, recoveredPhoneNumber, false, recoveredApiUsername, recoveredApiPassword, recoveredOwnerNumber);
        } else {
            console.log(`[INST_MGR] Folder ${folderName} does not contain an active Baileys session. Skipping restart.`);
            // Optionally, delete empty or incomplete client folders here if desired for cleanup
            // fs.rmSync(path.join(config.CLIENT_DATA_BASE_DIR, folderName), { recursive: true, force: true });
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
        instance.wsConnected = true; // Mark as WS connected when a status update comes
    } else if (status !== 'connecting') {
        console.warn(`[INST_MGR] Received status update for unknown/stopped client ID: ${clientId}, status: ${status}. Adding/Updating.`);
        // Re-add to active instances if it was stopped but reported connected
        // This is important for "resurrecting" client entries if Manager restarted and didn't track it
        ACTIVE_BOT_INSTANCES[clientId] = {
            process: null, // No direct child process handle yet, just tracking state
            phoneNumber: phoneNumber || 'N/A',
            name: name || 'Unknown',
            clientId,
            status,
            lastUpdated: Date.now(),
            lastKnownQR: qrFromStatusData || null,
            isLinkingClient: false, // Assume not linking if re-adding this way
            apiUsername: null, apiPassword: null, ownerNumber: null, // Must load from config.json later
            startTime: new Date().toISOString(),
            wsConnected: true,
        };
    }

    require('./qrWebSocketServer').notifyInstanceStatusChange(clientId, status, phoneNumber, name);

    const currentUiLinkingClientId = require('./qrWebSocketServer').managerQrState?.linkingClientId;

    if (status === 'connected') {
        if (instance && (instance.isLinkingClient || clientId === currentUiLinkingClientId)) {
            const oldLinkingClientId = clientId;
            // IMPORTANT: use normalizePhoneNumberToJid from apiSync for consistent JID formatting for filename.
            // But we need the actual number part, not the JID, for folder naming.
            // Let's assume phoneNumber here is already the numeric part.
            // The folder name is client_<phone>_<timestamp>
            const finalPhoneNumberForFolder = phoneNumber ? phoneNumber.replace(/\D/g, '') : oldLinkingClientId.replace('client_new_linking_', '');
            const newPermanentClientId = generateClientId(finalPhoneNumberForFolder);

            const oldClientPath = getClientDataPath(oldLinkingClientId);
            const newClientPath = getClientDataPath(newPermanentClientId);
            let renameSuccess = false;

            const linkedApiUsername = instance.apiUsername;
            const linkedApiPassword = instance.apiPassword;
            const linkedOwnerNumber = instance.ownerNumber;

            if (fs.existsSync(oldClientPath)) {
                try {
                    // Only rename if it's a temp client AND the new name is different
                    if (instance.isLinkingClient && oldClientPath !== newClientPath) {
                        fs.renameSync(oldClientPath, newClientPath);
                        console.log(`[INST_MGR] Client data folder renamed from ${oldLinkingClientId} to ${newPermanentClientId}.`);
                    } else {
                        // If it's already a permanent client or name is same, no rename needed.
                        console.log(`[INST_MGR] Client ID ${oldLinkingClientId} is already permanent or target path is identical. No folder rename needed.`);
                        if (!fs.existsSync(newClientPath)) { // If target path somehow doesn't exist, this is an issue
                            console.error(`[INST_MGR_ERROR] Target path ${newClientPath} does not exist after linking, assumed client data loss.`);
                        }
                    }
                    renameSuccess = true;
                } catch (err) {
                    console.error(`[INST_MGR_ERROR] Failed to rename client data folder for ${oldLinkingClientId}: ${err.message}`);
                    updateManagerQrState('error', `Linked but failed to store session: ${err.message}`, null, oldLinkingClientId, phoneNumber, name, true);
                }
            } else {
                console.warn(`[INST_MGR] Old client path ${oldClientPath} not found for rename during linking. It might have already been moved or not fully created.`);
                // If the folder was moved or didn't exist, and we now have a phoneNumber,
                // assume session was established and stored. We need to verify if the NEW_ClientPath exists.
                if (fs.existsSync(newClientPath) && phoneNumber) renameSuccess = true;
                else if (phoneNumber) {
                    // This is a recovery scenario - the temporary folder might not have been
                    // created if `clientBotApp` already had existing auth.
                    // If phone number is available, we assume a session has been successfully established.
                    // Ensure the 'temp' client entry is cleaned up if it was a temp one.
                    console.log(`[INST_MGR] Successfully linked a number ${phoneNumber}, assuming session is good. Cleanup temp ID.`);
                    renameSuccess = true; // Assume success for processing
                } else {
                     console.error(`[INST_MGR_ERROR] No old client path and no phone number after connection, unable to confirm linking persistence for ${oldLinkingClientId}`);
                     updateManagerQrState('error', `Linked but persistence failed. Please try again or check logs.`, null, oldLinkingClientId, phoneNumber, name, true);
                     return;
                }
            }

            if (renameSuccess) {
                const finalClientPathForConfig = newClientPath; // Use the path that *should* contain data
                if (!fs.existsSync(finalClientPathForConfig)) {
                     // Create it if it doesn't exist after attempts to rename.
                     // This could happen if temp folder never fully formed or was an edge case.
                     fs.mkdirSync(finalClientPathForConfig, { recursive: true });
                     console.log(`[INST_MGR] Created missing client path for config at ${finalClientPathForConfig}`);
                }
                const clientConfigPath = path.join(finalClientPathForConfig, 'client_config.json');
                try {
                    const clientConfigData = {
                        clientId: newPermanentClientId, // Store the new ID
                        phoneNumber: phoneNumber, // The actual phone number identified by Baileys
                        name: name, // The WhatsApp profile name
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

                // If it was a temporary ID, stop the old process
                if (instance.isLinkingClient && oldLinkingClientId !== newPermanentClientId) {
                    stopClientInstance(oldLinkingClientId); // This should remove old ID from ACTIVE_BOT_INSTANCES
                }

                // Remove the old (temporary) ID if it's still lingering after successful rename/relaunch
                // This might happen if `stopClientInstance` does async cleanup.
                if (instance.isLinkingClient) {
                    delete ACTIVE_BOT_INSTANCES[oldLinkingClientId];
                }
                
                console.log(`[INST_MGR] Client ${newPermanentClientId} (${phoneNumber}) successfully linked. (Re)Launching as permanent.`);

                // Relaunch the instance under its new, permanent ID (if it's not already tracking under that ID)
                // If it's already tracking under newPermanentClientId (e.g., if oldLinkingClientId == newPermanentClientId)
                // then just update its properties, no need to stop and relaunch.
                if (!ACTIVE_BOT_INSTANCES[newPermanentClientId]) {
                    launchClientInstance(newPermanentClientId, phoneNumber, false, linkedApiUsername, linkedApiPassword, linkedOwnerNumber);
                } else {
                    // Update properties of the existing permanent instance
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].isLinkingClient = false;
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].apiUsername = linkedApiUsername;
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].apiPassword = linkedApiPassword;
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].ownerNumber = linkedOwnerNumber;
                    ACTIVE_BOT_INSTANCES[newPermanentClientId].status = 'connected'; // Explicitly set as connected
                    console.log(`[INST_MGR] Updated existing permanent client ${newPermanentClientId} details.`);
                }

                updateManagerQrState('connected', `WhatsApp Linked: ${name} (${phoneNumber})!`, null, newPermanentClientId, phoneNumber, name, false);
            }
        } else {
            console.log(`[INST_MGR] Existing client ${clientId} (${phoneNumber || instance?.phoneNumber || 'unknown'}) reported status: ${status}. Message: ${message}`);
        }
    } else if (clientId === currentUiLinkingClientId) {
        if (status === 'disconnected_logout' || status === 'error' || status === 'linking_failed') {
            updateManagerQrState(status, message, null, clientId, null, null, true);
            // Don't call resetManagerLinkingDisplay immediately if it's an error,
            // let the UI decide if it wants to try again from that state.
            // if (status !== 'error') {
            //     require('qrWebSocketServer').resetManagerLinkingDisplay();
            // }
            if (status === 'disconnected_logout' || status === 'linking_failed') {
                // Ensure the temp process is stopped and removed if it fails to link
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
    // Merge ACTIVE_BOT_INSTANCES and any lingering log buffers
    const allClientIds = new Set([...Object.keys(ACTIVE_BOT_INSTANCES), ...Object.keys(INSTANCE_LOG_BUFFERS)]);
    const instances = [];

    for (const id of allClientIds) {
        const inst = ACTIVE_BOT_INSTANCES[id];
        if (inst) {
            instances.push({
                clientId: inst.clientId,
                phoneNumber: inst.phoneNumber,
                name: inst.name,
                status: inst.status,
                lastUpdated: inst.lastUpdated,
                startTime: inst.startTime,
                wsConnected: inst.wsConnected,
            });
        } else if (INSTANCE_LOG_BUFFERS[id]) { // If it's only in log buffers, it's exited/stopped
            instances.push({
                clientId: id,
                phoneNumber: 'N/A', // Cannot know without ACTIVE_BOT_INSTANCES entry
                name: 'N/A',
                status: 'exited_no_process',
                lastUpdated: Date.now(),
                startTime: 'N/A',
                wsConnected: false,
            });
        }
    }
    return instances;
}


function getInstanceLogs(clientId) {
    return INSTANCE_LOG_BUFFERS[clientId] || [];
}

function sendInternalCommandToClient(clientId, commandPayload) { // NEW UTILITY FUNCTION
    const qrws = require('./qrWebSocketServer'); // Dynamically import to avoid circular dependency
    const clientWs = qrws.clientBotWsMap.get(clientId); // Get the WebSocket for the specific client
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        const payload = {
            type: 'internalCommand', // Signal this is an internal command
            clientId: clientId, // Target client ID (redundant but good for clarity)
            command: commandPayload.command,
            groupId: commandPayload.groupId, // Optional
            // ... any other parameters required by the internal command ...
        };
        try {
            clientWs.send(JSON.stringify(payload));
            return true;
        } catch (e) {
            console.error(`[INST_MGR_ERROR] Failed to send internal command to ${clientId}: ${e.message}`);
            return false;
        }
    }
    return false;
}


module.exports = {
    launchClientInstance,
    stopClientInstance,
    restartClientInstance,
    deleteClientInstance, // EXPORTED NEW FUNCTION
    recoverExistingClientInstances,
    generateClientId,
    handleClientBotQrUpdate,
    handleClientBotStatusUpdate,
    listInstances,
    getInstanceLogs,
    ACTIVE_BOT_INSTANCES, // Export for manager.js callbacks
    sendInternalCommandToClient, // EXPORTED NEW FUNCTION
};