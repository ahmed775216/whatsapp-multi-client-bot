// manager/instanceManager.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws'); // Required for sendInternalCommandToClient

const config = require('../config');
// يجب استيراد وحدات qrWebSocketServer بدون destructuring لتجنب المشاكل مع الاستيراد الدائري المحتمل أو ترتيب التحميل
const qrWebSocketServerModule = require('./qrWebSocketServer');

const ACTIVE_BOT_INSTANCES = {};
const INSTANCE_LOG_BUFFERS = {};
const MAX_LOG_LINES = 100;

function ensureClientDataDirExists() {
    if (!fs.existsSync(config.CLIENT_DATA_BASE_DIR)) {
        fs.mkdirSync(config.CLIENT_DATA_BASE_DIR, { recursive: true });
        console.log(`[INST_MGR] Created client data base directory: ${config.CLIENT_DATA_BASE_DIR}`);
    }
}

function generateClientId(phoneNumberOrContext) {
if (phoneNumberOrContext === 'new_linking_num' || !phoneNumberOrContext || phoneNumberOrContext.trim() === '') {
        return `client_new_linking_${Date.now()}`;
    }
    const cleanPhone = phoneNumberOrContext.toString().replace(/\D/g, '');
    if (cleanPhone && cleanPhone.length > 5) {
        return `client_${cleanPhone}`; // معرف دائم
    }
    return `client_${phoneNumberOrContext.toString().replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`;
}

function getClientDataPath(clientId) {
    return path.join(config.CLIENT_DATA_BASE_DIR, clientId);
}

