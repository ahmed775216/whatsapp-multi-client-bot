// client-instance/plugins/whitelist.js
const fs = require('fs');
const path = require('path');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

const DATA_BASE_DIR = process.env.DATA_DIR;

if (!DATA_BASE_DIR) {
    console.error("[WHITELIST_FATAL] DATA_DIR_FOR_CLIENT environment variable is not set. Whitelist will not function correctly.");
    // In a production environment, you might want to exit here or throw.
    // For resilience during dev/testing, we'll try to proceed but expect issues.
}

// Ensure DATA_BASE_DIR exists before defining file paths.
const ensureDataDir = () => {
    if (!DATA_BASE_DIR) {
        console.error("[WL_INIT_ERROR] Cannot ensure data directory: DATA_BASE_DIR is undefined.");
        return false;
    }
    if (!fs.existsSync(DATA_BASE_DIR)) {
        console.log(`[WL_INIT] Data directory ${DATA_BASE_DIR} does not exist, creating.`);
        try {
            fs.mkdirSync(DATA_BASE_DIR, { recursive: true });
            console.log(`[WL_INIT] Created data directory for client at: ${DATA_BASE_DIR}`);
            return true;
        } catch (e) {
            console.error(`[WL_INIT_ERROR] Failed to create data directory ${DATA_BASE_DIR}:`, e.message);
            return false;
        }
    } else {
        console.log(`[WL_INIT] Data directory ${DATA_BASE_DIR} already exists.`);
        return true;
    }
};

// Immediately ensure data directory when the module is loaded
ensureDataDir();

const WHITELIST_FILE = path.join(DATA_BASE_DIR, 'whitelist.json');
const USER_GROUP_PERMISSIONS_FILE = path.join(DATA_BASE_DIR, 'user_group_permissions.json');


// --- Initialization Functions ---

const initWhitelistFile = () => {
    if (!fs.existsSync(WHITELIST_FILE)) {
        console.log(`[WL_INIT] Whitelist file ${WHITELIST_FILE} does not exist, creating default.`);
        const defaultWhitelist = { users: [], groups: [], version: 1, lastUpdated: new Date().toISOString() };
        try {
            fs.writeFileSync(WHITELIST_FILE, JSON.stringify(defaultWhitelist, null, 2));
            console.log(`[WL_INIT] Created initial client-specific whitelist.json at ${WHITELIST_FILE}`);
            return defaultWhitelist;
        } catch (e) {
            console.error(`[WL_INIT_ERROR] Failed to write default whitelist.json at ${WHITELIST_FILE}:`, e.message);
            return { users: [], groups: [] };
        }
    }
    try {
        const data = fs.readFileSync(WHITELIST_FILE, 'utf8');
        const parsed = JSON.parse(data);
        console.log(`[WL_INIT] Successfully loaded whitelist.json from ${WHITELIST_FILE}.`);
        return { users: parsed.users || [], groups: parsed.groups || [], ...parsed };
    } catch (error) {
        console.error(`[WL_INIT_ERROR] Error reading client-specific whitelist.json at ${WHITELIST_FILE}, initializing empty:`, error);
        return { users: [], groups: [] };
    }
};

