// client-instance/plugins/whitelist.js
const db = require('../../database/db');
const { getBotInstanceId } = require('../lib/apiSync');

// Cache for performance
let whitelistCache = {
    users: new Set(),
    groups: new Set(),
    lastLoaded: 0,
    cacheTimeout: 60000 // 1 minute
};

async function loadWhitelistFromDb() {
    const now = Date.now();
    if (whitelistCache.lastLoaded && (now - whitelistCache.lastLoaded) < whitelistCache.cacheTimeout) {
        return; // Use cache
    }

    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) {
        console.error('[WHITELIST] No bot instance ID found');
        return;
    }

    try {
        // Load users
        const usersResult = await db.query(
            'SELECT user_jid FROM whitelisted_users WHERE bot_instance_id = $1 AND api_active = true',
            [botInstanceId]
        );
        whitelistCache.users = new Set(usersResult.rows.map(r => r.user_jid));

        // Load groups
        const groupsResult = await db.query(
            'SELECT group_jid FROM whitelisted_groups WHERE bot_instance_id = $1 AND is_active = true',
            [botInstanceId]
        );
        whitelistCache.groups = new Set(groupsResult.rows.map(r => r.group_jid));

        whitelistCache.lastLoaded = now;
        console.log(`[WHITELIST] Loaded ${whitelistCache.users.size} users and ${whitelistCache.groups.size} groups from database`);
    } catch (error) {
        console.error('[WHITELIST] Error loading from database:', error);
    }
}

async function isWhitelisted(jid) {
    await loadWhitelistFromDb();
    return whitelistCache.users.has(jid) || whitelistCache.groups.has(jid);
}

async function addToWhitelist(jid) {
    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) {
        return { success: false, reason: 'no_bot_instance' };
    }

    try {
        const isGroup = jid.endsWith('@g.us');

        if (isGroup) {
            await db.query(`
                INSERT INTO whitelisted_groups (bot_instance_id, group_jid)
                VALUES ($1, $2)
                ON CONFLICT (bot_instance_id, group_jid) 
                DO UPDATE SET is_active = true, updated_at = CURRENT_TIMESTAMP
            `, [botInstanceId, jid]);
            whitelistCache.groups.add(jid);
        } else {
            await db.query(`
                INSERT INTO whitelisted_users (bot_instance_id, user_jid, phone_number)
                VALUES ($1, $2, $3)
                ON CONFLICT (bot_instance_id, user_jid) 
                DO UPDATE SET api_active = true, updated_at = CURRENT_TIMESTAMP
            `, [botInstanceId, jid, jid.split('@')[0]]);
            whitelistCache.users.add(jid);
        }
        // --- ADD THIS LINE ---
        whitelistCache.lastLoaded = 0; // Invalidate cache to force a DB reload on next check.

        return { success: true };
    } catch (error) {
        console.error('[WHITELIST] Error adding to whitelist:', error);
        return { success: false, reason: error.message };
    }
}

async function removeFromWhitelist(jid) {
    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) {
        return { success: false, reason: 'no_bot_instance' };
    }

    try {
        const isGroup = jid.endsWith('@g.us');

        if (isGroup) {
            await db.query(`
                UPDATE whitelisted_groups 
                SET is_active = false, updated_at = CURRENT_TIMESTAMP
                WHERE bot_instance_id = $1 AND group_jid = $2
            `, [botInstanceId, jid]);
            whitelistCache.groups.delete(jid);
        } else {
            await db.query(`
                UPDATE whitelisted_users 
                SET api_active = false, updated_at = CURRENT_TIMESTAMP
                WHERE bot_instance_id = $1 AND user_jid = $2
            `, [botInstanceId, jid]);
            whitelistCache.users.delete(jid);
        }

        // --- ADD THIS LINE ---
        whitelistCache.lastLoaded = 0; // Invalidate cache to force a DB reload on next check.

        return { success: true };
    } catch (error) {
        console.error('[WHITELIST] Error removing from whitelist:', error);
        return { success: false, reason: error.message };
    }
}

// LID resolution functions using database// This function now looks in bot_contacts
async function getLidToPhoneJidFromCache(lidJid) {
    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) return null;

    try {
        const result = await db.query(
            'SELECT user_jid FROM bot_contacts WHERE bot_instance_id = $1 AND lid_jid = $2 AND user_jid IS NOT NULL',
            [botInstanceId, lidJid]
        );
        return result.rows[0]?.user_jid || null;
    } catch (error) {
        console.error('[WHITELIST] Error getting LID resolution from bot_contacts:', error);
        return null;
    }
}

// client-instance/plugins/whitelist.js

// This file should already have `const db = require('../../database/db');` at the top.
// If not, please add it.

// Find the existing cacheLidToPhoneJid function and REPLACE IT with this code:

/**
 * Persists a manually resolved LID-to-PhoneJID mapping with enhanced logic.
 * It first checks if a contact record already exists for either JID. If so, it merges
 * the JIDs into that single record. If not, it only updates the dedicated
 * lid_resolutions cache to avoid creating nameless contacts.
 *
 * @param {string} lidJid The LID JID (e.g., '...@lid').
 * @param {string} phoneJid The resolved phone number JID (e.g., '...@s.whatsapp.net').
 * @returns {Promise<{success: boolean, reason: string|null}>}
 */
