// client-instance/lib/apiSync.js
const fetch = require('node-fetch');

const { formatJid, addToWhitelist, removeFromWhitelist, saveUserGroupPermissionsFile } = require('../plugins/whitelist');

const API_BASE_URL = process.env.API_BASE_URL;
const API_LOGIN_ENDPOINT = `${API_BASE_URL}/login`;
const API_GET_CONTACTS_ENDPOINT = `${API_BASE_URL}/get_contacts`;

console.log(`[${process.env.CLIENT_ID}_API_SYNC_CONFIG] API_BASE_URL: ${API_BASE_URL}`);
console.log(`[${process.env.CLIENT_ID}_API_SYNC_CONFIG] API_LOGIN_ENDPOINT: ${API_LOGIN_ENDPOINT}`);
console.log(`[${process.env.CLIENT_ID}_API_SYNC_CONFIG] API_GET_CONTACTS_ENDPOINT: ${API_GET_CONTACTS_ENDPOINT}`);

// Use API credentials specifically for this client instance
const CLIENT_API_USERNAME = process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC;
const CLIENT_API_PASSWORD = process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC;

let apiToken = null;

if (!global.userGroupPermissions) {
    // This should ideally be loaded by whitelist.js (which requires it on startup)
    // If you remove the direct require of whitelist.js from clientBotApp, ensure this initialization
    // is triggered implicitly when clientBotApp uses a whitelist function.
    // For now, whitelist.js will handle its own initialization when required for its functions.
}

/**
 * Attempts to log in to the external API and store the token.
 * Uses client-specific API credentials.
 */
async function loginToApi() {
    console.log(`[${process.env.CLIENT_ID}_API_SYNC] Attempting login to external API...`);
    // Ensure credentials are provided for this client instance
    if (!CLIENT_API_USERNAME || !CLIENT_API_PASSWORD) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] API username or password not set for this client instance. Skipping API login.`);
        return null;
    }

    try {
        const response = await fetch(API_LOGIN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: CLIENT_API_USERNAME, // Use client-specific API credentials
                password: CLIENT_API_PASSWORD, // Use client-specific API credentials
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login failed: ${response.status} - ${errorText}`);
            return null;
        }

        const data = await response.json();
        if (data.token) {
            apiToken = data.token;
            console.log(`[${process.env.CLIENT_ID}_API_SYNC] Login successful, token obtained.`);
            return apiToken;
        }
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login response missing token or malformed:`, data);
        return null;
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error during API login:`, error.message);
        return null;
    }
}

/**
 * Fetches whitelisted contacts from the external API and updates the bot's whitelist
 * and user group permissions for this specific client.
 */
async function syncWhitelistFromApi() {
    console.log(`[${process.env.CLIENT_ID}_API_SYNC] Starting whitelist sync...`);
    
    // Check if API credentials exist before attempting login
    if (!CLIENT_API_USERNAME || !CLIENT_API_PASSWORD) {
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Client API credentials not set. Skipping sync.`);
        return;
    }

    if (!apiToken) {
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] No token, attempting login first.`);
        if (!(await loginToApi())) {
            console.error(`[${process.env.CLIENT_ID}_API_SYNC] Login failed, aborting sync.`);
            return;
        }
    }

    try {
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Fetching contacts from API...`);
        const response = await fetch(API_GET_CONTACTS_ENDPOINT, {
            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Fetch contacts failed: ${response.status} - ${errorText}`);
            if (response.status === 401 || response.status === 403) {
                console.warn(`[${process.env.CLIENT_ID}_API_SYNC] Token might be invalid for fetching contacts. Clearing token.`);
                apiToken = null;
            }
            return;
        }
        const data = await response.json();

        if (!data || !data.status || !Array.isArray(data.contacts)) {
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Invalid contacts API response structure.`, data);
            return;
        }

        const contactsArray = data.contacts;
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Received ${contactsArray.length} contacts from API.`);
        let updatedUserPerms = 0;
        const apiUserJidsProcessed = new Set();

        for (const contact of contactsArray) {
            if (contact.mobile) {
                const jid = formatJid(contact.mobile);
                apiUserJidsProcessed.add(jid);

                if (contact.active === true) {
                    const addResult = addToWhitelist(jid);
                    if (addResult.success || addResult.reason === 'already_whitelisted') {
                        if (global.userGroupPermissions[jid] !== contact.allowed_in_groups) {
                            global.userGroupPermissions[jid] = contact.allowed_in_groups;
                            updatedUserPerms++;
                        }
                    } else {
                        console.warn(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Failed to add active user ${jid} to general whitelist: ${addResult.reason}`);
                    }
                } else {
                    const removalResult = removeFromWhitelist(jid);
                    if (removalResult.success) {
                        console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${jid} inactive in API, removed.`);
                    }
                }
            }
        }
        
        const currentBotWhitelistedUsers = [...global.whitelist.users];
        for (const botUserJid of currentBotWhitelistedUsers) {
            if (!apiUserJidsProcessed.has(botUserJid) && botUserJid.endsWith('@s.whatsapp.net')) {
                removeFromWhitelist(botUserJid);
                console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${botUserJid} no longer in API list, removed from bot's whitelist and group permissions.`);
            }
        }

        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Finished processing contacts. Updated permissions for ${updatedUserPerms} users.`);
        
        const saved = saveUserGroupPermissionsFile();
        if (saved) {
            console.log(`[${process.env.CLIENT_ID}_API_SYNC] Successfully saved user_group_permissions.json after sync.`);
        } else {
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] FAILED to save user_group_permissions.json after sync.`);
        }

    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error during whitelist sync:`, error);
    }
}

module.exports = { syncWhitelistFromApi };