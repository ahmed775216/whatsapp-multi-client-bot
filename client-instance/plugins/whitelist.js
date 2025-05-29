// client-instance/plugins/whitelist.js
const fs = require('fs');
const path = require('path');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

const DATA_BASE_DIR = process.env.DATA_DIR_FOR_CLIENT; 

if (!DATA_BASE_DIR) {
    console.error(`[${process.env.CLIENT_ID}_WHITELIST_FATAL] DATA_DIR_FOR_CLIENT environment variable is not set. Whitelist will not function correctly.`);
}

const ensureDataDir = () => {
    if (!DATA_BASE_DIR) {
        console.error(`[${process.env.CLIENT_ID}_WL_INIT_ERROR] Cannot ensure data directory: DATA_BASE_DIR is undefined.`);
        return false;
    }
    if (!fs.existsSync(DATA_BASE_DIR)) {
        console.log(`[${process.env.CLIENT_ID}_WL_INIT] Data directory ${DATA_BASE_DIR} does not exist, creating.`);
        try {
            fs.mkdirSync(DATA_BASE_DIR, { recursive: true });
            console.log(`[${process.env.CLIENT_ID}_WL_INIT] Created data directory for client at: ${DATA_BASE_DIR}`);
            return true;
        } catch (e) {
            console.error(`[${process.env.CLIENT_ID}_WL_INIT_ERROR] Failed to create data directory ${DATA_BASE_DIR}:`, e.message);
            return false;
        }
    } else {
        // console.log(`[${process.env.CLIENT_ID}_WL_INIT] Data directory ${DATA_BASE_DIR} already exists.`); // Can be noisy
        return true;
    }
};

ensureDataDir();

const WHITELIST_FILE = DATA_BASE_DIR ? path.join(DATA_BASE_DIR, 'whitelist.json') : 'whitelist.json';
const USER_GROUP_PERMISSIONS_FILE = DATA_BASE_DIR ? path.join(DATA_BASE_DIR, 'user_group_permissions.json') : 'user_group_permissions.json';
const LID_CACHE_FILE = DATA_BASE_DIR ? path.join(DATA_BASE_DIR, 'lid_cache.json') : 'lid_cache.json';
const ASKED_LIDS_FILE = DATA_BASE_DIR ? path.join(DATA_BASE_DIR, 'asked_lids.json') : 'asked_lids.json';
const PENDING_IDS_FILE = DATA_BASE_DIR ? path.join(DATA_BASE_DIR, 'pending_identifications.json') : 'pending_identifications.json';


