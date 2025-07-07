const { v4: uuidv4 } = require('uuid');
const config = require('../../config');
const { createLogger } = require('../lib/logger');
const transactionStore = require('../lib/transactionStore');

const MIN_MESSAGE_LENGTH = 20;

/**
 * Strips the country code from a phone number string.
 * @param {string} fullNumber The full number (e.g., '967712345678').
 * @param {string} countryCode The country code to strip.
 * @returns {string} The number without the country code.
 */
function stripCountryCode(fullNumber, countryCode = config.DEFAULT_PHONE_COUNTRY_CODE) {
    if (!fullNumber) return '';
    const numberPart = fullNumber.toString().replace(/[^0-9]/g, '');
    if (numberPart.startsWith(countryCode)) {
        return numberPart.substring(countryCode.length);
    }
    return numberPart;
}

/**
 * This plugin now acts as a transaction PRODUCER.
 * It intercepts whitelisted messages, filters them, and if they qualify,
 * it creates a transaction object and saves it to the queue for processing.
 */
module.exports = {
    all: async function (m, { sender, pushName }) {
        const clientId = process.env.CLIENT_ID;
        const logger = createLogger(clientId);

        try {
            // This logic correctly extracts text content from various message types.
            const messageContent = m.message?.conversation || 
                                 m.message?.extendedTextMessage?.text || 
                                 m.message?.imageMessage?.caption || 
                                 m.message?.videoMessage?.caption ||
                                 m.message?.documentMessage?.caption;

            // --- FILTERING LOGIC ---
            // Only process messages with text content longer than the minimum required length.
            if (!messageContent || messageContent.trim().length <= MIN_MESSAGE_LENGTH) {
                return m; // Does not qualify, let other plugins handle it.
            }

            const transactionId = uuidv4();
            logger.info({ transactionId, sender }, `Qualifying message received. Creating new transaction.`);

            // Construct the payload for the API.
            const senderPhoneNumberForApi = sender.endsWith('@s.whatsapp.net')
                ? stripCountryCode(sender.split('@')[0])
                : sender.split('@')[0]; // Keep LID as is for the API payload

            const apiPayload = {
                original_content: messageContent,
                sender_phone_number_from_device_contacts: senderPhoneNumberForApi,
                sender_display_name_from_notification: pushName,
                source_package_name: "whatsapp-bot-v3", // Use a versioned name
                client_event_key: transactionId,
                event_timestamp_utc: new Date(m.messageTimestamp * 1000).toISOString(),
            };

            const newTransaction = {
                transactionId: transactionId,
                payload: apiPayload,
                status: "UNSENT", // Initial status
                timestamp: new Date().toISOString(),
                retryCount: 0,
            };

            // Add the transaction to the persistent queue using our safe store.
            // This runs in the background and does not block the main message handler.
            transactionStore.addTransaction(clientId, newTransaction)
                .catch(err => {
                    logger.error({ err, transactionId }, "Failed to add transaction to the store.");
                });

        } catch (error) {
            logger.error({ err: error }, 'Critical error in transaction producer plugin (forwrder.js).');
        }
        
        // Always return the message `m` so that other plugins (if any) can run.
        return m;
    }
};