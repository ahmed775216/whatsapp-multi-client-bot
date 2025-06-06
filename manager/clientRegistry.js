// manager/clientRegistry.js
const fs = require('fs');
const path = require('path');

const CLIENT_REGISTRY_FILE = path.join(__dirname, '../client_data', 'clientRegistry.json');

let clientRegistry = {}; // Stores { csharpClientId: { botClientId: '...', lastSeen: '...' } }

function loadClientRegistry() {
    if (fs.existsSync(CLIENT_REGISTRY_FILE)) {
        try {
            const data = fs.readFileSync(CLIENT_REGISTRY_FILE, 'utf8');
            clientRegistry = JSON.parse(data);
            console.log(`[CLIENT_REGISTRY] Loaded ${Object.keys(clientRegistry).length} clients from registry.`);
        } catch (error) {
            console.error(`[CLIENT_REGISTRY_ERROR] Failed to load client registry: ${error.message}`);
            clientRegistry = {};
        }
    } else {
        console.log('[CLIENT_REGISTRY] No existing client registry found. Starting fresh.');
    }
}

function saveClientRegistry() {
    try {
        fs.writeFileSync(CLIENT_REGISTRY_FILE, JSON.stringify(clientRegistry, null, 2), 'utf8');
        console.log('[CLIENT_REGISTRY] Client registry saved.');
    } catch (error) {
        console.error(`[CLIENT_REGISTRY_ERROR] Failed to save client registry: ${error.message}`);
    }
}

function registerClient(csharpClientId, botClientId) {
    clientRegistry[csharpClientId] = { botClientId: botClientId, lastSeen: new Date().toISOString() };
    saveClientRegistry();
    console.log(`[CLIENT_REGISTRY] Registered C# client '${csharpClientId}' with bot instance '${botClientId}'.`);
}

function getBotClientIdForCsharpClient(csharpClientId) {
    const clientData = clientRegistry[csharpClientId];
    return clientData ? clientData.botClientId : null;
}

function updateClientLastSeen(csharpClientId) {
    if (clientRegistry[csharpClientId]) {
        clientRegistry[csharpClientId].lastSeen = new Date().toISOString();
        // No need to save immediately, can be done periodically or on significant events
    }
}

function removeClient(csharpClientId) {
    if (clientRegistry[csharpClientId]) {
        delete clientRegistry[csharpClientId];
        saveClientRegistry();
        console.log(`[CLIENT_REGISTRY] Removed C# client '${csharpClientId}' from registry.`);
    }
}

function listRegisteredClients() {
    return Object.keys(clientRegistry).map(csharpClientId => ({
        csharpClientId,
        botClientId: clientRegistry[csharpClientId].botClientId,
        lastSeen: clientRegistry[csharpClientId].lastSeen
    }));
}

// Load registry on module initialization
loadClientRegistry();

module.exports = {
    registerClient,
    getBotClientIdForCsharpClient,
    updateClientLastSeen,
    removeClient,
    listRegisteredClients,
    loadClientRegistry // Expose for explicit loading if needed
};