const initFile = (filePath, defaultContentGenerator, successMsg, errorMsgPrefix) => {
    if (!fs.existsSync(filePath)) {
        console.log(`[${process.env.CLIENT_ID}_WL_INIT] File ${filePath} does not exist, creating default.`);
        const defaultData = defaultContentGenerator();
        try {
            fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
            console.log(`[${process.env.CLIENT_ID}_WL_INIT] ${successMsg} at ${filePath}`);
            return defaultData.mappings || defaultData.permissions || defaultData; // Adjust based on structure
        } catch (e) {
            console.error(`[${process.env.CLIENT_ID}_WL_INIT_ERROR] ${errorMsgPrefix} writing default ${filePath}:`, e.message);
            return defaultContentGenerator().mappings || defaultContentGenerator().permissions || defaultContentGenerator();
        }
    }
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(data);
        console.log(`[${process.env.CLIENT_ID}_WL_INIT] Successfully loaded ${filePath}.`);
        return parsed.mappings || parsed.permissions || parsed; // Adjust based on structure
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_WL_INIT_ERROR] ${errorMsgPrefix} reading ${filePath}, initializing empty:`, error);
        const fallbackData = defaultContentGenerator();
        return fallbackData.mappings || fallbackData.permissions || fallbackData;
    }
};

if (!global.whitelist) {
    global.whitelist = initFile(WHITELIST_FILE, () => ({ users: [], groups: [], version: 1, lastUpdated: new Date().toISOString() }), 'Created initial client-specific whitelist.json', 'Failed to');
}
if (!global.userGroupPermissions) {
    global.userGroupPermissions = initFile(USER_GROUP_PERMISSIONS_FILE, () => ({ permissions: {}, lastUpdated: new Date().toISOString() }), 'Created initial client-specific user_group_permissions.json', 'Failed to');
}
if (!global.lidToPhoneJidPersistentCache) {
    global.lidToPhoneJidPersistentCache = initFile(LID_CACHE_FILE, () => ({ mappings: {}, lastUpdated: new Date().toISOString() }), 'Created initial lid_cache.json', 'Failed to');
}
if (!global.askedLidsCache) {
    const loadedAskedLids = initFile(ASKED_LIDS_FILE, () => ({ mappings: {}, lastUpdated: new Date().toISOString() }), 'Created initial asked_lids.json', 'Failed to');
    global.askedLidsCache = new Map(Object.entries(loadedAskedLids)); // Convert object to Map
}
if (!global.pendingLidIdentifications) {
    const loadedPendingIds = initFile(PENDING_IDS_FILE, () => ({ mappings: {}, lastUpdated: new Date().toISOString() }), 'Created initial pending_identifications.json', 'Failed to');
    global.pendingLidIdentifications = new Map(Object.entries(loadedPendingIds)); // Convert object to Map
}


const saveFile = (filePath, data, successMsg, errorMsgPrefix) => {
    try {
        let dataToSave = data;
        if (data instanceof Map) { // Convert Map to object for JSON serialization
            dataToSave = Object.fromEntries(data);
        }
        // Ensure there's a top-level structure if needed (e.g., { mappings: ..., lastUpdated: ... })
        let finalStructure = {};
        if (filePath === WHITELIST_FILE) finalStructure = dataToSave; // whitelist is already in correct_disabled_options
        else if (filePath === USER_GROUP_PERMISSIONS_FILE) finalStructure = { permissions: dataToSave, lastUpdated: new Date().toISOString() };
        else finalStructure = { mappings: dataToSave, lastUpdated: new Date().toISOString() };


        fs.writeFileSync(filePath, JSON.stringify(finalStructure, null, 2));
        // console.log(`[${process.env.CLIENT_ID}_WL_SAVE] ${successMsg} at ${filePath}`); // Can be noisy
        return true;
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_WL_SAVE_ERROR] ${errorMsgPrefix} saving ${filePath}:`, error.message);
        return false;
    }
};

const saveWhitelistFile = () => saveFile(WHITELIST_FILE, global.whitelist, 'Successfully saved client-specific whitelist.json', 'Error');
const saveUserGroupPermissionsFile = () => saveFile(USER_GROUP_PERMISSIONS_FILE, global.userGroupPermissions, 'Successfully saved client-specific user_group_permissions.json', 'Error');
const saveLidCacheFile = () => saveFile(LID_CACHE_FILE, global.lidToPhoneJidPersistentCache, 'Successfully saved lid_cache.json', 'Error');
const saveAskedLidsFile = () => saveFile(ASKED_LIDS_FILE, global.askedLidsCache, 'Successfully saved asked_lids.json', 'Error');
const savePendingIdsFile = () => saveFile(PENDING_IDS_FILE, global.pendingLidIdentifications, 'Successfully saved pending_identifications.json', 'Error');


const isWhitelisted = (jid) => {
    if (!jid) return false;
    const normalizedJid = jidNormalizedUser(jid);
    
    if (normalizedJid.endsWith('@lid')) {
        const phoneJidFromCache = global.lidToPhoneJidPersistentCache ? global.lidToPhoneJidPersistentCache[normalizedJid] : null;
        if (phoneJidFromCache) {
            return global.whitelist.users.includes(phoneJidFromCache);
        }
        return false;
    }
    
    return (normalizedJid.endsWith('@s.whatsapp.net') && global.whitelist.users.includes(normalizedJid)) ||
           (normalizedJid.endsWith('@g.us') && global.whitelist.groups.includes(normalizedJid));
};

