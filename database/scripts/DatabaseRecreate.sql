-- Ensure you are connected to the correct database (e.g., whatsapp_bot_system)
-- \c whatsapp_bot_system;

-- Set client encoding to UTF8 to avoid potential issues
SET client_encoding = 'UTF8';

-- Core Tables

-- Bot instances/clients
CREATE TABLE IF NOT EXISTS bot_instances (
    id SERIAL PRIMARY KEY,
    client_id VARCHAR(100) UNIQUE NOT NULL,
    phone_number VARCHAR(30), -- Increased length for potential full JIDs if needed
    display_name VARCHAR(255),
    status VARCHAR(50) DEFAULT 'disconnected',
    api_username VARCHAR(100),
    api_password_encrypted TEXT,
    owner_number VARCHAR(30), -- Increased length
    linked_at TIMESTAMP WITH TIME ZONE,
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE bot_instances IS 'Stores information about each managed WhatsApp bot instance.';
COMMENT ON COLUMN bot_instances.client_id IS 'Unique identifier for the client instance (e.g., client_PHONE_NUMBER or client_new_linking_XYZ).';
COMMENT ON COLUMN bot_instances.phone_number IS 'The actual WhatsApp number associated with this instance (e.g., 967xxxxxxxxx).';
COMMENT ON COLUMN bot_instances.display_name IS 'User-friendly alias or name for the instance.';
COMMENT ON COLUMN bot_instances.status IS 'Current operational status of the bot instance (e.g., connected, disconnected, linking_qr).';
COMMENT ON COLUMN bot_instances.api_password_encrypted IS 'API password, encrypted by the C# application or migration script.';
COMMENT ON COLUMN bot_instances.linked_at IS 'Timestamp when the WhatsApp account was successfully linked.';

-- Whitelist for groups
CREATE TABLE IF NOT EXISTS whitelisted_groups (
    id SERIAL PRIMARY KEY,
    bot_instance_id INTEGER NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
    group_jid VARCHAR(100) NOT NULL,
    group_name VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    added_by VARCHAR(100), -- Optional: JID or identifier of who added it
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bot_instance_id, group_jid)
);
COMMENT ON TABLE whitelisted_groups IS 'Stores whitelisted WhatsApp groups for each bot instance.';
COMMENT ON COLUMN whitelisted_groups.group_jid IS 'The JID of the WhatsApp group (e.g., xxxxx-yyyyy@g.us).';

-- Whitelist for users
CREATE TABLE IF NOT EXISTS whitelisted_users (
    id SERIAL PRIMARY KEY,
    bot_instance_id INTEGER NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
    user_jid VARCHAR(100) NOT NULL, -- Can be phone JID or LID
    phone_number VARCHAR(30),    -- Actual phone number if resolved or known
    display_name VARCHAR(255),   -- User's display name
    allowed_in_groups BOOLEAN DEFAULT true, -- Permission for user to interact in whitelisted groups
    api_contact_id INTEGER,      -- ID from the external API for this contact
    api_mobile VARCHAR(30),      -- Mobile number as per the external API
    api_active BOOLEAN DEFAULT true, -- Is the contact considered active by the API?
    is_synced BOOLEAN DEFAULT true,  -- Has this record been synced with the API recently?
    last_api_sync TIMESTAMP WITH TIME ZONE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bot_instance_id, user_jid)
);
COMMENT ON TABLE whitelisted_users IS 'Stores whitelisted WhatsApp users for each bot instance.';
COMMENT ON COLUMN whitelisted_users.user_jid IS 'The JID of the WhatsApp user (e.g., 967xxxxxxxxx@s.whatsapp.net or a LID).';

-- LID resolution cache
CREATE TABLE IF NOT EXISTS lid_resolutions (
    id SERIAL PRIMARY KEY,
    bot_instance_id INTEGER NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
    lid_jid VARCHAR(100) NOT NULL,
    resolved_phone_jid VARCHAR(100) NOT NULL,
    display_name VARCHAR(255), -- Name associated with the resolved JID
    resolved_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bot_instance_id, lid_jid)
);
COMMENT ON TABLE lid_resolutions IS 'Cache for resolved LID (Linked Device ID) to phone number JIDs.';

-- Group participants cache (optional, if you want to store full participant lists persistently)
CREATE TABLE IF NOT EXISTS group_participants (
    id SERIAL PRIMARY KEY,
    bot_instance_id INTEGER NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
    group_jid VARCHAR(100) NOT NULL,
    participant_jid VARCHAR(100) NOT NULL, -- Can be phone JID or LID
    display_name VARCHAR(255),
    is_admin BOOLEAN DEFAULT false,
    last_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, -- When this participant info was last fetched
    UNIQUE(bot_instance_id, group_jid, participant_jid)
);
COMMENT ON TABLE group_participants IS 'Stores participant information for groups managed by bot instances.';

