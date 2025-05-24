// config.js
const path = require('path');
require('dotenv').config(); // Load .env for config variables

const ROOT_DIR = __dirname; // Current directory (whatsapp-multi-client-bot)
const CLIENT_DATA_BASE_DIR = path.join(ROOT_DIR, 'client_data'); // Base directory for all client data

module.exports = {
    QR_WEBSOCKET_PORT: parseInt(process.env.QR_WEBSOCKET_PORT || '8088'),
    API_BASE_URL: process.env.API_BASE_URL || 'http://smartbook.selfip.com:8080/api',
    // Removed API_USERNAME, API_PASSWORD, OWNER_NUMBER from here
    // These will be passed dynamically from C#

    // Note: SKIP_API_SYNC_ON_RECONNECT was present in original file but not in .env.
    // Ensure if you want to use it, it's explicitly set to 'true' or 'false' in .env.
    // For now, it's commented out if not present, otherwise use its value.
    // SKIP_API_SYNC_ON_RECONNECT: process.env.SKIP_API_SYNC_ON_RECONNECT === 'true',

    CLIENT_DATA_BASE_DIR,
    CLIENT_CODE_DIR: path.join(ROOT_DIR, 'client-instance'),

    DEFAULT_PHONE_COUNTRY_CODE: '967', // Default for Yemen

    API_SYNC_INTERVAL_MS: 3600000, // 1 hour
    RECONNECT_DELAY_MS: 5000, // 5 seconds
    MESSAGE_PROCESS_TIMEOUT_MS: 30000, // 30 seconds
};