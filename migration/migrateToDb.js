// migration/migrateToDb.js
const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const crypto = require('crypto');
let process = require('process');
// Encryption helper (match C# encryption if needed)
function encryptPassword(password) {
    // For now, using simple encryption - should match your security requirements
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

async function migrateAllClients() {
    const clientDataDir = path.join(__dirname, '..', 'client_data');
    const clientFolders = fs.readdirSync(clientDataDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    console.log(`Found ${clientFolders.length} client folders to migrate`);

    for (const clientFolder of clientFolders) {
        try {
            await migrateClientData(path.join(clientDataDir, clientFolder));
        } catch (error) {
            console.error(`Failed to migrate ${clientFolder}:`, error);
        }
    }
}

async function migrateClientData(clientFolderPath) {
    const clientId = path.basename(clientFolderPath);
    console.log(`\nMigrating ${clientId}...`);
    
    await db.query('BEGIN');
    
    try {
        // 1. Migrate client_config.json
        const configPath = path.join(clientFolderPath, 'client_config.json');
        let botInstanceId;
        
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            const result = await db.query(`
                INSERT INTO bot_instances 
                (client_id, phone_number, display_name, api_username, 
                 api_password_encrypted, owner_number, linked_at, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (client_id) DO UPDATE
                SET phone_number = $2, 
                    display_name = $3,
                    api_username = $4,
                    api_password_encrypted = $5,
                    owner_number = $6,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id
            `, [
                clientId,
                config.phoneNumber,
                config.name || config.phoneNumber,
                config.apiUsername,
                encryptPassword(config.apiPassword),
                config.ownerNumber,
                config.linkedAt || new Date(),
                'disconnected' // Default status
            ]);
            
            botInstanceId = result.rows[0].id;
            console.log(`  ✓ Bot instance created/updated (ID: ${botInstanceId})`);
        } else {
            console.log(`  ⚠ No client_config.json found, skipping...`);
            await db.query('ROLLBACK');
            return;
        }
        
        // 2. Migrate whitelist.json
        const whitelistPath = path.join(clientFolderPath, 'data', 'whitelist.json');
        if (fs.existsSync(whitelistPath)) {
            const whitelist = JSON.parse(fs.readFileSync(whitelistPath, 'utf8'));
            
            // Migrate whitelisted users
            if (whitelist.users && whitelist.users.length > 0) {
                for (const userJid of whitelist.users) {
                    await db.query(`
                        INSERT INTO whitelisted_users 
                        (bot_instance_id, user_jid, phone_number, api_active)
                        VALUES ($1, $2, $3, true)
                        ON CONFLICT (bot_instance_id, user_jid) DO NOTHING
                    `, [botInstanceId, userJid, userJid.split('@')[0]]);
                }
                console.log(`  ✓ Migrated ${whitelist.users.length} whitelisted users`);
            }
            
            // Migrate whitelisted groups
            if (whitelist.groups && whitelist.groups.length > 0) {
                for (const groupJid of whitelist.groups) {
                    await db.query(`
                        INSERT INTO whitelisted_groups 
                        (bot_instance_id, group_jid, is_active)
                        VALUES ($1, $2, true)
                        ON CONFLICT (bot_instance_id, group_jid) DO NOTHING
                    `, [botInstanceId, groupJid]);
                }
                console.log(`  ✓ Migrated ${whitelist.groups.length} whitelisted groups`);
            }
        }
        
        // 3. Migrate user_group_permissions.json
        const permissionsPath = path.join(clientFolderPath, 'data', 'user_group_permissions.json');
        if (fs.existsSync(permissionsPath)) {
            const permissions = JSON.parse(fs.readFileSync(permissionsPath, 'utf8'));
            let updatedCount = 0;
            
            for (const [userJid, perms] of Object.entries(permissions)) {
                const result = await db.query(`
                    UPDATE whitelisted_users 
                    SET allowed_in_groups = $3,
                        api_contact_id = $4,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE bot_instance_id = $1 AND user_jid = $2
                `, [
                    botInstanceId, 
                    userJid, 
                    perms.allowed_in_groups || false,
                    perms.contact_id || null
                ]);
                
                if (result.rowCount > 0) updatedCount++;
            }
            console.log(`  ✓ Updated permissions for ${updatedCount} users`);
        }
        
        // 4. Migrate lid_to_phone_cache.json
        const lidCachePath = path.join(clientFolderPath, 'data', 'lid_to_phone_cache.json');
        if (fs.existsSync(lidCachePath)) {
            const lidCache = JSON.parse(fs.readFileSync(lidCachePath, 'utf8'));
            let lidCount = 0;
            
            for (const [lidJid, phoneJid] of Object.entries(lidCache)) {
                await db.query(`
                    INSERT INTO lid_resolutions 
                    (bot_instance_id, lid_jid, resolved_phone_jid)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (bot_instance_id, lid_jid) DO NOTHING
                `, [botInstanceId, lidJid, phoneJid]);
                lidCount++;
            }
            console.log(`  ✓ Migrated ${lidCount} LID resolutions`);
        }
        
        await db.query('COMMIT');
        console.log(`✅ Successfully migrated ${clientId}`);
        
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
}

// Run migration
if (require.main === module) {
    migrateAllClients()
        .then(() => {
            console.log('\n✅ Migration completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Migration failed:', error);
            process.exit(1);
        });
}

module.exports = { migrateClientData, migrateAllClients };