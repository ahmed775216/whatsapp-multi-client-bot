// client-instance/plugins/whitelist.js
const fs = require('fs');
const path = require('path');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

// Use environment variables for dynamic data paths provided by clientBotApp.js
// This path will be client-specific (e.g., client_data/client_12345/data)
const DATA_BASE_DIR = process.env.DATA_DIR_FOR_CLIENT; 

if (!DATA_BASE_DIR) {
    console.error("[WHITELIST_FATAL] DATA_DIR_FOR_CLIENT environment variable is not set. Whitelist will not function correctly.");
    // Fallback or exit if this is truly critical
    // process.exit(1);
    // For now, providing a hardcoded fallback if needed for local testing, but it defeats isolated storage
    // You should ensure clientBotApp always sets this for client instances.
    // In actual use, this will be passed.
    // Fallback: console.warn("Using fallback data directory for whitelist. This should not happen in a managed client instance.");
    // DATA_BASE_DIR = path.join(__dirname, '../../temp_data_fallback');
}


const WHITELIST_FILE = path.join(DATA_BASE_DIR, 'whitelist.json');
const USER_GROUP_PERMISSIONS_FILE = path.join(DATA_BASE_DIR, 'user_group_permissions.json');

// --- Initialization Functions ---
const ensureDataDir = () => {
    // This is called by clientBotApp.js's top-level checks, or by init functions
    if (!fs.existsSync(DATA_BASE_DIR)) {
        fs.mkdirSync(DATA_BASE_DIR, { recursive: true });
        console.log(`[WL_INIT] Created data directory for client at: ${DATA_BASE_DIR}`);
    }
};

const initWhitelistFile = () => {
    ensureDataDir(); // Ensure client's specific data dir exists
    if (!fs.existsSync(WHITELIST_FILE)) {
        const defaultWhitelist = { users: [], groups: [], version: 1, lastUpdated: new Date().toISOString() };
        fs.writeFileSync(WHITELIST_FILE, JSON.stringify(defaultWhitelist, null, 2));
        console.log(`[WL_INIT] Created initial client-specific whitelist.json at ${WHITELIST_FILE}`);
        return defaultWhitelist;
    }
    try {
        const data = fs.readFileSync(WHITELIST_FILE, 'utf8');
        const parsed = JSON.parse(data);
        return { users: parsed.users || [], groups: parsed.groups || [], ...parsed };
    } catch (error) {
        console.error(`[WL_INIT] Error reading client-specific whitelist.json at ${WHITELIST_FILE}, initializing empty:`, error);
        return { users: [], groups: [] };
    }
};

