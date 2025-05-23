// client-instance/plugins/_whitelistFilter.js
// This plugin handles the whitelist filtering for all messages for an individual client bot.
// Underscore prefix ensures it loads early.

const { text } = require('express');
const { isWhitelisted } = require('./whitelist'); // Ensure correct path for this client instance

module.exports = {
    all: async function (m, { sock, chatId, sender, isGroup, isOwner }) {
        if (isOwner) {
            console.log(`[${process.env.CLIENT_ID}_FILTER] Owner ${sender.split('@')[0]} bypasses whitelist filter.`); // Added log
            return;
        }

        const isSenderGenerallyWhitelisted = isWhitelisted(sender);
        if (!isSenderGenerallyWhitelisted) {
            console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender.split('@')[0]} not generally whitelisted. Blocking message.`); // Added log
            if (!isGroup) {
                try {
                    console.log(`[${process.env.CLIENT_ID}_FILTER] Sent DM rejection to non-whitelisted user ${sender.split('@')[0]}.`); // Added log
                } catch (e) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to send DM to non-whitelisted user ${sender.split('@')[0]}: ${e.message}`); }
            }
            return {}; // Block message
        }

        if (isGroup) {
            const isChatWhitelisted = isWhitelisted(chatId);
            if (!isChatWhitelisted) {
                console.log(`[${process.env.CLIENT_ID}_FILTER] Group ${chatId.split('@')[0]} not whitelisted. Blocking message.`); // Added log
                try { 
                    await sock.sendMessage(m.key.remoteJid, { react: { text: '🚫', key: m.key } });
                    console.log(`[${process.env.CLIENT_ID}_FILTER] Reacted to message in non-whitelisted group ${chatId.split('@')[0]}.`); // Added log
                } catch (reactErr) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to react in non-whitelisted group ${chatId.split('@')[0]}: ${reactErr.message}`); }
                return {}; // Block message
            }

            const senderAllowedInGroups = global.userGroupPermissions && global.userGroupPermissions[sender] === true;
            if (!senderAllowedInGroups) {
                console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender.split('@')[0]} is generally whitelisted but not allowed in groups. Blocking message.`); // Added log
                try {
                    await sock.sendMessage(m.key.remoteJid, { react: { text: '🚫', key: m.key } });
                    console.log(`[${process.env.CLIENT_ID}_FILTER] Reacted to message from user not allowed in group ${sender.split('@')[0]} in ${chatId.split('@')[0]}.`); // Added log
                } catch (e) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to react to group-restricted user: ${e.message}`); }
                return {}; // Block message
            }
        }
        console.log(`[${process.env.CLIENT_ID}_FILTER] Message from ${sender.split('@')[0]} in ${isGroup ? 'group ' + chatId.split('@')[0] : 'DM'} ALLOWED by whitelist filter.`); // Added log
    }
};