function launchClientInstance(clientId, phoneNumberForContext, forceNewScan = false, apiUsername = null, apiPassword = null, ownerNumber = null) {
    ensureClientDataDirExists();

    // Check if this is a linking client and if another linking is already in progress
    const isNewLinking = phoneNumberForContext === 'new_linking_num' || clientId.startsWith('client_new_linking_');
    if (isNewLinking) {
        // Check if there's already an active linking instance
        const activeLinkingInstances = Object.values(ACTIVE_BOT_INSTANCES).filter(inst => 
            inst.isLinkingClient && inst.process && !inst.process.killed
        );
        
        if (activeLinkingInstances.length > 0) {
            console.warn(`[INST_MGR] A linking process is already active (${activeLinkingInstances[0].clientId}). Aborting new launch.`);
            // Notify the UI about the existing linking process
            qrWebSocketServerModule.notifyInstanceStatusChange(clientId, 'error', null, null);
            qrWebSocketServerModule.updateManagerQrState('error', 'A linking process is already in progress. Please complete or cancel it first.', null, clientId, null, null, true);
            return null;
        }
    }

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
        console.log(`[INST_MGR] Auth data for ${clientId} is empty, will attempt QR scan on launch.`);
        forceNewScan = true; 
    }

    if (ACTIVE_BOT_INSTANCES[clientId] && ACTIVE_BOT_INSTANCES[clientId].process && !ACTIVE_BOT_INSTANCES[clientId].process.killed) {
        console.warn(`[INST_MGR] Instance ${clientId} is already running. Aborting launch.`);
        return ACTIVE_BOT_INSTANCES[clientId].process;
    }

    console.log(`[INST_MGR_DEBUG] Launching instance ${clientId} (Context Phone: ${phoneNumberForContext}):`);
    console.log(`[INST_MGR_DEBUG]   API Username: ${apiUsername ? 'Set' : 'NULL'}, Owner Number: ${ownerNumber ? 'Set' : 'NULL'}`);

    const env = { ...process.env, /* نسخ متغيرات البيئة الحالية */
        AUTH_DIR: authDir, DATA_DIR: dataDir, CLIENT_ID: clientId,
        OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC: ownerNumber,
        MANAGER_WS_PORT: config.QR_WEBSOCKET_PORT,
        API_USERNAME_FOR_CLIENT_BOT_LOGIC: apiUsername,
        API_PASSWORD_FOR_CLIENT_BOT_LOGIC: apiPassword,
        API_BASE_URL: config.API_BASE_URL,
    };

    const clientBotEntryFile = path.join(config.CLIENT_CODE_DIR, 'clientBotApp.js');
    console.log(`[INST_MGR] Spawning: node ${clientBotEntryFile} for ${clientId}`);

    const child = spawn('node', [clientBotEntryFile], {
        cwd: config.CLIENT_CODE_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: env,
    });

    INSTANCE_LOG_BUFFERS[clientId] = [];
    ACTIVE_BOT_INSTANCES[clientId] = {
        process: child,
        phoneNumber: phoneNumberForContext === 'new_linking_num' ? null : phoneNumberForContext.replace(/\D/g, ''), // رقم الهاتف الفعلي سيتأكد عند الاتصال
        name: 'Pending...',
        clientId, status: 'starting', lastUpdated: Date.now(), lastKnownQR: null,
        isLinkingClient: phoneNumberForContext === 'new_linking_num' || clientId.startsWith('client_new_linking_'),
        apiUsername, apiPassword, ownerNumber,
        startTime: new Date().toISOString(), wsConnected: false,
    };

    child.stdout.on('data', (data) => { /* ... (نفس معالجة stdout) ... */ 
        const logLine = data.toString().trim();
        if (logLine) {
            INSTANCE_LOG_BUFFERS[clientId].push(`[OUT] ${logLine}`);
            if (INSTANCE_LOG_BUFFERS[clientId].length > MAX_LOG_LINES) INSTANCE_LOG_BUFFERS[clientId].shift();
        }
    });
    child.stderr.on('data', (data) => { /* ... (نفس معالجة stderr) ... */ 
        const logLine = data.toString().trim();
        if (logLine) {
            INSTANCE_LOG_BUFFERS[clientId].push(`[ERR] ${logLine}`);
            if (INSTANCE_LOG_BUFFERS[clientId].length > MAX_LOG_LINES) INSTANCE_LOG_BUFFERS[clientId].shift();
            console.error(`[${clientId}_ERR] ${logLine}`);
        }
    });

    child.on('close', (code) => {
        console.log(`[INST_MGR] Client ${clientId} process exited with code ${code}.`);
        const instanceData = ACTIVE_BOT_INSTANCES[clientId];
        if (instanceData) {
            instanceData.status = `exited (${code !== null ? code : 'signal'})`;
            instanceData.lastUpdated = Date.now();
            instanceData.wsConnected = false; // اتصال WebSocket بالمدير قد انقطع
        }
        qrWebSocketServerModule.notifyInstanceStatusChange(clientId, instanceData ? instanceData.status : `exited (${code})`);
        
        const currentUiLinkingClientId = qrWebSocketServerModule.managerQrState?.linkingClientId;
        if (clientId === currentUiLinkingClientId && code !== 0) {
             qrWebSocketServerModule.updateManagerQrState('linking_failed', `QR linking process for ${clientId} failed or was closed.`, null, clientId, null, null, true);
        }
        if (instanceData && !instanceData.status.startsWith('stopping') && !instanceData.status.startsWith('restarting')) {
            delete ACTIVE_BOT_INSTANCES[clientId];
            console.log(`[INST_MGR] Removed ${clientId} from active instances due to unexpected exit.`);
        }
    });
    child.on('error', (err) => { /* ... (نفس معالجة error) ... */ 
        console.error(`[INST_MGR_ERROR] Failed to start process for ${clientId}:`, err);
        const instanceData = ACTIVE_BOT_INSTANCES[clientId];
        if (instanceData) {
            instanceData.status = `error_spawning (${err.message})`;
            instanceData.lastUpdated = Date.now();
        }
        qrWebSocketServerModule.notifyInstanceStatusChange(clientId, instanceData ? instanceData.status : `error_spawning (${err.message})`);
        const currentUiLinkingClientId = qrWebSocketServerModule.managerQrState?.linkingClientId;
        if (clientId === currentUiLinkingClientId) {
             qrWebSocketServerModule.updateManagerQrState('error', `Failed to start QR process for ${clientId}: ${err.message}`, null, clientId, null, null, true);
        }
    });
    return child;
}