const formatJid = (input) => {
    if (!input) return null;
    const cleanedInput = input.toString().trim();

    if (/^\d+$/.test(cleanedInput)) return jidNormalizedUser(`${cleanedInput}@s.whatsapp.net`);
    if (/^\d+(-?\d*)?@g\.us$/.test(cleanedInput)) return jidNormalizedUser(cleanedInput); 
    if (cleanedInput.endsWith('@lid')) return jidNormalizedUser(cleanedInput);
    if (cleanedInput.endsWith('@s.whatsapp.net')) return jidNormalizedUser(cleanedInput);
    
    console.warn(`[${process.env.CLIENT_ID}_WL_FORMAT_JID] Unrecognized JID format for input: "${input}", returning null.`);
    return null;
};

const getLidToPhoneJidFromCache = (lid) => {
    if (!lid || !lid.endsWith('@lid')) return null;
    return global.lidToPhoneJidPersistentCache ? global.lidToPhoneJidPersistentCache[jidNormalizedUser(lid)] : null;
};

const cacheLidToPhoneJid = (lid, phoneJid) => {
    if (!lid || !lid.endsWith('@lid') || !phoneJid || !phoneJid.endsWith('@s.whatsapp.net')) {
        console.warn(`[${process.env.CLIENT_ID}_WL_CACHE_LID] Invalid JIDs for caching: lid=${lid}, phoneJid=${phoneJid}`);
        return false;
    }
    const normalizedLid = jidNormalizedUser(lid);
    const normalizedPhoneJid = jidNormalizedUser(phoneJid);

    if (global.lidToPhoneJidPersistentCache) {
        global.lidToPhoneJidPersistentCache[normalizedLid] = normalizedPhoneJid;
        // console.log(`[${process.env.CLIENT_ID}_WL_CACHE_LID] Cached mapping: ${normalizedLid} -> ${normalizedPhoneJid}. Attempting to save.`);
        return saveLidCacheFile();
    }
    return false;
};

const getAskedLidsCache = () => global.askedLidsCache;
const getPendingLidIdentifications = () => global.pendingLidIdentifications;