-- Instance logs (for persistent logging, if desired beyond console/file logs)
CREATE TABLE IF NOT EXISTS instance_logs (
    id SERIAL PRIMARY KEY,
    bot_instance_id INTEGER REFERENCES bot_instances(id) ON DELETE CASCADE,
    log_level VARCHAR(20),
    message TEXT,
    metadata JSONB, -- For structured log data
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE instance_logs IS 'Persistent logs for bot instances.';

-- API sync log
CREATE TABLE IF NOT EXISTS api_sync_log (
    id SERIAL PRIMARY KEY,
    bot_instance_id INTEGER NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
    sync_type VARCHAR(50) NOT NULL, -- e.g., 'contacts', 'whitelist'
    sync_status VARCHAR(50) NOT NULL, -- e.g., 'started', 'completed', 'failed'
    contacts_fetched INTEGER,
    contacts_added INTEGER,
    contacts_updated INTEGER,
    contacts_removed INTEGER,
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);
COMMENT ON TABLE api_sync_log IS 'Tracks the status and results of synchronizations with external APIs.';

-- Pending LID identifications (tracks LIDs that have been asked for their phone number)
CREATE TABLE IF NOT EXISTS pending_lid_identifications (
    id SERIAL PRIMARY KEY,
    bot_instance_id INTEGER NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
    lid_jid VARCHAR(100) NOT NULL,
    requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, -- When the identification was requested
    message_key TEXT, -- Optional: store the key of the message that triggered the request
    UNIQUE(bot_instance_id, lid_jid)
);
COMMENT ON TABLE pending_lid_identifications IS 'Tracks LIDs from whom a phone number identification has been requested.';

-- Asked LIDs cache (tracks when a LID was last asked to prevent spamming)
CREATE TABLE IF NOT EXISTS asked_lids_cache (
    id SERIAL PRIMARY KEY,
    bot_instance_id INTEGER NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
    lid_jid VARCHAR(100) NOT NULL,
    asked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bot_instance_id, lid_jid)
);
COMMENT ON TABLE asked_lids_cache IS 'Tracks when a LID was last asked for identification to manage cooldowns.';

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_bot_instances_status ON bot_instances(status);
CREATE INDEX IF NOT EXISTS idx_bot_instances_phone_number ON bot_instances(phone_number);

CREATE INDEX IF NOT EXISTS idx_whitelisted_groups_bot_instance_id ON whitelisted_groups(bot_instance_id);
CREATE INDEX IF NOT EXISTS idx_whitelisted_groups_group_jid ON whitelisted_groups(group_jid);

CREATE INDEX IF NOT EXISTS idx_whitelisted_users_bot_instance_id ON whitelisted_users(bot_instance_id);
CREATE INDEX IF NOT EXISTS idx_whitelisted_users_user_jid ON whitelisted_users(user_jid);
CREATE INDEX IF NOT EXISTS idx_whitelisted_users_api_active ON whitelisted_users(api_active);

CREATE INDEX IF NOT EXISTS idx_lid_resolutions_bot_instance_id ON lid_resolutions(bot_instance_id);
CREATE INDEX IF NOT EXISTS idx_lid_resolutions_lid_jid ON lid_resolutions(lid_jid);
CREATE INDEX IF NOT EXISTS idx_lid_resolutions_resolved_phone_jid ON lid_resolutions(resolved_phone_jid);

CREATE INDEX IF NOT EXISTS idx_group_participants_bot_instance_id ON group_participants(bot_instance_id);
CREATE INDEX IF NOT EXISTS idx_group_participants_group_jid ON group_participants(group_jid);
CREATE INDEX IF NOT EXISTS idx_group_participants_participant_jid ON group_participants(participant_jid);