function stopClientInstance(clientId, isRestarting = false) { // إضافة معامل isRestarting
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance && instance.process) {
        console.log(`[INST_MGR] Stopping client ${instance.clientId}... (Is Restarting: ${isRestarting})`);
        instance.status = isRestarting ? 'restarting_stopping' : 'stopping';
        instance.lastUpdated = Date.now();
        qrWebSocketServerModule.notifyInstanceStatusChange(clientId, instance.status);

        if (instance.terminateTimeout) clearTimeout(instance.terminateTimeout);
        
        if (instance.process.connected) {
            try { instance.process.disconnect(); } catch (e) { /* ... */ }
        }
        instance.process.kill('SIGTERM');
        instance.terminateTimeout = setTimeout(() => {
            if (instance.process && !instance.process.killed) {
                instance.process.kill('SIGKILL');
                console.warn(`[INST_MGR] Client ${instance.clientId} force-killed.`);
            }
        }, 5000); // تقليل المهلة قليلاً
        return true;
    }
    console.warn(`[INST_MGR] Attempted to stop non-running or unknown client: ${clientId}`);
    return false;
}

function deleteClientInstance(clientId) {
    console.log(`[INST_MGR] Initiating deletion for client ${clientId}...`);
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance && instance.process && !instance.process.killed) {
        console.log(`[INST_MGR] Instance ${clientId} is running. Stopping it before deletion.`);
        stopClientInstance(clientId); // سيؤدي هذا إلى استدعاء 'close' للعملية
        // سيتم حذف المجلدات بعد خروج العملية، في معالج 'close' أو بعد مهلة
         instance.status = 'pending_deletion'; // حالة خاصة للإشارة إلى أنه سيتم الحذف
    } else {
        // إذا لم يكن المثيل يعمل، قم بالحذف مباشرة
        console.log(`[INST_MGR] Instance ${clientId} not running or process not found. Proceeding with data deletion.`);
        performDataDeletion(clientId);
    }
}

function performDataDeletion(clientId) {
    const clientDataPath = getClientDataPath(clientId);
    if (fs.existsSync(clientDataPath)) {
        try {
            fs.rmSync(clientDataPath, { recursive: true, force: true });
            console.log(`[INST_MGR] Successfully deleted client data for ${clientId}: ${clientDataPath}`);
        } catch (e) {
            console.error(`[INST_MGR_ERROR] Failed to delete client data for ${clientId}: ${e.message}`);
            qrWebSocketServerModule.notifyInstanceStatusChange(clientId, 'deletion_failed');
            return false;
        }
    } else {
        console.log(`[INST_MGR] Client data path for ${clientId} not found, assumed already deleted.`);
    }
    // إزالة من التتبع النشط والسجلات
    if (ACTIVE_BOT_INSTANCES[clientId]) delete ACTIVE_BOT_INSTANCES[clientId];
    if (INSTANCE_LOG_BUFFERS[clientId]) delete INSTANCE_LOG_BUFFERS[clientId];
    qrWebSocketServerModule.notifyInstanceStatusChange(clientId, 'deleted');
    return true;
}


// تعديل معالج 'close' ليتعامل مع pending_deletion
// في دالة launchClientInstance، معالج 'on close':
// child.on('close', (code) => {
//     ...
//     const instanceData = ACTIVE_BOT_INSTANCES[clientId];
//     if (instanceData && instanceData.status === 'pending_deletion') {
//         console.log(`[INST_MGR] Process for ${clientId} (pending deletion) closed. Performing data deletion.`);
//         performDataDeletion(clientId);
//     } else if (instanceData && !instanceData.status.startsWith('stopping') && !instanceData.status.startsWith('restarting')) {
//         delete ACTIVE_BOT_INSTANCES[clientId];
//     }
// });


