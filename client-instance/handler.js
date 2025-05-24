// client-instance/handler.js
const { getContentType, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');

const { addToWhitelist, removeFromWhitelist, formatJid } = require('./plugins/whitelist');
const forwarderPlugin = require('./plugins/forwrder.js');
const withdrawalRequestsPlugin = require('./plugins/withdrawalRequests.js');

const ALL_HANDLERS_FROM_PLUGINS = [
    withdrawalRequestsPlugin.all,
    require('./plugins/_whitelistFilter.js').all,
    forwarderPlugin.all
];

async function handleMessage(sock, m, options = {}) {
    // Determine if this is an internal command from the manager vs a WhatsApp message
    const isInternalCommand = options.isInternalCommand || false;
    const internalReply = options.internalReply || null; // Function to send a WebSocket reply back to Manager

    if (!isInternalCommand && !m.message) {
        console.log("[HANDLER] Message object is empty, skipping.");
        return;
    }
    const msgType = isInternalCommand ? 'internalCommand' : getContentType(m.message);
    if (!msgType) {
        console.warn("[HANDLER] Could not determine message type, skipping.");
        return;
    }

    if (!isInternalCommand && (msgType === 'protocolMessage' || msgType === 'senderKeyDistributionMessage')) {
        console.log(`[HANDLER] Ignoring protocol/senderKeyDistribution message type: ${msgType}`);
        return;
    }

    const chatId = m.key?.remoteJid;
    const initialSenderFromMessageKey = jidNormalizedUser(m.key?.participant || m.key?.remoteJid || (sock.user && sock.user.id));
    const isGroup = chatId?.endsWith('@g.us') || false; // Handle internal commands which might not have a chatId

    let actualSenderForLogic = initialSenderFromMessageKey;

    let isOwner = options.isOwner || false; // `isOwner` can be passed in `options` for internal commands.
    if (!isOwner) { // Recalculate if not provided (for regular WA messages)
        const botCanonicalJid = sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : null;
        const botLid = sock.user && sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;

        if (botCanonicalJid && (areJidsSameUser(initialSenderFromMessageKey, botCanonicalJid) ||
                                 (botLid && areJidsSameUser(initialSenderFromMessageKey, botLid)))) {
            isOwner = true;
            actualSenderForLogic = botCanonicalJid;
        } else {
            const ownerPhoneNumberStrings = (process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC || "")
                .split(',')
                .map(num => num.trim().replace(/@s\.whatsapp\.net$/, ''))
                .filter(num => num);

            for (const ownerPhone of ownerPhoneNumberStrings) {
                if (ownerPhone) {
                    const configuredOwnerJid = jidNormalizedUser(`${ownerPhone}@s.whatsapp.net`);
                    if (areJidsSameUser(initialSenderFromMessageKey, configuredOwnerJid)) {
                        isOwner = true;
                        actualSenderForLogic = configuredOwnerJid;
                        break;
                    }
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
                 } else {
                     console.warn(`[HANDLER_WARN] Could not find full participant info for '${initialSenderFromMessageKey}' in group '${groupMetadata.subject || chatId}'. Using initial ID. (Possible LID or missing participant data)`);
                 }
            }

            const botJid = jidNormalizedUser(sock.user?.id);
            const botParticipant = participants.find(p => p && p.id && areJidsSameUser(p.id, botJid));
            isBotAdmin = !!(botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin'));

            const senderAdminInfo = participants.find(p => p && p.id && areJidsSameUser(p.id, actualSenderForLogic));
            isAdminOfGroup = !!(senderAdminInfo && (senderAdminInfo.admin === 'admin' || senderAdminInfo.admin === 'superadmin'));
            
            console.log(`[HANDLER_DETAIL] Group Info: ${groupMetadata.subject || chatId}, Bot Admin: ${isBotAdmin}, Sender Admin: ${isAdminOfGroup} (Sender ID resolved to: ${actualSenderForLogic.split('@')[0]})`);

        } catch (e) {
            console.error(`[HANDLER_ERROR] Could not fetch group metadata or participant info for ${chatId}. Reason: ${e.message}.`);
        }
    }

    const ctx = {
        sock,
        m,
        chatId,
        sender: actualSenderForLogic,
        text: m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || '',
        usedPrefix: '!',
        isGroup,
        participants,
        groupMetadata,
        isAdmin: isAdminOfGroup,
        isBotAdmin,
        isOwner,
        botJid: jidNormalizedUser(sock.user?.id), // Canonical JID of the bot itself
    };

    m.reply = (text, targetChatId = m.key?.remoteJid || ctx.chatId, replyOptions = {}) => sock.sendMessage(targetChatId, (typeof text === 'string') ? { text: text } : text, { quoted: m, ...replyOptions });

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
            sender: jidNormalizedUser(m.message[msgType].contextInfo.participant),
        };
    }
    if (m.message?.[msgType]?.mimetype) {
         m.download = () => require('@whiskeysockets/baileys').downloadContentFromMessage(m.message[msgType], msgType.replace('Message', ''));
    }

    // --- NEW: Internal Command Handling ---
    if (isInternalCommand) {
        console.log(`[HANDLER] Processing internal command: ${options.command} for client ${options.clientId}`);
        switch (options.command) {
            case 'fetchGroups':
                if (!ctx.isOwner) {
                     if (internalReply) internalReply({ type: 'error', message: 'Unauthorized: Not owner of this bot.', clientId: options.clientId });
                     return;
                }
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    const formattedGroups = Object.values(groups).map(g => ({
                        id: g.id,
                        subject: g.subject,
                        participantsCount: g.participants.length
                    }));
                    if (internalReply) internalReply({ type: 'groupsList', groups: formattedGroups, clientId: options.clientId });
                    console.log(`[HANDLER_INTERNAL] Fetched ${formattedGroups.length} groups for ${options.clientId}.`);
                } catch (e) {
                    console.error(`[HANDLER_INTERNAL_ERROR] Failed to fetch groups for ${options.clientId}:`, e);
                    if (internalReply) internalReply({ type: 'error', message: `Failed to fetch groups: ${e.message}`, clientId: options.clientId });
                }
                return;

            case 'addChatToWhitelist': // For internal calls directly whitelisting a group ID from UI
                if (!ctx.isOwner) {
                     if (internalReply) internalReply({ type: 'error', message: 'Unauthorized: Not owner of this bot.', clientId: options.clientId });
                     return;
                }
                const groupIdToAdd = options.groupId;
                if (!groupIdToAdd) {
                    if (internalReply) internalReply({ type: 'error', message: 'Group ID is required for whitelisting.', clientId: options.clientId });
                    return;
                }
                const addResult = addToWhitelist(groupIdToAdd);
                if (internalReply) internalReply({
                    type: 'addChatToWhitelistResponse',
                    success: addResult.success,
                    reason: addResult.reason,
                    jid: groupIdToAdd,
                    typeOfItem: 'group',
                    clientId: options.clientId
                });
                console.log(`[HANDLER_INTERNAL] Whitelist group result for ${groupIdToAdd}: ${addResult.success}`);
                return;

            case 'fetchParticipants':
                if (!ctx.isOwner) {
                    if (internalReply) internalReply({ type: 'error', message: 'Unauthorized: Not owner of this bot.', clientId: options.clientId });
                    return;
                }
                const groupJid = options.groupId;
                if (!groupJid) {
                    if (internalReply) internalReply({ type: 'error', message: 'Group ID is required for fetching participants.', clientId: options.clientId });
                    return;
                }
                try {
                    const groupMetadata = await sock.groupMetadata(groupJid);
                    const participants = groupMetadata.participants.map(p => ({
                        jid: jidNormalizedUser(p.id),
                        isAdmin: (p.admin === 'admin' || p.admin === 'superadmin')
                    }));
                    if (internalReply) internalReply({ type: 'participantsList', participants: participants, groupId: groupJid, clientId: options.clientId });
                    console.log(`[HANDLER_INTERNAL] Fetched ${participants.length} participants for ${groupJid}.`);
                } catch (e) {
                    console.error(`[HANDLER_INTERNAL_ERROR] Failed to fetch participants for ${groupJid}:`, e);
                    if (internalReply) internalReply({ type: 'error', message: `Failed to fetch participants: ${e.message}`, clientId: options.clientId });
                }
                return;

            default:
                console.warn(`[HANDLER] Unrecognized internal command: ${options.command}`);
                if (internalReply) internalReply({ type: 'error', message: `Unrecognized internal command: ${options.command}`, clientId: options.clientId });
                return;
        }
    }
    // --- END NEW Internal Command Handling ---

    // Final consolidated log of resolved sender, helpful for debugging
    console.log(`[HANDLER] MSG From: ${actualSenderForLogic.split('@')[0]} (Initial Key: ${initialSenderFromMessageKey}, Resolved ID: ${actualSenderForLogic}) in ${isGroup ? 'Group: ' + (groupMetadata.subject || chatId.split('@')[0]) : 'DM'}. IsOwner: ${isOwner}. Text: "${m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || ''}"`);


    // --- Run 'all' plugins, like _whitelistFilter.js ---
    for (const allHandler of ALL_HANDLERS_FROM_PLUGINS) {
        console.log(`[HANDLER] Running 'all' plugin: ${allHandler.name || 'Anonymous'}`);
        try {
            const blockResult = await allHandler(m, ctx); 
            if (blockResult && typeof blockResult === 'object' && Object.keys(blockResult).length === 0) {
                console.log(`[HANDLER] Message blocked by 'all' plugin (${allHandler.name || 'Anonymous'}). Halting further processing.`);
                return;
            }
        } catch (e) {
            console.error(`[HANDLER_ERROR] Error in 'all' plugin (${allHandler.name || 'Anonymous'}):`, e);
        }
    }

    // --- Owner Commands (will now work as isOwner is correct) ---
    const command = ctx.text.split(' ')[0];
    const args = ctx.text.split(' ').slice(1);

    if (ctx.isOwner) {
        console.log(`[HANDLER] Owner command received: ${command}. Executing...`);
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
                    console.warn(`[HANDLER] Whitelistgroup command used outside a group by owner.`);
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
                    console.warn(`[HANDLER] Removegroup command used outside a group by owner.`);
                }
                break;

            case '!addtochatwhitelist':
                if (args.length > 0) {
                    const numberToAdd = args[0];
                    const jidToAdd = formatJid(numberToAdd);

                    if (jidToAdd.endsWith('@s.whatsapp.net') || jidToAdd.endsWith('@g.us')) { // Handle both user and group JIDs
                        const addResult = addToWhitelist(jidToAdd);
                        if (addResult.success) {
                            m.reply(`${jidToAdd.endsWith('@s.whatsapp.net') ? 'User' : 'Group'} ${jidToAdd.split('@')[0]} added to general whitelist.`);
                            console.log(`[HANDLER] Whitelisted ${jidToAdd.endsWith('@s.whatsapp.net') ? 'user' : 'group'}: ${jidToAdd}`);
                        } else {
                            m.reply(`Failed to add ${jidToAdd.endsWith('@s.whatsapp.net') ? 'user' : 'group'} to general whitelist: ${addResult.reason}`);
                            console.error(`[HANDLER] Failed to whitelist ${jidToAdd.endsWith('@s.whatsapp.net') ? 'user' : 'group'} ${jidToAdd}: ${addResult.reason}`);
                        }
                    } else {
                        m.reply(`Invalid number format. Please provide a valid phone number or group JID.`);
                        console.warn(`[HANDLER] Invalid format for !addtochatwhitelist: ${numberToAdd}`);
                    }
                } else {
                    m.reply(`Usage: !addtochatwhitelist <phone_number_or_group_jid>`);
                    console.warn(`[HANDLER] Missing argument for addtochatwhitelist.`);
                }
                break;
            
            case '!removefromchatwhitelist':
                if (args.length > 0) {
                    const numberToRemove = args[0];
                    const jidToRemove = formatJid(numberToRemove);

                    if (jidToRemove.endsWith('@s.whatsapp.net') || jidToRemove.endsWith('@g.us')) {
                        const removeResult = removeFromWhitelist(jidToRemove);
                        if (removeResult.success) {
                            m.reply(`${jidToRemove.endsWith('@s.whatsapp.net') ? 'User' : 'Group'} ${jidToRemove.split('@')[0]} removed from general whitelist.`);
                            console.log(`[HANDLER] Removed ${jidToRemove.endsWith('@s.whatsapp.net') ? 'user' : 'group'} from general whitelist: ${jidToRemove}`);
                        } else {
                            m.reply(`Failed to remove ${jidToRemove.endsWith('@s.whatsapp.net') ? 'user' : 'group'} from general whitelist: ${removeResult.reason}`);
                            console.error(`[HANDLER] Failed to remove ${jidToRemove.endsWith('@s.whatsapp.net') ? 'user' : 'group'} ${jidToRemove}: ${removeResult.reason}`);
                        }
                    } else {
                        m.reply(`Invalid number format. Please provide a valid phone number or group JID.`);
                        console.warn(`[HANDLER] Invalid format for removefromchatwhitelist: ${numberToRemove}`);
                    }
                } else {
                    m.reply(`Usage: !removefromchatwhitelist <phone_number_or_group_jid>`);
                    console.warn(`[HANDLER] Missing argument for removefromchatwhitelist.`);
                }
                break;
            default:
                console.log(`[HANDLER] Unknown owner command: ${command}. No action taken.`);
                break;
        }
    } else {
        console.log(`[HANDLER] Non-owner message, not processing as command.`);
    }
}

module.exports = { handleMessage };