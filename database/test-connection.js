// const db = require('./db'); // Comment out pool for now
const { Client } = require('pg');
let process = require('process')
async function testConnection() {
    console.log("Attempting direct client connection...");
    const client = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'whatsapp_bot_system',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'Ahmed@2025',
        connectionTimeoutMillis: 5000, // Increased timeout
    });

    try {
        await client.connect();
        console.log('Direct client connection successful!');
        const result = await client.query('SELECT current_database(), current_user, version()');
        console.log('Connected to database:', result.rows[0].current_database);
        console.log('As user:', result.rows[0].current_user);
        console.log('PostgreSQL version:', result.rows[0].version);
        await client.end();
        process.exit(0);
    } catch (err) {
        console.error('Direct client connection test failed:', err);
        if (client) await client.end().catch(e => console.error("Error ending client after failure:", e));
        process.exit(1);
    }
}
testConnection();