const initUserGroupPermissionsFile = () => {
    if (!fs.existsSync(USER_GROUP_PERMISSIONS_FILE)) {
        console.log(`[WL_INIT] User group permissions file ${USER_GROUP_PERMISSIONS_FILE} does not exist, creating default.`);
        const defaultPermissions = { permissions: {}, lastUpdated: new Date().toISOString() };
        try {
            fs.writeFileSync(USER_GROUP_PERMISSIONS_FILE, JSON.stringify(defaultPermissions, null, 2));
            console.log(`[WL_INIT] Created initial client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}`);
            return defaultPermissions.permissions;
        } catch (e) {
            console.error(`[WL_INIT_ERROR] Failed to write default user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}:`, e.message);
            return {};
        }
    }
    try {
        const data = fs.readFileSync(USER_GROUP_PERMISSIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        console.log(`[WL_INIT] Successfully loaded user_group_permissions.json from ${USER_GROUP_PERMISSIONS_FILE}.`);
        return parsed.permissions || {};
    } catch (error) {
        console.error(`[WL_INIT_ERROR] Error reading client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}, initializing empty:`, error);
        return {};
    }
};

// Global variables should be initialized only once per client instance process
if (!global.whitelist) {
    global.whitelist = initWhitelistFile();
    console.log(`[WL_LOAD] Client-specific: Loaded ${global.whitelist.users.length} users and ${global.whitelist.groups.length} groups.`);
}
if (!global.userGroupPermissions) {
    global.userGroupPermissions = initUserGroupPermissionsFile();
    console.log(`[WL_LOAD] Client-specific: Loaded group permissions for ${Object.keys(global.userGroupPermissions).length} users.`);
}

const saveWhitelistFile = () => {
    try {
        global.whitelist.lastUpdated = new Date().toISOString();
        fs.writeFileSync(WHITELIST_FILE, JSON.stringify(global.whitelist, null, 2));
        console.log(`[WL_SAVE_MAIN] Successfully saved client-specific whitelist.json at ${WHITELIST_FILE}`);
        return true;
    } catch (error) {
        console.error(`[WL_SAVE_MAIN_ERROR] Error saving client-specific whitelist.json at ${WHITELIST_FILE}:`, error.message);
        return false;
    }
};

const saveUserGroupPermissionsFile = () => {
    try {
        const dataToSave = { permissions: global.userGroupPermissions, lastUpdated: new Date().toISOString() };
        fs.writeFileSync(USER_GROUP_PERMISSIONS_FILE, JSON.stringify(dataToSave, null, 2));
        console.log(`[WL_SAVE_PERM] Successfully saved client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}`);
        return true;
    } catch (error) {
        console.error(`[WL_SAVE_PERM_ERROR] Error saving client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}:`, error.message);
        return false;
    }
};

const isWhitelisted = (jid) => {
    const normalizedJid = jidNormalizedUser(jid);
    const result = (normalizedJid.endsWith('@s.whatsapp.net') && global.whitelist.users.includes(normalizedJid)) ||
                   (normalizedJid.endsWith('@g.us') && global.whitelist.groups.includes(normalizedJid));
    return result;
};

const formatJid = (input) => {
    // If it's just numbers, assume it's a user and append @s.whatsapp.net
    if (/^\d+$/.test(input)) return jidNormalizedUser(`${input}@s.whatsapp.net`);
    // If it's a group JID (digits-timestamp@g.us), return as is after normalizing
    if (/^\d+-\d+@g\.us$/.test(input)) return jidNormalizedUser(input);
    // Otherwise, attempt to normalize whatever JID string is given (e.g., handles '1234567890')
    return jidNormalizedUser(input);
};


const addToWhitelist = (jidOrNumber) => {
    try {
        const jid = formatJid(jidOrNumber);
        if (jid.endsWith('@s.whatsapp.net')) {
            if (!global.whitelist.users.includes(jid)) {
                global.whitelist.users.push(jid);
                saveWhitelistFile();
                console.log(`[WL_ADD] Added user ${jid} to whitelist.`);
                return { success: true, type: 'user', jid };
            }
            console.log(`[WL_ADD] User ${jid} already whitelisted.`);
            return { success: false, reason: 'already_whitelisted', type: 'user', jid };
        } else if (jid.endsWith('@g.us')) {
            if (!global.whitelist.groups.includes(jid)) {
                global.whitelist.groups.push(jid);
                saveWhitelistFile();
                console.log(`[WL_ADD] Added group ${jid} to whitelist.`);
                return { success: true, type: 'group', jid };
            }
            console.log(`[WL_ADD] Group ${jid} already whitelisted.`);
            return { success: false, reason: 'already_whitelisted', type: 'group', jid };
        }
        console.warn(`[WL_ADD] Invalid JID or number format for adding to whitelist: ${jidOrNumber}`);
        return { success: false, reason: 'invalid_jid_or_number', type: 'unknown', jid };
    } catch (error) {
        console.error('[WL_ADD_ERROR] Error in addToWhitelist:', error.message);
        return { success: false, reason: 'internal_error', type: 'unknown', error: error.message };
    }
};

const removeFromWhitelist = (jidOrNumber) => {
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
                // If user is removed from whitelist, remove their specific group permissions too
                if (global.userGroupPermissions[jid] !== undefined) {
                    delete global.userGroupPermissions[jid];
                    saveUserGroupPermissionsFile(); // Ensure this is saved
                    console.log(`[WL_REMOVE] Removed user ${jid} from whitelist and cleared group permissions.`);
                } else {
                    console.log(`[WL_REMOVE] Removed user ${jid} from whitelist. No group permissions to clear.`);
                }
            } else {
                console.log(`[WL_REMOVE] Removed group ${jid} from whitelist.`);
            }
            return { success: true, jid };
        }
        console.log(`[WL_REMOVE] JID ${jid} not found in whitelist.`);
        return { success: false, reason: 'not_whitelisted', jid };
    } catch (error) {
        console.error('[WL_REMOVE_ERROR] Error in removeFromWhitelist:', error.message);
        return { success: false, reason: 'internal_error', error: error.message };
    }
};

const setUserGroupPermission = (userJidOrNumber, allow) => {
    try {
        const userJid = formatJid(userJidOrNumber);
        if (!userJid.endsWith('@s.whatsapp.net')) {
            console.warn(`[WL_SET_PERM] Cannot set group permission for non-user JID: ${userJid}`);
            return { success: false, reason: 'not_a_user_jid' };
        }

        // Ensure the user is in the general whitelist before setting group permissions for them
        // If they are not and `allow` is true, add them.
        if (!isWhitelisted(userJid) && allow === true) {
            console.log(`[WL_SET_PERM] User ${userJid} not in general whitelist, auto-adding for group access.`);
            addToWhitelist(userJid);
        }
        
        // Ensure the structure exists
        if (!global.userGroupPermissions[userJid] || typeof global.userGroupPermissions[userJid] !== 'object') {
            global.userGroupPermissions[userJid] = {};
        }

        global.userGroupPermissions[userJid].allowed_in_groups = allow;
        saveUserGroupPermissionsFile();
        console.log(`[WL_SET_PERM] Set group permission for ${userJid} to ${allow}.`);
        return { success: true, jid: userJid, allowed: allow };
    } catch (error) {
        console.error('[WL_SET_PERM_ERROR] Error in setUserGroupPermission:', error.message);
        return { success: false, reason: 'internal_error', error: error.message };
    }
};

module.exports = {
    formatJid,
    isWhitelisted,
    addToWhitelist,
    removeFromWhitelist,
    saveUserGroupPermissionsFile,
    setUserGroupPermission,
};