// client-instance/lib/apiSync.js
const fetch = require('node-fetch');
const db = require('../../database/db');
// const { formatJid } = require('../plugins/whitelist');
const config = require('../../config');
let process = require('process');
const API_BASE_URL = process.env.API_BASE_URL;
const API_LOGIN_ENDPOINT = `${API_BASE_URL}/login`;
const API_GET_CONTACTS_ENDPOINT = `${API_BASE_URL}/get_contacts`;

const CLIENT_API_USERNAME = process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC;
const CLIENT_API_PASSWORD = process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC;

let apiToken = null;
function stripCountryCode(fullJid, countryCode) {
    if (!fullJid) return '';
    const numberPart = fullJid.split('@')[0];
    if (numberPart.startsWith(countryCode)) {
        return numberPart.substring(countryCode.length);
    }
    return numberPart;
}

function formatJid(number) {
    if (!number) return null;
    const cleaned = number.toString().replace(/[^0-9]/g, '');
    if (cleaned.includes('@')) return cleaned;
    return cleaned + '@s.whatsapp.net';
}

function normalizePhoneNumberToJid(mobileNumber) {
    if (!mobileNumber) return null;
    let cleanedNumber = mobileNumber.toString().replace(/\D/g, '');
    
    if (!cleanedNumber.startsWith(config.DEFAULT_PHONE_COUNTRY_CODE) && !cleanedNumber.startsWith('00' + config.DEFAULT_PHONE_COUNTRY_CODE)) {
        if (cleanedNumber.length > 10) {
            // No change if it's likely a full international number not matching default code
        } else {
            cleanedNumber = config.DEFAULT_PHONE_COUNTRY_CODE + cleanedNumber;
        }
    }
    
    return formatJid(cleanedNumber);
}

async function getBotInstanceId() {
    //console.log(`[API_SYNC_CRITICAL_DEBUG] In getBotInstanceId - process.env.CLIENT_ID value is: '${process.env.CLIENT_ID}' (Type: ${typeof process.env.CLIENT_ID})`); // CRITICAL LOG
    if (!process.env.CLIENT_ID || typeof process.env.CLIENT_ID !== 'string' || process.env.CLIENT_ID.trim() === '') {
        console.error(`[API_SYNC_CRITICAL_ERROR] process.env.CLIENT_ID is invalid or not set when getBotInstanceId is called!`);
        return null; // Early exit if CLIENT_ID is bad
    }
    try {
        const result = await db.query(
            'SELECT id FROM bot_instances WHERE client_id = $1',
            [process.env.CLIENT_ID]
        );
        if (result.rows.length > 0) {
            //console.log(`[API_SYNC_DEBUG] Found bot_instance_id: ${result.rows[0]?.id} for CLIENT_ID: ${process.env.CLIENT_ID}`);
            return result.rows[0]?.id;
        } else {
            console.error(`[API_SYNC_ERROR] No bot_instance_id found in DB for CLIENT_ID: ${process.env.CLIENT_ID}. Query was: SELECT id FROM bot_instances WHERE client_id = '${process.env.CLIENT_ID}'`); // Log the actual query
            return null;
        }
    } catch (dbError) {
        console.error(`[API_SYNC_DB_ERROR] Error querying for bot_instance_id for ${process.env.CLIENT_ID}: ${dbError.message}`/* , dbError.stack */);
        return null;
    }
}
// let process = require('process');
// Global state to track failed credential attempts per client
const credentialFailureCache = new Map();

