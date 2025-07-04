// client-instance/plugins/forwrder.js
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
// const { isWhitelisted } = require('./whitelist'); // <-- REMOVED THIS LINE
const { getApiToken } = require('../lib/apiSync');
const config = require('../../config');
let process = require('process');
const API_BASE_URL = process.env.API_BASE_URL;
const RAW_NOTIFICATION_API_PATH = '/raw-notifications';
const RAW_NOTIFICATION_API_ENDPOINT = `${API_BASE_URL}${RAW_NOTIFICATION_API_PATH}`;

// Add this function in forwarder.js
function stripCountryCode(fullNumber, countryCode = '967') {
    if (!fullNumber) return '';
    const numberPart = fullNumber.toString().replace(/[^0-9]/g, '');
    if (numberPart.startsWith(countryCode)) {
        return numberPart.substring(countryCode.length);
    }
    return numberPart;
}
function generateSourcePackageName() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 5; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}
 // Export the function for use in other modules

module.exports = {
    // UPDATED: 'sock' parameter removed from the function signature
    all: async function (m, { chatId, sender, isGroup, groupMetadata, isOwner, pushName }) {
        if (typeof sender !== 'string' || !sender.includes('@')) {
            console.warn(`[${process.env.CLIENT_ID}_FORWARDER-API] Skipping forwarder because sender is not a valid JID string. Sender:`, sender);
            return m;
        }

        console.log(`[${process.env.CLIENT_ID}_FORWARDER-API] Initiating forwarding for message from ${sender.split('@')[0]} (Name: ${pushName}) in ${isGroup ? 'group ' + (groupMetadata?.subject || chatId.split('@')[0]) : 'DM'}. IsOwner: ${isOwner}.`);

        // The primary whitelist filter is applied in _whitelistFilter.js, so no check is needed here.

        try {
            const msgType = Object.keys(m.message)[0];
            if (!m.message[msgType]) {
                console.warn(`[${process.env.CLIENT_ID}_FORWARDER-API] Invalid message structure or unknown msgType: ${msgType}. Skipping.`);
                return;
            }

            let originalContent = "";
            if (m.message.conversation) {
                originalContent = m.message.conversation;
            } else if (m.message.extendedTextMessage) {
                originalContent = m.message.extendedTextMessage.text;
            } else if (m.message.imageMessage && m.message.imageMessage.caption) {
                originalContent = m.message.imageMessage.caption;
            } else if (m.message.videoMessage && m.message.videoMessage.caption) {
                originalContent = m.message.videoMessage.caption;
            } else if (m.message.documentMessage && m.message.documentMessage.caption) {
                originalContent = m.message.documentMessage.caption;
            } else if (msgType === 'listResponseMessage') {
                originalContent = `Selected List Item: "${m.message.listResponseMessage.title}" (ID: ${m.message.listResponseMessage.singleSelectReply?.selectedRowId || 'N/A'})`;
            } else if (msgType === 'buttonsResponseMessage') {
                originalContent = `Clicked Button: "${m.message.buttonsResponseMessage.selectedDisplayText || m.message.buttonsResponseMessage.selectedButtonId || 'N/A'}"`;
            } else if (msgType === 'templateButtonReplyMessage') {
                originalContent = `Clicked Template Button: "${m.message.templateButtonReplyMessage.selectedDisplayText || m.message.templateButtonReplyMessage.selectedId || 'N/A'}"`;
            } else if (m.message.imageMessage || m.message.videoMessage || m.message.audioMessage || m.message.stickerMessage || m.message.documentMessage) {
                originalContent = `[${msgType.replace('Message', '').toUpperCase()} MESSAGE - Sender: ${pushName}]`;
            } else {
                console.log(`[${process.env.CLIENT_ID}_FORWARDER-API] No specific content extraction for msgType: ${msgType}. Content will be empty.`);
            }

            const fullSenderPhoneNumber = sender.split('@')[0];
            const senderPhoneNumberForApi = sender.endsWith('@s.whatsapp.net')
                ? stripCountryCode(fullSenderPhoneNumber, config.DEFAULT_PHONE_COUNTRY_CODE)
                : fullSenderPhoneNumber;

            const payload = {
                original_content: originalContent,
                sender_phone_number_from_device_contacts: senderPhoneNumberForApi,
                sender_display_name_from_notification: pushName,
                source_package_name: generateSourcePackageName(),
                client_event_key: uuidv4(),
                event_timestamp_utc: new Date(m.messageTimestamp * 1000).toISOString(),
            };

            console.log(`[${process.env.CLIENT_ID}_FORWARDER-API] Final Payload to send (truncated for log):`, JSON.stringify(payload).substring(0, 500) + '...');

            const apiToken = getApiToken();
            if (!apiToken) {
                console.error(`[${process.env.CLIENT_ID}_FORWARDER-API] No API token available. Cannot send raw notification.`);
                return;
            }

            const response = await fetch(RAW_NOTIFICATION_API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiToken}`,
                },
                body: JSON.stringify(payload),
            });
            if (response.ok) {
                const responseData = await response.json();
                console.log(`[${process.env.CLIENT_ID}_FORWARDER-API] Successfully sent raw notification. Response:${response.status}`, responseData);
            } else {
                const errorText = await response.text();
                console.error(`[${process.env.CLIENT_ID}_FORWARDER-API] Failed to send raw notification. Status: ${response.status}. Response: ${errorText}`);
            }

        } catch (error) {
            console.error(`[${process.env.CLIENT_ID}_FORWARDER-API] Critical Error processing message for API:`, error.message, error.stack);
        }
        
        return m;
    }
};
