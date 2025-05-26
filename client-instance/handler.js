// client-instance/handler.js
const { getContentType, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');

const { addToWhitelist, removeFromWhitelist, formatJid, isWhitelisted } = require ('./plugins/whitelist.js');
const forwarderPlugin = require('./plugins/forwrder.js');
const withdrawalRequestsPlugin = require('./plugins/withdrawalRequests.js');

const ALL_HANDLERS_FROM_PLUGINS = [
    require('./plugins/_whitelistFilter.js').all,
    withdrawalRequestsPlugin.all,
    forwarderPlugin.all
];

async function handleMessage(sock, m, options = {}) {
    const isInternalCommand = options.isInternalCommand || false;
    const internalReply = options.internalReply || null;
    const clientIdForReply = options.clientId || null;

    // For internal commands, authorization comes from the manager.
    // The 'isOwner' for *internal* commands is less about the sender of a WhatsApp message
    // and more about whether this bot instance *itself* is an owner, which might grant it special internal capabilities.
    // However, for most internal commands like fetching data, this isn't strictly necessary.
    // The `isBotOwnerForInternal` check was simplified/removed from this specific section
    // as the commands primarily fetch data or modify a whitelist based on manager's instruction.

    if (isInternalCommand) {
        console.log(`[HANDLER_INTERNAL] Client ${clientIdForReply} received internal command: ${options.command} with payload:`, { groupId: options.groupId, participantJid: options.participantJid });
        try {
            switch (options.command) {
                case 'fetchGroups':
                    const groups = await sock.groupFetchAllParticipating();
                    const formattedGroups = Object.values(groups).map(g => ({
                        id: g.id,
                        subject: g.subject,
                        participantsCount: g.participants.length,
                        isWhitelisted: isWhitelisted(g.id) // Check whitelist status for the group JID
                    }));
                    if (internalReply) internalReply({ type: 'groupsList', groups: formattedGroups, clientId: clientIdForReply });
                    console.log(`[HANDLER_INTERNAL] Client ${clientIdForReply} fetched ${formattedGroups.length} groups.`);
                    break;

                case 'addChatToWhitelist':
                case 'removeFromChatWhitelist':
                    const jidToModify = options.groupId || options.participantJid;
                    if (!jidToModify) {
                        if (internalReply) internalReply({ type: 'error', message: 'JID (groupId or participantJid) is required for (un)whitelisting.', clientId: clientIdForReply });
                        return; // Exit early
                    }

                    let modResult;
                    let itemType = jidToModify.endsWith('@g.us') ? 'group' : 'user';
                    let actionType = ''; // For the reply type

                    if (options.command === 'addChatToWhitelist') {
                        modResult = addToWhitelist(jidToModify);
                        actionType = 'addChatToWhitelistResponse';
                        console.log(`[HANDLER_INTERNAL] Client ${clientIdForReply} attempting to add ${itemType} ${jidToModify} to whitelist. Result: ${modResult.success}`);
                    } else { // removeFromChatWhitelist
                        modResult = removeFromWhitelist(jidToModify);
                        actionType = 'removeFromChatWhitelistResponse';
                        console.log(`[HANDLER_INTERNAL] Client ${clientIdForReply} attempting to remove ${itemType} ${jidToModify} from whitelist. Result: ${modResult.success}`);
                    }

                    if (internalReply) internalReply({
                        type: actionType,
                        success: modResult.success,
                        reason: modResult.reason,
                        jid: jidToModify,
                        typeOfItem: itemType,
                        clientId: clientIdForReply
                    });
                    break;

                case 'fetchParticipants':
                    const groupJidForParticipants = options.groupId;
                    if (!groupJidForParticipants) {
                        if (internalReply) internalReply({ type: 'error', message: 'Group ID is required for fetching participants.', clientId: clientIdForReply });
                        return; // Exit early
                    }
                    const groupMeta = await sock.groupMetadata(groupJidForParticipants);
                    const participants = groupMeta.participants.map(p => {
                        const participantJid = jidNormalizedUser(p.id);
                        return {
                            jid: participantJid,
                            isAdmin: (p.admin === 'admin' || p.admin === 'superadmin'),
                            isWhitelisted: isWhitelisted(participantJid) // Check whitelist status for the participant JID
                        };
                    });
                    if (internalReply) internalReply({ type: 'participantsList', participants: participants, groupId: groupJidForParticipants, clientId: clientIdForReply });
                    console.log(`[HANDLER_INTERNAL] Client ${clientIdForReply} fetched ${participants.length} participants for group ${groupJidForParticipants}.`);
                    break;

                default:
                    console.warn(`[HANDLER_INTERNAL] Client ${clientIdForReply} received unrecognized internal command: ${options.command}`);
                    if (internalReply) internalReply({ type: 'error', message: `Unrecognized internal command: ${options.command}`, clientId: clientIdForReply });
            }
        } catch (e) {
            console.error(`[HANDLER_INTERNAL_ERROR] Client ${clientIdForReply} error processing internal command ${options.command}:`, e.message, e.stack);
            if (internalReply) internalReply({ type: 'error', message: `Error processing command ${options.command}: ${e.message}`, clientId: clientIdForReply });
        }
        return; // Internal commands processed, stop further execution for this "message"
    }

    // --- Regular WhatsApp Message Processing ---
    if (!m.message) {
        console.log("[HANDLER] Message object is empty, skipping."); // Can be noisy
        return;
    }
    const msgType = getContentType(m.message);
    if (!msgType) {
        console.warn("[HANDLER] Could not determine message type, skipping.");
        return;
    }

    if (msgType === 'protocolMessage' || msgType === 'senderKeyDistributionMessage') {
        console.log(`[HANDLER] Ignoring protocol/senderKeyDistribution message type: ${msgType}`); // Can be noisy
        return;
    }

    const chatId = m.key.remoteJid;
    const initialSenderFromMessageKey = jidNormalizedUser(m.key.participant || m.key.remoteJid);
    const isGroup = chatId.endsWith('@g.us');
    let actualSenderForLogic = initialSenderFromMessageKey;
    let isOwner = false; // This is for the WhatsApp message sender

    const botCanonicalJid = sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : null;
    const botLid = sock.user && sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;

    if (botCanonicalJid && (areJidsSameUser(initialSenderFromMessageKey, botCanonicalJid) || (botLid && areJidsSameUser(initialSenderFromMessageKey, botLid)))) {
        isOwner = true;
        actualSenderForLogic = botCanonicalJid;
    } else {
        const ownerPhoneNumberStrings = (process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC || "").split(',').map(num => num.trim().replace(/@s\.whatsapp\.net$/, '')).filter(num => num);
        for (const ownerPhone of ownerPhoneNumberStrings) {
            if (ownerPhone) {
                const configuredOwnerJid = formatJid(ownerPhone); // formatJid will add @s.whatsapp.net
                if (areJidsSameUser(initialSenderFromMessageKey, configuredOwnerJid)) {
                    isOwner = true;
                    actualSenderForLogic = configuredOwnerJid;
                    break;
                }
            }
        }
    }

    let groupMetadata = {};
    let participants = [];
    let isBotAdmin = false;
    let isAdminOfGroup = false;

    if (isGroup) {
        try {
            groupMetadata = await sock.groupMetadata(chatId);
            participants = groupMetadata.participants || [];
            if (actualSenderForLogic.endsWith('@lid') && !isOwner) {
                const senderParticipantInfo = participants.find(p => p && p.id && areJidsSameUser(p.id, initialSenderFromMessageKey));
                if (senderParticipantInfo && senderParticipantInfo.id) {
                    actualSenderForLogic = jidNormalizedUser(senderParticipantInfo.id);
                }
            }
            const botParticipant = participants.find(p => p && p.id && areJidsSameUser(p.id, botCanonicalJid));
            isBotAdmin = !!(botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin'));
            const senderAdminInfo = participants.find(p => p && p.id && areJidsSameUser(p.id, actualSenderForLogic));
            isAdminOfGroup = !!(senderAdminInfo && (senderAdminInfo.admin === 'admin' || senderAdminInfo.admin === 'superadmin'));
        } catch (e) {
            console.error(`[HANDLER_ERROR] Could not fetch group metadata for ${chatId}: ${e.message}.`);
        }
    }

    console.log(`[HANDLER] MSG From: ${actualSenderForLogic.split('@')[0]} in ${isGroup ? 'Group: ' + (groupMetadata.subject || chatId.split('@')[0]) : 'DM'}. IsOwner: ${isOwner}.`); // Can be noisy

    m.reply = (text, targetChatId = m.key.remoteJid, replyOptions = {}) => sock.sendMessage(targetChatId, (typeof text === 'string') ? { text: text } : text, { quoted: m, ...replyOptions });
    const msgContextInfo = m.message?.[msgType]?.contextInfo;
    m.mentionedJid = msgContextInfo?.mentionedJid || [];
    if (m.message?.[msgType]?.contextInfo?.quotedMessage) {
        m.quoted = { /* ... quoted message setup ... */ };
    }
    if (m.message?.[msgType]?.mimetype) {
        m.download = () => require('@whiskeysockets/baileys').downloadContentFromMessage(m.message[msgType], msgType.replace('Message', ''));
    }

    const ctx = {
        sock, m, chatId,
        sender: actualSenderForLogic,
        text: m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || '',
        usedPrefix: '!', isGroup, participants, groupMetadata,
        isAdmin: isAdminOfGroup, isBotAdmin, isOwner,
        botJid: botCanonicalJid,
    };

    for (const allHandler of ALL_HANDLERS_FROM_PLUGINS) {
        try {
            const blockResult = await allHandler(m, ctx);
            if (blockResult && typeof blockResult === 'object' && Object.keys(blockResult).length === 0) {
                console.log(`[HANDLER] Message blocked by 'all' plugin (${allHandler.name || 'Anonymous'}).`); // Can be noisy
                return;
            }
        } catch (e) {
            console.error(`[HANDLER_ERROR] Error in 'all' plugin (${allHandler.name || 'Anonymous'}):`, e);
        }
    }

    // --- Owner Commands for WhatsApp messages ---
    const command = ctx.text.split(' ')[0];
    const args = ctx.text.split(' ').slice(1);

    if (ctx.isOwner) { // This uses isOwner derived from WhatsApp message sender
        console.log(`[HANDLER] Owner command received via WhatsApp: ${command}.`); // Can be noisy
        switch (command) {
            case '!whitelistgroup':
                if (ctx.isGroup) {
                    const addResult = addToWhitelist(ctx.chatId);
                    m.reply(addResult.success ? `Group ${ctx.groupMetadata.subject || ctx.chatId} added to whitelist.` : `Failed: ${addResult.reason}`);
                } else { m.reply(`This command can only be used in a group.`); }
                break;
            case '!removegroup':
                if (ctx.isGroup) {
                    const removeResult = removeFromWhitelist(ctx.chatId);
                    m.reply(removeResult.success ? `Group ${ctx.groupMetadata.subject || ctx.chatId} removed from whitelist.` : `Failed: ${removeResult.reason}`);
                } else { m.reply(`This command can only be used in a group.`); }
                break;
            case '!addtochatwhitelist': // For adding users or groups via owner's WhatsApp
                if (args.length > 0) {
                    const jidToAdd = formatJid(args[0]);
                    if (jidToAdd) {
                        const addResult = addToWhitelist(jidToAdd);
                        m.reply(addResult.success ? `${jidToAdd.split('@')[0]} added to general whitelist.` : `Failed: ${addResult.reason}`);
                    } else { m.reply(`Invalid JID format: ${args[0]}`); }
                } else { m.reply(`Usage: !addtochatwhitelist <phone_number_or_group_jid>`); }
                break;
            case '!removefromchatwhitelist':
                if (args.length > 0) {
                    const jidToRemove = formatJid(args[0]);
                    if (jidToRemove) {
                        const removeResult = removeFromWhitelist(jidToRemove);
                        m.reply(removeResult.success ? `${jidToRemove.split('@')[0]} removed from general whitelist.` : `Failed: ${removeResult.reason}`);
                    } else { m.reply(`Invalid JID format: ${args[0]}`); }
                } else { m.reply(`Usage: !removefromchatwhitelist <phone_number_or_group_jid>`); }
                break;
            // default: console.log(`[HANDLER] Unknown owner command via WhatsApp: ${command}.`); // Can be noisy
        }
    }
}

module.exports = { handleMessage };