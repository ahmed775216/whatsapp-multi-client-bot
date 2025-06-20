// // database/botContactsDb.js
// const db = require('./db'); // Assuming db.js exports pool.query
// let process = require('process');

// // Fixed function call - using correct function name
// const UPSERT_BY_NAME_FUNCTION_CALL = `
//     SELECT upsert_bot_contact_by_name(
//         $1, -- p_bot_instance_id
//         $2, -- p_user_jid
//         $3, -- p_lid_jid
//         $4, -- p_phone_number
//         $5, -- p_display_name
//         $6, -- p_whatsapp_name
//         $7, -- p_is_whatsapp_contact
//         $8  -- p_is_saved_contact
//     );
// `;

// async function getClientBotInstanceId(clientId = process.env.CLIENT_ID) {
//     const result = await db.query(
//         'SELECT id FROM bot_instances WHERE client_id = $1',
//         [clientId]
//     );
//     return result.rows[0]?.id;
// }

// /**
//  * Robustly upserts a contact by finding an existing record with the same display_name
//  * and merging information, or creating a new one.
//  * @param {number} botInstanceId - The numeric ID of the bot instance.
//  * @param {object} contactData - An object containing contact details.
//  */
// async function upsertBotContact(botInstanceId, {
//     userJid,
//     lidJid,
//     phoneNumber,
//     displayName,
//     whatsappName,
//     isWhatsappContact = true,
//     isSavedContact = false // Default to false unless explicitly a saved contact
// }) {
//     if (!botInstanceId) {
//         console.error("[BOT_CONTACTS_DB] Missing botInstanceId for upserting contact.");
//         return;
//     }
//     if (!displayName) {
//         console.warn("[BOT_CONTACTS_DB] upsertBotContact called without a displayName. Aborting to prevent corrupt data.");
//         return;
//     }

//     try {
//         const result = await db.query(UPSERT_BY_NAME_FUNCTION_CALL, [
//             botInstanceId,
//             userJid,
//             lidJid,
//             phoneNumber,
//             displayName,
//             whatsappName,
//             isWhatsappContact,
//             isSavedContact
//         ]);
        
//         console.log(`[BOT_CONTACTS_DB] Successfully upserted contact: ${displayName}`);
//         return result;
//     } catch (error) {
//         const id = displayName || userJid || lidJid;
//         console.error(`[BOT_CONTACTS_DB_ERROR] Failed to call upsert_bot_contact_by_name for contact ${id}: ${error.message}`, error.stack);
        
//         // Log the parameters for debugging
//         console.error('[BOT_CONTACTS_DB_ERROR] Parameters:', {
//             botInstanceId,
//             userJid,
//             lidJid,
//             phoneNumber,
//             displayName,
//             whatsappName,
//             isWhatsappContact,
//             isSavedContact
//         });
//     }
// }

// async function deleteStaleContactsForInstance(botInstanceId, currentContactUserJids) {
//     if (!botInstanceId || !Array.isArray(currentContactUserJids)) {
//         console.error("[BOT_CONTACTS_DB] Invalid arguments for deleting stale contacts.");
//         return;
//     }
//     if (currentContactUserJids.length === 0) {
//         console.warn(`[BOT_CONTACTS_DB] No current contact JIDs provided for instance ${botInstanceId}. No contacts will be marked as stale.`);
//         return;
//     }

//     // This query now safely DEACTIVATES contacts that were not in the sync.
//     // It targets records with a user_jid, preventing accidental deletion of unresolved LIDs.
//     const query = `
//         UPDATE bot_contacts 
//         SET is_whatsapp_contact = false, synced_at = CURRENT_TIMESTAMP
//         WHERE 
//             bot_instance_id = $1 
//             AND user_jid IS NOT NULL
//             AND user_jid <> ALL($2::text[]);
//     `;

//     try {
//         const result = await db.query(query, [botInstanceId, currentContactUserJids]);
//         if (result.rowCount > 0) {
//             console.log(`[BOT_CONTACTS_DB] Marked ${result.rowCount} stale contacts as inactive for bot ${botInstanceId}.`);
//         }
//     } catch (error) {
//         console.error(`[BOT_CONTACTS_DB_ERROR] Failed to mark stale contacts for bot ${botInstanceId}: ${error.message}`, error.stack);
//     }
// }

// async function getContactByJid(botInstanceId, contactJid) {
//     if (!botInstanceId || !contactJid) return null;
//     try {
//         const result = await db.query(
//             'SELECT * FROM bot_contacts WHERE bot_instance_id = $1 AND (user_jid = $2 OR lid_jid = $2)',
//             [botInstanceId, contactJid]
//         );
//         return result.rows[0] || null;
//     } catch (error) {
//         console.error(`[DB_ERROR] Failed to get contact ${contactJid} for bot ${botInstanceId}: ${error.message}`);
//         return null;
//     }
// }

