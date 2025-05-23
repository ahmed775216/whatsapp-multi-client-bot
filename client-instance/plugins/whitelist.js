// client-instance/plugins/whitelist.js
const fs = require('fs');
const path = require('path');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

const DATA_BASE_DIR = process.env.DATA_DIR_FOR_CLIENT; 

if (!DATA_BASE_DIR) {
    console.error("[WHITELIST_FATAL] DATA_DIR_FOR_CLIENT environment variable is not set. Whitelist will not function correctly.");
}

const WHITELIST_FILE = path.join(DATA_BASE_DIR, 'whitelist.json');
const USER_GROUP_PERMISSIONS_FILE = path.join(DATA_BASE_DIR, 'user_group_permissions.json');

// --- Initialization Functions ---
const ensureDataDir = () => {
    if (!fs.existsSync(DATA_BASE_DIR)) {
        console.log(`[WL_INIT] Data directory ${DATA_BASE_DIR} does not exist, creating.`); // Added log
        try {
            fs.mkdirSync(DATA_BASE_DIR, { recursive: true });
            console.log(`[WL_INIT] Created data directory for client at: ${DATA_BASE_DIR}`);
        } catch (e) {
            console.error(`[WL_INIT_ERROR] Failed to create data directory ${DATA_BASE_DIR}:`, e.message); // Added error log
        }
    } else {
        console.log(`[WL_INIT] Data directory ${DATA_BASE_DIR} already exists.`); // Added log
    }
};

const initWhitelistFile = () => {
    ensureDataDir();
    if (!fs.existsSync(WHITELIST_FILE)) {
        console.log(`[WL_INIT] Whitelist file ${WHITELIST_FILE} does not exist, creating default.`); // Added log
        const defaultWhitelist = { users: [], groups: [], version: 1, lastUpdated: new Date().toISOString() };
        try {
            fs.writeFileSync(WHITELIST_FILE, JSON.stringify(defaultWhitelist, null, 2));
            console.log(`[WL_INIT] Created initial client-specific whitelist.json at ${WHITELIST_FILE}`);
            return defaultWhitelist;
        } catch (e) {
            console.error(`[WL_INIT_ERROR] Failed to write default whitelist.json at ${WHITELIST_FILE}:`, e.message); // Added error log
            return { users: [], groups: [] }; // Return empty on write error
        }
    }
    try {
        const data = fs.readFileSync(WHITELIST_FILE, 'utf8');
        const parsed = JSON.parse(data);
        console.log(`[WL_INIT] Successfully loaded whitelist.json from ${WHITELIST_FILE}.`); // Added log
        return { users: parsed.users || [], groups: parsed.groups || [], ...parsed };
    } catch (error) {
        console.error(`[WL_INIT_ERROR] Error reading client-specific whitelist.json at ${WHITELIST_FILE}, initializing empty:`, error);
        return { users: [], groups: [] };
    }
};

const initUserGroupPermissionsFile = () => {
    ensureDataDir();
    if (!fs.existsSync(USER_GROUP_PERMISSIONS_FILE)) {
        console.log(`[WL_INIT] User group permissions file ${USER_GROUP_PERMISSIONS_FILE} does not exist, creating default.`); // Added log
        const defaultPermissions = { permissions: {}, lastUpdated: new Date().toISOString() };
        try {
            fs.writeFileSync(USER_GROUP_PERMISSIONS_FILE, JSON.stringify(defaultPermissions, null, 2));
            console.log(`[WL_INIT] Created initial client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}`);
            return defaultPermissions.permissions;
        } catch (e) {
            console.error(`[WL_INIT_ERROR] Failed to write default user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}:`, e.message); // Added error log
            return {}; // Return empty on write error
        }
    }
    try {
        const data = fs.readFileSync(USER_GROUP_PERMISSIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        console.log(`[WL_INIT] Successfully loaded user_group_permissions.json from ${USER_GROUP_PERMISSIONS_FILE}.`); // Added log
        return parsed.permissions || {};
    } catch (error) {
        console.error(`[WL_INIT_ERROR] Error reading client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}, initializing empty:`, error);
        return {};
    }
};

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
        console.log(`[WL_SAVE_MAIN] Successfully saved client-specific whitelist.json at ${WHITELIST_FILE}`); // Added log
        return true;
    } catch (error) {
        console.error(`[WL_SAVE_MAIN_ERROR] Error saving client-specific whitelist.json at ${WHITELIST_FILE}:`, error.message); // Added error log
        return false;
    }
};

