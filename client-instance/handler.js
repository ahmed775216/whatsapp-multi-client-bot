// client-instance/handler.js
const { getContentType, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');
const { addToWhitelist, removeFromWhitelist, formatJid, isWhitelisted, getLidToPhoneJidFromCache, cacheLidToPhoneJid, getAskedLidsCache, getPendingLidIdentifications, savePendingIdsFile, saveAskedLidsFile } = require('./plugins/whitelist.js');
const forwarderPlugin = require('./plugins/forwrder.js');
const withdrawalRequestsPlugin = require('./plugins/withdrawalRequests.js');
let process = require('process');
const { getContactByJid } = require('../database/botContactsDb'); // <-- ADD THIS
const { getBotInstanceId } = require('./lib/apiSync'); // <-- ADD THIS
const ALL_HANDLERS_FROM_PLUGINS = [
    withdrawalRequestsPlugin.all,
    require('./plugins/_whitelistFilter.js').all,
    forwarderPlugin.all
];
const fetch = require('node-fetch'); 
// Add this function in forwarder.js
function stripCountryCode(fullNumber, countryCode = '967') {
    if (!fullNumber) return '';
    const numberPart = fullNumber.toString().replace(/[^0-9]/g, '');
    if (numberPart.startsWith(countryCode)) {
        return numberPart.substring(countryCode.length);
    }
    return numberPart;
}
const FormData = require('form-data');
const { getApiToken } = require('./lib/apiSync');
const receiptState = require('./lib/receiptState'); // Our new state module
// const { stripCountryCode } = require('./plugins/forwrder');
async function handleMessage(sock, m, options = {}) {
    const isInternalCommand = options.isInternalCommand || false;
    const internalReply = options.internalReply || null;
    const clientIdForReply = options.clientId || process.env.CLIENT_ID; // تأكد من وجود clientIdForReply
    if (isInternalCommand) {
        console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Received internal command: ${options.command} with payload:`, { groupId: options.groupId, participantJid: options.participantJid });
        try {
            switch (options.command) {
                case 'fetchGroups':
                    {
                        const groups = await sock.groupFetchAllParticipating();

                        const formattedGroups = await Promise.all(
                            Object.values(groups).map(async (g) => {
                                return {
                                    id: g.id,
                                    subject: g.subject,
                                    participantsCount: g.participants.length,
                                    isWhitelisted: await isWhitelisted(g.id)
                                };
                            })
                        );

                        if (internalReply) internalReply({ type: 'groupsList', groups: formattedGroups, clientId: clientIdForReply });
                        console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Fetched ${formattedGroups.length} groups.`);
                        break;
                    }

                case 'addChatToWhitelist':
                case 'removeFromChatWhitelist':
                    {
                        const jidToModify = options.groupId || options.participantJid;
                        if (!jidToModify) {
                            if (internalReply) internalReply({ type: 'error', message: 'JID (groupId or participantJid) is required for (un)whitelisting.', clientId: clientIdForReply });
                            return;
                        }
                        let modResult;
                        let itemType = jidToModify.endsWith('@g.us') ? 'group' : 'user';
                        let actionType = '';
                        if (options.command === 'addChatToWhitelist') {
                            modResult = await addToWhitelist(jidToModify); actionType = 'addChatToWhitelistResponse';
                        } else {
                            modResult = await removeFromWhitelist(jidToModify);
                            actionType = 'removeFromChatWhitelistResponse';
                        }
                        if (internalReply) internalReply({ type: actionType, success: modResult.success, reason: modResult.reason, jid: jidToModify, typeOfItem: itemType, clientId: clientIdForReply });
                        break;
                    }

                // In handler.js, update the fetchParticipants case:
                // case 'fetchParticipants': // <--- START MODIFICATION FOR THIS CASE
                //     {
                //         console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Processing 'fetchParticipants' command.`);
                //         const groupJidForParticipants = options.groupId;
                //         if (!groupJidForParticipants) {
                //             if (internalReply) internalReply({ type: 'error', message: 'Group ID is required for fetching participants.', clientId: clientIdForReply });
                //             return;
                //         }

                //         let groupMetaForParticipants;
                //         try {
                //             groupMetaForParticipants = await sock.groupMetadata(groupJidForParticipants);
                //             console.log(`[${clientIdForReply}_FETCH_DEBUG] Group has ${groupMetaForParticipants.participants.length} participants.`);
                //         } catch (e) {
                //             console.error(`[${clientIdForReply}_FETCH_ERROR] Could not fetch group metadata for ${groupJidForParticipants}: ${e.message}`, e.stack);
                //             if (internalReply) internalReply({ type: 'error', message: `Failed to fetch group participants: ${e.message}`, clientId: clientIdForReply });
                //             return;
                //         }

                //         const rawParticipants = groupMetaForParticipants.participants || [];
                //         const processedParticipants = [];

                //         for (const p of rawParticipants) {
                //             const participantJid = jidNormalizedUser(p.id);
                //             let displayName = global.pushNameCache?.get(participantJid) || p.name || p.notify || participantJid.split('@')[0];
                //             let resolvedJidForPayload = null; // Will store the resolved phone JID if successful

                //             console.log(`[${clientIdForReply}_FETCH_DEBUG] Processing participant: ${participantJid}`);
                //             // console.log(`[${clientIdForReply}_FETCH_DEBUG] Raw participant data: ${JSON.stringify(p)}`); // Can be noisy
                //             // console.log(`[${clientIdForReply}_FETCH_DEBUG] Normalized JID: ${participantJid}`);

                //             if (participantJid.endsWith('@lid')) {
                //                 console.log(`[${clientIdForReply}_FETCH_DEBUG] Participant is LID, attempting resolution...`);
                //                 // AWAITING getLidToPhoneJidFromCache to get the actual JID from DB
                //                 const resolvedPhoneJidFromCache = await getLidToPhoneJidFromCache(participantJid);
                //                 console.log(`[${clientIdForReply}_FETCH_DEBUG] LID cache lookup result: ${resolvedPhoneJidFromCache ? 'FOUND' : 'NOT FOUND'}`);

                //                 if (resolvedPhoneJidFromCache && typeof resolvedPhoneJidFromCache === 'string') {
                //                     resolvedJidForPayload = resolvedPhoneJidFromCache;
                //                     const phoneNumberPart = resolvedPhoneJidFromCache.includes('@') ? resolvedPhoneJidFromCache.split('@')[0] : resolvedPhoneJidFromCache;
                //                     displayName = global.pushNameCache?.get(resolvedPhoneJidFromCache) ||
                //                         global.pushNameCache?.get(participantJid) ||
                //                         phoneNumberPart;
                //                     console.log(`[${clientIdForReply}_FETCH_DEBUG] Resolved @lid ${participantJid} to phone JID ${resolvedJidForPayload} with name ${displayName}`);
                //                 } else {
                //                     // If display name derived solely from LID number, use it. Otherwise, keep existing pushName.
                //                     if (displayName === participantJid.split('@')[0] && !global.pushNameCache?.has(participantJid)) {
                //                         displayName = participantJid; // Keep LID JID as display if no better name.
                //                     }
                //                     console.log(`[${clientIdForReply}_FETCH_DEBUG] No resolution for LID ${participantJid}. DisplayName: ${displayName}`);
                //                 }
                //             }

                //             // IMPORTANT: `isWhitelisted` is async, so it must be awaited!
                //             let isParticipantWhitelisted = false;
                //             try {
                //                 // Check whitelist status against the resolved JID first, fallback to original LID
                //                 isParticipantWhitelisted = await isWhitelisted(resolvedJidForPayload || participantJid);
                //             } catch (err) {
                //                 console.error(`[${clientIdForReply}_FETCH_ERROR] Error checking whitelist for ${participantJid}: ${err.message}`, err.stack);
                //                 isParticipantWhitelisted = false; // Default to not whitelisted on error
                //             }

                //             processedParticipants.push({
                //                 jid: participantJid, // Original JID (can be @lid)
                //                 resolvedJid: resolvedJidForPayload, // The resolved phone JID, or null
                //                 displayName: displayName,
                //                 isAdmin: (p.admin === 'admin' || p.admin === 'superadmin'),
                //                 isWhitelisted: isParticipantWhitelisted
                //             });
                //         } // End of for...of loop

                //         console.log(`[${clientIdForReply}_FETCH_DEBUG] Sending ${processedParticipants.length} participants to UI`);
                //         if (internalReply) internalReply({ type: 'participantsList', participants: processedParticipants, groupId: groupJidForParticipants, clientId: clientIdForReply });
                //         console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Fetched ${processedParticipants.length} participants for group ${groupJidForParticipants}.`);
                //         break;
                //     } // <--- END MODIFICATION FOR THIS CASE
                // End of fetchParticipants case
                // In client-instance/handler.js

                // In client-instance/handler.js

                case 'fetchParticipants':
                    {
                        console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Processing 'fetchParticipants' command.`);
                        const groupJidForParticipants = options.groupId;
                        if (!groupJidForParticipants) {
                            if (internalReply) internalReply({ type: 'error', message: 'Group ID is required for fetching participants.', clientId: clientIdForReply });
                            return;
                        }

                        const botInstanceId = await getBotInstanceId(clientIdForReply);
                        if (!botInstanceId) {
                            if (internalReply) internalReply({ type: 'error', message: 'Could not identify bot instance in database.', clientId: clientIdForReply });
                            return;
                        }

                        let groupMetaForParticipants;
                        try {
                            groupMetaForParticipants = await sock.groupMetadata(groupJidForParticipants);
                        } catch (e) {
                            console.error(`[${clientIdForReply}_FETCH_ERROR] Could not fetch group metadata for ${groupJidForParticipants}: ${e.message}`);
                            if (internalReply) internalReply({ type: 'error', message: `Failed to fetch group participants: ${e.message}`, clientId: clientIdForReply });
                            return;
                        }

                        const rawParticipants = groupMetaForParticipants.participants || [];
                        const processedParticipants = [];

                        for (const p of rawParticipants) {
                            const participantJid = jidNormalizedUser(p.id); // This is the JID Baileys gives us

                            // --- NEW: UNIFIED DATABASE LOOKUP ---
                            // Perform one single query to get the complete contact record from our database.
                            // getContactByJid is smart and can find the record by phone JID or LID.
                            const dbContact = await getContactByJid(botInstanceId, participantJid);

                            // --- NAME FINDING HIERARCHY ---
                            let displayName = p.name || p.notify; // 1. Name from Baileys' current session metadata
                            if (!displayName) displayName = global.pushNameCache?.get(participantJid); // 2. Name from our live message cache
                            if (!displayName && dbContact) displayName = dbContact.display_name; // 3. Name from our persistent database record

                            // --- JID & WHITELIST LOGIC ---
                            // The resolved phone JID is whatever is in our database record's 'user_jid' column.
                            const resolvedJidForPayload = dbContact?.user_jid || null;

                            // For the whitelist check, we prioritize the resolved phone JID if it exists,
                            // otherwise we fall back to the JID Baileys gave us.
                            const jidForWhitelistCheck = resolvedJidForPayload || participantJid;
                            const isParticipantWhitelisted = await isWhitelisted(jidForWhitelistCheck);

                            processedParticipants.push({
                                jid: participantJid,                  // The original JID from the group (could be LID)
                                resolvedJid: resolvedJidForPayload,   // The resolved phone JID from our DB, if it exists
                                displayName: displayName,             // The best name we could find
                                isAdmin: (p.admin === 'admin' || p.admin === 'superadmin'),
                                isWhitelisted: isParticipantWhitelisted
                            });
                        } // End of for...of loop

                        console.log(`[${clientIdForReply}_FETCH_DEBUG] Sending ${processedParticipants.length} participants to UI`);
                        if (internalReply) internalReply({ type: 'participantsList', participants: processedParticipants, groupId: groupJidForParticipants, clientId: clientIdForReply });
                        break;
                    }
                case 'manualLidResolution': // ADDED: New case for manual LID resolution
                    {
                        console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Processing manualLidResolution for LID: ${options.lidJid} to Phone: ${options.phoneJid}`);
                        const lidJid = options.lidJid;
                        const phoneJid = options.phoneJid;

                        if (!lidJid || !phoneJid) {
                            if (internalReply) internalReply({ type: 'error', message: 'LID JID and Phone JID are required for manual resolution.', clientId: clientIdForReply });
                            return;
                        }

                        try {
                            // Update the database with the manual resolution
                            await cacheLidToPhoneJid(lidJid, phoneJid); // This function already handles upserting to DB

                            // Notify the UI about the successful resolution
                            if (internalReply) internalReply({
                                type: 'manualLidResolutionResponse', // New response type for UI
                                success: true,
                                lidJid: lidJid,
                                resolvedPhoneJid: phoneJid,
                                displayName: global.pushNameCache?.get(phoneJid) || phoneJid.split('@')[0], // Use cached name or phone part
                                clientId: clientIdForReply,
                                message: `LID ${lidJid} manually resolved to ${phoneJid}.`
                            });
                            console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Manual LID resolution successful for ${lidJid}.`);

                            // As per blueprint, after manual resolution, forward any stored messages.
                            // This requires the `unresolved_messages_queue` and its processing logic,
                            // which we haven't implemented yet. This will be done in a later step.
                            // For now, the resolution itself is handled.

                        } catch (error) {
                            console.error(`[${clientIdForReply}_HANDLER_INTERNAL_ERROR] Error during manual LID resolution for ${lidJid}: ${error.message}`, error.stack);
                            if (internalReply) internalReply({
                                type: 'manualLidResolutionResponse',
                                success: false,
                                lidJid: lidJid,
                                clientId: clientIdForReply,
                                message: `Failed to manually resolve LID ${lidJid}: ${error.message}`
                            });
                        }
                        break;

                        // console.warn(`[${clientIdForReply}_HANDLER_INTERNAL] Received unrecognized internal command: ${options.command}`);
                        // if (internalReply) internalReply({ type: 'error', message: `Unrecognized internal command: ${options.command}`, clientId: clientIdForReply });
                    }

                case 'manualLidEntry':
                    {
                        console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Processing manualLidEntry for LID: ${options.lid} to Phone: ${options.phoneJid}`);
                        const lid = options.lid;
                        const phoneJid = options.phoneJid;

                        // ADDED: Detailed logging for lid and phoneJid values and types
                        console.log(`[${clientIdForReply}_HANDLER_DEBUG] lid value: '${lid}', type: ${typeof lid}`);
                        console.log(`[${clientIdForReply}_HANDLER_DEBUG] phoneJid value: '${phoneJid}', type: ${typeof phoneJid}`);

                        if (!lid || !phoneJid) {
                            if (internalReply) internalReply({ type: 'error', message: 'LID and Phone JID are required for manual LID entry.', clientId: clientIdForReply });
                            return;
                        }

                        try {
                            // --- NEW NAMING LOGIC ---
                            // 1. Check if we already know a name for this LID from the live cache.
                            let nameToUse = global.pushNameCache?.get(lid);

                            // 2. If not, use the phone number as a temporary name.
                            if (!nameToUse) {
                                nameToUse = phoneJid.split('@')[0];
                                console.log(`[${clientIdForReply}_HANDLER_INTERNAL] No pushName found for ${lid}. Using phone number '${nameToUse}' as temporary name.`);
                            }

                            // 3. Update the database. Our smart `cacheLidToPhoneJid` will handle the merge.
                            await cacheLidToPhoneJid(lid, phoneJid, nameToUse);

                            // 4. Update the live cache for both JIDs with the best name we have.
                            // This ensures subsequent lookups in this session are fast and correct.
                            global.pushNameCache?.set(lid, nameToUse);
                            global.pushNameCache?.set(phoneJid, nameToUse);

                            if (internalReply) internalReply({
                                type: 'manualLidEntryResponse',
                                success: true,
                                lid: lid,
                                phoneJid: phoneJid,
                                message: `LID ${lid} manually entered and cached to ${phoneJid}.`,
                                clientId: clientIdForReply
                                
                            });
                        
                            
                            // --- ADD THIS ---
                            // After a successful manual resolution, we should notify the UI to refresh
                            // the participant list to show the newly resolved phone number.
                            // We use the 'participantDetailsUpdate' message which the UI already understands.
                            if (internalReply) {
                                const updatePayload = {
                                    type: 'participantDetailsUpdate',
                                    clientId: clientIdForReply,
                                    originalLid: lid,
                                    resolvedPhoneJid: phoneJid,
                                    displayName: nameToUse
                                };
                                internalReply(updatePayload);
                                console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Sent participantDetailsUpdate to UI for ${lid}.`);
                            }

                            console.log(`[${clientIdForReply}_HANDLER_INTERNAL] Manual LID entry successful for ${lid}.`);
                        } catch (error) {
                            console.error(`[${clientIdForReply}_HANDLER_INTERNAL_ERROR] Error during manual LID entry for ${lid}: ${error.message}`, error.stack);
                            if (internalReply) internalReply({
                                type: 'manualLidEntryResponse',
                                success: false,
                                lid: lid,
                                clientId: clientIdForReply,
                                message: `Failed to manually enter LID ${lid}: ${error.message}`
                            });
                        }
                    }
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
        if (!global.pushNameCache) global.pushNameCache = new Map();
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
        const cachedPhoneJid = await getLidToPhoneJidFromCache(originalMessageSenderJid);
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
            } catch (e) {
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

    console.log(`[${process.env.CLIENT_ID}_HANDLER] MSG From: ${typeof actualSenderForLogic === 'string' ? actualSenderForLogic.split('@')[0] : actualSenderForLogic} (LID?: ${originalMessageSenderJid}, Name: ${pushName}) in ${isGroup ? 'Group: ' + (groupMetadata.subject || chatId.split('@')[0]) : 'DM'}. IsOwner: ${isOwner}.`);

    // console.log = (text, targetChatId = m.key.remoteJid, replyOptions = {}) => sock.sendMessage(targetChatId, (typeof text === 'string') ? { text: text } : text, { quoted: m, ...replyOptions });
    const msgContextInfo = m.message?.[msgType]?.contextInfo;
    m.mentionedJid = msgContextInfo?.mentionedJid || [];
    if (m.message?.[msgType]?.contextInfo?.quotedMessage) {
        m.quoted = {

        };
    }
    if (m.message?.[msgType]?.mimetype) { m.download = () => require('@whiskeysockets/baileys').downloadContentFromMessage(m.message[msgType], msgType.replace('Message', '')); }

    const textContent = m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || '';

    const pendingIdentificationsMap = await getPendingLidIdentifications();
    const askedLidsMap = await getAskedLidsCache();

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

                // await console.log(`شكرًا لك ${pushName || ''}! تم التحقق من رقمك (${providedPhoneNumber}). يمكنك الآن استخدام خدمات البوت. يرجى إعادة إرسال طلبك الأصلي إذا لم تتم معالجته.`);

                // إرسال تحديث إلى المدير بالـ JID المحلول والاسم
                const { reportLidResolution } = require('./clientBotApp'); // استيراد الدالة
                if (reportLidResolution) {
                    reportLidResolution(originalMessageSenderJid, providedPhoneJid, pushName);
                }

                actualSenderForLogic = providedPhoneJid;
                return {};
            } else {
                console.log(`[${process.env.CLIENT_ID}_HANDLER_IDENTIFY] Provided phone ${providedPhoneJid || providedPhoneNumber} by ${originalMessageSenderJid} (Name: ${pushName}) is NOT whitelisted.`);
                // await console.log(`عذرًا ${pushName || ''}! الرقم الذي قدمته (${providedPhoneNumber}) غير موجود في قائمة المستخدمين المصرح لهم. يرجى التأكد من الرقم أو التواصل مع المسؤول.`);
                return {};
            }
        } else {
            console.log(`[${process.env.CLIENT_ID}_HANDLER_IDENTIFY] Message from ${originalMessageSenderJid} (Name: ${pushName}) did not seem to contain a phone number reply. Original text: "${textContent.substring(0, 50)}"`);
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
    try {
        const amountRegex = /المبلغ:\s*(\d+(\.\d{1,2})?)/;
        const textForAmountCheck = ctx.text || m.message?.documentMessage?.caption || '';
        const amountMatch = textForAmountCheck.match(amountRegex);
        const msgType = getContentType(m.message); // Get message type for document check

        // --- Helper function to process and upload the receipt ---
        async function processReceiptUpload(amount, documentMessage, senderJid) {
            console.log(`[RECEIPT_HANDLER] Processing upload for amount '${amount}' from sender ${senderJid}.`);
            const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

            try {
                const fileBuffer = await m.download();
                if (!fileBuffer || fileBuffer.length === 0) {
                    throw new Error("Document download failed or resulted in an empty buffer.");
                }

                if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
                    await console.log(`⚠️ عذراً، حجم الملف يتجاوز الحد المسموح به (5 ميغابايت).`);
                    return;
                }

                const apiToken = getApiToken();
                if (!apiToken) throw new Error("API token is not available.");

                const senderPhoneNumber = stripCountryCode(senderJid.split('@')[0]);
                const form = new FormData();
                form.append('receipt_file', fileBuffer, { filename: documentMessage.fileName || 'receipt.pdf' });
                form.append('amount', amount);
                form.append('from_contact', senderPhoneNumber);

                const response = await fetch(`${process.env.API_BASE_URL}/whats-transfers/receipt`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiToken}`, ...form.getHeaders() },
                    body: form
                });

                if (response.ok) {
                    await console.log(`✅ تم استلام الإيصال والمبلغ بنجاح.`);
                } else {
                    const errorText = await response.text();
                    await console.log(`🚫 حدث خطأ أثناء معالجة الإيصال. [${response.status}]`);
                    console.error(`[RECEIPT_HANDLER] API Error for ${senderJid}: ${response.status} - ${errorText}`);
                }
            } catch (error) {
                await console.log(`🚫 عذراً، حدث خطأ فني أثناء معالجة طلبك.`);
                console.error('[RECEIPT_HANDLER_CRITICAL] An error occurred:', error.message);
            }
        }

        // CASE A: Message has "المبلغ:" and a document attached.
        if (amountMatch && msgType === 'documentMessage') {
            const amount = amountMatch[1];
            await processReceiptUpload(amount, m.message.documentMessage, ctx.sender);
            return; // Transaction handled, stop all further processing.
        }

        // CASE B: Message is only a document, check if an amount is pending for this sender.
        const pending = receiptState.getPendingReceipt(ctx.sender);
        if (pending && msgType === 'documentMessage') {
            await processReceiptUpload(pending.amount, m.message.documentMessage, ctx.sender);
            receiptState.clearPendingReceipt(ctx.sender);
            return; // Transaction handled, stop all further processing.
        }
        
        // CASE C: Message is only text containing "المبلغ:", set pending state.
        if (amountMatch) {
            const amount = amountMatch[1];
            receiptState.addPendingReceipt(ctx.sender, amount);
            await console.log(`تم استلام المبلغ: *${amount}*. \nالرجاء إرسال إيصال الـ PDF الآن.`);
            return; // Stop processing, wait for the document.
        }

    } catch (e) {
        console.error(`[HANDLER_RECEIPT_ERROR] Error in receipt handling logic: ${e.message}`, e.stack);
    }

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
                    console.log(addResult.success ? `Group ${ctx.groupMetadata.subject || ctx.chatId} added to whitelist.` : `Failed: ${addResult.reason}`);
                } else {
                    // console.log(`This command can only be used in a group.`);
                }
                break;
            case '!removegroup':
                if (ctx.isGroup) {
                    const removeResult = removeFromWhitelist(ctx.chatId);
                    console.log(removeResult.success ? `Group ${ctx.groupMetadata.subject || ctx.chatId} removed from whitelist.` : `Failed: ${removeResult.reason}`);
                } else {
                    //  console.log(`This command can only be used in a group.`);
                }
                break;
            case '!addtochatwhitelist':
                if (args.length > 0) {
                    const jidToAdd = formatJid(args[0]);
                    if (jidToAdd) {
                        const addResult = addToWhitelist(jidToAdd);
                        console.log(addResult.success ? `${jidToAdd.split('@')[0]} added to general whitelist.` : `Failed: ${addResult.reason}`);
                    } else {
                        //  console.log(`Invalid JID format: ${args[0]}`);
                    }
                } else {
                    //  console.log(`Usage: !addtochatwhitelist <phone_number_or_group_jid>`); 
                }
                break;
            case '!removefromchatwhitelist':
                if (args.length > 0) {
                    const jidToRemove = formatJid(args[0]);
                    if (jidToRemove) {
                        const removeResult = removeFromWhitelist(jidToRemove);
                        console.log(removeResult.success ? `${jidToRemove.split('@')[0]} removed from general whitelist.` : `Failed: ${removeResult.reason}`);
                    } else {
                        //  console.log(`Invalid JID format: ${args[0]}`);
                    }
                } else {
                    //  console.log(`Usage: !removefromchatwhitelist <phone_number_or_group_jid>`);
                }
                break;
        }
    }
}

module.exports = { handleMessage };