function restartClientInstance(clientId) {
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance) {
        console.log(`[INST_MGR] Restarting client ${clientId}...`);
        // لا نرسل 'restarting' فورًا، دع stopClientInstance ترسل 'restarting_stopping'
        // qrWebSocketServerModule.notifyInstanceStatusChange(clientId, 'restarting');

        const { phoneNumber, apiUsername, apiPassword, ownerNumber } = instance;
        stopClientInstance(clientId, true); // تمرير true للإشارة إلى إعادة التشغيل
        
        setTimeout(() => {
            console.log(`[INST_MGR] Relaunching ${clientId} after restart stop.`);
            launchClientInstance(clientId, phoneNumber || clientId, false, apiUsername, apiPassword, ownerNumber);
        }, config.RECONNECT_DELAY_MS + 1000); // إضافة مهلة صغيرة إضافية
        return true;
    }
    console.warn(`[INST_MGR] Attempted to restart unknown/stopped client: ${clientId}`);
    return false;
}

function recoverExistingClientInstances() {
    // ... (نفس الكود مع التأكد من استخدام generateClientId الصحيح للمعرفة الدائمة)
    ensureClientDataDirExists();
     console.log("[INST_MGR] Scanning for existing client instances to restart...");
    const existingClientFolders = fs.readdirSync(config.CLIENT_DATA_BASE_DIR, { withFileTypes: true })
                                   .filter(dirent => dirent.isDirectory())
                                   .map(dirent => dirent.name);
    for (const folderName of existingClientFolders) {
        if (folderName.startsWith('client_new_linking_')) continue;
        const clientAuthPath = path.join(config.CLIENT_DATA_BASE_DIR, folderName, 'auth_info_baileys');
        const clientConfigPath = path.join(config.CLIENT_DATA_BASE_DIR, folderName, 'client_config.json');
        let recoveredApiUsername = null, recoveredApiPassword = null, recoveredOwnerNumber = null;
        let recoveredPhoneNumber = folderName.startsWith('client_') ? folderName.split('_')[1] : folderName; // استخلاص الرقم من اسم المجلد

        if (fs.existsSync(clientConfigPath)) {
            try {
                const clientConfigData = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
                recoveredApiUsername = clientConfigData.apiUsername;
                recoveredApiPassword = clientConfigData.apiPassword;
                recoveredOwnerNumber = clientConfigData.ownerNumber;
                recoveredPhoneNumber = clientConfigData.phoneNumber || recoveredPhoneNumber; 
            } catch (e) { /* ... */ }
        }
        if (fs.existsSync(clientAuthPath) && fs.readdirSync(clientAuthPath).length > 0) {
            console.log(`[INST_MGR] Found session for ${folderName} (Phone: ${recoveredPhoneNumber}). Launching.`);
            // استخدم اسم المجلد كـ clientId للاسترداد
            launchClientInstance(folderName, recoveredPhoneNumber, false, recoveredApiUsername, recoveredApiPassword, recoveredOwnerNumber);
        }
    }
}

