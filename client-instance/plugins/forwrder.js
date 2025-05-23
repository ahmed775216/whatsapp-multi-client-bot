// client-instance/plugins/forwrder.js
// Extracts message information and sends it to an external API

const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid'); // Import UUID generator
const { isWhitelisted } = require('./whitelist');
const { getApiToken, stripCountryCode } = require('../lib/apiSync'); // Import stripCountryCode from apiSync
const config = require('../../config'); // Import shared config to get DEFAULT_PHONE_COUNTRY_CODE

// API Configuration
const API_BASE_URL = process.env.API_BASE_URL; // Use process.env.API_BASE_URL from manager
const RAW_NOTIFICATION_API_PATH = '/raw-notifications'; // Specific path for this action
const RAW_NOTIFICATION_API_ENDPOINT = `${API_BASE_URL}${RAW_NOTIFICATION_API_PATH}`;

// Helper function to generate a random 5-character string
function generateSourcePackageName() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 5; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

module.exports = {
    all: async function (m, { sock, chatId, sender, isGroup, groupMetadata }) {
        // Uncomment this if you only want to forward group messages
        // if (!isGroup) {
        //     return;
        // }

        // 1. Check if the GROUP CHAT itself is whitelisted (if message is from a group)
        if (isGroup) {
            const isGroupWhitelisted = isWhitelisted(chatId);
            if (!isGroupWhitelisted) {
                console.log(`[FORWARDER-API] Group ${chatId} not whitelisted. Skipping forwarding.`);
                return;
            }
        }
        // If not a group, it must be a DM, which doesn't have a group to whitelist.
        // The check `isSenderGenerallyWhitelisted` still applies for DMs.

        // 2. Check if the SENDER is generally whitelisted
        const isSenderGenerallyWhitelisted = isWhitelisted(sender);
        if (!isSenderGenerallyWhitelisted) {
            console.log(`[FORWARDER-API] Sender ${sender} not generally whitelisted. Skipping forwarding.`);
            return;
        }

        // 3. Check if the SENDER is specifically allowed to have messages processed IN GROUPS
        // This check only applies if it's actually a group message
        if (isGroup) {
            const senderAllowedInGroups = global.userGroupPermissions && global.userGroupPermissions[sender] === true;
            if (!senderAllowedInGroups) {
                console.log(`[FORWARDER-API] Sender ${sender} not allowed to send messages in groups. Skipping forwarding.`);
                return;
            }
        }

        console.log(`[FORWARDER-API] Processing message from ${sender.split('@')[0]} in ${isGroup ? 'group ' + chatId.split('@')[0] : 'DM'} to send to API.`);

        try {
            const msgType = Object.keys(m.message)[0];
            if (!m.message[msgType]) {
                console.warn(`[FORWARDER-API] Invalid message structure or unknown msgType: ${msgType}`);
                return;
            }

            let originalContent = "";
            // Extract original_content based on message type
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
            }
            // For media without text, originalContent will be empty.
            // If you need a placeholder for media without text, you can add it here:
            // if (!originalContent && (m.message.imageMessage || m.message.videoMessage || m.message.audioMessage || m.message.stickerMessage || m.message.documentMessage)) {
            //     originalContent = `[${msgType.replace('Message', '').toUpperCase()}]`;
            // }

            const fullSenderPhoneNumber = sender.split('@')[0];
            // Use the stripCountryCode function from apiSync.js and the default country code
            const senderPhoneNumber = stripCountryCode(fullSenderPhoneNumber, config.DEFAULT_PHONE_COUNTRY_CODE);
            // const senderDisplayName = m.pushName || senderPhoneNumber; // Not used directly in payload per new spec

            const payload = {
                original_content: originalContent,
                sender_phone_number_from_device_contacts: senderPhoneNumber,
                sender_display_name_from_notification: senderPhoneNumber, // Same as sender_phone_number_from_device_contacts
                source_package_name: generateSourcePackageName(), // Generate 5 char key
                client_event_key: uuidv4(), // Use UUID for a unique key
                event_timestamp_utc: new Date(m.messageTimestamp * 1000).toISOString(),
            };

            console.log('[FORWARDER-API] Payload to send:', JSON.stringify(payload, null, 2));

            const apiToken = getApiToken();
            if (!apiToken) {
                console.error('[FORWARDER-API] No API token available. Cannot send raw notification.');
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
                try {
                    const responseData = await response.json();
                    console.log(`[FORWARDER-API] Successfully sent raw notification for message ${m.key.id}. API Response:`, responseData);
                } catch (jsonError) {
                    console.log(`[FORWARDER-API] Successfully sent raw notification for message ${m.key.id}. Response was not JSON or empty. Status: ${response.status}`);
                }
            } else {
                const errorText = await response.text();
                console.error(`[FORWARDER-API] Failed to send raw notification. Status: ${response.status}. Response: ${errorText}`);
                if (response.status === 401 || response.status === 403) {
                    console.warn('[FORWARDER-API] Token might be invalid for raw_notification endpoint. Consider re-login or token refresh logic.');
                }
            }

        } catch (error) {
            console.error('[FORWARDER-API] Error processing message for API:', error);
        }
    }
};