const addToWhitelist = (jidOrNumber) => {
    try {
        const jid = formatJid(jidOrNumber);
        if (!jid) {
            console.warn(`[${process.env.CLIENT_ID}_WL_ADD] Add to whitelist failed for "${jidOrNumber}" due to invalid JID format.`);
            return { success: false, reason: 'invalid_jid_format' };
        }

        if (jid.endsWith('@s.whatsapp.net')) {
            if (!global.whitelist.users.includes(jid)) {
                global.whitelist.users.push(jid);
                saveWhitelistFile();
                console.log(`[${process.env.CLIENT_ID}_WL_ADD] Added user ${jid} to whitelist.`);
                return { success: true, type: 'user', jid };
            }
            // console.log(`[${process.env.CLIENT_ID}_WL_ADD] User ${jid} already whitelisted.`); // Can be noisy
            return { success: false, reason: 'already_whitelisted', type: 'user', jid };
        } else if (jid.endsWith('@g.us')) {
            if (!global.whitelist.groups.includes(jid)) {
                global.whitelist.groups.push(jid);
                saveWhitelistFile();
                console.log(`[${process.env.CLIENT_ID}_WL_ADD] Added group ${jid} to whitelist.`);
                return { success: true, type: 'group', jid };
            }
            // console.log(`[${process.env.CLIENT_ID}_WL_ADD] Group ${jid} already whitelisted.`); // Can be noisy
            return { success: false, reason: 'already_whitelisted', type: 'group', jid };
        }
        console.warn(`[${process.env.CLIENT_ID}_WL_ADD] Attempted to add non-standard JID to main whitelist: ${jidOrNumber} (Formatted: ${jid})`);
        return { success: false, reason: 'unsupported_jid_type_for_main_whitelist', type: 'unknown', jid };
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_WL_ADD_ERROR] Error in addToWhitelist:`, error.message);
        return { success: false, reason: 'internal_error', type: 'unknown', error: error.message };
    }
};

const removeFromWhitelist = (jidOrNumber) => {
    try {
        const jid = formatJid(jidOrNumber);
        if (!jid) {
             console.warn(`[${process.env.CLIENT_ID}_WL_REMOVE] Remove from whitelist failed for "${jidOrNumber}" due to invalid JID format.`);
            return { success: false, reason: 'invalid_jid_format' };
        }
        
        let removed = false;
        let itemType = '';

        if (jid.endsWith('@s.whatsapp.net')) {
            itemType = 'user';
            const index = global.whitelist.users.indexOf(jid);
            if (index !== -1) {
                global.whitelist.users.splice(index, 1);
                removed = true;
                if (global.lidToPhoneJidPersistentCache) {
                    for (const lidKey in global.lidToPhoneJidPersistentCache) {
                        if (global.lidToPhoneJidPersistentCache[lidKey] === jid) {
                            delete global.lidToPhoneJidPersistentCache[lidKey];
                        }
                    }
                    saveLidCacheFile();
                }
                if (global.askedLidsCache.has(jid)) { // Though unlikely for a phone JID to be a key here
                    global.askedLidsCache.delete(jid);
                    saveAskedLidsFile();
                }
                if (global.pendingLidIdentifications.has(jid)) { // Though unlikely for a phone JID to be a key here
                    global.pendingLidIdentifications.delete(jid);
                    savePendingIdsFile();
                }
            }
        } else if (jid.endsWith('@g.us')) {
            itemType = 'group';
            const index = global.whitelist.groups.indexOf(jid);
            if (index !== -1) {
                global.whitelist.groups.splice(index, 1);
                removed = true;
            }
        }

        if (removed) {
            saveWhitelistFile();
            if (itemType === 'user' && global.userGroupPermissions[jid] !== undefined) {
                delete global.userGroupPermissions[jid];
                saveUserGroupPermissionsFile();
                console.log(`[${process.env.CLIENT_ID}_WL_REMOVE] Removed user ${jid} from whitelist and cleared group permissions.`);
            } else if (itemType === 'group') {
                console.log(`[${process.env.CLIENT_ID}_WL_REMOVE] Removed group ${jid} from whitelist.`);
            }
            return { success: true, jid };
        }
        // console.log(`[${process.env.CLIENT_ID}_WL_REMOVE] JID ${jid} not found in whitelist.`); // Can be noisy
        return { success: false, reason: 'not_whitelisted', jid };
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_WL_REMOVE_ERROR] Error in removeFromWhitelist:`, error.message);
        return { success: false, reason: 'internal_error', error: error.message };
    }
};

const setUserGroupPermission = (userJidOrNumber, allow) => {
    try {
        const userJid = formatJid(userJidOrNumber);
        if (!userJid || !userJid.endsWith('@s.whatsapp.net')) {
            console.warn(`[${process.env.CLIENT_ID}_WL_SET_PERM] Cannot set group permission for non-user JID: ${userJid}`);
            return { success: false, reason: 'not_a_user_jid' };
        }
        if (!isWhitelisted(userJid) && allow === true) {
            addToWhitelist(userJid);
        }
        if (!global.userGroupPermissions[userJid] || typeof global.userGroupPermissions[userJid] !== 'object') {
            global.userGroupPermissions[userJid] = {};
        }
        global.userGroupPermissions[userJid].allowed_in_groups = allow;
        saveUserGroupPermissionsFile();
        console.log(`[${process.env.CLIENT_ID}_WL_SET_PERM] Set group permission for ${userJid} to ${allow}.`);
        return { success: true, jid: userJid, allowed: allow };
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_WL_SET_PERM_ERROR] Error in setUserGroupPermission:`, error.message);
        return { success: false, reason: 'internal_error', error: error.message };
    }
};

module.exports = {
    formatJid,
    isWhitelisted,
    addToWhitelist,
    removeFromWhitelist,
    saveUserGroupPermissionsFile, // Keep for apiSync
    setUserGroupPermission,
    getLidToPhoneJidFromCache,
    cacheLidToPhoneJid,
    getAskedLidsCache,
    saveAskedLidsFile, // Export save functions for direct use if needed
    getPendingLidIdentifications,
    savePendingIdsFile,
};