// client-instance/lib/apiSync.js
const fetch = require("node-fetch");

// Whitelist functions from this client's local whitelist.js
const {
    formatJid,
    addToWhitelist,
    removeFromWhitelist,
    saveUserGroupPermissionsFile,
} = require("../plugins/whitelist");

// API configuration from environment variables injected by manager
// client-instance/lib/apiSync.js
// client-instance/lib/apiSync.js
// ...
// API configuration from environment variables injected by manager
const API_BASE_URL = process.env.API_BASE_URL; // From manager

// Verify the exact URL being constructed
const API_LOGIN_ENDPOINT = `${API_BASE_URL}/login`; // This should be `http://smartbook.selfip.com:8080/api/login  http://smartbook.selfip.com:8080/api/login`
const API_GET_CONTACTS_ENDPOINT = `${API_BASE_URL}/get_contacts`; // This should be `http://smartbook.selfip.com:8080/api/get_contacts`

console.log(
    `[${process.env.CLIENT_ID}_API_SYNC_CONFIG] API_BASE_URL: ${API_BASE_URL}`
);
console.log(
    `[${process.env.CLIENT_ID}_API_SYNC_CONFIG] API_LOGIN_ENDPOINT: ${API_LOGIN_ENDPOINT}`
);
console.log(
    `[${process.env.CLIENT_ID}_API_SYNC_CONFIG] API_GET_CONTACTS_ENDPOINT: ${API_GET_CONTACTS_ENDPOINT}`
);
// ...

// Use API credentials specifically for this client instance
const API_USERNAME = process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC;
const API_PASSWORD = process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC;

let apiToken = null; // Token specific to this client's API credentials

// Initialize global.userGroupPermissions for this specific client bot instance
// This part might be better handled by whitelist.js itself on module load
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
    // Validate and normalize the API endpoint
    if (API_LOGIN_ENDPOINT.includes('/app/')) {
        console.warn(`[${process.env.CLIENT_ID}_API_SYNC_WARN] API endpoint was incorrect, replacing '/app/' with '/api/'`);
        API_LOGIN_ENDPOINT = API_LOGIN_ENDPOINT.replace('/app/', '/api/');
    }

    console.log(`[${process.env.CLIENT_ID}_API_SYNC] Using API endpoint: ${API_LOGIN_ENDPOINT}`);
    console.log(`[${process.env.CLIENT_ID}_API_SYNC] Attempting login to external API...`);

    // Check required credentials
    if (!API_USERNAME || !API_PASSWORD) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Missing API_USERNAME or API_PASSWORD.`);
        return null;
    }

    try {
        const response = await fetch(API_LOGIN_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username: API_USERNAME, password: API_PASSWORD }),
        });

        const contentType = response.headers.get('content-type');

        // Check for non-JSON response (usually HTML)
        if (!contentType || !contentType.includes('application/json')) {
            const html = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Expected JSON but received HTML or invalid format.`);
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] First part of response:\n${html.substring(0, 300)}...`);
            return null;
        }

        const data = await response.json();

        if (response.ok && data.token) {
            apiToken = data.token;
            console.log(`[${process.env.CLIENT_ID}_API_SYNC] Login successful. Token acquired.`);
            return apiToken;
        }

        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login failed. Status: ${response.status}`);
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Response body: ${JSON.stringify(data, null, 2)}`);
        return null;
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Exception during login:`, error.message || error);
        return null;
    }
}

/**
 * Fetches whitelisted contacts from the external API and updates the bot's whitelist
 * and user group permissions for this specific client.
 */