CREATE INDEX IF NOT EXISTS idx_instance_logs_bot_instance_id ON instance_logs(bot_instance_id);
CREATE INDEX IF NOT EXISTS idx_instance_logs_created_at ON instance_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_sync_log_bot_instance_id ON api_sync_log(bot_instance_id);
CREATE INDEX IF NOT EXISTS idx_api_sync_log_status ON api_sync_log(sync_status);
CREATE INDEX IF NOT EXISTS idx_api_sync_log_started_at ON api_sync_log(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_lid_identifications_bot_instance_id_lid_jid ON pending_lid_identifications(bot_instance_id, lid_jid);
CREATE INDEX IF NOT EXISTS idx_asked_lids_cache_bot_instance_id_lid_jid ON asked_lids_cache(bot_instance_id, lid_jid);

-- Triggers for updated_at columns (Optional but good practice)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW(); 
   RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_bot_instances_updated_at
BEFORE UPDATE ON bot_instances
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_whitelisted_groups_updated_at
BEFORE UPDATE ON whitelisted_groups
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_whitelisted_users_updated_at
BEFORE UPDATE ON whitelisted_users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Views

-- View for active bot instances with some statistics
CREATE OR REPLACE VIEW v_active_bot_instances AS
SELECT 
    bi.id,
    bi.client_id,
    bi.phone_number,
    bi.display_name,
    bi.status,
    bi.api_username,
    bi.owner_number,
    bi.linked_at,
    bi.last_seen,
    bi.created_at AS instance_created_at,
    bi.updated_at AS instance_updated_at,
    (SELECT COUNT(*) FROM whitelisted_users wu WHERE wu.bot_instance_id = bi.id AND wu.api_active = true) as active_whitelisted_users_count,
    (SELECT COUNT(*) FROM whitelisted_groups wg WHERE wg.bot_instance_id = bi.id AND wg.is_active = true) as active_whitelisted_groups_count,
    (SELECT COUNT(*) FROM lid_resolutions lr WHERE lr.bot_instance_id = bi.id) as resolved_lids_count,
    (SELECT MAX(asl.completed_at) FROM api_sync_log asl WHERE asl.bot_instance_id = bi.id AND asl.sync_status = 'completed' AND asl.sync_type = 'contacts') as last_successful_contact_sync
FROM bot_instances bi
WHERE bi.status <> 'deleted'; -- Exclude logically deleted instances

-- View for recent API sync activity
CREATE OR REPLACE VIEW v_recent_api_syncs AS
SELECT 
    asl.id AS sync_log_id,
    asl.bot_instance_id,
    bi.client_id,
    bi.phone_number AS bot_phone_number,
    bi.display_name AS bot_display_name,
    asl.sync_type,
    asl.sync_status,
    asl.contacts_fetched,
    asl.contacts_added,
    asl.contacts_updated,
    asl.contacts_removed,
    asl.error_message,
    asl.started_at AS sync_started_at,
    asl.completed_at AS sync_completed_at
FROM api_sync_log asl
JOIN bot_instances bi ON bi.id = asl.bot_instance_id
ORDER BY asl.started_at DESC
LIMIT 100;

-- Functions from your SQL.txt

CREATE OR REPLACE FUNCTION cleanup_old_sync_logs(days_to_keep INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM api_sync_log 
    WHERE started_at < CURRENT_TIMESTAMP - (days_to_keep * INTERVAL '1 day'); -- Corrected interval usage
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_bot_instance_id(p_client_id VARCHAR)
RETURNS INTEGER AS $$
DECLARE
    v_instance_id INTEGER;
BEGIN
    SELECT id INTO v_instance_id FROM bot_instances WHERE client_id = p_client_id LIMIT 1;
    RETURN v_instance_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION is_whitelisted(p_bot_instance_id INTEGER, p_jid VARCHAR)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS(
        SELECT 1 FROM whitelisted_users wu
        WHERE wu.bot_instance_id = p_bot_instance_id AND wu.user_jid = p_jid AND wu.api_active = true
    ) OR EXISTS (
        SELECT 1 FROM whitelisted_groups wg
        WHERE wg.bot_instance_id = p_bot_instance_id AND wg.group_jid = p_jid AND wg.is_active = true
    );
END;
$$ LANGUAGE plpgsql;


-- Grant permissions (Adjust user and permissions as necessary)
-- Ensure the user your application connects with has the necessary permissions.
-- Example for a specific user (uncomment and modify if needed):
/*
DO $$
DECLARE
  app_user_exists BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'whatsapp_bot_user') INTO app_user_exists;
  IF NOT app_user_exists THEN
     CREATE USER whatsapp_bot_user WITH PASSWORD 'your_secure_password_here'; -- Replace with actual password
  END IF;
END $$;

GRANT CONNECT ON DATABASE whatsapp_bot_system TO whatsapp_bot_user;
GRANT USAGE ON SCHEMA public TO whatsapp_bot_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO whatsapp_bot_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO whatsapp_bot_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO whatsapp_bot_user;
*/

-- Grant to postgres user (often the default superuser/owner during development)
GRANT ALL PRIVILEGES ON DATABASE whatsapp_bot_system TO postgres;
GRANT ALL PRIVILEGES ON SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO postgres;

-- Notify completion
\echo 'Database schema, views, functions, and permissions set up successfully.'
