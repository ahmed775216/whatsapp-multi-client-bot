// database/botContactsDb.js
const db = require('./db'); // Assuming db.js exports pool.query
// const { getBotInstanceId } = require('../client-instance/lib/apiSync'); // Get bot instance ID from client-instance context
const {  DELETE_STALE_CONTACTS_FOR_INSTANCE, GET_CONTACT_BY_JID } = require('./queries'); // Import new queries
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

// database/botContactsDb.js
// database/botContactsDb.js
// database/botContactsDb.js
const { INSERT_BOT_CONTACT, UPDATE_BOT_CONTACT, GET_CONTACT_BY_ANY_JID, GET_CONTACT_BY_NAME } = require('./queries');

async function upsertBotContact(botInstanceId, jid, displayName, whatsappName, isWhatsappContact = true, isSavedContact = false) {
    if (!botInstanceId || !jid || !displayName) {
        console.warn("[BOT_CONTACTS_DB] Missing botInstanceId, JID, or displayName for upsert. Skipping.");
        return;
    }

    try {
        let existingContactId = null;

        // --- HIERARCHY FOR FINDING EXISTING CONTACT ---

        // 1. First, try to find an exact match on the JID (phone or LID). This is the most reliable match.
        const existingJidResult = await db.query(GET_CONTACT_BY_ANY_JID, [botInstanceId, jid]);
        if (existingJidResult.rows.length > 0) {
            existingContactId = existingJidResult.rows[0].id;
        }

        // 2. If no JID match, try to find a match by display_name.
        // This helps merge records when a known user messages from a new device (LID).
        if (!existingContactId) {
            const existingNameResult = await db.query(GET_CONTACT_BY_NAME, [botInstanceId, displayName]);
            if (existingNameResult.rows.length > 0) {
                const foundContact = existingNameResult.rows[0];
                // Check if we are about to overwrite a more specific JID with null. We shouldn't.
                const isIncomingJidLid = jid.endsWith('@lid');
                const isExistingJidPhone = foundContact.user_jid && !foundContact.user_jid.endsWith('@lid');

                // Don't merge if the existing contact has a phone number but the new message is from a LID.
                // This prevents a temporary LID from "claiming" a primary contact record.
                // We let the LID create its own record, which can be merged later if resolved.
                if (!(isIncomingJidLid && isExistingJidPhone)) {
                    existingContactId = foundContact.id;
                }
            }
        }
        
        const isLid = jid.endsWith('@lid');
        const userJid = isLid ? null : jid;
        const lidJid = isLid ? jid : null;
        const phoneNumber = isLid ? null : jid.split('@')[0];

        if (existingContactId) {
            // --- UPDATE EXISTING RECORD ---
            // It exists, so we update it with any new non-null information.
            // COALESCE is used to avoid overwriting existing data with nulls.
            await db.query(UPDATE_BOT_CONTACT, [
                existingContactId,
                userJid,
                lidJid,
                phoneNumber,
                displayName,
                whatsappName
            ]);
            // console.log(`[BOT_CONTACTS_DB] Updated contact for JID: ${jid}, Name: ${displayName}`);
        } else {
            // --- INSERT NEW RECORD ---
            // It's a genuinely new contact, so we insert it.
            await db.query(INSERT_BOT_CONTACT, [
                botInstanceId,
                userJid,
                lidJid,
                phoneNumber,
                displayName,
                whatsappName,
                isWhatsappContact,
                isSavedContact
            ]);
            // console.log(`[BOT_CONTACTS_DB] Inserted new contact for JID: ${jid}, Name: ${displayName}`);
        }
    } catch (error) {
        console.error(`[BOT_CONTACTS_DB_ERROR] Failed to upsert contact ${jid} for bot ${botInstanceId}: ${error.message}`, error.stack);
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