async function cacheLidToPhoneJid(lidJid, phoneJid) {
    console.log(`[WHITELIST_CACHE_LID] Starting smart resolution for: ${lidJid} -> ${phoneJid}`);

    if (!lidJid || !lidJid.endsWith('@lid') || !phoneJid || !phoneJid.endsWith('@s.whatsapp.net')) {
        const reason = "Invalid JID format for LID resolution.";
        console.error(`[WHITELIST_CACHE_LID_ERROR] ${reason}`);
        return { success: false, reason: reason };
    }

    try {
        const botInstanceId = await require('../lib/apiSync').getBotInstanceId();
        if (!botInstanceId) {
            const reason = "Could not get bot instance ID for LID resolution.";
            console.error(`[WHITELIST_CACHE_LID_ERROR] ${reason}`);
            return { success: false, reason: reason };
        }

        // Step 1: Check if a contact record exists for either the LID or the Phone JID.
        const findQuery = `
            SELECT id FROM bot_contacts
            WHERE bot_instance_id = $1 AND (lid_jid = $2 OR user_jid = $3) AND (user_jid IS NULL OR lid_jid IS NULL)
            LIMIT 1;
        `;
        const findResult = await db.query(findQuery, [botInstanceId, lidJid, phoneJid]);

        // Step 2: If a record was found, update it to merge the JIDs.
        if (findResult.rows.length > 0) {
            const existingContactId = findResult.rows[0].id;
            console.log(`[WHITELIST_CACHE_LID] Found existing contact (ID: ${existingContactId}). Merging JIDs into bot_contacts.`);
            
            const updateQuery = `
                UPDATE bot_contacts
                SET
                    user_jid = $1,      -- Set the resolved phone JID
                    lid_jid = $2,       -- Set the resolved LID JID
                    synced_at = CURRENT_TIMESTAMP
                WHERE id = $3;
            `;
            // We use the passed-in phoneJid and lidJid to ensure the record is complete.
            await db.query(updateQuery, [phoneJid, lidJid, existingContactId]);
            console.log(`[WHITELIST_CACHE_LID] Successfully merged JIDs for contact ID ${existingContactId}.`);

        } else {
            // Step 2b: If no contact exists, we do NOT create one. We log this decision.
            console.log(`[WHITELIST_CACHE_LID] No existing contact found in bot_contacts. Will only update resolution cache.`);
        }

        // Step 3: ALWAYS update the dedicated lid_resolutions table.
        // This ensures the mapping is available for immediate use by the whitelist filter,
        // regardless of whether a full contact record existed.
        const lidResolutionQuery = `
            INSERT INTO lid_resolutions (bot_instance_id, lid_jid, resolved_phone_jid)
            VALUES ($1, $2, $3)
            ON CONFLICT (bot_instance_id, lid_jid)
            DO UPDATE SET
                resolved_phone_jid = EXCLUDED.resolved_phone_jid,
                resolved_at = CURRENT_TIMESTAMP;
        `;
        await db.query(lidResolutionQuery, [botInstanceId, lidJid, phoneJid]);
        
        console.log(`[WHITELIST_CACHE_LID] Smart resolution process complete. lid_resolutions table is up-to-date.`);
        return { success: true, reason: null };

    } catch (error) {
        console.error(`[WHITELIST_CACHE_LID_ERROR] Database error during smart LID resolution: ${error.message}`, error.stack);
        return { success: false, reason: error.message };
    }
}
// Update these functions to use database
async function getPendingLidIdentifications() {
    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) return new Map();

    try {
        const result = await db.query(
            'SELECT lid_jid, requested_at FROM pending_lid_identifications WHERE bot_instance_id = $1',
            [botInstanceId]
        );

        const map = new Map();
        result.rows.forEach(row => {
            map.set(row.lid_jid, new Date(row.requested_at).getTime());
        });
        return map;
    } catch (error) {
        console.error('[WHITELIST] Error getting pending LID identifications:', error);
        return new Map();
    }
}

async function getAskedLidsCache() {
    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) return new Map();

    try {
        const result = await db.query(
            'SELECT lid_jid, asked_at FROM asked_lids_cache WHERE bot_instance_id = $1',
            [botInstanceId]
        );

        const map = new Map();
        result.rows.forEach(row => {
            map.set(row.lid_jid, new Date(row.asked_at).getTime());
        });
        return map;
    } catch (error) {
        console.error('[WHITELIST] Error getting asked LIDs cache:', error);
        return new Map();
    }
}

async function savePendingIdsFile() {
    // No longer needed - database handles persistence
    return true;
}

async function saveAskedLidsFile() {
    // No longer needed - database handles persistence
    return true;
}

// Export the functions
module.exports = {
    isWhitelisted,
    addToWhitelist,
    removeFromWhitelist,
    getLidToPhoneJidFromCache,
    cacheLidToPhoneJid,
    getPendingLidIdentifications,
    getAskedLidsCache,
    savePendingIdsFile,
    saveAskedLidsFile,
    formatJid: (number) => {
        if (!number) return null;
        const cleaned = number.toString().replace(/[^0-9]/g, '');
        if (cleaned.includes('@')) return cleaned;
        return cleaned + '@s.whatsapp.net';
    }
};
