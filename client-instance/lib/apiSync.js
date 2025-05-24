// client-instance/lib/apiSync.js
const fetch = require('node-fetch');
const path = require('path');

const { formatJid, addToWhitelist, removeFromWhitelist, saveUserGroupPermissionsFile } = require('../plugins/whitelist');
const config = require('../../config');

const API_BASE_URL = process.env.API_BASE_URL;
const API_LOGIN_ENDPOINT = `${API_BASE_URL}/login`;
const API_GET_CONTACTS_ENDPOINT = `${API_BASE_URL}/get_contacts`;

console.log(`[${process.env.CLIENT_ID}_API_SYNC_CONFIG] API_BASE_URL: ${API_BASE_URL}`);
console.log(`[${process.env.CLIENT_ID}_API_SYNC_CONFIG] API_LOGIN_ENDPOINT: ${API_LOGIN_ENDPOINT}`);
console.log(`[${process.env.CLIENT_ID}_API_SYNC_CONFIG] API_GET_CONTACTS_ENDPOINT: ${API_GET_CONTACTS_ENDPOINT}`);

const CLIENT_API_USERNAME = process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC;
const CLIENT_API_PASSWORD = process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC;

let apiToken = null;

if (!global.userGroupPermissions) {
    // This should ideally be loaded by whitelist.js (which requires it on startup)
    // If you remove the direct require of whitelist.js from clientBotApp, ensure this initialization
    // is triggered implicitly when clientBotApp uses a whitelist function.
    // For now, whitelist.js will handle its own initialization when required for its functions.
}

function normalizePhoneNumberToJid(mobileNumber) {
    let cleanedNumber = mobileNumber.replace(/\D/g, '');
    
    if (!cleanedNumber.startsWith(config.DEFAULT_PHONE_COUNTRY_CODE) && !cleanedNumber.startsWith('00' + config.DEFAULT_PHONE_COUNTRY_CODE)) {
        cleanedNumber = config.DEFAULT_PHONE_COUNTRY_CODE + cleanedNumber;
    }
    
    return formatJid(cleanedNumber);
}

function stripCountryCode(fullJid, countryCode) {
    const numberPart = fullJid.split('@')[0];
    if (numberPart.startsWith(countryCode)) {
        return numberPart.substring(countryCode.length);
    }
    return numberPart;
}

/**
 * Attempts to log in to the external API and store the token.
 * Uses client-specific API credentials.
 */
