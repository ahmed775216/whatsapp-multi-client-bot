// client-instance/handler.js
const { getContentType, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');

const { addToWhitelist, removeFromWhitelist, formatJid } = require('./plugins/whitelist');
const forwarderPlugin = require('./plugins/forwrder.js');
const withdrawalRequestsPlugin = require('./plugins/withdrawalRequests.js'); // NEW: Import withdrawalRequestsPlugin

const ALL_HANDLERS_FROM_PLUGINS = [
    // NEW: Add the withdrawalRequestsPlugin here.
    // It MUST come BEFORE the _whitelistFilter.js if you want it to block messages
    // before whitelist checks (e.g., if withdrawal requests can bypass whitelist).
    // If whitelist must ALWAYS apply, put it AFTER _whitelistFilter.js.
    // Given its nature, it likely needs to process messages from non-whitelisted users,
    // so placing it before _whitelistFilter.js is logical if it has its own filtering.
    // However, if withdrawal requests *must* come from whitelisted users/groups,
    // then it should come after _whitelistFilter.js.
    // Let's assume it should run *before* the general whitelist for now, as it might
    // have its own filtering for "special" commands.
    withdrawalRequestsPlugin.all, // NEW
    require('./plugins/_whitelistFilter.js').all, // Existing whitelist filter
    forwarderPlugin.all // Existing forwarder plugin
];


async function handleMessage(sock, m, options = {}) {
    if (!m.message) {
        console.log("[HANDLER] Message object is empty, skipping.");
        return;
    }
    const msgType = getContentType(m.message);
    if (!msgType) {
        console.warn("[HANDLER] Could not determine message type, skipping.");
        return;
    }

    if (msgType === 'protocolMessage' || msgType === 'senderKeyDistributionMessage') {
        console.log(`[HANDLER] Ignoring protocol/senderKeyDistribution message type: ${msgType}`);
        return;
    }

    const chatId = m.key.remoteJid;
    // initialSenderFromMessageKey: The raw sender ID from the message, could be a JID or a LID.
    const initialSenderFromMessageKey = jidNormalizedUser(m.key.participant || m.key.remoteJid);
    const isGroup = chatId.endsWith('@g.us');

    // actualSenderForLogic: This will be the ID used for all checks and passed to plugins.
    // Initialize with the raw sender, will try to resolve it to canonical JID.
    let actualSenderForLogic = initialSenderFromMessageKey; 

    // --- Start: Owner check, prioritizing the bot's own linked ID ---
    let isOwner = false;
    const botCanonicalJid = sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : null;
    const botLid = sock.user && sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;

    // Check if the sender is the bot's own linked number (which is also an owner by default)
    if (botCanonicalJid && (areJidsSameUser(initialSenderFromMessageKey, botCanonicalJid) ||
                             (botLid && areJidsSameUser(initialSenderFromMessageKey, botLid)))) {
        isOwner = true;
        actualSenderForLogic = botCanonicalJid; // Always use the canonical JID if it's the bot itself
        console.log(`[HANDLER_OWNER_PRIMARY] Sender (${initialSenderFromMessageKey}) identified as bot's own linked number/owner. Resolved JID: ${actualSenderForLogic}.`);
    } else {
        // Fallback for cases where owner might be different from bot's linked number (if bot is not the owner's number),
        // or just to verify with configured owner numbers.
        const ownerPhoneNumberStrings = (process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC || "")
            .split(',')
            .map(num => num.trim().replace(/@s\.whatsapp\.net$/, '')) // Extract only the number part
            .filter(num => num);

        for (const ownerPhone of ownerPhoneNumberStrings) {
            if (ownerPhone) {
                const configuredOwnerJid = jidNormalizedUser(`${ownerPhone}@s.whatsapp.net`);
                if (areJidsSameUser(initialSenderFromMessageKey, configuredOwnerJid)) {
                    isOwner = true;
                    // Attempt to use canonical JID from config, otherwise keep initial sender ID for consistency.
                    // This might be redundant if the initialSenderFromMessageKey itself is the canonical one,
                    // but safer in case Baileys reports a LID for a non-bot-owner in group metadata.
                    actualSenderForLogic = configuredOwnerJid; 
                    console.log(`[HANDLER_OWNER_FALLBACK] Sender (${initialSenderFromMessageKey}) matched configured owner (${configuredOwnerJid}).`);
                    break;
                }
            }
        }
    }
    // --- End: Owner check ---


    let groupMetadata = {};
    let participants = [];
    let isBotAdmin = false;
    let isAdminOfGroup = false; 

    if (isGroup) {
        try {
            // Attempt to fetch group metadata
            groupMetadata = await sock.groupMetadata(chatId);
            participants = groupMetadata.participants || [];

            // If `actualSenderForLogic` is still a LID and not yet an owner (covered by primary owner check)
            // try to resolve from group participants (only if not already canonical bot JID)
            if (actualSenderForLogic.endsWith('@lid') && !isOwner) { 
                 const senderParticipantInfo = participants.find(p => p && p.id && areJidsSameUser(p.id, initialSenderFromMessageKey));
                 if (senderParticipantInfo && senderParticipantInfo.id) {
                     actualSenderForLogic = jidNormalizedUser(senderParticipantInfo.id);
                     console.log(`[HANDLER_DETAIL] Resolved group participant LID (${initialSenderFromMessageKey}) to JID (${actualSenderForLogic}).`);
                 } else {
                     console.warn(`[HANDLER_WARN] Could not find full participant info for '${initialSenderFromMessageKey}' in group '${groupMetadata.subject || chatId}'. Using initial ID. (Possible LID or missing participant data)`);
                 }
            }

            const botJid = jidNormalizedUser(sock.user?.id); // Re-get it, already normalized
            const botParticipant = participants.find(p => p && p.id && areJidsSameUser(p.id, botJid));
            isBotAdmin = !!(botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin'));

            const senderAdminInfo = participants.find(p => p && p.id && areJidsSameUser(p.id, actualSenderForLogic));
            isAdminOfGroup = !!(senderAdminInfo && (senderAdminInfo.admin === 'admin' || senderAdminInfo.admin === 'superadmin'));
            
            console.log(`[HANDLER_DETAIL] Group Info: ${groupMetadata.subject || chatId}, Bot Admin: ${isBotAdmin}, Sender Admin: ${isAdminOfGroup} (Sender ID resolved to: ${actualSenderForLogic.split('@')[0]})`);

        } catch (e) {
            // CRITICAL FIX: If groupMetadata fetching fails, DO NOT block or reset `isOwner`.
            console.error(`[HANDLER_ERROR] Could not fetch group metadata or participant info for ${chatId}. Reason: ${e.message}.`);
            // `actualSenderForLogic` retains its value from the initial (and potentially owner) check.
        }
    }

    // Final consolidated log of resolved sender, helpful for debugging
    console.log(`[HANDLER] MSG From: ${actualSenderForLogic.split('@')[0]} (Initial Key: ${initialSenderFromMessageKey}, Resolved ID: ${actualSenderForLogic}) in ${isGroup ? 'Group: ' + (groupMetadata.subject || chatId.split('@')[0]) : 'DM'}. IsOwner: ${isOwner}. Text: "${m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || ''}"`);

    m.reply = (text, targetChatId = m.key.remoteJid, replyOptions = {}) => sock.sendMessage(targetChatId, (typeof text === 'string') ? { text: text } : text, { quoted: m, ...replyOptions });

    const msgContextInfo = m.message?.[msgType]?.contextInfo;
    m.mentionedJid = msgContextInfo?.mentionedJid || [];

    if (m.message?.[msgType]?.contextInfo?.quotedMessage) {
        console.log("[HANDLER] Message is a reply.");
        m.quoted = {
            key: {
                remoteJid: m.key.remoteJid,
                id: m.message[msgType].contextInfo.stanzaId,
                participant: m.message[msgType].contextInfo.participant
            },
            message: m.message[msgType].contextInfo.quotedMessage,
            sender: jidNormalizedUser(m.message[msgType].contextInfo.participant), // Correctly normalize quoted sender
        };
    }
    if (m.message?.[msgType]?.mimetype) {
        console.log(`[HANDLER] Message contains media: ${msgType}`);
         m.download = () => require('@whiskeysockets/baileys').downloadContentFromMessage(m.message[msgType], msgType.replace('Message', ''));
    }

    // Construct the context object (ctx) that is passed to plugins
    const ctx = {
        sock,
        m,
        chatId,
        sender: actualSenderForLogic, // IMPORTANT: Use the final, most resolved sender ID
        text: m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || '',
        usedPrefix: '!',
        isGroup,
        participants, // May be empty if group metadata failed
        groupMetadata, // May be empty if group metadata failed
        isAdmin: isAdminOfGroup, // Only true if group metadata was successfully fetched and sender is admin
        isBotAdmin, // Only true if group metadata was successfully fetched and bot is admin
        isOwner, // This is now accurately derived (from bot's own credentials or owner config)
        botJid: botCanonicalJid, // Canonical JID of the bot itself
    };

    // --- Run 'all' plugins, like _whitelistFilter.js ---
    for (const allHandler of ALL_HANDLERS_FROM_PLUGINS) {
        console.log(`[HANDLER] Running 'all' plugin: ${allHandler.name || 'Anonymous'}`);
        try {
            // If a plugin returns an empty object, it means it handled the message
            // and no further processing should occur.
            const blockResult = await allHandler(m, ctx); 
            if (blockResult && typeof blockResult === 'object' && Object.keys(blockResult).length === 0) {
                console.log(`[HANDLER] Message blocked by 'all' plugin (${allHandler.name || 'Anonymous'}). Halting further processing.`);
                return; // Stop processing further plugins and commands
            }
        } catch (e) {
            console.error(`[HANDLER_ERROR] Error in 'all' plugin (${allHandler.name || 'Anonymous'}):`, e);
        }
    }

    // --- Owner Commands (will now work as isOwner is correct) ---
    const command = ctx.text.split(' ')[0];
    const args = ctx.text.split(' ').slice(1);

    if (ctx.isOwner) { // This now uses the robust isOwner check
        console.log(`[HANDLER] Owner command received: ${command}. Executing...`); // Added log
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

                    if (jidToAdd.endsWith('@s.whatsapp.net')) {
                        const addResult = addToWhitelist(jidToAdd);
                        if (addResult.success) {
                            m.reply(`User ${jidToAdd.split('@')[0]} added to general whitelist.`);
                            console.log(`[HANDLER] Whitelisted user: ${jidToAdd}`);
                        } else {
                            m.reply(`Failed to add user to general whitelist: ${addResult.reason}`);
                            console.error(`[HANDLER] Failed to whitelist user ${jidToAdd}: ${addResult.reason}`);
                        }
                    } else if (jidToAdd.endsWith('@g.us')) { // Allow group JID for direct whitelist
                         const addResult = addToWhitelist(jidToAdd);
                         if (addResult.success) {
                             m.reply(`Group ${jidToAdd.split('@')[0]} added to general whitelist.`);
                             console.log(`[HANDLER] Whitelisted group: ${jidToAdd}`);
                         } else {
                             m.reply(`Failed to add group to general whitelist: ${addResult.reason}`);
                             console.error(`[HANDLER] Failed to whitelist group ${jidToAdd}: ${addResult.reason}`);
                         }
                    }
                    else {
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

                    if (jidToRemove.endsWith('@s.whatsapp.net')) {
                        const removeResult = removeFromWhitelist(jidToRemove);
                        if (removeResult.success) {
                            m.reply(`User ${jidToRemove.split('@')[0]} removed from general whitelist.`);
                            console.log(`[HANDLER] Removed user from general whitelist: ${jidToRemove}`);
                        } else {
                            m.reply(`Failed to remove user from general whitelist: ${removeResult.reason}`);
                            console.error(`[HANDLER] Failed to remove user ${jidToRemove}: ${removeResult.reason}`);
                        }
                    } else if (jidToRemove.endsWith('@g.us')) { // Allow group JID for direct removal
                         const removeResult = removeFromWhitelist(jidToRemove);
                         if (removeResult.success) {
                             m.reply(`Group ${jidToRemove.split('@')[0]} removed from general whitelist.`);
                             console.log(`[HANDLER] Removed group ${jidToRemove} from general whitelist.`);
                         } else {
                             m.reply(`Failed to remove group from general whitelist: ${removeResult.reason}`);
                             console.error(`[HANDLER] Failed to remove group ${jidToRemove}: ${removeResult.reason}`);
                         }
                    }
                    else {
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