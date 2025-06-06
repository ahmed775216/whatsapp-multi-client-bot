/* eslint-disable no-undef */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'whatsapp_bot_system',
    user: process.env.DB_USER || 'postgres', // Changed to postgres for now
    password: process.env.DB_PASSWORD || 'postgres_admin_password', // Use the postgres password
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool
};