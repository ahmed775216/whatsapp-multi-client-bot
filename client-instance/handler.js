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
    const lidToJidCache = options.lidToJidCache || new Map();

    // --- Internal Command Processing ---
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
                        isWhitelisted: isWhitelisted(g.id)
                    }));
                    if (internalReply) internalReply({ type: 'groupsList', groups: formattedGroups, clientId: clientIdForReply });
                    console.log(`[HANDLER_INTERNAL] Client ${clientIdForReply} fetched ${formattedGroups.length} groups.`);
                    break;

                case 'addChatToWhitelist':
                case 'removeFromChatWhitelist':
                    const jidToModify = options.groupId || options.participantJid;
                    if (!jidToModify) {
                        if (internalReply) internalReply({ type: 'error', message: 'JID (groupId or participantJid) is required for (un)whitelisting.', clientId: clientIdForReply });
                        return;
                    }

                    let modResult;
                    let itemType = jidToModify.endsWith('@g.us') ? 'group' : 'user';
                    let actionType = '';

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
                        return;
                    }
                    const groupMetaForParticipants = await sock.groupMetadata(groupJidForParticipants);
                    const participantsData = groupMetaForParticipants.participants.map(p => {
                        const participantJid = jidNormalizedUser(p.id);
                        // محاولة الحصول على الاسم من خصائص المشارك المتوفرة
                        let displayName = p.name || p.notify || p.pushname || p.verifiedName || ''; 

                        // إذا لم يكن هناك اسم، استخدم الجزء الأول من JID/LID كاسم افتراضي
                        if (!displayName) {
                            displayName = participantJid.split('@')[0];
                        }

                        return {
                            jid: participantJid,
                            displayName: displayName,
                            isAdmin: (p.admin === 'admin' || p.admin === 'superadmin'),
                            isWhitelisted: isWhitelisted(participantJid) || (lidToJidCache.has(participantJid) && isWhitelisted(lidToJidCache.get(participantJid)))
                        };
                    });
                    if (internalReply) internalReply({ type: 'participantsList', participants: participantsData, groupId: groupJidForParticipants, clientId: clientIdForReply });
                    console.log(`[HANDLER_INTERNAL] Client ${clientIdForReply} fetched ${participantsData.length} participants for group ${groupJidForParticipants}.`);
                    break;

                default:
                    console.warn(`[HANDLER_INTERNAL] Client ${clientIdForReply} received unrecognized internal command: ${options.command}`);
                    if (internalReply) internalReply({ type: 'error', message: `Unrecognized internal command: ${options.command}`, clientId: clientIdForReply });
            }
        } catch (e) {
            console.error(`[HANDLER_INTERNAL_ERROR] Client ${clientIdForReply} error processing internal command ${options.command}:`, e.message, e.stack);
            if (internalReply) internalReply({ type: 'error', message: `Error processing command ${options.command}: ${e.message}`, clientId: clientIdForReply });
        }
        return; // Internal commands processed, stop further execution
    }

    // --- Regular WhatsApp Message Processing ---
    if (!m.message) {
        return;
    }
    const msgType = getContentType(m.message);
    if (!msgType) {
        console.warn("[HANDLER] Could not determine message type, skipping.");
        return;
    }

    if (msgType === 'protocolMessage' || msgType === 'senderKeyDistributionMessage') {
        return;
    }

    const chatId = m.key.remoteJid;
    const initialSenderFromMessageKey = jidNormalizedUser(m.key.participant || m.key.remoteJid);
    const isGroup = chatId.endsWith('@g.us');
    let actualSenderForLogic = initialSenderFromMessageKey;
    let isOwner = false;

    if (actualSenderForLogic.endsWith('@lid')) {
        console.log(`[HANDLER_LID] Initial sender is LID: ${actualSenderForLogic}. Attempting to resolve JID.`);
        const cachedJid = lidToJidCache.get(actualSenderForLogic);
        if (cachedJid) {
            actualSenderForLogic = cachedJid;
            console.log(`[HANDLER_LID] Resolved ${initialSenderFromMessageKey} to JID ${actualSenderForLogic} from cache.`);
        } else {
            console.log(`[HANDLER_LID] LID ${actualSenderForLogic} not in cache. Attempting direct fetch.`);
            try {
                const contactInfoArray = await sock.getContacts([actualSenderForLogic]);
                if (contactInfoArray && contactInfoArray.length > 0) {
                    const contactInfo = contactInfoArray[0];
                    if (contactInfo.id && contactInfo.id.endsWith('@s.whatsapp.net')) {
                        actualSenderForLogic = jidNormalizedUser(contactInfo.id);
                        lidToJidCache.set(initialSenderFromMessageKey, actualSenderForLogic);
                        console.log(`[HANDLER_LID] Resolved ${initialSenderFromMessageKey} to JID ${actualSenderForLogic} via direct fetch and cached.`);
                    } else {
                        console.warn(`[HANDLER_LID] Direct fetch for ${initialSenderFromMessageKey} did not return a valid JID. Contact info:`, contactInfo);
                    }
                } else {
                    console.warn(`[HANDLER_LID] Could not resolve LID ${initialSenderFromMessageKey} to JID via direct fetch (no contact info returned).`);
                }
            } catch (fetchErr) {
                console.error(`[HANDLER_LID_ERROR] Error fetching contact info for LID ${initialSenderFromMessageKey}:`, fetchErr.message);
            }
        }
    }

    const botCanonicalJid = sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : null;
    const botLid = sock.user && sock.user.lid && sock.user.lid.user ? jidNormalizedUser(`${sock.user.lid.user}@${sock.user.lid.server || 'lid'}`) : null;


    if (botCanonicalJid && (areJidsSameUser(actualSenderForLogic, botCanonicalJid) || (botLid && areJidsSameUser(actualSenderForLogic, botLid)))) {
        isOwner = true;
        if (actualSenderForLogic.endsWith('@lid') && botCanonicalJid) {
            actualSenderForLogic = botCanonicalJid;
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
                const senderParticipantInfo = participants.find(p => p && p.id && (areJidsSameUser(p.id, initialSenderFromMessageKey) || (p.lid && p.lid.user && areJidsSameUser(jidNormalizedUser(`${p.lid.user}@${p.lid.server || 'lid'}`), initialSenderFromMessageKey))));
                if (senderParticipantInfo && senderParticipantInfo.id.endsWith('@s.whatsapp.net')) {
                    actualSenderForLogic = jidNormalizedUser(senderParticipantInfo.id);
                    console.log(`[HANDLER_LID] Resolved ${initialSenderFromMessageKey} to JID ${actualSenderForLogic} from groupMetadata.`);
                    if (!lidToJidCache.has(initialSenderFromMessageKey)) {
                        lidToJidCache.set(initialSenderFromMessageKey, actualSenderForLogic);
                    }
                } else {
                    console.log(`[HANDLER_LID] Still could not resolve LID ${initialSenderFromMessageKey} from groupMetadata.`);
                }
            }

            const botParticipant = participants.find(p => p && p.id && botCanonicalJid && areJidsSameUser(p.id, botCanonicalJid));
            isBotAdmin = !!(botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin'));
            
            const senderAdminInfo = participants.find(p => p && p.id && areJidsSameUser(p.id, actualSenderForLogic));
            isAdminOfGroup = !!(senderAdminInfo && (senderAdminInfo.admin === 'admin' || senderAdminInfo.admin === 'superadmin'));
        } catch (e) {
            console.error(`[HANDLER_ERROR] Could not fetch group metadata for ${chatId}: ${e.message}.`);
        }
    }
    
    if (!isOwner) {
        const ownerPhoneNumberStrings = (process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC || "").split(',').map(num => num.trim().replace(/@s\.whatsapp\.net$/, '')).filter(num => num);
        for (const ownerPhone of ownerPhoneNumberStrings) {
            if (ownerPhone) {
                const configuredOwnerJid = formatJid(ownerPhone);
                if (areJidsSameUser(actualSenderForLogic, configuredOwnerJid)) {
                    isOwner = true;
                    break;
                }
            }
        }
    }

    console.log(`[HANDLER] MSG From: ${actualSenderForLogic.split('@')[0]} (Original: ${initialSenderFromMessageKey.split('@')[0]}) in ${isGroup ? 'Group: ' + (groupMetadata.subject || chatId.split('@')[0]) : 'DM'}. IsOwner: ${isOwner}.`);

    m.reply = (text, targetChatId = m.key.remoteJid, replyOptions = {}) => sock.sendMessage(targetChatId, (typeof text === 'string') ? { text: text } : text, { quoted: m, ...replyOptions });
    const msgContextInfo = m.message?.[msgType]?.contextInfo;
    m.mentionedJid = msgContextInfo?.mentionedJid || [];
    if (m.message?.[msgType]?.contextInfo?.quotedMessage) {
        m.quoted = {
             key: msgContextInfo.stanzaId,
             id: msgContextInfo.stanzaId,
             sender: jidNormalizedUser(msgContextInfo.participant || chatId),
             message: msgContextInfo.quotedMessage,
             text: msgContextInfo.quotedMessage?.conversation || msgContextInfo.quotedMessage?.[getContentType(msgContextInfo.quotedMessage)]?.text || msgContextInfo.quotedMessage?.[getContentType(msgContextInfo.quotedMessage)]?.caption || '',
        };
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
            const blockResult = await allHandler(m, { ...ctx, lidToJidCache });
            if (blockResult && typeof blockResult === 'object' && Object.keys(blockResult).length === 0) {
                return;
            }
        } catch (e) {
            console.error(`[HANDLER_ERROR] Error in 'all' plugin (${allHandler.name || 'Anonymous'}):`, e);
        }
    }

    const command = ctx.text.split(' ')[0];
    const args = ctx.text.split(' ').slice(1);

    if (ctx.isOwner) {
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
            case '!addtochatwhitelist':
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
        }
    }
}

module.exports = { handleMessage };