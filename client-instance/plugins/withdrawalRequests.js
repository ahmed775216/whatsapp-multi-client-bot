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

        // Optional: If 'سحب' command should *always* bypass general whitelist,
        // you can put an 'isOwner' check here and return, similar to forwrder.js
        // For now, keeping the whitelist check below but with a more forgiving regex.

        // Regex for "سحب", optionally followed by any whitespace, then a newline, then numbers, then optional whitespace.
        // It allows for flexible whitespace around the command and number.
        // `\s*` allows zero or more whitespace characters.
        // `[\r\n]+` handles one or more newline characters (CRLF or LF).
        // `trim()` is applied to the input text to remove leading/trailing whitespace.
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

            await syncWhitelistFromApi(); // Re-sync to ensure latest contact_ids are available

            const senderInfo = global.userGroupPermissions[sender];
            const contactId = senderInfo ? senderInfo.contact_id : null;

            if (!contactId) {
                console.error(`[WITHDRAWAL_REQ_ERROR] No contact_id found for sender ${sender}. Cannot process withdrawal request.`);
                m.reply("عذراً، لم أتمكن من العثور على معلومات حسابك. يرجى التأكد من بياناتك في النظام.");
                return {}; // Block message as it's a command we tried to handle but failed
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

            console.log(`[WITHDRAWAL_REQ] Sending withdrawal request to ${WITHDRAWAL_API_ENDPOINT} with payload (truncated):`, JSON.stringify(payload).substring(0, 500) + '...');

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
                    console.log(`[WITHDRAWAL_REQ] Successfully sent withdrawal request. API Response (truncated):`, JSON.stringify(responseData).substring(0, 200) + '...');
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