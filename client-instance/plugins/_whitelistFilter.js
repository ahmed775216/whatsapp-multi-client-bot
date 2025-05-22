// client-instance/plugins/_whitelistFilter.js
// This plugin handles the whitelist filtering for all messages for an individual client bot.
// Underscore prefix ensures it loads early.

const { isWhitelisted } = require('./whitelist'); // Ensure correct path for this client instance

module.exports = {
    all: async function (m, { sock, chatId, sender, isGroup, isOwner }) {
        if (isOwner) {
            // console.log(`[FILTER] Owner ${sender.split('@')[0]} bypass.`);
            return;
        }

        const isSenderGenerallyWhitelisted = isWhitelisted(sender);
        if (!isSenderGenerallyWhitelisted) {
            console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender.split('@')[0]} not generally whitelisted. Blocking.`);
            if (!isGroup) {
                try {
                    await sock.sendMessage(sender, { text: `Sorry, you are not authorized to use this bot.` });
                } catch (e) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to send DM to non-whitelisted user: ${sender}`, e); }
            }
            return {};
        }

        if (isGroup) {
            const isChatWhitelisted = isWhitelisted(chatId);
            if (!isChatWhitelisted) {
                console.log(`[${process.env.CLIENT_ID}_FILTER] Group ${chatId.split('@')[0]} not whitelisted. Blocking.`);
                try { await sock.sendMessage(m.key.remoteJid, { react: { text: '🚫', key: m.key } }); } catch (reactErr) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] React failed`, reactErr); }
                return {};
            }

            // CRITICAL: Check sender's specific group permission for this client bot
            // global.userGroupPermissions for this client bot instance
            const senderAllowedInGroups = global.userGroupPermissions && global.userGroupPermissions[sender] === true;
            if (!senderAllowedInGroups) {
                console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender.split('@')[0]} not allowed to use bot in groups. Blocking.`);
                try {
                    await sock.sendMessage(m.key.remoteJid, { react: { text: '🚫', key: m.key } });
                    // Or send DM: await sock.sendMessage(sender, { text: `You are whitelisted for private use, but not authorized to use this bot in group chats.` });
                } catch (e) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] React/DM failed for group restriction: ${sender}`, e); }
                return {};
            }
        }
        // console.log(`[${process.env.CLIENT_ID}_FILTER] Message allowed from ${sender.split('@')[0]} in ${isGroup ? 'group' : 'DM'}.`);
    }
};