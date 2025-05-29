// client-instance/plugins/forwrder.js
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
    all: async function (m, { sock, chatId, sender, isGroup, groupMetadata, isOwner, pushName /* pushName now passed in ctx */ }) {
        console.log(`[${process.env.CLIENT_ID}_FORWARDER-API] Initiating forwarding for message from ${sender.split('@')[0]} (Name: ${pushName}) in ${isGroup ? 'group ' + (groupMetadata?.subject || chatId.split('@')[0]) : 'DM'}. IsOwner: ${isOwner}.`);

        // فلتر القائمة البيضاء الأساسي يجب أن يكون قد تم تطبيقه في _whitelistFilter.js
        // هنا، نفترض أن الرسالة مسموح بها للمتابعة إذا وصلت إلى هذه النقطة.
        // ومع ذلك، قد تحتاج إلى إعادة فحص isWhitelisted(sender) إذا كنت تريد فلترة إضافية خاصة بهذا الـ plugin.

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

            const fullSenderPhoneNumber = sender.split('@')[0]; // هذا قد يكون رقم أو جزء من @lid
            // إذا كان sender هو @lid ولم يتم حله، فإن stripCountryCode لن يفعل الكثير
            const senderPhoneNumberForApi = sender.endsWith('@s.whatsapp.net')
                ? stripCountryCode(fullSenderPhoneNumber, config.DEFAULT_PHONE_COUNTRY_CODE)
                : fullSenderPhoneNumber; // إذا كان @lid، أرسله كما هو أو "غير معروف"

            const payload = {
                original_content: originalContent,
                sender_phone_number_from_device_contacts: senderPhoneNumberForApi,
                sender_display_name_from_notification: pushName, // استخدام pushName المستلم
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
                // ... (نفس معالجة الاستجابة)
                console.log(`[${process.env.CLIENT_ID}_FORWARDER-API] Successfully sent raw notification. Status: ${response.status}`);
            } else {
                const errorText = await response.text();
                console.error(`[${process.env.CLIENT_ID}_FORWARDER-API] Failed to send raw notification. Status: ${response.status}. Response: ${errorText}`);
            }

        } catch (error) {
            console.error(`[${process.env.CLIENT_ID}_FORWARDER-API] Critical Error processing message for API:`, error.message, error.stack);
        }
        // لا تحظر الرسالة هنا، دعها تستمر للمعالجات الأخرى إذا لزم الأمر
        return m;
    }
};