async function loginToApi() {
    const MAX_ATTEMPTS = 3;
    const CLIENT_ID = process.env.CLIENT_ID;
    
    //console.log(`[${CLIENT_ID}_API_SYNC] Attempting login to external API...`);
    //console.log(`[${CLIENT_ID}_API_SYNC] Using username: ${CLIENT_API_USERNAME ? CLIENT_API_USERNAME.substring(0, 3) + '***' : 'N/A'}`);
    
    if (!CLIENT_API_USERNAME || !CLIENT_API_PASSWORD) {
        console.error(`[${CLIENT_ID}_API_SYNC_ERROR] API username or password not set for this client instance. Skipping API login.`);
        return null;
    }

    // Check if credentials have already been marked as invalid
    const cacheKey = `${CLIENT_ID}_${CLIENT_API_USERNAME}`;
    const cachedFailure = credentialFailureCache.get(cacheKey);
    if (cachedFailure && Date.now() - cachedFailure.timestamp < 300000) { // 5 minutes cache
        // console.error(`[${CLIENT_ID}_API_SYNC_ERROR] Credentials previously failed. Skipping login attempts for ${Math.ceil((300000 - (Date.now() - cachedFailure.timestamp)) / 60000)} more minutes.`);
        return null;
    }

    let attempts = 0;
    
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        console.log(`[${CLIENT_ID}_API_SYNC] Login attempt ${attempts}/${MAX_ATTEMPTS}`);

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
                redirect: 'manual',
                timeout: 10000 // 10 second timeout
            });

            //console.log(`[${CLIENT_ID}_API_SYNC] Login API response status: ${response.status}`);
            
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                console.error(`[${CLIENT_ID}_API_SYNC_ERROR] Login endpoint redirected to: ${location}`);
                console.error(`[${CLIENT_ID}_API_SYNC_ERROR] This suggests the API endpoint URL might be incorrect.`);
                return null;
            }
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[${CLIENT_ID}_API_SYNC_ERROR] Login failed (attempt ${attempts}): ${response.status} - ${errorText.substring(0, 500)}`);
                
                // Enhanced credential error detection
                const isCredentialError = response.status === 401 || 
                                        response.status === 403 || 
                                        response.status === 422 ||
                                        errorText.toLowerCase().includes('credentials are incorrect') ||
                                        errorText.toLowerCase().includes('provided credentials are incorrect') ||
                                        errorText.toLowerCase().includes('invalid credentials') ||
                                        errorText.toLowerCase().includes('unauthorized') ||
                                        errorText.toLowerCase().includes('authentication failed') ||
                                        errorText.toLowerCase().includes('invalid username') ||
                                        errorText.toLowerCase().includes('invalid password') ||
                                        errorText.toLowerCase().includes('login failed') ||
                                        errorText.toLowerCase().includes('wrong username') ||
                                        errorText.toLowerCase().includes('wrong password');
                
                if (isCredentialError) {
                    console.error(`[${CLIENT_ID}_API_SYNC_ERROR] Credentials detected as incorrect (Status: ${response.status}). Caching failure and stopping all retry attempts.`);
                    
                    // Cache the credential failure to prevent future attempts
                    credentialFailureCache.set(cacheKey, { 
                        timestamp: Date.now(), 
                        status: response.status,
                        message: errorText.substring(0, 200)
                    });
                    
                    return null;
                }
                
                if (errorText.includes('<!DOCTYPE html>') || errorText.includes('<html')) {
                    console.error(`[${CLIENT_ID}_API_SYNC_ERROR] Login response is HTML - likely wrong endpoint or server redirect. Check API_BASE_URL: ${API_BASE_URL}`);
                    return null;
                }
                
                // For non-credential errors, retry with exponential backoff
                if (attempts < MAX_ATTEMPTS) {
                    const backoffDelay = Math.min(2000 * Math.pow(2, attempts - 1), 10000); // 2s, 4s, 8s max
                    console.log(`[${CLIENT_ID}_API_SYNC] Retrying in ${backoffDelay/1000} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                    continue;
                }
                
                return null;
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const responseText = await response.text();
                console.error(`[${CLIENT_ID}_API_SYNC_ERROR] Login response is not JSON. Content-Type: ${contentType}. Response: ${responseText.substring(0, 200)}...`);
                
                // For non-JSON responses, retry with backoff
                if (attempts < MAX_ATTEMPTS) {
                    const backoffDelay = Math.min(2000 * Math.pow(2, attempts - 1), 10000);
                    console.log(`[${CLIENT_ID}_API_SYNC] Retrying in ${backoffDelay/1000} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                    continue;
                }
                
                return null;
            }

            const data = await response.json();
            if (data.token) {
                apiToken = data.token;
                console.log(`[${CLIENT_ID}_API_SYNC] Login successful on attempt ${attempts}, token obtained. Token Length: ${apiToken.length > 0 ? apiToken.length : '0'}`);
                
                // Clear any cached failures on successful login
                credentialFailureCache.delete(cacheKey);
                
                return apiToken;
            }
            
            console.error(`[${CLIENT_ID}_API_SYNC_ERROR] Login response missing token (attempt ${attempts}):`, JSON.stringify(data).substring(0, 200) + '...');
            
            // For missing token, retry with backoff
            if (attempts < MAX_ATTEMPTS) {
                const backoffDelay = Math.min(2000 * Math.pow(2, attempts - 1), 10000);
                console.log(`[${CLIENT_ID}_API_SYNC] Retrying in ${backoffDelay/1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
                continue;
            }
            
            return null;
            
        } catch (error) {
            console.error(`[${CLIENT_ID}_API_SYNC_ERROR] Error during API login (attempt ${attempts}):`, error.message);
            
            // For network errors, retry with backoff
            if (attempts < MAX_ATTEMPTS) {
                const backoffDelay = Math.min(2000 * Math.pow(2, attempts - 1), 10000);
                console.log(`[${CLIENT_ID}_API_SYNC] Network error, retrying in ${backoffDelay/1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
                continue;
            }
            
            console.error(`[${CLIENT_ID}_API_SYNC_ERROR] All ${MAX_ATTEMPTS} login attempts failed. Final error:`, error.stack);
            return null;
        }
    }
    
    console.error(`[${CLIENT_ID}_API_SYNC_ERROR] All ${MAX_ATTEMPTS} login attempts exhausted.`);
    return null;
}

// Optional: Function to clear credential failure cache manually
// function clearCredentialFailureCache(clientId = null, username = null) {
//     if (clientId && username) {
//         const cacheKey = `${clientId}_${username}`;
//         credentialFailureCache.delete(cacheKey);
//         console.log(`[${clientId}_API_SYNC] Cleared credential failure cache for ${username}`);
//     } else {
//         credentialFailureCache.clear();
//         console.log(`[API_SYNC] Cleared all credential failure cache entries`);
//     }
// }

async function syncWhitelistFromApi() {
    //console.log(`[${process.env.CLIENT_ID}_API_SYNC] Starting whitelist sync...`);
    
    if (!CLIENT_API_USERNAME || !CLIENT_API_PASSWORD) {
        //console.log(`[${process.env.CLIENT_ID}_API_SYNC] Client API credentials not set. Skipping sync.`);
        return;
    }

    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC] Bot instance not found in database`);
        return;
    }

    // Check if credentials have been marked as failed (same logic as loginToApi)
    const CLIENT_ID = process.env.CLIENT_ID;
    const cacheKey = `${CLIENT_ID}_${CLIENT_API_USERNAME}`;
    const cachedFailure = credentialFailureCache.get(cacheKey);
    if (cachedFailure && Date.now() - cachedFailure.timestamp < 300000) { // 5 minutes cache
        // console.error(`[${CLIENT_ID}_API_SYNC_ERROR] Credentials previously failed. Skipping login attempts for ${Math.ceil((300000 - (Date.now() - cachedFailure.timestamp)) / 60000)} more minutes.`);
        return;
    }

    // Log sync start
    const syncLogResult = await db.query(
        `INSERT INTO api_sync_log (bot_instance_id, sync_type, sync_status) 
         VALUES ($1, 'contacts', 'started') RETURNING id`,
        [botInstanceId]
    );
    const syncLogId = syncLogResult.rows[0].id;

    try {
        // Login if no token
        if (!apiToken) {
            //console.log(`[${process.env.CLIENT_ID}_API_SYNC] No token available for sync, attempting login first.`);
            const loginResult = await loginToApi();
            if (!loginResult) {
                throw new Error('Login failed, aborting sync.');
            }
        }

        // Fetch contacts from API
        //console.log(`[${process.env.CLIENT_ID}_API_SYNC] Fetching contacts from API endpoint: ${API_GET_CONTACTS_ENDPOINT}`);
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
        
        //console.log(`[${process.env.CLIENT_ID}_API_SYNC] Get contacts API response status: ${response.status}`);
        
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Get contacts endpoint redirected to: ${location}. This suggests the API endpoint URL might be incorrect or token is invalid.`);
            apiToken = null; // Force re-login next time
            throw new Error(`API redirected to ${location}`);
        }
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Fetch contacts failed: ${response.status} - ${errorText.substring(0, 500)}`);
            if (response.status === 401 || response.status === 403) {
                console.warn(`[${process.env.CLIENT_ID}_API_SYNC] Token might be invalid for fetching contacts. Clearing token.`);
                apiToken = null;
            }
            throw new Error(`API returned ${response.status}: ${errorText.substring(0, 100)}`);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const responseText = await response.text();
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Get contacts response is not JSON. Content-Type: ${contentType}. Response: ${responseText.substring(0, 200)}...`);
            throw new Error('API response is not JSON');
        }

        const data = await response.json();
        //console.log(`[${process.env.CLIENT_ID}_API_SYNC_DEBUG] API response structure - status: ${data.status}, contacts is array: ${Array.isArray(data.contacts)}, contacts length: ${data.contacts?.length || 0}`);

        if (!data || typeof data.status === 'undefined' || !Array.isArray(data.contacts)) {
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Invalid contacts API response structure. Expected 'status' and 'contacts' array. Received:`, JSON.stringify(data).substring(0, 200) + '...');
            throw new Error('Invalid API response structure');
        }

        const contactsArray = data.contacts;
        //console.log(`[${process.env.CLIENT_ID}_API_SYNC] Received ${contactsArray.length} contacts from API.`);
        
        let stats = {
            fetched: contactsArray.length,
            added: 0,
            updated: 0,
            removed: 0
        };

        // Begin transaction
        await db.query('BEGIN');

        // Process contacts from API
        const apiUserJids = new Set();
        
        for (const contact of contactsArray) {
            if (contact.mobile) {
                const jid = normalizePhoneNumberToJid(contact.mobile);
                if (!jid) {
                    console.warn(`[${process.env.CLIENT_ID}_API_SYNC_WARNING] Could not normalize mobile number ${contact.mobile} for contact:`, contact);
                    continue;
                }
                
                apiUserJids.add(jid);
                
                // Debug specific user
                if (jid === '967733300785@s.whatsapp.net') {
                    //console.log(`[API_SYNC_DEBUG_USER_TARGET] Processing target user ${jid}. API contact object:`, JSON.stringify(contact));
                    //console.log(`[API_SYNC_DEBUG_USER_TARGET] Value of contact.id from API: ${contact.id}, Type: ${typeof contact.id}`);
                }
                
                if (contact.active === true) {
                    // Upsert user in database
                    const result = await db.query(`
                        INSERT INTO whitelisted_users 
                        (bot_instance_id, user_jid, phone_number, api_contact_id, 
                         api_mobile, api_active, allowed_in_groups, is_synced, last_api_sync)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, true, CURRENT_TIMESTAMP)
                        ON CONFLICT (bot_instance_id, user_jid) 
                        DO UPDATE SET 
                            api_contact_id = $4,
                            api_mobile = $5,
                            api_active = $6,
                            allowed_in_groups = $7,
                            is_synced = true,
                            last_api_sync = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        RETURNING (xmax = 0) as inserted
                    `, [
                        botInstanceId,
                        jid,
                        contact.mobile,
                        contact.id || null, // Ensure null if undefined
                        contact.mobile,
                        true,
                        contact.allowed_in_groups || false
                    ]);
                    
                    if (result.rows[0].inserted) {
                        stats.added++;
                        //console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Added new user ${jid} to whitelist`);
                    } else {
                        stats.updated++;
                        //console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Updated existing user ${jid} in whitelist`);
                    }
                } else {
                    // Contact is not active in API, ensure it's marked as inactive in DB
                    const removalResult = await db.query(`
                        UPDATE whitelisted_users 
                        SET api_active = false, is_synced = true, last_api_sync = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                        WHERE bot_instance_id = $1 AND user_jid = $2
                        RETURNING user_jid
                    `, [botInstanceId, jid]);
                    
                    if (removalResult.rowCount > 0) {
                        //console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Marked user ${jid} as inactive (not active in API)`);
                    }
                }
            } else {
                console.warn(`[${process.env.CLIENT_ID}_API_SYNC_WARNING] API contact missing mobile number:`, contact);
            }
        }
        
        // Remove users not in API (mark as inactive)
        const removedResult = await db.query(`
            UPDATE whitelisted_users 
            SET api_active = false, is_synced = false, updated_at = CURRENT_TIMESTAMP
            WHERE bot_instance_id = $1 
            AND user_jid NOT IN (SELECT unnest($2::text[]))
            AND api_active = true
            RETURNING user_jid
        `, [botInstanceId, Array.from(apiUserJids)]);
        
        stats.removed = removedResult.rowCount;
        
        if (stats.removed > 0) {
            //console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Marked ${stats.removed} users as inactive (not found in API)`);
            removedResult.rows.forEach(row => {
                console.log(`[${process.env.CLIENT_ID}_API_SYNC_DETAIL] Removed user: ${row.user_jid}`);
            });
        }

        // Commit transaction
        await db.query('COMMIT');

        // Update sync log with success
        await db.query(`
            UPDATE api_sync_log 
            SET sync_status = 'completed',
                contacts_fetched = $2,
                contacts_added = $3,
                contacts_updated = $4,
                contacts_removed = $5,
                completed_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [syncLogId, stats.fetched, stats.added, stats.updated, stats.removed]);

        //console.log(`[${process.env.CLIENT_ID}_API_SYNC] Sync completed successfully. Added: ${stats.added}, Updated: ${stats.updated}, Removed: ${stats.removed}`);

        // Update global whitelist cache if it exists
        if (global.whitelist) {
            //console.log(`[${process.env.CLIENT_ID}_API_SYNC] Updating in-memory whitelist cache...`);
            const activeUsersResult = await db.query(
                'SELECT user_jid FROM whitelisted_users WHERE bot_instance_id = $1 AND api_active = true',
                [botInstanceId]
            );
            global.whitelist.users = new Set(activeUsersResult.rows.map(r => r.user_jid));
            //console.log(`[${process.env.CLIENT_ID}_API_SYNC] In-memory cache updated with ${global.whitelist.users.size} active users`);
        }

    } catch (error) {
        // Rollback transaction on error
        await db.query('ROLLBACK');
        
        // Log error in sync log
        await db.query(`
            UPDATE api_sync_log 
            SET sync_status = 'failed',
                error_message = $2,
                completed_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [syncLogId, error.message]);

        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error during whitelist sync:`, error.message);
        if (error.stack) {
            console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Stack trace:`, error.stack);
        }
    }
}
// Helper function to check if user is whitelisted in database
async function isWhitelistedInDb(jid, botInstanceId) {
    if (!botInstanceId) {
        botInstanceId = await getBotInstanceId();
        if (!botInstanceId) return false;
    }
    
    const result = await db.query(
        `SELECT EXISTS(
            SELECT 1 FROM whitelisted_users 
            WHERE bot_instance_id = $1 AND user_jid = $2 AND api_active = true
            UNION
            SELECT 1 FROM whitelisted_groups 
            WHERE bot_instance_id = $1 AND group_jid = $2 AND is_active = true
        ) as is_whitelisted`,
        [botInstanceId, jid]
    );
    return result.rows[0]?.is_whitelisted || false;
}

