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

function normalizePhoneNumberToJid(mobileNumber) {
    if (!mobileNumber) return null; // Handle null or undefined input
    let cleanedNumber = mobileNumber.toString().replace(/\D/g, ''); // Ensure it's a string before replace
    
    if (!cleanedNumber.startsWith(config.DEFAULT_PHONE_COUNTRY_CODE) && !cleanedNumber.startsWith('00' + config.DEFAULT_PHONE_COUNTRY_CODE)) {
        // Avoid prepending if it's a full international number already starting with something else
        if (cleanedNumber.length > 10) { // Heuristic: if it's long, it might be full international
             // No change if it's likely a full international number not matching default code
        } else {
            cleanedNumber = config.DEFAULT_PHONE_COUNTRY_CODE + cleanedNumber;
        }
    }
    
    return formatJid(cleanedNumber);
}

function stripCountryCode(fullJid, countryCode) {
    if (!fullJid) return '';
    const numberPart = fullJid.split('@')[0];
    if (numberPart.startsWith(countryCode)) {
        return numberPart.substring(countryCode.length);
    }
    return numberPart;
}

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
            redirect: 'manual'
        });

        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Login API response status: ${response.status}`);
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Login API response headers:`, Object.fromEntries(response.headers.entries()));
        
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login endpoint redirected to: ${location}`);
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] This suggests the API endpoint URL might be incorrect.`);
            return null;
        }
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login failed: ${response.status} - ${errorText.substring(0, 500)}`);
            if (errorText.includes('<!DOCTYPE html>') || errorText.includes('<html')) {
                console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login response is HTML - likely wrong endpoint or server redirect. Check API_BASE_URL: ${API_BASE_URL}`);
            }
            return null;
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const responseText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login response is not JSON. Content-Type: ${contentType}. Response: ${responseText.substring(0, 200)}...`);
            return null;
        }

        const data = await response.json();
        if (data.token) {
            apiToken = data.token;
            console.log(`[${process.env.CLIENT_ID}_API_SYNC] Login successful, token obtained. Token Length: ${apiToken.length > 0 ? apiToken.length : '0'}`);
            return apiToken;
        }
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Login response missing token:`, JSON.stringify(data).substring(0, 200) + '...');
        return null;
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error during API login:`, error.message, error.stack);
        return null;
    }
}

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
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] API token already exists.`); // Can be noisy
    }

    if (!global.userGroupPermissions || typeof global.userGroupPermissions !== 'object') {
        console.warn(`[${process.env.CLIENT_ID}_API_SYNC_WARN] global.userGroupPermissions was not initialized as an object. Initializing now.`);
        global.userGroupPermissions = {}; 
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
            redirect: 'manual'
        });
        
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Get contacts API response status: ${response.status}`);
        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Get contacts API response headers:`, Object.fromEntries(response.headers.entries()));
        
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Get contacts endpoint redirected to: ${location}. This suggests the API endpoint URL might be incorrect or token is invalid.`);
            apiToken = null; // Force re-login next time
            return;
        }
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Fetch contacts failed: ${response.status} - ${errorText.substring(0, 500)}`);
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Full non-OK response body:`, errorText); // Uncomment for full error
            if (response.status === 401 || response.status === 403) {
                console.warn(`[${process.env.CLIENT_ID}_API_SYNC] Token might be invalid for fetching contacts. Clearing token.`);
                apiToken = null;
            }
            if (errorText.includes('<!DOCTYPE html>') || errorText.includes('<html')) {
                console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Get contacts response is HTML - likely wrong endpoint or server redirect. Check API_BASE_URL: ${API_BASE_URL}`);
            }
            return;
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const responseText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Get contacts response is not JSON. Content-Type: ${contentType}. Response: ${responseText.substring(0, 200)}...`);
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Full non-JSON response body:`, responseText); // Uncomment for full error
            return;
        }

        const data = await response.json();
        // For very detailed debugging:
        console.log(`[${process.env.CLIENT_ID}_API_SYNC_DEBUG] Full parsed API response for /get_contacts:`, JSON.stringify(data, null, 2));

        if (!data || typeof data.status === 'undefined' || !Array.isArray(data.contacts)) { // Check for status existence too
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
                if (!jid) {
                    console.warn(`[${process.env.CLIENT_ID}_API_SYNC_WARNING] Could not normalize mobile number ${contact.mobile} for contact:`, contact);
                    continue; // Skip this contact if JID normalization fails
                }
                apiUserJidsProcessed.add(jid);
                
                // Specific user debugging
                if (jid === '967733300785@s.whatsapp.net') {
                    console.log(`[API_SYNC_DEBUG_USER_TARGET] Processing target user ${jid}. API contact object:`, JSON.stringify(contact));
                    console.log(`[API_SYNC_DEBUG_USER_TARGET] Value of contact.id from API: ${contact.id}, Type: ${typeof contact.id}`);
                }

                if (contact.active === true) {
                    const addResult = addToWhitelist(jid);
                    if (addResult.success || addResult.reason === 'already_whitelisted') {
                        
                        if (!global.userGroupPermissions[jid] || typeof global.userGroupPermissions[jid] !== 'object') {
                            console.log(`[${process.env.CLIENT_ID}_API_SYNC_DEBUG] Initializing permissions object for ${jid} during sync loop.`);
                            global.userGroupPermissions[jid] = {};
                        }
                        
                        let updated = false;

                        if (global.userGroupPermissions[jid].allowed_in_groups !== contact.allowed_in_groups) {
                            global.userGroupPermissions[jid].allowed_in_groups = contact.allowed_in_groups;
                            updated = true;
                            console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Updated group permission for ${jid} to ${contact.allowed_in_groups}`);
                        }

                        if (contact.id !== undefined && contact.id !== null) { // Allow 0 if it's a valid ID
                            if (global.userGroupPermissions[jid].contact_id !== contact.id) {
                                global.userGroupPermissions[jid].contact_id = contact.id;
                                updated = true;
                                console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Updated contact_id for ${jid} to ${contact.id}.`);
                            }
                        } else {
                            console.warn(`[${process.env.CLIENT_ID}_API_SYNC_WARNING] API contact for ${jid} (Mobile: ${contact.mobile}) is missing 'id' property or it is null/undefined. API provided id: '${contact.id}'`);
                            if (global.userGroupPermissions[jid].contact_id !== undefined) {
                                delete global.userGroupPermissions[jid].contact_id;
                                updated = true;
                                console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Removed 'contact_id' for ${jid} as 'id' is missing or null/undefined from API response.`);
                            }
                        }
                        if (updated) updatedUserPerms++;
                    } else {
                        console.warn(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Failed to add active user ${jid} to general whitelist: ${addResult.reason}`);
                    }
                } else { // Contact not active
                    const removalResult = removeFromWhitelist(jid); // This also removes from userGroupPermissions (whitelist.js was updated)
                    if (removalResult.success) {
                        console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${jid} inactive in API, removed from whitelist and associated permissions.`);
                    } else if (removalResult.reason === 'not_whitelisted') {
                        console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${jid} inactive in API, but not found in bot's whitelist.`);
                    }
                    // Safeguard: ensure permissions are cleared if somehow missed by removeFromWhitelist
                    if (global.userGroupPermissions[jid]) {
                        delete global.userGroupPermissions[jid];
                        console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Ensured permissions for inactive user ${jid} are cleared.`);
                    }
                }
            } else {
                console.warn(`[${process.env.CLIENT_ID}_API_SYNC_WARNING] API contact missing mobile number:`, contact);
            }
        }
        
        const currentBotWhitelistedUsers = [...global.whitelist.users];
        for (const botUserJid of currentBotWhitelistedUsers) {
            if (!apiUserJidsProcessed.has(botUserJid) && botUserJid.endsWith('@s.whatsapp.net')) {
                console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] User ${botUserJid} found in bot's whitelist but not in API list. Removing.`);
                removeFromWhitelist(botUserJid); // This will also remove from userGroupPermissions
            }
        }

        console.log(`[${process.env.CLIENT_ID}_API_SYNC] Finished processing contacts. Updated permissions for ${updatedUserPerms} users.`);
        // For verification during debugging:
        // if (global.userGroupPermissions['967733300785@s.whatsapp.net']) {
        //     console.log(`[API_SYNC_DEBUG_USER_TARGET_END] Final state for 967733300785@s.whatsapp.net:`, JSON.stringify(global.userGroupPermissions['967733300785@s.whatsapp.net']));
        // }
        
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

module.exports = { syncWhitelistFromApi, getApiToken: () => apiToken, stripCountryCode, loginToApi };