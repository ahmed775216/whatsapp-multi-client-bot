// client-instance/plugins/withdrawalRequests.js
const fetch = require('node-fetch');
const { getApiToken, syncWhitelistFromApi } = require('../lib/apiSync');
const { isWhitelisted } = require('./whitelist');
const config = require('../../config');

const WITHDRAWAL_API_PATH = '/withdrawal-requests';
const WITHDRAWAL_API_ENDPOINT = `${config.API_BASE_URL}${WITHDRAWAL_API_PATH}`;

module.exports = {
    all: async function (m, { sock, chatId, sender, isGroup, text, isOwner /* Add isOwner here for potential bypass */ }) {
        console.log(`[WITHDRAWAL_REQ] Checking message for withdrawal request from ${sender.split('@')[0]}. IsOwner: ${isOwner}.`);
        console.log(`[WITHDRAWAL_REQ_DEBUG] Raw text content: "${text}" (Length: ${text.length})`);
        console.log(`[WITHDRAWAL_REQ_DEBUG] Text.charCodeAt(0): ${text.charCodeAt(0)}`);
        console.log(`[WITHDRAWAL_REQ_DEBUG] Text.charCodeAt(text.indexOf('\\n') - 1): ${text.charCodeAt(text.indexOf('\n') - 1)}`); // Char before newline
        console.log(`[WITHDRAWAL_REQ_DEBUG] Text.charCodeAt(text.indexOf('\\n')): ${text.charCodeAt(text.indexOf('\n'))}`); // The newline char
        console.log(`[WITHDRAWAL_REQ_DEBUG] Text.charCodeAt(text.indexOf('\\n') + 1): ${text.charCodeAt(text.indexOf('\n') + 1)}`); // Char after newline


        const cleanedText = text.trim();
        const withdrawalRegex = /^سحب\s*[\r\n]+\s*(\d+)\s*$/m; // Added \s* around newlines and end anchor
        const match = cleanedText.match(withdrawalRegex);

        console.log(`[WITHDRAWAL_REQ_DEBUG] Cleaned text for regex: "${cleanedText}" (Length: ${cleanedText.length})`);
        console.log(`[WITHDRAWAL_REQ_DEBUG] Regex test result: ${withdrawalRegex.test(cleanedText)}`); // Test the regex

        if (match) {
            console.log(`[WITHDRAWAL_REQ] Detected withdrawal request command. Match:`, match);
            const transferNumber = match[1];

            // If it's the owner, bypass the whitelist check here explicitly for the command itself.
            if (!isOwner && !isWhitelisted(sender)) { // If not owner AND not whitelisted, then block.
                console.log(`[WITHDRAWAL_REQ] Sender ${sender.split('@')[0]} not whitelisted and not owner. Blocking withdrawal request.`);
                m.reply("عذراً، لا يمكنك استخدام هذا الأمر. يرجى التواصل مع المسؤول.");
                return {}; // Block message
            }
            
            console.log(`[WITHDRAWAL_REQ_DEBUG] Sender JID being processed: ${sender}`);
            console.log(`[WITHDRAWAL_REQ_DEBUG] PRE-SYNC: global.userGroupPermissions[${sender}]:`, JSON.stringify(global.userGroupPermissions[sender]));


            await syncWhitelistFromApi(); // Re-sync to ensure latest contact_ids are available

            console.log(`[WITHDRAWAL_REQ_DEBUG] POST-SYNC: global.userGroupPermissions (entire object, first 1000 chars): ${JSON.stringify(global.userGroupPermissions).substring(0, 1000)}`);
            console.log(`[WITHDRAWAL_REQ_DEBUG] POST-SYNC: global.userGroupPermissions[${sender}]:`, JSON.stringify(global.userGroupPermissions[sender]));

            const senderInfo = global.userGroupPermissions[sender]; // Access after sync

            // More detailed check for senderInfo
            if (!senderInfo) {
                console.error(`[WITHDRAWAL_REQ_ERROR] No senderInfo object found in global.userGroupPermissions for sender ${sender} AFTER sync.`);
                m.reply("عذراً، لم أتمكن من العثور على معلومات حسابك (SI). يرجى التأكد من بياناتك في النظام.");
                return {};
            }

            const contactId = senderInfo.contact_id; // Access contact_id from senderInfo

            console.log(`[WITHDRAWAL_REQ_DEBUG] Extracted senderInfo from global.userGroupPermissions:`, JSON.stringify(senderInfo));
            console.log(`[WITHDRAWAL_REQ_DEBUG] Extracted contactId from senderInfo:`, contactId);


            if (!contactId && contactId !== 0) { // Check if contactId is null, undefined, empty string, but allow 0 if it's a valid ID
                console.error(`[WITHDRAWAL_REQ_ERROR] No contact_id found for sender ${sender}. Cannot process withdrawal request. Value was: ${contactId}`);
                m.reply("عذراً، لم أتمكن من العثور على معلومات حسابك (CI). يرجى التأكد من بياناتك في النظام.");
                return {};
            }


            const apiToken = getApiToken();
            if (!apiToken) {
                console.error('[WITHDRAWAL_REQ_ERROR] No API token available. Cannot send withdrawal request.');
                m.reply("عذراً، لا يمكنني معالجة طلبك الآن بسبب مشكلة فنية. يرجى المحاولة لاحقاً.");
                return {}; // Block message
            }

            const payload = {
                contact_id: contactId,
                customer_request: "سحب",
                original_transfer_number: transferNumber

            };

            console.log(`[WITHDRAWAL_REQ] Sending withdrawal request to ${WITHDRAWAL_API_ENDPOINT} with payload:`, JSON.stringify(payload));

            try {
                const response = await fetch(WITHDRAWAL_API_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiToken}`,
                        'User-Agent': 'WhatsApp-Bot-Client-Withdrawal'
                    },
                    body: JSON.stringify(payload),
                });

                console.log(`[WITHDRAWAL_REQ] API response status: ${response.status}`);

                if (response.ok) {
                    const responseData = await response.json();
                    console.log(`[WITHDRAWAL_REQ] Successfully sent withdrawal request. API Response:`, JSON.stringify(responseData));
                    m.reply(`تم استلام طلب السحب بنجاح للمبلغ ${transferNumber}. سيتم مراجعته والتواصل معك قريبا.`);
                } else {
                    const errorText = await response.text();
                    console.error(`[WITHDRAWAL_REQ_ERROR] Failed to send withdrawal request. Status: ${response.status}. Response: ${errorText}`);
                    if (response.status === 401 || response.status === 403) {
                        console.warn('[WITHDRAWAL_REQ_ERROR] API token might be invalid for withdrawal endpoint.');
                    }
                    m.reply("عذراً، حدث خطأ أثناء معالجة طلب السحب. يرجى المحاولة مرة أخرى لاحقاً.");
                }
            } catch (error) {
                console.error(`[WITHDRAWAL_REQ_ERROR] Error sending withdrawal request:`, error.message, error.stack);
                m.reply("عذراً، حدث خطأ غير متوقع أثناء معالجة طلب السحب. يرجى المحاولة مرة أخرى لاحقاً.");
            }
            
            return {}; // BLOCK THE MESSAGE AFTER PROCESSING (SUCCESS OR FAIL)
        }

        return; // Not a withdrawal request, let other plugins handle it
    }
};