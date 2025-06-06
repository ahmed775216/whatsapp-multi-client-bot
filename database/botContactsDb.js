// database/botContactsDb.js
const db = require('./db'); // Assuming db.js exports pool.query
const { getBotInstanceId } = require('../client-instance/lib/apiSync'); // Get bot instance ID from client-instance context
const { UPSERT_CONTACT, DELETE_STALE_CONTACTS_FOR_INSTANCE, GET_CONTACT_BY_JID } = require('./queries'); // Import new queries
let process = require('process');
async function getClientBotInstanceId(clientId = process.env.CLIENT_ID) {
    // We explicitly pass CLIENT_ID from process.env because this module
    // might be used from client-instance context.
    const result = await db.query(
        'SELECT id FROM bot_instances WHERE client_id = $1',
        [clientId]
    );
    return result.rows[0]?.id;
}

async function upsertBotContact(botInstanceId, contactJid, phoneNumber, displayName, whatsappName, isWhatsappContact = true, isSavedContact = true) {
    if (!botInstanceId) {
        console.error("[BOT_CONTACTS_DB] Missing botInstanceId for upserting contact.");
        return;
    }
    if (!contactJid) {
        console.warn("[BOT_CONTACTS_DB] Missing contactJid for upserting contact. Skipping.");
        return;
    }

    try {
        await db.query(UPSERT_CONTACT, [
            botInstanceId,
            contactJid,
            phoneNumber,
            displayName,
            whatsappName,
            isWhatsappContact,
            isSavedContact
        ]);
        // console.log(`[BOT_CONTACTS_DB] Upserted contact ${contactJid} for bot ${botInstanceId}`); // Can be noisy
    } catch (error) {
        console.error(`[BOT_CONTACTS_DB_ERROR] Failed to upsert contact ${contactJid} for bot ${botInstanceId}: ${error.message}`, error.stack);
    }
}

async function deleteStaleContactsForInstance(botInstanceId, currentContactJids) {
    if (!botInstanceId || !Array.isArray(currentContactJids)) {
        console.error("[BOT_CONTACTS_DB] Invalid arguments for deleting stale contacts.");
        return;
    }
    if (currentContactJids.length === 0) { // If no contacts provided, assume all should be marked stale
        console.warn(`[BOT_CONTACTS_DB] No current contact JIDs provided for instance ${botInstanceId}. Will mark all as potentially stale.`);
        // Or handle based on specific needs - perhaps delete if none from Baileys
    }

    try {
        const result = await db.query(DELETE_STALE_CONTACTS_FOR_INSTANCE, [
            botInstanceId,
            currentContactJids // PostgreSQL can work with array parameters
        ]);
        if (result.rowCount > 0) {
            console.log(`[BOT_CONTACTS_DB] Marked ${result.rowCount} stale contacts as inactive for bot ${botInstanceId}.`);
        }
    } catch (error) {
        console.error(`[BOT_CONTACTS_DB_ERROR] Failed to delete stale contacts for bot ${botInstanceId}: ${error.message}`, error.stack);
    }
}

async function getContactByJid(botInstanceId, contactJid) {
    if (!botInstanceId || !contactJid) return null;
    try {
        const result = await db.query(GET_CONTACT_BY_JID, [botInstanceId, contactJid]);
        return result.rows[0] || null;
    } catch (error) {
        console.error(`[BOT_CONTACTS_DB_ERROR] Failed to get contact ${contactJid} for bot ${botInstanceId}: ${error.message}`, error.stack);
        return null;
    }
}

module.exports = {
    getClientBotInstanceId, // Exported to be called by instanceManager if needed for migration/cleanup
    upsertBotContact,
    deleteStaleContactsForInstance,
    getContactByJid,
};