// client-instance/plugins/forwrder.js
// Extracts message information and sends it to an external API

const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { isWhitelisted } = require('./whitelist');
const { getApiToken, stripCountryCode } = require('../lib/apiSync');
const config = require('../../config');

const API_BASE_URL = process.env.API_BASE_URL;
const RAW_NOTIFICATION_API_PATH = '/raw-notifications';
const RAW_NOTIFICATION_API_ENDPOINT = `${API_BASE_URL}${RAW_NOTIFICATION_API_PATH}`;

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
        // If you only want to forward group messages, uncomment this:
        // if (!isGroup) {
        //     console.log(`[FORWARDER-API] Skipping forwarding: Not a group message.`);
        //     return;
        // }

        console.log(`[FORWARDER-API] Initiating forwarding checks for message from ${sender.split('@')[0]} in ${isGroup ? 'group ' + chatId.split('@')[0] : 'DM'}.`);

        // 1. Check if the GROUP CHAT itself is whitelisted (if message is from a group)
        if (isGroup) {
            const isGroupWhitelisted = isWhitelisted(chatId);
            if (!isGroupWhitelisted) {
                console.log(`[FORWARDER-API] Skipping forwarding: Group ${chatId} not whitelisted.`);
                return;
            }
            console.log(`[FORWARDER-API] Group ${chatId} is whitelisted.`);
        }

        // 2. Check if the SENDER is generally whitelisted
        const isSenderGenerallyWhitelisted = isWhitelisted(sender);
        if (!isSenderGenerallyWhitelisted) {
            console.log(`[FORWARDER-API] Skipping forwarding: Sender ${sender} not generally whitelisted.`);
            return;
        }
        console.log(`[FORWARDER-API] Sender ${sender} is generally whitelisted.`);


        // 3. Check if the SENDER is specifically allowed to have messages processed IN GROUPS
        // This check only applies if it's actually a group message
        if (isGroup) {
            const senderAllowedInGroups = global.userGroupPermissions && global.userGroupPermissions[sender] === true;
            if (!senderAllowedInGroups) {
                console.log(`[FORWARDER-API] Skipping forwarding: Sender ${sender} not allowed to send messages in groups.`);
                return;
            }
            console.log(`[FORWARDER-API] Sender ${sender} is allowed in groups.`);
        }

        console.log(`[FORWARDER-API] All whitelist and permission checks passed. Proceeding to forward message.`);

        try {
            const msgType = Object.keys(m.message)[0];
            if (!m.message[msgType]) {
                console.warn(`[FORWARDER-API] Invalid message structure or unknown msgType: ${msgType}. Skipping.`);
                return;
            }

            let originalContent = "";
            if (m.message.conversation) {
                originalContent = m.message.conversation;
                console.log(`[FORWARDER-API] Extracted conversation content.`);
            } else if (m.message.extendedTextMessage) {
                originalContent = m.message.extendedTextMessage.text;
                console.log(`[FORWARDER-API] Extracted extendedTextMessage content.`);
            } else if (m.message.imageMessage && m.message.imageMessage.caption) {
                originalContent = m.message.imageMessage.caption;
                console.log(`[FORWARDER-API] Extracted imageMessage caption.`);
            } else if (m.message.videoMessage && m.message.videoMessage.caption) {
                originalContent = m.message.videoMessage.caption;
                console.log(`[FORWARDER-API] Extracted videoMessage caption.`);
            } else if (m.message.documentMessage && m.message.documentMessage.caption) {
                originalContent = m.message.documentMessage.caption;
                console.log(`[FORWARDER-API] Extracted documentMessage caption.`);
            } else if (msgType === 'listResponseMessage') {
                originalContent = `Selected List Item: "${m.message.listResponseMessage.title}" (ID: ${m.message.listResponseMessage.singleSelectReply?.selectedRowId || 'N/A'})`;
                console.log(`[FORWARDER-API] Extracted listResponseMessage content.`);
            } else if (msgType === 'buttonsResponseMessage') {
                originalContent = `Clicked Button: "${m.message.buttonsResponseMessage.selectedDisplayText || m.message.buttonsResponseMessage.selectedButtonId || 'N/A'}"`;
                console.log(`[FORWARDER-API] Extracted buttonsResponseMessage content.`);
            } else if (msgType === 'templateButtonReplyMessage') {
                originalContent = `Clicked Template Button: "${m.message.templateButtonReplyMessage.selectedDisplayText || m.message.templateButtonReplyMessage.selectedId || 'N/A'}"`;
                console.log(`[FORWARDER-API] Extracted templateButtonReplyMessage content.`);
            } else if (m.message.imageMessage || m.message.videoMessage || m.message.audioMessage || m.message.stickerMessage || m.message.documentMessage) {
                 originalContent = `[${msgType.replace('Message', '').toUpperCase()} MESSAGE]`; // Placeholder for media without text
                 console.log(`[FORWARDER-API] Extracted media message without caption: ${msgType}`);
            } else {
                console.log(`[FORWARDER-API] No specific content extraction for msgType: ${msgType}. Content will be empty.`);
            }


            const fullSenderPhoneNumber = sender.split('@')[0];
            const senderPhoneNumber = stripCountryCode(fullSenderPhoneNumber, config.DEFAULT_PHONE_COUNTRY_CODE); // Using config.DEFAULT_PHONE_COUNTRY_CODE
            
            console.log(`[FORWARDER-API] Original sender number: ${fullSenderPhoneNumber}, Stripped: ${senderPhoneNumber}`); // Added log

            const payload = {
                original_content: originalContent,
                sender_phone_number_from_device_contacts: senderPhoneNumber,
                sender_display_name_from_notification: senderPhoneNumber,
                source_package_name: generateSourcePackageName(),
                client_event_key: uuidv4(),
                event_timestamp_utc: new Date(m.messageTimestamp * 1000).toISOString(),
            };

            console.log('[FORWARDER-API] Final Payload to send (truncated for log):', JSON.stringify(payload, null, 2).substring(0, 500) + '...'); // Log truncated payload

            const apiToken = getApiToken();
            if (!apiToken) {
                console.error('[FORWARDER-API] No API token available for forwarding. Cannot send raw notification.');
                return;
            }
            console.log(`[FORWARDER-API] API token available (length: ${apiToken.length}). Sending to ${RAW_NOTIFICATION_API_ENDPOINT}.`); // Added log

            const response = await fetch(RAW_NOTIFICATION_API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiToken}`,
                },
                body: JSON.stringify(payload),
            });

            console.log(`[FORWARDER-API] Raw notification API response status: ${response.status}`); // Added log

            if (response.ok) {
                try {
                    const responseData = await response.json();
                    console.log(`[FORWARDER-API] Successfully sent raw notification. API Response (truncated):`, JSON.stringify(responseData).substring(0, 200) + '...');
                } catch (jsonError) {
                    const rawResponseText = await response.text();
                    console.log(`[FORWARDER-API] Successfully sent raw notification. Response was not JSON or empty. Status: ${response.status}. Raw response: ${rawResponseText.substring(0, 100)}...`); // Log raw response if not JSON
                }
            } else {
                const errorText = await response.text();
                console.error(`[FORWARDER-API] Failed to send raw notification. Status: ${response.status}. Response: ${errorText}`);
                if (response.status === 401 || response.status === 403) {
                    console.warn('[FORWARDER-API] Token might be invalid for raw_notification endpoint. Consider re-login or token refresh logic.');
                }
            }

        } catch (error) {
            console.error('[FORWARDER-API] Critical Error processing message for API:', error.message, error.stack); // Log stack trace
        }
    }
};