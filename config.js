// config.js
const path = require('path');
require('dotenv').config(); // Load .env for config variables

const ROOT_DIR = __dirname; // Current directory (whatsapp-multi-client-bot)
const CLIENT_DATA_BASE_DIR = path.join(ROOT_DIR, 'client_data'); // Base directory for all client data

module.exports = {
    QR_WEBSOCKET_PORT: parseInt(process.env.QR_WEBSOCKET_PORT || '8088'),
    API_BASE_URL: process.env.API_BASE_URL || 'http://smartbook.selfip.com:8080/api',
    API_USERNAME: process.env.API_USERNAME,
    API_PASSWORD: process.env.API_PASSWORD,
    OWNER_NUMBER: process.env.OWNER_NUMBER,
    SKIP_API_SYNC_ON_RECONNECT: process.env.SKIP_API_SYNC_ON_RECONNECT === 'true', // Useful for dev/debug

    CLIENT_DATA_BASE_DIR, // Base directory for all client data
    CLIENT_CODE_DIR: path.join(ROOT_DIR, 'client-instance'), // Path to the individual bot's app.js

    // Add default country code if not always provided by API/user
    DEFAULT_PHONE_COUNTRY_CODE: '967', // Example for Yemen

    // Timeouts and intervals (adjust as needed)
    API_SYNC_INTERVAL_MS: 3600000, // 1 hour for regular sync
    RECONNECT_DELAY_MS: 5000,
    MESSAGE_PROCESS_TIMEOUT_MS: 30000, // Max time to process a message
};