function handleClientBotQrUpdate(clientId, qr) { // هذا يستقبل سلسلة QR مباشرة
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    if (instance) {
        console.log(`[INST_MGR] Received QR for ${clientId}. Updating status and QR state.`);
        instance.status = 'qr_received'; // تحديث الحالة هنا
        instance.lastUpdated = Date.now();
        instance.lastKnownQR = qr;
        qrWebSocketServerModule.notifyInstanceStatusChange(clientId, instance.status, instance.phoneNumber, instance.name);
        
        const isCurrentlyLinkingOnUI = clientId === qrWebSocketServerModule.managerQrState?.linkingClientId;
        if (instance.isLinkingClient || isCurrentlyLinkingOnUI) {
            qrWebSocketServerModule.updateManagerQrState('qr', 'Scan the QR code with WhatsApp.', qr, clientId, null, null, true);
        }
    } else {
        console.warn(`[INST_MGR] Received QR update for unknown client ID: ${clientId}`);
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
    // إضافة المثيلات الموجودة فقط في السجلات (التي خرجت)
    for (const id in INSTANCE_LOG_BUFFERS) {
        if (!ACTIVE_BOT_INSTANCES[id]) {
            instances.push({
                clientId: id, phoneNumber: 'N/A', name: 'N/A', status: 'exited_no_active_process',
                lastUpdated: Date.now(), startTime: 'N/A', wsConnected: false,
            });
        }
    }
    return instances;
}

function getInstanceLogs(clientId) {
    return INSTANCE_LOG_BUFFERS[clientId] || [`No logs found for ${clientId}. It might have been deleted or never started.`];
}

function sendInternalCommandToClient(clientId, commandPayload) {
    const clientWs = qrWebSocketServerModule.clientBotWsMap.get(clientId);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        const payload = { type: 'internalCommand', clientId: clientId, ...commandPayload };
        try {
            clientWs.send(JSON.stringify(payload));
            console.log(`[INST_MGR] Sent internal command '${commandPayload.command}' to ${clientId}.`);
            return true;
        } catch (e) {
            console.error(`[INST_MGR_ERROR] Failed to send internal command to ${clientId}: ${e.message}`);
        }
    } else {
        console.warn(`[INST_MGR] Cannot send internal command to ${clientId}: WebSocket not open or client not found.`);
    }
    return false;
}
function handleClientBotDataUpdate(clientId, type, data) {
    const instance = ACTIVE_BOT_INSTANCES[clientId];
    console.log(`[INST_MGR_DATA_UPDATE] For ${clientId}, Type: '${type}', Instance Exists: ${!!instance}, Data Keys: ${data ? Object.keys(data).join(', ') : 'N/A'}`);

    if (type === 'status') {
        const { status: newStatus, message, phoneNumber, name, qr: qrFromStatusData } = data;
        console.log(`[INST_MGR] Status update for ${clientId}: '${newStatus}'. Current instance state: '${instance?.status}'`);

        if (instance) {
            if (!((instance.status === 'connected_whatsapp' || instance.status === 'qr_received') && newStatus === 'starting')) {
                if (instance.status !== newStatus) {
                    instance.status = newStatus;
                }
            }
            instance.lastUpdated = Date.now();
            if (phoneNumber && instance.phoneNumber !== phoneNumber.replace(/\D/g, '')) instance.phoneNumber = phoneNumber.replace(/\D/g, '');
            if (name && instance.name !== name) instance.name = name;
            instance.wsConnected = true;
        } else if (newStatus && newStatus !== 'connecting_whatsapp' && newStatus !== 'starting') {
            console.warn(`[INST_MGR] Status for UNKNOWN client ${clientId}: ${newStatus}. Creating entry.`);
            ACTIVE_BOT_INSTANCES[clientId] = {
                process: null, phoneNumber: phoneNumber?.replace(/\D/g, '') || 'N/A', name: name || 'Pending...', clientId, status: newStatus,
                lastUpdated: Date.now(), lastKnownQR: qrFromStatusData || null, isLinkingClient: false,
                apiUsername: null, apiPassword: null, ownerNumber: null, startTime: new Date().toISOString(), wsConnected: true,
            };
        } else {
            console.log(`[INST_MGR] Ignored status update '${newStatus}' for non-tracked/starting client ${clientId}.`);
            return;
        }

        qrWebSocketServerModule.notifyInstanceStatusChange(clientId, newStatus, phoneNumber, name);
        const currentUiLinkingClientId = qrWebSocketServerModule.managerQrState?.linkingClientId;

        if (newStatus === 'connected_whatsapp') {
            console.log(`[INST_MGR] Client ${clientId} reported 'connected_whatsapp'. isLinking: ${instance?.isLinkingClient}, UI Linking ID: ${currentUiLinkingClientId}`);
            if (instance && (instance.isLinkingClient || clientId === currentUiLinkingClientId)) {
                console.log(`[INST_MGR] Finalizing linking for ${clientId}.`);
                const actualPhoneNumber = (phoneNumber || instance.phoneNumber)?.replace(/\D/g, '');
                if (!actualPhoneNumber) {
                    qrWebSocketServerModule.updateManagerQrState('error', `Finalize linking for ${clientId} failed: Phone number missing.`, null, clientId, null, name, true);
                    return;
                }
                const newPermanentClientId = generateClientId(actualPhoneNumber); // `client_PHONE`
                const oldLinkingClientId = clientId;
                console.log(`[INST_MGR] Linking: TempID='${oldLinkingClientId}', ActualPhone='${actualPhoneNumber}', PermanentID='${newPermanentClientId}', Name='${name || instance.name}'`);

                const oldClientPath = getClientDataPath(oldLinkingClientId);
                const newClientPath = getClientDataPath(newPermanentClientId);
                let dataMoveSuccess = false;

                if (oldLinkingClientId !== newPermanentClientId) {
                    if (fs.existsSync(oldClientPath)) {
                        try {
                            if (fs.existsSync(newClientPath)) {
                                console.warn(`[INST_MGR] Path ${newClientPath} exists. Overwriting for new link.`);
                                fs.rmSync(newClientPath, { recursive: true, force: true });
                            }
                            fs.renameSync(oldClientPath, newClientPath);
                            dataMoveSuccess = true;
                        } catch (err) { console.error(`[INST_MGR_ERROR] Rename ${oldClientPath} to ${newClientPath} failed: ${err.message}`); }
                    } else {
                        if (!fs.existsSync(newClientPath)) fs.mkdirSync(newClientPath, { recursive: true });
                        dataMoveSuccess = true;
                    }
                } else {
                    if (!fs.existsSync(newClientPath)) fs.mkdirSync(newClientPath, { recursive: true });
                    dataMoveSuccess = true;
                }

                if (dataMoveSuccess) {
                    const clientConfigPath = path.join(newClientPath, 'client_config.json');
                    try {
                        fs.writeFileSync(clientConfigPath, JSON.stringify({
                            clientId: newPermanentClientId, phoneNumber: actualPhoneNumber, name: name || instance.name,
                            apiUsername: instance.apiUsername, apiPassword: instance.apiPassword, ownerNumber: instance.ownerNumber,
                            linkedAt: new Date().toISOString()
                        }, null, 2));
                    } catch (e) { console.error(`[INST_MGR_ERROR] Save client_config for ${newPermanentClientId} failed:`, e.message); }

                    const previousProcess = instance.process; // احتفظ بالعملية الحالية إذا كان الـ ID لم يتغير

                    if (oldLinkingClientId !== newPermanentClientId && ACTIVE_BOT_INSTANCES[oldLinkingClientId]) {
                        stopClientInstance(oldLinkingClientId); // أوقف العملية المؤقتة
                        delete ACTIVE_BOT_INSTANCES[oldLinkingClientId]; // احذف التتبع المؤقت
                    }
                    
                    // حدث بيانات المثيل بالمعرف الدائم
                    ACTIVE_BOT_INSTANCES[newPermanentClientId] = {
                        ...instance, // انسخ معظم البيانات
                        process: (oldLinkingClientId === newPermanentClientId) ? previousProcess : null, // احتفظ بالعملية إذا كان نفس الـ ID
                        clientId: newPermanentClientId,
                        phoneNumber: actualPhoneNumber,
                        name: name || instance.name,
                        status: 'connected_whatsapp',
                        isLinkingClient: false,
                    };
                    
                    console.log(`[INST_MGR] Client ${newPermanentClientId} finalized. Status: ${ACTIVE_BOT_INSTANCES[newPermanentClientId].status}`);
                    
                    if (!ACTIVE_BOT_INSTANCES[newPermanentClientId].process || ACTIVE_BOT_INSTANCES[newPermanentClientId].process.killed) {
                        console.log(`[INST_MGR] Relaunching instance under permanent ID: ${newPermanentClientId}`);
                        setTimeout(() => {
                             launchClientInstance(newPermanentClientId, actualPhoneNumber, false, instance.apiUsername, instance.apiPassword, instance.ownerNumber);
                        }, 1000); // مهلة صغيرة
                    }
                    qrWebSocketServerModule.updateManagerQrState('connected', `WhatsApp Linked: ${name || instance.name} (${actualPhoneNumber})!`, null, newPermanentClientId, actualPhoneNumber, name || instance.name, false);
                    qrWebSocketServerModule.resetManagerLinkingDisplay();
                } else {
                     qrWebSocketServerModule.updateManagerQrState('error', `Failed to prepare data folder for ${newPermanentClientId}`, null, oldLinkingClientId, actualPhoneNumber, name || instance.name, true);
                }
            }
        } else if (clientId === currentUiLinkingClientId) {
             if (newStatus === 'disconnected_logout' || newStatus === 'error' || newStatus === 'linking_failed' || newStatus === 'error_startup' || newStatus === 'error_spawning') {
                qrWebSocketServerModule.updateManagerQrState(newStatus, message, null, clientId, null, null, true);
                if (newStatus === 'disconnected_logout' || newStatus === 'linking_failed') stopClientInstance(clientId);
            } else if (newStatus === 'connecting_whatsapp' || newStatus === 'starting') {
                qrWebSocketServerModule.updateManagerQrState('linking_in_progress', `WhatsApp connecting... (Client ID: ${clientId})`, null, clientId, null, null, true);
            }
            // رسائل QR تعالج بشكل منفصل الآن
        } else if (newStatus === 'disconnected_logout' || newStatus === 'error' || newStatus === 'linking_failed' || newStatus === 'error_spawning') {
            if (newStatus === 'disconnected_logout' || newStatus === 'linking_failed') stopClientInstance(clientId);
        }

    } else if (type === 'qr') {
        const qrData = data; // data هنا هي سلسلة QR
        const instance = ACTIVE_BOT_INSTANCES[clientId];
        if (instance) {
            console.log(`[INST_MGR] QR received for ${clientId}. Current status: ${instance.status}`);
            if (instance.status !== 'qr_received') { // تحديث الحالة فقط إذا تغيرت
                instance.status = 'qr_received';
                instance.lastUpdated = Date.now();
                qrWebSocketServerModule.notifyInstanceStatusChange(clientId, instance.status, instance.phoneNumber, instance.name);
            }
            instance.lastKnownQR = qrData;
            
            const isCurrentlyLinkingOnUI = clientId === qrWebSocketServerModule.managerQrState?.linkingClientId;
            if (instance.isLinkingClient || isCurrentlyLinkingOnUI) {
                console.log(`[INST_MGR] Forwarding QR for linking client ${clientId} to UI.`);
                qrWebSocketServerModule.updateManagerQrState('qr', 'Scan the QR code with WhatsApp.', qrData, clientId, null, null, true);
            }
        } else {
            console.warn(`[INST_MGR] Received QR for unknown/inactive client: ${clientId}.`);
        }
    
    } else if (type === 'lidResolved') {
        const { originalLid, resolvedPhoneJid, displayName } = data;
        console.log(`[INST_MGR] Received LID resolution for client ${clientId}: ${originalLid} -> ${resolvedPhoneJid} (Name: ${displayName})`);
        qrWebSocketServerModule.notifyParticipantDetailsUpdate(clientId, originalLid, resolvedPhoneJid, displayName);
    }
}

module.exports = {
    launchClientInstance,
    stopClientInstance,
    restartClientInstance,
    deleteClientInstance,
    recoverExistingClientInstances,
    generateClientId,
    handleClientBotDataUpdate,
    listInstances,
    getInstanceLogs,
    ACTIVE_BOT_INSTANCES,
    sendInternalCommandToClient,
    performDataDeletion 
};