async function syncWhitelistFromApi() {
    console.log(`[${process.env.CLIENT_ID}_API_SYNC] Starting whitelist sync...`);
    // Ensure `global.userGroupPermissions` is initialized by `whitelist.js` when required by clientBotApp.
    // If not, add `require('../plugins/whitelist')` at the top of clientBotApp.js for this.

    if (!apiToken) {
        console.log(
            `[${process.env.CLIENT_ID}_API_SYNC] No token, attempting login first.`
        );
        if (!(await loginToApi())) {
            console.error(
                `[${process.env.CLIENT_ID}_API_SYNC] Login failed, aborting sync.`
            );
            return;
        }
    }

    try {
        console.log(
            `[${process.env.CLIENT_ID}_API_SYNC] Fetching contacts from API...`
        );
        const response = await fetch(API_GET_CONTACTS_ENDPOINT, {
            headers: {
                Authorization: `Bearer ${apiToken}`,
                "Content-Type": "application/json",
            },
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(
                `[${process.env.CLIENT_ID}_API_SYNC_ERROR] Fetch contacts failed: ${response.status} - ${errorText}`
            );
            if (response.status === 401 || response.status === 403) {
                console.warn(
                    `[${process.env.CLIENT_ID}_API_SYNC] Token might be invalid for fetching contacts. Clearing token.`
                );
                apiToken = null; // Clear token to force re-login next time
            }
            return;
        }
        const data = await response.json();
        // console.log(`[${process.env.CLIENT_ID}_API_SYNC] Raw API contact data:`, JSON.stringify(data, null, 2).substring(0, 500) + "...");

        if (!data || !data.status || !Array.isArray(data.contacts)) {
            console.error(
                `[${process.env.CLIENT_ID}_API_SYNC_ERROR] Invalid contacts API response structure.`,
                data
            );
            return;
        }

        const contactsArray = data.contacts;
        console.log(
            `[${process.env.CLIENT_ID}_API_SYNC] Received ${contactsArray.length} contacts from API.`
        );
        let updatedUserPerms = 0;
        const apiUserJidsProcessed = new Set();

        for (const contact of contactsArray) {
            if (contact.mobile) {
                const jid = formatJid(contact.mobile);
                apiUserJidsProcessed.add(jid);

                if (contact.active === true) {
                    const addResult = addToWhitelist(jid); // Adds to client's global.whitelist.users
                    if (addResult.success || addResult.reason === "already_whitelisted") {
                        // API sets/overrides group permission for this user in this client instance's global.userGroupPermissions
                        if (
                            global.userGroupPermissions[jid] !== contact.allowed_in_groups
                        ) {
                            global.userGroupPermissions[jid] = contact.allowed_in_groups;
                            updatedUserPerms++;
                            // console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Set group permission for ${jid} to ${contact.allowed_in_groups}`);
                        }
                    } else {
                        console.warn(
                            `[${process.env.CLIENT_ID}_API_SYNC_ERROR] Failed to add active user ${jid} to general whitelist: ${addResult.reason}`
                        );
                    }
                } else {
                    // contact.active is false
                    const removalResult = removeFromWhitelist(jid); // Removes from general and clears group perm
                    if (removalResult.success) {
                        console.log(
                            `[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${jid} inactive in API, removed.`
                        );
                    }
                }
            }
        }

        // Remove users from this client's bot whitelist/permissions if they are no longer in the API's active list
        // Iterate over a copy of the current global.whitelist.users
        const currentBotWhitelistedUsers = [...global.whitelist.users];
        for (const botUserJid of currentBotWhitelistedUsers) {
            if (
                !apiUserJidsProcessed.has(botUserJid) &&
                botUserJid.endsWith("@s.whatsapp.net")
            ) {
                // If user was previously synced from API but not in current API response, remove them
                removeFromWhitelist(botUserJid); // This also removes from global.userGroupPermissions
                console.log(
                    `[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${botUserJid} no longer in API list, removed from bot's whitelist and group permissions.`
                );
            }
        }

        console.log(
            `[${process.env.CLIENT_ID}_API_SYNC] Finished processing contacts. Updated permissions for ${updatedUserPerms} users.`
        );
        // console.log(`[${process.env.CLIENT_ID}_API_SYNC] State of global.userGroupPermissions before save:`, JSON.stringify(global.userGroupPermissions, null, 2).substring(0, 500) + "...");

        const saved = saveUserGroupPermissionsFile(); // Save the updated permissions for this client
        if (saved) {
            console.log(
                `[${process.env.CLIENT_ID}_API_SYNC] Successfully saved user_group_permissions.json after sync.`
            );
        } else {
            console.error(
                `[${process.env.CLIENT_ID}_API_SYNC_ERROR] FAILED to save user_group_permissions.json after sync.`
            );
        }
    } catch (error) {
        console.error(
            `[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error during whitelist sync:`,
            error
        );
    }
}

module.exports = { syncWhitelistFromApi };