// Helper function to get user permissions from database
async function getUserPermissionsFromDb(jid, botInstanceId) {
    if (!botInstanceId) {
        botInstanceId = await getBotInstanceId();
        if (!botInstanceId) return null;
    }
    
    const result = await db.query(
        `SELECT allowed_in_groups, api_contact_id, display_name
         FROM whitelisted_users
         WHERE bot_instance_id = $1 AND user_jid = $2 AND api_active = true`,
        [botInstanceId, jid]
    );
    
    if (result.rows.length > 0) {
        return {
            allowed_in_groups: result.rows[0].allowed_in_groups,
            contact_id: result.rows[0].api_contact_id,
            display_name: result.rows[0].display_name
        };
    }
    return null;
}

// Function to manually update a user's whitelist status
async function updateUserWhitelistStatus(jid, isActive, allowedInGroups = null) {
    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC] Cannot update whitelist status - bot instance not found`);
        return false;
    }
    
    try {
        const result = await db.query(`
            UPDATE whitelisted_users 
            SET api_active = $3,
                allowed_in_groups = COALESCE($4, allowed_in_groups),
                updated_at = CURRENT_TIMESTAMP
            WHERE bot_instance_id = $1 AND user_jid = $2
            RETURNING user_jid
        `, [botInstanceId, jid, isActive, allowedInGroups]);
        
        if (result.rowCount > 0) {
            //console.log(`[${process.env.CLIENT_ID}_API_SYNC] Updated whitelist status for ${jid}: active=${isActive}, allowed_in_groups=${allowedInGroups}`);
            return true;
        } else {
            //console.log(`[${process.env.CLIENT_ID}_API_SYNC] User ${jid} not found in whitelist`);
            return false;
        }
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error updating whitelist status:`, error);
        return false;
    }
}

