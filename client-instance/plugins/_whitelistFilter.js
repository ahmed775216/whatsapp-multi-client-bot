// client-instance/plugins/_whitelistFilter.js
// This plugin handles the whitelist filtering for all messages for an individual client bot.
// Underscore prefix ensures it loads early.

const { text } = require('express'); // This import seems unnecessary for this file
const { isWhitelisted } = require('./whitelist'); // Ensure correct path for this client instance

module.exports = {
    all: async function (m, { sock, chatId, sender, isGroup, isOwner }) {
        if (isOwner) {
            console.log(`[${process.env.CLIENT_ID}_FILTER] Owner ${sender.split('@')[0]} bypasses whitelist filter.`);
            return;
        }

        const isSenderGenerallyWhitelisted = isWhitelisted(sender);
        if (!isSenderGenerallyWhitelisted) {
            console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender.split('@')[0]} not generally whitelisted. Blocking message.`);
            if (!isGroup) {
                try {
                    // Send an explicit message in DM if not whitelisted
                    // Consider a polite one-time message if possible, or remove to avoid spamming unknown users
                    // m.reply("عذراً، لا يمكنك استخدام هذا البوت. يرجى التواصل مع المسؤول.");
                    console.log(`[${process.env.CLIENT_ID}_FILTER] Sent DM rejection to non-whitelisted user ${sender.split('@')[0]}.`);
                } catch (e) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to send DM to non-whitelisted user ${sender.split('@')[0]}: ${e.message}`); }
            }
            return {}; // Block message
        }

        if (isGroup) {
            const isChatWhitelisted = isWhitelisted(chatId);
            if (!isChatWhitelisted) {
                console.log(`[${process.env.CLIENT_ID}_FILTER] Group ${chatId.split('@')[0]} not whitelisted. Blocking message.`);
                try { 
                    await sock.sendMessage(m.key.remoteJid, { react: { text: '🚫', key: m.key } });
                    console.log(`[${process.env.CLIENT_ID}_FILTER] Reacted to message in non-whitelisted group ${chatId.split('@')[0]}.`);
                } catch (reactErr) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to react in non-whitelisted group ${chatId.split('@')[0]}: ${reactErr.message}`); }
                return {}; // Block message
            }

            // Note: global.userGroupPermissions[sender] holds an object, not just a boolean.
            // We need to check global.userGroupPermissions[sender].allowed_in_groups.
            const senderAllowedInGroups = global.userGroupPermissions && global.userGroupPermissions[sender] && global.userGroupPermissions[sender].allowed_in_groups === true;
            if (!senderAllowedInGroups) {
                console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender.split('@')[0]} is generally whitelisted but not allowed in groups. Blocking message.`);
                try {
                    await sock.sendMessage(m.key.remoteJid, { react: { text: '🚫', key: m.key } });
                    console.log(`[${process.env.CLIENT_ID}_FILTER] Reacted to message from user not allowed in group ${sender.split('@')[0]} in ${chatId.split('@')[0]}.`);
                } catch (e) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to react to group-restricted user: ${e.message}`); }
                return {}; // Block message
            }
        }
        console.log(`[${process.env.CLIENT_ID}_FILTER] Message from ${sender.split('@')[0]} in ${isGroup ? 'group ' + chatId.split('@')[0] : 'DM'} ALLOWED by whitelist filter.`);
    }
};