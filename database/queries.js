module.exports = {
    // Get all whitelisted users for a bot instance
    getWhitelistedUsers: `
        SELECT user_jid, phone_number, display_name, allowed_in_groups, api_contact_id
        FROM whitelisted_users
        WHERE bot_instance_id = $1 AND api_active = true
    `,

    // Get user permissions
    getUserPermissions: `
        SELECT allowed_in_groups, api_contact_id
        FROM whitelisted_users
        WHERE bot_instance_id = $1 AND user_jid = $2 AND api_active = true
    `,

    // Check if user/group is whitelisted
    checkWhitelist: `
        SELECT EXISTS(
            SELECT 1 FROM whitelisted_users 
            WHERE bot_instance_id = $1 AND user_jid = $2 AND api_active = true
            UNION
            SELECT 1 FROM whitelisted_groups 
            WHERE bot_instance_id = $1 AND group_jid = $2 AND is_active = true
        )
    `,


    // New: Delete/mark as stale contacts not present in the new sync
    DELETE_STALE_CONTACTS_FOR_INSTANCE: `
        DELETE FROM bot_contacts
        WHERE bot_instance_id = $1 AND user_jid <> ALL($2::text[])
    `,
    // Note: The previous definition in my head was "UPDATE SET is_active = false",
    // but the `bot_contacts` schema I provided doesn't have `is_active`.
    // It has `is_whatsapp_contact` and `is_saved_contact`. Let's delete for simplicity
    // based on `user_jid <> ALL($2::text[])` meaning "not in the current list".
    // If you prefer soft deletes (marking as inactive), we'd need to add an `is_active` column to `bot_contacts`.

    // New: Get a single contact by JID
    GET_CONTACT_BY_JID: `
        SELECT * FROM bot_contacts
        WHERE bot_instance_id = $1 AND user_jid = $2
    `,
// Replace the old UPSERT_CONTACT with these two simpler queries:
// INSERT_BOT_CONTACT: `
//     INSERT INTO bot_contacts
//     (bot_instance_id, user_jid, lid_jid, phone_number, display_name, whatsapp_name, is_whatsapp_contact, is_saved_contact)
//     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
//     RETURNING id
// `,
UPDATE_BOT_CONTACT: `
    UPDATE bot_contacts SET
        user_jid = COALESCE($2, user_jid),
        lid_jid = COALESCE($3, lid_jid),
        phone_number = COALESCE($4, phone_number),
        display_name = COALESCE($5, display_name),
        whatsapp_name = COALESCE($6, whatsapp_name),
        synced_at = CURRENT_TIMESTAMP
    WHERE id = $1
`,
// Also, let's add a query to find a contact by either JID
GET_CONTACT_BY_ANY_JID: `
    SELECT id FROM bot_contacts
    WHERE bot_instance_id = $1 AND (user_jid = $2 OR lid_jid = $2)
    LIMIT 1
`,
GET_CONTACT_BY_NAME: `
SELECT id, user_jid, lid_jid FROM bot_contacts
WHERE bot_instance_id = $1 AND display_name = $2
ORDER BY synced_at DESC -- Get the most recent one if there are duplicates
LIMIT 1
 `,
// GET_FULL_CONTACT_BY_ANY_JID: `
//     SELECT id, user_jid, lid_jid, display_name
//     FROM bot_contacts
//     WHERE bot_instance_id = $1 AND (user_jid = $2 OR lid_jid = $2)
//     LIMIT 1
// `,
// In database/queries.js
GET_FULL_CONTACT_BY_ANY_JID: `
    SELECT id, user_jid, lid_jid, display_name, phone_number
    FROM bot_contacts
    WHERE bot_instance_id = $1 AND (lid_jid = $2 OR user_jid = $3)
    LIMIT 1
`,
INSERT_BOT_CONTACT: `
    INSERT INTO bot_contacts (bot_instance_id, user_jid, lid_jid, phone_number, display_name, whatsapp_name)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
`,
UPDATE_BOT_CONTACT_MERGE: `
    UPDATE bot_contacts SET
        user_jid = COALESCE($2, user_jid),
        lid_jid = COALESCE($3, lid_jid),
        phone_number = COALESCE($4, phone_number),
        display_name = COALESCE($5, display_name),
        whatsapp_name = COALESCE($6, whatsapp_name),
        synced_at = CURRENT_TIMESTAMP
    WHERE id = $1
`,
/* UPDATE_WHITELIST_USER_FROM_CONTACT: `
    UPDATE whitelisted_users
    SET
        display_name = $2,
        phone_number = $3
    WHERE
        bot_instance_id = $1 AND user_jid = $4
`, */
// Add this new query to get all resolutions to be synced:
GET_ALL_LID_RESOLUTIONS: `
    SELECT lid_jid, resolved_phone_jid, display_name FROM lid_resolutions WHERE bot_instance_id = $1
`,

UPDATE_WHITELIST_USER_FROM_CONTACT: `
    UPDATE whitelisted_users wu
    SET display_name = $2, phone_number = $3
    FROM bot_contacts bc
    WHERE wu.bot_instance_id = bc.bot_instance_id
    AND wu.user_jid = bc.user_jid
    AND bc.id = $1
`,
};