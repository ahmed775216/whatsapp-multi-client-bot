/* eslint-disable no-undef */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'whatsapp_bot_system',
    user: process.env.DB_USER || 'postgres', // Changed to postgres for now
    password: process.env.DB_PASSWORD || 'A7med@2025', // Use the postgres password
    max: 40,
    // Time a client can be idle in the pool before being closed.
    idleTimeoutMillis: 30000,
    // Time to wait for a new connection to be established.
    // Increased from 2s to 10s to be more resilient to network latency or slow DB startup.
    connectionTimeoutMillis: 10000,
});

// Add an error listener to the pool. This is a best-practice for node-postgres.
// It catches errors on idle clients and handles scenarios where a connection
// is terminated by the database server or a network issue.
pool.on('error', (err, client) => {
    // The 'client' argument is the client that experienced the error.
    // It's good practice to log this so you can see if it's a recurring issue.
    console.error('[DB_POOL_ERROR] An idle client in the pool encountered an error.', {
        errorMessage: err.message,
        clientInfo: { user: client.user, database: client.database, host: client.host, port: client.port }
    });
    // The pool will automatically remove this client, so no further action is needed.
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool
};