// Function to get sync statistics
async function getSyncStatistics() {
    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) return null;
    
    try {
        const result = await db.query(`
            SELECT 
                COUNT(*) FILTER (WHERE sync_status = 'completed') as successful_syncs,
                COUNT(*) FILTER (WHERE sync_status = 'failed') as failed_syncs,
                MAX(completed_at) FILTER (WHERE sync_status = 'completed') as last_successful_sync,
                SUM(contacts_fetched) FILTER (WHERE sync_status = 'completed') as total_contacts_fetched,
                SUM(contacts_added) FILTER (WHERE sync_status = 'completed') as total_contacts_added,
                SUM(contacts_updated) FILTER (WHERE sync_status = 'completed') as total_contacts_updated,
                SUM(contacts_removed) FILTER (WHERE sync_status = 'completed') as total_contacts_removed
            FROM api_sync_log
            WHERE bot_instance_id = $1
        `, [botInstanceId]);
        
        return result.rows[0];
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error getting sync statistics:`, error);
        return null;
    }
}

// Function to clean up old sync logs
async function cleanupOldSyncLogs(daysToKeep = 30) {
    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) return;
    
    try {
        const result = await db.query(`
            DELETE FROM api_sync_log 
            WHERE bot_instance_id = $1 
            AND started_at < CURRENT_TIMESTAMP - INTERVAL '1 day' * $2
            RETURNING id
        `, [botInstanceId, daysToKeep]);
        
        if (result.rowCount > 0) {
            //console.log(`[${process.env.CLIENT_ID}_API_SYNC] Cleaned up ${result.rowCount} old sync log entries`);
        }
    } catch (error) {
        console.error(`[${process.env.CLIENT_ID}_API_SYNC_ERROR] Error cleaning up old sync logs:`, error);
    }
}

// Export all functions
module.exports = { 
    syncWhitelistFromApi, 
    isWhitelistedInDb, 
    stripCountryCode,
    getBotInstanceId,
    getUserPermissionsFromDb,
    updateUserWhitelistStatus,
    getSyncStatistics,
    cleanupOldSyncLogs,
    getApiToken: () => apiToken,
    loginToApi
};