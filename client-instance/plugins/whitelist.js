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
async function cacheLidToPhoneJid(lidJid, phoneJid) { // Removed displayName from parameters, we will fetch it.
    const botInstanceId = await getBotInstanceId();
    if (!botInstanceId) return;

    try {
        const { upsertBotContact, getContactByJid } = require('../../database/botContactsDb');

        // Step 1: Fetch the existing contact record for the LID to get its name.
        const lidContact = await getContactByJid(botInstanceId, lidJid);
        const displayName = lidContact?.display_name || phoneJid.split('@')[0]; // Use existing name or fallback to phone number part

        // Step 2: Now upsert the contact using the phoneJid as the primary key.
        // This will find the record by name (if it exists) or create a new one.
        await upsertBotContact(botInstanceId, phoneJid, displayName, displayName);

        // Step 3: Ensure the LID is associated with the updated record.
        // We find the record by its primary phone JID and update its lid_jid field.
        await db.query(
            'UPDATE bot_contacts SET lid_jid = $1 WHERE bot_instance_id = $2 AND user_jid = $3',
            [lidJid, botInstanceId, phoneJid]
        );

        console.log(`[WHITELIST] Cached LID resolution in bot_contacts: ${lidJid} -> ${phoneJid}`);
    } catch (error) {
        console.error('[WHITELIST] Error caching LID resolution in bot_contacts:', error);
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