// module.exports = {
//     getClientBotInstanceId, 
//     upsertBotContact,
//     deleteStaleContactsForInstance,
//     getContactByJid,
// };
// database/botContactsDb.js
const db = require('./db');
let process = require('process');

// Define the SQL to call our new database function
const UPSERT_BY_NAME_FUNCTION_CALL = `
    SELECT * FROM upsert_bot_contact_by_name(
        $1, -- p_bot_instance_id
        $2, -- p_user_jid
        $3, -- p_lid_jid
        $4, -- p_phone_number
        $5, -- p_display_name
        $6, -- p_whatsapp_name
        $7, -- p_is_whatsapp_contact
        $8  -- p_is_saved_contact
    );
`;

/**
 * Fetches the numeric ID for a bot instance from its client_id string.
 * @param {string} [clientId] - The client ID (e.g., 'client_967...'). Defaults to process.env.CLIENT_ID.
 * @returns {Promise<number|null>} The numeric ID or null if not found.
 */
async function getClientBotInstanceId(clientId = process.env.CLIENT_ID) {
    if (!clientId) return null;
    try {
        const result = await db.query(
            'SELECT id FROM bot_instances WHERE client_id = $1',
            [clientId]
        );
        return result.rows[0]?.id || null;
    } catch (error) {
        console.error(`[DB_ERROR] Failed to get bot instance ID for client ${clientId}: ${error.message}`);
        return null;
    }
}

/**
 * Performs a smart insert/update for a contact using the name-based upsert logic in the database.
 * @param {number} botInstanceId - The numeric ID of the bot instance.
 * @param {object} contactData - An object containing all necessary contact details.
 */
async function upsertBotContact(botInstanceId, {
    userJid,
    lidJid,
    phoneNumber,
    displayName,
    whatsappName,
    isWhatsappContact = true,
    isSavedContact = false
}) {
    if (!botInstanceId || !displayName) {
        // This check is a safeguard. The displayName should be validated by the calling function.
        console.warn("[BOT_CONTACTS_DB] upsertBotContact called with invalid botInstanceId or displayName.");
        return;
    }

    try {
        const result = await db.query(UPSERT_BY_NAME_FUNCTION_CALL, [
            botInstanceId,
            userJid,
            lidJid,
            phoneNumber,
            displayName,
            whatsappName,
            isWhatsappContact,
            isSavedContact
        ]);
        
        // Log the result from the SQL function for debugging
        const actionResult = result.rows[0];
        if (actionResult && actionResult.action_taken !== 'SKIPPED_INVALID_NAME') {
             console.log(`[BOT_CONTACTS_DB] Upsert for "${displayName}": Action taken = ${actionResult.action_taken}, Contact ID = ${actionResult.contact_id}`);
        }
    } catch (error) {
        const id = displayName || userJid || lidJid;
        console.error(`[BOT_CONTACTS_DB_ERROR] Failed to call DB function for contact ${id}: ${error.message}`, error.stack);
    }
}

/**
 * Deactivates saved contacts that are no longer in the user's address book.
 * @param {number} botInstanceId - The numeric ID of the bot instance.
 * @param {string[]} currentContactUserJids - An array of userJids from the current contact sync.
 */
async function deleteStaleContactsForInstance(botInstanceId, currentContactUserJids) {
    if (!botInstanceId || !Array.isArray(currentContactUserJids)) {
        console.error("[BOT_CONTACTS_DB] Invalid arguments for deleting stale contacts.");
        return;
    }
    
    // We only deactivate contacts that are explicitly marked as "saved".
    // Auto-added contacts from messages will not be touched by this process.
    const query = `
        UPDATE bot_contacts
        SET is_whatsapp_contact = false, synced_at = CURRENT_TIMESTAMP
        WHERE
            bot_instance_id = $1
            AND user_jid IS NOT NULL
            AND is_saved_contact = true
            AND user_jid <> ALL($2::text[]);
    `;

    try {
        const result = await db.query(query, [botInstanceId, currentContactUserJids]);
        if (result.rowCount > 0) {
            console.log(`[BOT_CONTACTS_DB] Marked ${result.rowCount} stale saved contacts as inactive for bot ${botInstanceId}.`);
        }
    } catch (error) {
        console.error(`[BOT_CONTACTS_DB_ERROR] Failed to mark stale contacts for bot ${botInstanceId}: ${error.message}`, error.stack);
    }
}

/**
 * Retrieves a single, complete contact record from the database by any of its JIDs.
 * @param {number} botInstanceId - The numeric ID of the bot instance.
 * @param {string} contactJid - The JID to search for (can be user_jid or lid_jid).
 * @returns {Promise<object|null>} The full contact record or null if not found.
 */
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

// We now export only the functions needed by the rest of the application.
module.exports = {
    getClientBotInstanceId,
    upsertBotContact,
    deleteStaleContactsForInstance,
    getContactByJid
};