async function loginToApi() {
    console.log(`[${process.env.CLIENT_ID}_API_SYNC] Attempting login to external API...`);
    console.log(`[${process.env.CLIENT_ID}_API_SYNC] Using username: ${CLIENT_API_USERNAME ? CLIENT_API_USERNAME.substring(0, 3) + '***' : 'N/A'}`);
    
    if (!CLIENT_API_USERNAME || !CLIENT_API_PASSWORD) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] API username or password not set for this client instance. Skipping API login.`);
        return null;
    }

    try {
        const response = await fetch(API_LOGIN_ENDPOINT, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'WhatsApp-Bot-Client'
            },
            body: JSON.stringify({
                username: CLIENT_API_USERNAME,
                password: CLIENT_API_PASSWORD,
            }),
            redirect: 'manual' // Prevent automatic redirects
        });

        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Login API response status: ${response.status}`);
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Login API response headers:`, Object.fromEntries(response.headers.entries()));
        
        // Handle redirects manually
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login endpoint redirected to: ${location}`);
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] This suggests the API endpoint URL might be incorrect.`);
            return null;
        }
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login failed: ${response.status} - ${errorText.substring(0, 500)}`);
            
            // Check if response indicates HTML, which means wrong endpoint or redirect
            if (errorText.includes('<!DOCTYPE html>') || errorText.includes('<html')) {
                console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login response is HTML - likely wrong endpoint or server redirect.`);
                console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Check if the API_BASE_URL is correct: ${API_BASE_URL}`);
            }
            return null;
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const responseText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login response is not JSON. Content-Type: ${contentType}`);
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Response: ${responseText.substring(0, 200)}...`);
            return null;
        }

        const data = await response.json();
        if (data.token) {
            apiToken = data.token;
            console.log(`[${process.env.CLIENT_ID}_API_SYNC] Login successful, token obtained. Token Length: ${apiToken.length > 0 ? 'Set' : 'Empty'}`);
            return apiToken;
        }
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login response missing token:`, JSON.stringify(data).substring(0, 200) + '...');
        return null;
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error during API login:`, error.message);
        if (error.stack) {
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Stack trace:`, error.stack);
        }
        return null;
    }
}

/**
 * Fetches whitelisted contacts from the external API and updates the bot's whitelist
 * and user group permissions for this specific client.
 */
async function syncWhitelistFromApi() {
    console.log(`[${process.env.CLIENT_ID}_API_SYNC] Starting whitelist sync...`);
    
    if (!CLIENT_API_USERNAME || !CLIENT_API_PASSWORD) {
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Client API credentials not set. Skipping sync.`);
        return;
    }

    if (!apiToken) {
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] No token available for sync, attempting login first.`);
        if (!(await loginToApi())) {
            console.error(`[${process.env.CLIENT_ID}_API_SYNC] Login failed, aborting sync.`);
            return;
        }
    } else {
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] API token already exists.`);
    }

    try {
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Fetching contacts from API endpoint: ${API_GET_CONTACTS_ENDPOINT}`);
        const response = await fetch(API_GET_CONTACTS_ENDPOINT, {
            method: 'GET',
            headers: { 
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'WhatsApp-Bot-Client'
            },
            redirect: 'manual' // Prevent automatic redirects
        });
        
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Get contacts API response status: ${response.status}`);
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Get contacts API response headers:`, Object.fromEntries(response.headers.entries()));
        
        // Handle redirects manually
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Get contacts endpoint redirected to: ${location}`);
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] This suggests the API endpoint URL might be incorrect or token is invalid.`);
            apiToken = null; // Clear token to force re-login
            return;
        }
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Fetch contacts failed: ${response.status} - ${errorText.substring(0, 500)}`);
            
            if (response.status === 401 || response.status === 403) {
                console.warn(`[${process.env.CLIENT_ID}_API_SYNC] Token might be invalid for fetching contacts. Clearing token to force re-login.`);
                apiToken = null;
            }
            
            // Check if response indicates HTML
            if (errorText.includes('<!DOCTYPE html>') || errorText.includes('<html')) {
                console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Get contacts response is HTML - likely wrong endpoint or server redirect.`);
                console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Check if the API_BASE_URL is correct: ${API_BASE_URL}`);
            }
            return;
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const responseText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Get contacts response is not JSON. Content-Type: ${contentType}`);
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Response: ${responseText.substring(0, 200)}...`);
            return;
        }

        const data = await response.json();
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Raw API contact data (first 500 chars): ${JSON.stringify(data).substring(0, 500)}...`);

        if (!data || !data.status || !Array.isArray(data.contacts)) {
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Invalid contacts API response structure. Expected 'status' and 'contacts' array. Received:`, JSON.stringify(data).substring(0, 200) + '...');
            return;
        }

        const contactsArray = data.contacts;
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Received ${contactsArray.length} contacts from API.`);
        let updatedUserPerms = 0;
        const apiUserJidsProcessed = new Set();

        for (const contact of contactsArray) {
            if (contact.mobile) {
                const jid = normalizePhoneNumberToJid(contact.mobile);
                apiUserJidsProcessed.add(jid);
                console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Processing contact: Mobile=${contact.mobile}, Normalized JID=${jid}, Active=${contact.active}`);

                if (contact.active === true) {
                    const addResult = addToWhitelist(jid);
                    if (addResult.success || addResult.reason === 'already_whitelisted') {
                        // --- NEW: Store contact_id and allowed_in_groups ---
                        if (!global.userGroupPermissions[jid]) {
                            global.userGroupPermissions[jid] = {}; // Ensure object exists
                        }
                        
                        let updated = false;
                        if (global.userGroupPermissions[jid].allowed_in_groups !== contact.allowed_in_groups) {
                            global.userGroupPermissions[jid].allowed_in_groups = contact.allowed_in_groups;
                            updated = true;
                            console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Updated group permission for ${jid} to ${contact.allowed_in_groups}`);
                        }
                        if (contact.contact_id !== undefined && global.userGroupPermissions[jid].contact_id !== contact.contact_id) { // Assuming your API sends contact.contact_id
                            global.userGroupPermissions[jid].contact_id = contact.contact_id;
                            updated = true;
                            console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Updated contact_id for ${jid} to ${contact.contact_id}`);
                        }
                        if (updated) updatedUserPerms++;

                    } else {
                        console.warn(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Failed to add active user ${jid} to general whitelist: ${addResult.reason}`);
                    }
                } else {
                    const removalResult = removeFromWhitelist(jid);
                    if (removalResult.success) {
                        console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${jid} inactive in API, removed.`);
                        // Also remove from userGroupPermissions if it exists
                        if (global.userGroupPermissions[jid]) {
                            delete global.userGroupPermissions[jid];
                            console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Removed ${jid} from userGroupPermissions as well.`);
                        }
                    } else if (removalResult.reason === 'not_whitelisted') {
                        console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${jid} inactive in API, but not found in bot's whitelist.`);
                    }
                }
            } else {
                console.warn(`[${process.env.CLIENT_ID}_API_SYNC_WARNING] API contact missing mobile number:`, contact);
            }
        }
        
        const currentBotWhitelistedUsers = [...global.whitelist.users];
        console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Checking for users to remove from bot's whitelist (not in API list). Current count: ${currentBotWhitelistedUsers.length}`);
        for (const botUserJid of currentBotWhitelistedUsers) {
            if (!apiUserJidsProcessed.has(botUserJid) && botUserJid.endsWith('@s.whatsapp.net')) {
                console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${botUserJid} found in bot's whitelist but not in API list. Removing.`);
                removeFromWhitelist(botUserJid);
                // Also remove from userGroupPermissions if it exists
                if (global.userGroupPermissions[botUserJid]) {
                    delete global.userGroupPermissions[botUserJid];
                    console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Removed ${botUserJid} from userGroupPermissions as it's no longer whitelisted.`);
                }
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
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error during whitelist sync:`, error.message);
        if (error.stack) {
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Stack trace:`, error.stack);
        }
    }
}

module.exports = { syncWhitelistFromApi, getApiToken: () => apiToken, stripCountryCode };