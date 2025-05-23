// client-instance/handler.js
const { getContentType, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');

const { addToWhitelist, removeFromWhitelist, formatJid } = require('./plugins/whitelist');
const forwarderPlugin = require('./plugins/forwrder.js');

const plugins = {};

const ALL_HANDLERS_FROM_PLUGINS = [
    require('./plugins/_whitelistFilter.js').all,
    forwarderPlugin.all
];

async function handleMessage(sock, m, options = {}) {
    if (!m.message) {
        console.log("[HANDLER] Message object is empty, skipping."); // Added log
        return;
    }
    const msgType = getContentType(m.message);
    if (!msgType) {
        console.warn("[HANDLER] Could not determine message type, skipping."); // Added log
        return;
    }

    if (msgType === 'protocolMessage' || msgType === 'senderKeyDistributionMessage') {
        console.log(`[HANDLER] Ignoring protocol/senderKeyDistribution message type: ${msgType}`); // Added log
        return;
    }

    const chatId = m.key.remoteJid;
    const sender = jidNormalizedUser(m.key.participant || m.key.remoteJid);
    const isGroup = chatId.endsWith('@g.us');

    const ownerNumbers = (process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC || "").split(',').map(num => num.trim());
    const isOwner = ownerNumbers.includes(sender.split('@')[0]);
    console.log(`[HANDLER] Processing message from ${sender.split('@')[0]} in ${isGroup ? 'group' : 'DM'} (Is Owner: ${isOwner}). Text: "${m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || ''}"`); // Added verbose log

    m.reply = (text, targetChatId = m.key.remoteJid, replyOptions = {}) => sock.sendMessage(targetChatId, (typeof text === 'string') ? { text: text } : text, { quoted: m, ...replyOptions });

    const msgContextInfo = m.message?.[msgType]?.contextInfo;
    m.mentionedJid = msgContextInfo?.mentionedJid || [];

    if (m.message?.[msgType]?.contextInfo?.quotedMessage) {
        console.log("[HANDLER] Message is a reply."); // Added log
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
        console.log(`[HANDLER] Message contains media: ${msgType}`); // Added log
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
            console.log(`[HANDLER] Group Info: ${groupMetadata.subject}, Bot Admin: ${isBotAdmin}, Sender Admin: ${isAdmin}`); // Added log
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

    for (const allHandler of ALL_HANDLERS_FROM_PLUGINS) {
        console.log(`[HANDLER] Running 'all' plugin: ${allHandler.name || 'Anonymous'}`); // Added log for plugin execution
        try {
            const blockResult = await allHandler(m, ctx);
            if (blockResult && typeof blockResult === 'object' && Object.keys(blockResult).length === 0) {
                console.log(`[HANDLER] Message blocked by 'all' plugin (${allHandler.name || 'Anonymous'}). Halting further processing.`); // Added log
                return;
            }
        } catch (e) {
            console.error(`[HANDLER_ERROR] Error in 'all' plugin (${allHandler.name || 'Anonymous'}):`, e);
        }
    }

    const command = ctx.text.split(' ')[0];
    const args = ctx.text.split(' ').slice(1);

    if (ctx.isOwner) {
        console.log(`[HANDLER] Owner command received: ${command}`); // Added log
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
                    console.warn(`[HANDLER] Whitelistgroup command used outside a group by owner.`); // Added log
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
                    console.warn(`[HANDLER] Removegroup command used outside a group by owner.`); // Added log
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
                        console.warn(`[HANDLER] Invalid number format for addtochatwhitelist: ${numberToAdd}`); // Added log
                    }
                } else {
                    m.reply(`Usage: !addtochatwhitelist <phone_number>`);
                    console.warn(`[HANDLER] Missing argument for addtochatwhitelist.`); // Added log
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
                        console.warn(`[HANDLER] Invalid number format for removefromchatwhitelist: ${numberToRemove}`); // Added log
                    }
                } else {
                    m.reply(`Usage: !removefromchatwhitelist <phone_number>`);
                    console.warn(`[HANDLER] Missing argument for removefromchatwhitelist.`); // Added log
                }
                break;
            default:
                console.log(`[HANDLER] Unknown owner command: ${command}. No action taken.`); // Added log
                break;
        }
    } else {
        console.log(`[HANDLER] Non-owner message, not processing as command.`); // Added log
    }
}

module.exports = { handleMessage };