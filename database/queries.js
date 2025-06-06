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
    UPSERT_CONTACT: `
        INSERT INTO bot_contacts 
        (bot_instance_id, user_jid, phone_number, display_name, whatsapp_name, is_whatsapp_contact, is_saved_contact)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (bot_instance_id, user_jid) 
        DO UPDATE SET 
            phone_number = $3, 
            display_name = $4,
            whatsapp_name = $5,
            is_whatsapp_contact = $6,
            is_saved_contact = $7,
            synced_at = CURRENT_TIMESTAMP
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
    `
};