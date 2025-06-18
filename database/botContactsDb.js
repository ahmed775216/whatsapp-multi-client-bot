// database/botContactsDb.js
const db = require('./db'); // Assuming db.js exports pool.query
// const { getBotInstanceId } = require('../client-instance/lib/apiSync'); // Get bot instance ID from client-instance context
const {  DELETE_STALE_CONTACTS_FOR_INSTANCE } = require('./queries'); // Import new queries
// let process = require('process');
// async function getClientBotInstanceId(clientId = process.env.CLIENT_ID) {
//     // We explicitly pass CLIENT_ID from process.env because this module
//     // might be used from client-instance context.
//     const result = await db.query(
//         'SELECT id FROM bot_instances WHERE client_id = $1',
//         [clientId]
//     );
//     return result.rows[0]?.id;
// }

// database/botContactsDb.js
// database/botContactsDb.js
// database/botContactsDb.js
// const { INSERT_BOT_CONTACT, UPDATE_BOT_CONTACT, GET_CONTACT_BY_ANY_JID, GET_CONTACT_BY_NAME } = require('./queries');
// database/botContactsDb.js

/**
 * Calls the database function to intelligently insert or update a contact.
 * This handles name changes and merges LID/phone JIDs for existing contacts.
 * @param {number} botInstanceId - The numeric ID of the bot instance.
 * @param {string} jid - The JID of the contact (can be a phone JID or a LID).
 * @param {string} displayName - The latest display name for the contact.
 * @param {string} whatsappName - The latest WhatsApp name (pushName) for the contact.
 */
async function upsertBotContact(botInstanceId, jid, displayName, whatsappName) {
    if (!botInstanceId || !jid || !displayName) {
        // console.warn("[DB] upsertBotContact skipped due to missing parameters.");
        return;
    }
    try {
        await db.query('SELECT upsert_bot_contact($1, $2, $3, $4)', [
            botInstanceId,
            jid,
            displayName,
            whatsappName,
        ]);
    } catch (error) {
        console.error(`[DB_ERROR] Failed to execute upsert_bot_contact for JID ${jid}: ${error.message}`, error.stack);
    }
}

async function getClientBotInstanceId(clientId) {
    const result = await db.query(
        'SELECT id FROM bot_instances WHERE client_id = $1',
        [clientId]
    );
    return result.rows[0]?.id;
}

async function getContactByJid(botInstanceId, contactJid) {
    if (!botInstanceId || !contactJid) return null;
    try {
        const result = await db.query(
            'SELECT * FROM bot_contacts WHERE bot_instance_id = $1 AND (user_jid = $2 OR lid_jid = $2)',
            [botInstanceId, contactJid]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error(`[DB_ERROR] Failed to get contact ${contactJid} for bot ${botInstanceId}: ${error.message}`);
        return null;
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


module.exports = {
    getClientBotInstanceId, 
    upsertBotContact,
    deleteStaleContactsForInstance,
    getContactByJid,
};