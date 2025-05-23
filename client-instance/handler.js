// client-instance/handler.js
const { getContentType, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');

// Import whitelist and other necessary functions/modules
const { addToWhitelist, removeFromWhitelist, formatJid } = require('./plugins/whitelist');

// Import the new forwarder plugin
const forwarderPlugin = require('./plugins/forwrder.js'); // Note the filename: forwrder.js

const plugins = {};

// Load ALL_HANDLERS_FROM_PLUGINS
const ALL_HANDLERS_FROM_PLUGINS = [
    require('./plugins/_whitelistFilter.js').all, // Whitelist filter should generally run first
    forwarderPlugin.all // Add the new forwarder plugin here
];

async function handleMessage(sock, m, options = {}) {
        // Basic Message Checks
    if (!m.message) return;

    // --- FIX START ---
    // Define msgType here, BEFORE its first usage
    const msgType = getContentType(m.message);
    // --- FIX END ---

    if (msgType === 'protocolMessage' || msgType === 'senderKeyDistributionMessage') return;
    const chatId = m.key.remoteJid;
    const sender = jidNormalizedUser(m.key.participant || m.key.remoteJid);
    const isGroup = chatId.endsWith('@g.us');

    const ownerNumbers = (process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC || "").split(',').map(num => num.trim());
    const isOwner = ownerNumbers.includes(sender.split('@')[0]);

    m.reply = (text, targetChatId = m.key.remoteJid, replyOptions = {}) => sock.sendMessage(targetChatId, (typeof text === 'string') ? { text: text } : text, { quoted: m, ...replyOptions });

    const msgContextInfo = m.message?.[msgType]?.contextInfo;
    m.mentionedJid = msgContextInfo?.mentionedJid || [];

    if (m.message?.[msgType]?.contextInfo?.quotedMessage) {
        m.quoted = {
            key: {
                remoteJid: m.key.remoteJid,
                id: m.message[msgType].contextInfo.stanzaId,
                participant: m.message[msgType].contextInfo.participant
            },
            message: m.message[msgType].contextInfo.quotedMessage,
            sender: m.message[msgType].contextInfo.participant,
        };
    }
    if (m.message?.[msgType]?.mimetype) {
         m.download = () => require('@whiskeysockets/baileys').downloadContentFromMessage(m.message[msgType], msgType.replace('Message', ''));
    }

    let groupMetadata = {};
    let participants = [];
    let isAdmin = false;
    let isBotAdmin = false;

    if (isGroup) {
        try {
            groupMetadata = await sock.groupMetadata(chatId);
            participants = groupMetadata.participants || [];
            const botJid = jidNormalizedUser(sock.user?.id);
            const botParticipant = participants.find(p => p.id === botJid);
            isBotAdmin = botParticipant && botParticipant.admin === 'admin';

            const senderParticipant = participants.find(p => p.id === sender);
            isAdmin = senderParticipant && senderParticipant.admin === 'admin';
        } catch (e) {
            console.warn(`[HANDLER] Could not fetch group metadata or participant info for ${chatId}:`, e.message);
        }
    }

    const ctx = {
        sock,
        m,
        chatId,
        sender,
        text: m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || '',
        usedPrefix: '!',
        isGroup,
        participants,
        groupMetadata,
        isAdmin,
        isBotAdmin,
        isOwner,
        botJid: jidNormalizedUser(sock.user?.id),
    };

    // --- Process 'all' type handlers first (e.g., whitelistFilter, then forwarder) ---
    for (const allHandler of ALL_HANDLERS_FROM_PLUGINS) {
        try {
            // If a handler returns an object with no keys (e.g., {}), it signifies blockage
            const blockResult = await allHandler(m, ctx);
            if (blockResult && typeof blockResult === 'object' && Object.keys(blockResult).length === 0) {
                console.log(`[HANDLER] Message blocked by 'all' plugin.`);
                return; // Stop further processing if blocked
            }
        } catch (e) {
            console.error(`[HANDLER_ERROR] Error in 'all' handler:`, e);
        }
    }

    // --- Command Processing for Groups (ONLY FOR OWNER) ---
    const command = ctx.text.split(' ')[0];
    const args = ctx.text.split(' ').slice(1);

    if (ctx.isOwner) {
        switch (command) {
            case '!whitelistgroup':
                if (ctx.isGroup) {
                    const addResult = addToWhitelist(ctx.chatId);
                    if (addResult.success) {
                        m.reply(`This group has been added to the whitelist.`);
                        console.log(`[HANDLER] Whitelisted group: ${ctx.chatId}`);
                    } else if (addResult.reason === 'already_whitelisted') {
                        m.reply(`This group is already whitelisted.`);
                    } else {
                        m.reply(`Failed to whitelist this group: ${addResult.reason}`);
                        console.error(`[HANDLER] Failed to whitelist group ${ctx.chatId}: ${addResult.reason}`);
                    }
                } else {
                    m.reply(`This command can only be used in a group.`);
                }
                break;

            case '!removegroup':
                if (ctx.isGroup) {
                    const removeResult = removeFromWhitelist(ctx.chatId);
                    if (removeResult.success) {
                        m.reply(`This group has been removed from the whitelist.`);
                        console.log(`[HANDLER] Removed group from whitelist: ${ctx.chatId}`);
                    } else if (removeResult.reason === 'not_whitelisted') {
                        m.reply(`This group is not currently whitelisted.`);
                    } else {
                        m.reply(`Failed to remove group from whitelist: ${removeResult.reason}`);
                        console.error(`[HANDLER] Failed to remove group ${ctx.chatId}: ${removeResult.reason}`);
                    }
                } else {
                    m.reply(`This command can only be used in a group.`);
                }
                break;

            case '!addtochatwhitelist':
                if (args.length > 0) {
                    const numberToAdd = args[0];
                    const jidToAdd = formatJid(numberToAdd);

                    if (jidToAdd.endsWith('@s.whatsapp.net')) {
                        const addResult = addToWhitelist(jidToAdd);
                        if (addResult.success) {
                            m.reply(`User ${jidToAdd.split('@')[0]} added to general whitelist.`);
                            console.log(`[HANDLER] Whitelisted user: ${jidToAdd}`);
                        } else {
                            m.reply(`Failed to add user to general whitelist: ${addResult.reason}`);
                            console.error(`[HANDLER] Failed to whitelist user ${jidToAdd}: ${addResult.reason}`);
                        }
                    } else {
                        m.reply(`Invalid number format. Please provide a valid phone number.`);
                    }
                } else {
                    m.reply(`Usage: !addtochatwhitelist <phone_number>`);
                }
                break;
            
            case '!removefromchatwhitelist':
                if (args.length > 0) {
                    const numberToRemove = args[0];
                    const jidToRemove = formatJid(numberToRemove);

                    if (jidToRemove.endsWith('@s.whatsapp.net')) {
                        const removeResult = removeFromWhitelist(jidToRemove);
                        if (removeResult.success) {
                            m.reply(`User ${jidToRemove.split('@')[0]} removed from general whitelist.`);
                            console.log(`[HANDLER] Removed user from general whitelist: ${jidToRemove}`);
                        } else {
                            m.reply(`Failed to remove user from general whitelist: ${removeResult.reason}`);
                            console.error(`[HANDLER] Failed to remove user ${jidToRemove}: ${removeResult.reason}`);
                        }
                    } else {
                        m.reply(`Invalid number format. Please provide a valid phone number.`);
                    }
                } else {
                    m.reply(`Usage: !removefromchatwhitelist <phone_number>`);
                }
                break;
            default:
                break;
        }
    }
}

module.exports = { handleMessage };