const saveUserGroupPermissionsFile = () => {
    try {
        const dataToSave = { permissions: global.userGroupPermissions, lastUpdated: new Date().toISOString() };
        fs.writeFileSync(USER_GROUP_PERMISSIONS_FILE, JSON.stringify(dataToSave, null, 2));
        console.log(`[WL_SAVE_PERM] Successfully saved client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}`); // Added log
        return true;
    } catch (error) {
        console.error(`[WL_SAVE_PERM_ERROR] Error saving client-specific user_group_permissions.json at ${USER_GROUP_PERMISSIONS_FILE}:`, error.message); // Added error log
        return false;
    }
};

const isWhitelisted = (jid) => {
    const normalizedJid = jidNormalizedUser(jid);
    const result = (normalizedJid.endsWith('@s.whatsapp.net') && global.whitelist.users.includes(normalizedJid)) ||
                   (normalizedJid.endsWith('@g.us') && global.whitelist.groups.includes(normalizedJid));
    // console.log(`[WL_CHECK] Is ${normalizedJid} whitelisted? ${result}`); // Too verbose for general use, uncomment if deep debugging needed
    return result;
};

const formatJid = (input) => {
    if (/^\d+$/.test(input)) return jidNormalizedUser(`${input}@s.whatsapp.net`);
    return jidNormalizedUser(input);
};

const addToWhitelist = (jidOrNumber) => {
    try {
        const jid = formatJid(jidOrNumber);
        if (jid.endsWith('@s.whatsapp.net')) {
            if (!global.whitelist.users.includes(jid)) {
                global.whitelist.users.push(jid);
                saveWhitelistFile();
                console.log(`[WL_ADD] Added user ${jid} to whitelist.`); // Added log
                return { success: true, type: 'user', jid };
            }
            console.log(`[WL_ADD] User ${jid} already whitelisted.`); // Added log
            return { success: false, reason: 'already_whitelisted', type: 'user', jid };
        } else if (jid.endsWith('@g.us')) {
            if (!global.whitelist.groups.includes(jid)) {
                global.whitelist.groups.push(jid);
                saveWhitelistFile();
                console.log(`[WL_ADD] Added group ${jid} to whitelist.`); // Added log
                return { success: true, type: 'group', jid };
            }
            console.log(`[WL_ADD] Group ${jid} already whitelisted.`); // Added log
            return { success: false, reason: 'already_whitelisted', type: 'group', jid };
        }
        console.warn(`[WL_ADD] Invalid JID or number format for adding to whitelist: ${jidOrNumber}`); // Added warning
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
                if (global.userGroupPermissions[jid] !== undefined) { // Check if permission existed
                    delete global.userGroupPermissions[jid];
                    saveUserGroupPermissionsFile();
                    console.log(`[WL_REMOVE] Removed user ${jid} from whitelist and cleared group permissions.`); // Added log
                } else {
                    console.log(`[WL_REMOVE] Removed user ${jid} from whitelist. No group permissions to clear.`); // Added log
                }
            } else {
                console.log(`[WL_REMOVE] Removed group ${jid} from whitelist.`); // Added log
            }
            return { success: true, jid };
        }
        console.log(`[WL_REMOVE] JID ${jid} not found in whitelist.`); // Added log
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
            console.warn(`[WL_SET_PERM] Cannot set group permission for non-user JID: ${userJid}`); // Added warning
            return { success: false, reason: 'not_a_user_jid' };
        }

        if (!isWhitelisted(userJid) && allow === true) {
            console.log(`[WL_SET_PERM] User ${userJid} not in general whitelist, auto-adding for group access.`); // Added log
            addToWhitelist(userJid);
        }
        
        global.userGroupPermissions[userJid] = allow;
        saveUserGroupPermissionsFile();
        console.log(`[WL_SET_PERM] Set group permission for ${userJid} to ${allow}.`); // Added log
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
    setUserGroupPermission, // Export this if used elsewhere
};