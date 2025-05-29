// client-instance/handler.js
const { getContentType, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');
const { addToWhitelist, removeFromWhitelist, formatJid, isWhitelisted, getLidToPhoneJidFromCache, cacheLidToPhoneJid, getAskedLidsCache, getPendingLidIdentifications, savePendingIdsFile, saveAskedLidsFile } = require ('./plugins/whitelist.js');
const forwarderPlugin = require('./plugins/forwrder.js');
const withdrawalRequestsPlugin = require('./plugins/withdrawalRequests.js');

const ALL_HANDLERS_FROM_PLUGINS = [
    withdrawalRequestsPlugin.all,
    require('./plugins/_whitelistFilter.js').all,
    forwarderPlugin.all
];

async function handleMessage(sock, m, options = {}) {
    const isInternalCommand = options.isInternalCommand || false;
    const internalReply = options.internalReply || null;
    const clientIdForReply = options.clientId || process.env.CLIENT_ID; // تأكد من وجود clientIdForReply

    // ... (كود الأوامر الداخلية كما هو) ...
    if (isInternalCommand) {
        console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Received internal command: ${options.command} with payload:`, { groupId: options.groupId, participantJid: options.participantJid });
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
                    console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Fetched ${formattedGroups.length} groups.`);
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
                    } else {
                        modResult = removeFromWhitelist(jidToModify);
                        actionType = 'removeFromChatWhitelistResponse';
                    }
                    if (internalReply) internalReply({ type: actionType, success: modResult.success, reason: modResult.reason, jid: jidToModify, typeOfItem: itemType, clientId: clientIdForReply });
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
                        // محاولة الحصول على pushName من الكاش أولاً، ثم من بيانات الاتصال (إذا توفرت)
                        let displayName = global.pushNameCache?.get(participantJid) || p.name || p.notify || participantJid.split('@')[0];
                        
                        // إذا كان participantJid هو @lid، حاول حله إلى رقم هاتف من الكاش الدائم
                        if (participantJid.endsWith('@lid')) {
                            const resolvedPhoneJid = getLidToPhoneJidFromCache(participantJid);
                            if (resolvedPhoneJid) {
                                // إذا تم حله، استخدم رقم الهاتف كـ JID أساسي واعرض الاسم المرتبط به (إذا وجد)
                                displayName = global.pushNameCache?.get(resolvedPhoneJid) || global.pushNameCache?.get(participantJid) || resolvedPhoneJid.split('@')[0];
                                console.log(`[${clientIdForReply}_FETCH_PARTICIPANTS] Displaying resolved ${resolvedPhoneJid} for original @lid ${participantJid} with name ${displayName}`);
                                // يجب إرسال كل من ה-LID الأصلي و ה-JID المحلول إلى الواجهة إذا أمكن ذلك
                                // أو تحديث الواجهة لاحقًا
                            } else {
                                displayName = global.pushNameCache?.get(participantJid) || participantJid; // عرض ה-LID نفسه إذا لم يتم حله
                            }
                        }


                        return {
                            jid: participantJid, // أرسل دائمًا الـ JID الأصلي الذي حصلت عليه من المجموعة
                            resolvedJid: participantJid.endsWith('@lid') ? getLidToPhoneJidFromCache(participantJid) : null, // أرسل الرقم المحلول إذا كان متاحًا
                            displayName: displayName,
                            isAdmin: (p.admin === 'admin' || p.admin === 'superadmin'),
                            isWhitelisted: isWhitelisted(participantJid) // الفحص يجب أن يكون على JID الهاتف إذا تم حله
                        };
                    });
                    if (internalReply) internalReply({ type: 'participantsList', participants: participantsData, groupId: groupJidForParticipants, clientId: clientIdForReply });
                    console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Fetched ${participantsData.length} participants for group ${groupJidForParticipants}.`);
                    break;

                default:
                    console.warn(`[${clientIdForReply}_HANDLER_INTERNAL] Received unrecognized internal command: ${options.command}`);
                    if (internalReply) internalReply({ type: 'error', message: `Unrecognized internal command: ${options.command}`, clientId: clientIdForReply });
            }
        } catch (e) {
            console.error(`[${clientIdForReply}_HANDLER_INTERNAL_ERROR] Error processing internal command ${options.command}:`, e.message, e.stack);
            if (internalReply) internalReply({ type: 'error', message: `Error processing command ${options.command}: ${e.message}`, clientId: clientIdForReply });
        }
        return;
    }


    if (!m.message) return;
    const msgType = getContentType(m.message);
    if (!msgType || msgType === 'protocolMessage' || msgType === 'senderKeyDistributionMessage') return;

    const chatId = m.key.remoteJid;
    const originalMessageSenderJid = jidNormalizedUser(m.key.participant || m.key.remoteJid);
    const pushName = m.pushName || "UnknownPN"; 
    const isGroup = chatId.endsWith('@g.us');
    let actualSenderForLogic = originalMessageSenderJid;
    let isOwner = false;

    // تحديث/تخزين pushName في الكاش عند كل رسالة
    if (originalMessageSenderJid && pushName !== "UnknownPN") {
        if(!global.pushNameCache) global.pushNameCache = new Map();
        global.pushNameCache.set(originalMessageSenderJid, pushName);
    }


    const botCanonicalJid = sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : null;
    const botLid = sock.user && sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;

    if (botCanonicalJid && (areJidsSameUser(originalMessageSenderJid, botCanonicalJid) || (botLid && areJidsSameUser(originalMessageSenderJid, botLid)))) {
        isOwner = true;
        actualSenderForLogic = botCanonicalJid;
    } else {
        const ownerPhoneNumberStrings = (process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC || "").split(',').map(num => num.trim().replace(/@s\.whatsapp\.net$/, '')).filter(num => num);
        for (const ownerPhone of ownerPhoneNumberStrings) {
            if (ownerPhone) {
                const configuredOwnerJid = formatJid(ownerPhone);
                if (areJidsSameUser(originalMessageSenderJid, configuredOwnerJid)) {
                    isOwner = true;
                    actualSenderForLogic = configuredOwnerJid;
                    break;
                }
            }
        }
    }
    
    if (originalMessageSenderJid.endsWith('@lid') && !isOwner) {
        const cachedPhoneJid = getLidToPhoneJidFromCache(originalMessageSenderJid);
        if (cachedPhoneJid) {
            actualSenderForLogic = cachedPhoneJid;
            console.log(`[${process.env.CLIENT_ID}_HANDLER] Resolved @lid ${originalMessageSenderJid} to ${actualSenderForLogic} from LIDCached.`);
        } else if (isGroup) {
            try {
                const groupMetadataForLid = await sock.groupMetadata(chatId);
                const participantsForLid = groupMetadataForLid.participants || [];
                const senderParticipantInfo = participantsForLid.find(p => p && p.id && areJidsSameUser(p.id, originalMessageSenderJid));
                if (senderParticipantInfo && senderParticipantInfo.id) {
                    const resolvedJid = jidNormalizedUser(senderParticipantInfo.id);
                    if (resolvedJid.endsWith('@s.whatsapp.net')) {
                        actualSenderForLogic = resolvedJid;
                        cacheLidToPhoneJid(originalMessageSenderJid, actualSenderForLogic);
                        console.log(`[${process.env.CLIENT_ID}_HANDLER] Resolved @lid ${originalMessageSenderJid} to phone JID ${actualSenderForLogic} via group metadata and cached it.`);
                    } else {
                        console.log(`[${process.env.CLIENT_ID}_HANDLER] Could not resolve @lid ${originalMessageSenderJid} to a phone JID via group metadata. Resolved JID was: ${resolvedJid}`);
                    }
                } else {
                     console.log(`[${process.env.CLIENT_ID}_HANDLER] Participant with @lid ${originalMessageSenderJid} not found in group metadata for ${chatId}.`);
                }
            } catch(e) {
                console.error(`[${process.env.CLIENT_ID}_HANDLER_ERROR] Could not fetch group metadata for @lid resolution in ${chatId}: ${e.message}.`);
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
            const botParticipant = participants.find(p => p && p.id && areJidsSameUser(p.id, botCanonicalJid));
            isBotAdmin = !!(botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin'));
            const senderAdminInfo = participants.find(p => p && p.id && areJidsSameUser(p.id, actualSenderForLogic));
            isAdminOfGroup = !!(senderAdminInfo && (senderAdminInfo.admin === 'admin' || senderAdminInfo.admin === 'superadmin'));
        } catch (e) {
            console.error(`[${process.env.CLIENT_ID}_HANDLER_ERROR] Could not fetch group metadata for ${chatId} (main block): ${e.message}.`);
        }
    }

    console.log(`[${process.env.CLIENT_ID}_HANDLER] MSG From: ${actualSenderForLogic.split('@')[0]} (LID?: ${originalMessageSenderJid}, Name: ${pushName}) in ${isGroup ? 'Group: ' + (groupMetadata.subject || chatId.split('@')[0]) : 'DM'}. IsOwner: ${isOwner}.`);

    m.reply = (text, targetChatId = m.key.remoteJid, replyOptions = {}) => sock.sendMessage(targetChatId, (typeof text === 'string') ? { text: text } : text, { quoted: m, ...replyOptions });
    const msgContextInfo = m.message?.[msgType]?.contextInfo;
    m.mentionedJid = msgContextInfo?.mentionedJid || [];
    if (m.message?.[msgType]?.contextInfo?.quotedMessage) { m.quoted = { /* ... */ }; }
    if (m.message?.[msgType]?.mimetype) { m.download = () => require('@whiskeysockets/baileys').downloadContentFromMessage(m.message[msgType], msgType.replace('Message', '')); }
    
    const textContent = m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || '';

    const pendingIdentificationsMap = getPendingLidIdentifications();
    const askedLidsMap = getAskedLidsCache();

    if (originalMessageSenderJid.endsWith('@lid') && pendingIdentificationsMap.has(originalMessageSenderJid) && !isOwner) {
        const phoneRegex = /(?:\+|\d{1,3})?\s*(?:\d[\s-]*){7,15}\d/;
        const potentialPhoneNumberMatch = textContent.match(phoneRegex);

        if (potentialPhoneNumberMatch) {
            const providedPhoneNumber = potentialPhoneNumberMatch[0].replace(/\D/g, '');
            const providedPhoneJid = formatJid(providedPhoneNumber);

            console.log(`[${process.env.CLIENT_ID}_HANDLER_IDENTIFY] User ${originalMessageSenderJid} (Name: ${pushName}) provided phone: ${providedPhoneNumber} -> JID: ${providedPhoneJid}`);

            if (providedPhoneJid && isWhitelisted(providedPhoneJid)) {
                cacheLidToPhoneJid(originalMessageSenderJid, providedPhoneJid);
                pendingIdentificationsMap.delete(originalMessageSenderJid);
                savePendingIdsFile();
                askedLidsMap.delete(originalMessageSenderJid);
                saveAskedLidsFile();
                
                await m.reply(`شكرًا لك ${pushName || ''}! تم التحقق من رقمك (${providedPhoneNumber}). يمكنك الآن استخدام خدمات البوت. يرجى إعادة إرسال طلبك الأصلي إذا لم تتم معالجته.`);
                
                // إرسال تحديث إلى المدير بالـ JID المحلول والاسم
                const { reportLidResolution } = require('./clientBotApp'); // استيراد الدالة
                if (reportLidResolution) {
                    reportLidResolution(originalMessageSenderJid, providedPhoneJid, pushName);
                }

                actualSenderForLogic = providedPhoneJid;
                return {};
            } else {
                console.log(`[${process.env.CLIENT_ID}_HANDLER_IDENTIFY] Provided phone ${providedPhoneJid || providedPhoneNumber} by ${originalMessageSenderJid} (Name: ${pushName}) is NOT whitelisted.`);
                await m.reply(`عذرًا ${pushName || ''}! الرقم الذي قدمته (${providedPhoneNumber}) غير موجود في قائمة المستخدمين المصرح لهم. يرجى التأكد من الرقم أو التواصل مع المسؤول.`);
                return {};
            }
        } else {
            console.log(`[${process.env.CLIENT_ID}_HANDLER_IDENTIFY] Message from ${originalMessageSenderJid} (Name: ${pushName}) did not seem to contain a phone number reply. Original text: "${textContent.substring(0,50)}"`);
        }
        return {};
    }

    const ctx = {
        sock, m, chatId,
        sender: actualSenderForLogic,
        text: textContent,
        pushName: pushName,
        usedPrefix: '!', isGroup, participants, groupMetadata,
        isAdmin: isAdminOfGroup, isBotAdmin, isOwner,
        botJid: botCanonicalJid,
        originalMessageSenderJid: originalMessageSenderJid
    };

    for (const allHandler of ALL_HANDLERS_FROM_PLUGINS) {
        try {
            const blockResult = await allHandler(m, ctx);
            if (blockResult && typeof blockResult === 'object' && Object.keys(blockResult).length === 0) {
                console.log(`[${process.env.CLIENT_ID}_HANDLER] Message from ${actualSenderForLogic.split('@')[0]} (Name: ${pushName}) blocked by 'all' plugin (${allHandler.name || 'Anonymous'}).`);
                return;
            }
        } catch (e) {
            console.error(`[${process.env.CLIENT_ID}_HANDLER_ERROR] Error in 'all' plugin (${allHandler.name || 'Anonymous'}):`, e);
        }
    }

    // ... (كود أوامر المالك كما هو) ...
    const command = ctx.text.split(' ')[0];
    const args = ctx.text.split(' ').slice(1);

    if (ctx.isOwner) {
        console.log(`[${process.env.CLIENT_ID}_HANDLER] Owner command received via WhatsApp: ${command}.`);
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