const initUserGroupPermissionsFile = () => {
    ensureDataDir(); // Ensure client's specific data dir exists
    if (!fs.existsSync(USER_GROUP_PERMISSIONS_FILE)) {
        const defaultPermissions = { permissions: {}, lastUpdated: new Date().toISOString() };
        fs.writeFileSync(USER_GROUP_PERMISSIONS_FILE, JSON.stringify(defaultPermissions, null, 2));
        console.log(`[WL_INIT] Created initial client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}`);
        return defaultPermissions.permissions;
    }
    try {
        const data = fs.readFileSync(USER_GROUP_PERMISSIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        return parsed.permissions || {};
    } catch (error) {
        console.error(`[WL_INIT] Error reading client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}, initializing empty:`, error);
        return {};
    }
};

// Global variables specific to this client's process
// Ensure these are initialized when whitelist.js is `required` by clientBotApp.js
if (!global.whitelist) {
    global.whitelist = initWhitelistFile();
    console.log(`[WL_LOAD] Client-specific: Loaded ${global.whitelist.users.length} users and ${global.whitelist.groups.length} groups.`);
}
if (!global.userGroupPermissions) {
    global.userGroupPermissions = initUserGroupPermissionsFile();
    console.log(`[WL_LOAD] Client-specific: Loaded group permissions for ${Object.keys(global.userGroupPermissions).length} users.`);
}


// --- Save Functions ---
const saveWhitelistFile = () => {
    try {
        global.whitelist.lastUpdated = new Date().toISOString();
        fs.writeFileSync(WHITELIST_FILE, JSON.stringify(global.whitelist, null, 2));
        // console.log('[WL_SAVE_MAIN] Successfully saved client-specific whitelist.json'); // Reduce logging verbosity
        return true;
    } catch (error) {
        console.error(`[WL_SAVE_MAIN_ERROR] Error saving client-specific whitelist.json at ${WHITELIST_FILE}:`, error);
        return false;
    }
};

const saveUserGroupPermissionsFile = () => {
    try {
        const dataToSave = { permissions: global.userGroupPermissions, lastUpdated: new Date().toISOString() };
        fs.writeFileSync(USER_GROUP_PERMISSIONS_FILE, JSON.stringify(dataToSave, null, 2));
        // console.log('[WL_SAVE_PERM] Successfully saved client-specific user_group_permissions.json'); // Reduce logging verbosity
        return true;
    } catch (error) {
        console.error(`[WL_SAVE_PERM_ERROR] Error saving client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}:`, error);
        return false;
    }
};


// --- Utility Functions (isWhitelisted, formatJid, addToWhitelist, removeFromWhitelist, setUserGroupPermission) ---
// These functions remain largely the same, but now implicitly work on the
// `global.whitelist` and `global.userGroupPermissions` objects specific to this
// client instance's Node.js process and their dynamically determined file paths.

const isWhitelisted = (jid) => { /* ... same as before ... */
    const normalizedJid = jidNormalizedUser(jid);
    if (normalizedJid.endsWith('@s.whatsapp.net')) return global.whitelist.users.includes(normalizedJid);
    if (normalizedJid.endsWith('@g.us')) return global.whitelist.groups.includes(normalizedJid);
    return false;
};

const formatJid = (input) => { /* ... same as before ... */
    if (/^\d+$/.test(input)) return jidNormalizedUser(`${input}@s.whatsapp.net`);
    return jidNormalizedUser(input);
};

const addToWhitelist = (jidOrNumber) => { /* ... same as before, calls saveWhitelistFile ... */
    try {
        const jid = formatJid(jidOrNumber);
        if (jid.endsWith('@s.whatsapp.net')) {
            if (!global.whitelist.users.includes(jid)) {
                global.whitelist.users.push(jid);
                saveWhitelistFile();
                return { success: true, type: 'user', jid };
            }
            return { success: false, reason: 'already_whitelisted', type: 'user', jid };
        } else if (jid.endsWith('@g.us')) {
            if (!global.whitelist.groups.includes(jid)) {
                global.whitelist.groups.push(jid);
                saveWhitelistFile();
                return { success: true, type: 'group', jid };
            }
            return { success: false, reason: 'already_whitelisted', type: 'group', jid };
        }
        return { success: false, reason: 'invalid_jid_or_number', type: 'unknown', jid };
    } catch (error) {
        console.error('[WL_ADD_ERROR] Error in addToWhitelist:', error);
        return { success: false, reason: 'internal_error', type: 'unknown', error: error.message };
    }
};

const removeFromWhitelist = (jidOrNumber) => { /* ... same as before, calls saveWhitelistFile/saveUserGroupPermissionsFile ... */
    try {
        const jid = formatJid(jidOrNumber);
        let removed = false;
        if (jid.endsWith('@s.whatsapp.net')) {
            const index = global.whitelist.users.indexOf(jid);
            if (index !== -1) {
                global.whitelist.users.splice(index, 1);
                removed = true;
            }
        } else if (jid.endsWith('@g.us')) {
            const index = global.whitelist.groups.indexOf(jid);
            if (index !== -1) {
                global.whitelist.groups.splice(index, 1);
                removed = true;
            }
        }
        if (removed) {
            saveWhitelistFile();
            if (jid.endsWith('@s.whatsapp.net')) {
                delete global.userGroupPermissions[jid];
                saveUserGroupPermissionsFile();
            }
            return { success: true, jid };
        }
        return { success: false, reason: 'not_whitelisted', jid };
    } catch (error) {
        console.error('[WL_REMOVE_ERROR] Error in removeFromWhitelist:', error);
        return { success: false, reason: 'internal_error', error: error.message };
    }
};

const setUserGroupPermission = (userJidOrNumber, allow) => { /* ... same as before, calls saveUserGroupPermissionsFile ... */
    try {
        const userJid = formatJid(userJidOrNumber);
        if (!userJid.endsWith('@s.whatsapp.net')) return { success: false, reason: 'not_a_user_jid' };

        if (!isWhitelisted(userJid) && allow === true) {
            addToWhitelist(userJid); // Auto-add to general whitelist if allowing group access
            // console.log(`[WL_SET_PERM] User ${userJid} auto-added to general whitelist.`);
        }
        
        global.userGroupPermissions[userJid] = allow;
        saveUserGroupPermissionsFile();
        return { success: true, jid: userJid, allowed: allow };
    } catch (error) {
        console.error('[WL_SET_PERM_ERROR] Error in setUserGroupPermission:', error);
        return { success: false, reason: 'internal_error', error: error.message };
    }
};


// Not exporting a 'handler' for this specific test stage
// Just exporting the utility functions
module.exports = {
    formatJid,
    isWhitelisted,
    addToWhitelist,
    removeFromWhitelist,
    saveUserGroupPermissionsFile,
    // Add other relevant exports if any other module directly needs them
};