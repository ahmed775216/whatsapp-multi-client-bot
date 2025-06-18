const db = require('./db');
const fs = require('fs');
const path = require('path');

const commands = {
    async reset() {
        console.log('Resetting database...');
        await db.query('DROP SCHEMA public CASCADE');
        await db.query('CREATE SCHEMA public');
        await db.query('GRANT ALL ON SCHEMA public TO whatsapp_bot_user');
        console.log('Database reset complete');
    },
    
    async migrate() {
        console.log('Running migrations...');
        const schemaSQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        await db.query(schemaSQL);
        
        const viewsSQL = fs.readFileSync(path.join(__dirname, 'views_and_functions.sql'), 'utf8');
        await db.query(viewsSQL);
        
        console.log('Migrations complete');
    },
    
    async seed() {
        console.log('Seeding test data...');
        // Add test data if needed
        console.log('Seeding complete');
    }
};

const command = process.argv[2];
if (commands[command]) {
    commands[command]()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Error:', err);
            process.exit(1);
        });
} else {
    console.log('Usage: node database/manage.js [reset|migrate|seed]');
    process.exit(1);
}