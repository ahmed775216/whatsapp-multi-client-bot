// migration/migrateToDb.js
const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const crypto = require('crypto');
let process = require('process');

function encryptPassword(password) {
    if (!password) return null;
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'kqBxxtSh2ufFdm78PZdbHfTweYQAGH7JyZkElgmE4dxZufxUzLBr38oMaTpAM1Ap', 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

async function migrateAllClients() {
    const clientDataDir = path.join(__dirname, '..', 'client_data');
    if (!fs.existsSync(clientDataDir)) {
        console.error(`[ERROR] Client data directory not found at: ${clientDataDir}`);
        return;
    }
    const clientFolders = fs.readdirSync(clientDataDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    console.log(`Found ${clientFolders.length} client folders to migrate.`);

    for (const clientFolder of clientFolders) {
        try {
            await migrateClientData(path.join(clientDataDir, clientFolder));
        } catch (error) {
            console.error(`[MIGRATION_FAILED] Rolled back transaction for ${path.basename(clientFolder)}.`);
        }
    }
}

async function migrateClientData(clientFolderPath) {
    const clientId = path.basename(clientFolderPath);
    console.log(`\n--- Migrating ${clientId}... ---`);

    const client = await db.pool.connect(); // Use a single connection for the transaction

    try {
        await client.query('BEGIN');
        let botInstanceId;

        // Step 1: Migrate client_config.json
        const configPath = path.join(clientFolderPath, 'client_config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const result = await client.query(`
                INSERT INTO bot_instances (client_id, phone_number, display_name, api_username, api_password_encrypted, owner_number, linked_at, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (client_id) DO UPDATE SET phone_number = EXCLUDED.phone_number, display_name = EXCLUDED.display_name, api_username = EXCLUDED.api_username, api_password_encrypted = EXCLUDED.api_password_encrypted, owner_number = EXCLUDED.owner_number, updated_at = CURRENT_TIMESTAMP
                RETURNING id
            `, [config.clientId || clientId, config.phoneNumber, config.name || config.phoneNumber, config.apiUsername, encryptPassword(config.apiPassword), config.ownerNumber, config.linkedAt ? new Date(config.linkedAt) : new Date(), 'stopped']);
            botInstanceId = result.rows[0].id;
            console.log(`  ✓ Bot instance created/updated (ID: ${botInstanceId})`);
        } else {
            console.log(`  ⚠ No client_config.json found for ${clientId}, skipping.`);
            await client.query('ROLLBACK');
            return;
        }

        // Step 2 & 3 are safe and can remain the same
        const whitelistPath = path.join(clientFolderPath, 'data', 'whitelist.json');
        if (fs.existsSync(whitelistPath)) {
            const whitelist = JSON.parse(fs.readFileSync(whitelistPath, 'utf8'));
            if (whitelist.users?.length > 0) {
                for (const userJid of whitelist.users) {
                    await client.query(`INSERT INTO whitelisted_users (bot_instance_id, user_jid, phone_number, api_active) VALUES ($1, $2, $3, true) ON CONFLICT (bot_instance_id, user_jid) DO NOTHING`, [botInstanceId, userJid, userJid.split('@')[0]]);
                }
                console.log(`  ✓ Migrated ${whitelist.users.length} whitelisted users.`);
            }
            if (whitelist.groups?.length > 0) {
                for (const groupJid of whitelist.groups) {
                    await client.query(`INSERT INTO whitelisted_groups (bot_instance_id, group_jid, is_active) VALUES ($1, $2, true) ON CONFLICT (bot_instance_id, group_jid) DO NOTHING`, [botInstanceId, groupJid]);
                }
                console.log(`  ✓ Migrated ${whitelist.groups.length} whitelisted groups.`);
            }
        }
        
        const permissionsPath = path.join(clientFolderPath, 'data', 'user_group_permissions.json');
        if (fs.existsSync(permissionsPath)) {
            const permissions = JSON.parse(fs.readFileSync(permissionsPath, 'utf8'));
            let updatedCount = 0;
            for (const [userJid, perms] of Object.entries(permissions)) {
                if (perms && typeof perms === 'object') {
                    const result = await client.query(`UPDATE whitelisted_users SET allowed_in_groups = $3, api_contact_id = $4, updated_at = CURRENT_TIMESTAMP WHERE bot_instance_id = $1 AND user_jid = $2`, [botInstanceId, userJid, perms.allowed_in_groups === true, perms.contact_id || null]);
                    if (result.rowCount > 0) updatedCount++;
                }
            }
            console.log(`  ✓ Updated permissions for ${updatedCount} users.`);
        }

        // ** Step 4: ROBUST MIGRATION for lid_cache.json -> bot_contacts table **
        const lidCachePath = path.join(clientFolderPath, 'data', 'lid_cache.json');
        if (fs.existsSync(lidCachePath)) {
            const lidCache = JSON.parse(fs.readFileSync(lidCachePath, 'utf8'));
            if (lidCache && typeof lidCache.mappings === 'object' && lidCache.mappings !== null) {
                const migratedLids = new Set();
                let updatedOrCreatedCount = 0;
                
                for (const [lidJid, phoneJid] of Object.entries(lidCache.mappings)) {
                    // Check if this LID has already been processed in this run
                    if (migratedLids.has(lidJid)) {
                        console.warn(`  ~ WARNING: Duplicate LID '${lidJid}' found in JSON file for client ${clientId}. Ignoring subsequent mapping to '${phoneJid}'.`);
                        continue;
                    }

                    // Also check if the LID is already in the DB for this instance from a previous run/different phone
                    const checkResult = await client.query(`SELECT id FROM bot_contacts WHERE bot_instance_id = $1 AND lid_jid = $2`, [botInstanceId, lidJid]);
                    if (checkResult.rowCount > 0) {
                        console.warn(`  ~ WARNING: LID '${lidJid}' already exists in database for client ${clientId}. Ignoring new mapping to '${phoneJid}'.`);
                        continue;
                    }

                    if (typeof lidJid === 'string' && typeof phoneJid === 'string' && lidJid.includes('@lid')) {
                        const phoneNumber = phoneJid.split('@')[0];
                        await client.query(`
                            INSERT INTO bot_contacts (bot_instance_id, user_jid, phone_number, lid_jid)
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT (bot_instance_id, user_jid) DO UPDATE 
                            SET lid_jid = EXCLUDED.lid_jid, synced_at = CURRENT_TIMESTAMP
                            WHERE bot_contacts.lid_jid IS NULL;
                        `, [botInstanceId, phoneJid, phoneNumber, lidJid]);
                        
                        migratedLids.add(lidJid);
                        updatedOrCreatedCount++;
                    }
                }
                console.log(`  ✓ Processed ${updatedOrCreatedCount} valid LID resolutions for bot_contacts.`);
            }
        }
        
        await client.query('COMMIT');
        console.log(`✅ Successfully committed migration for ${clientId}`);
        
    } catch (error) {
        console.error(`[ERROR_DETAILS] For client ${clientId}: ${error.message}`);
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release(); // Release the client back to the pool
    }
}

// Main execution block remains the same
if (require.main === module) {
    migrateAllClients()
        .then(() => { console.log('\n✅ Migration process finished.'); process.exit(0); })
        .catch(() => { console.error('\n❌ Migration process finished with one or more errors.'); process.exit(1); });
}