
const { isWhitelisted,isAllowedInGroups,isAllowedInDm } = require('./whitelist');
const { jidNormalizedUser } = require('@whiskeysockets/baileys'); // تأكد من استيراد jidNormalizedUser
let process = require('process');
const botContactsDb = require('../../database/botContactsDb');
module.exports = {
    all: async function (m, { /* sock, */ chatId, sender, isGroup, isOwner, pushName }) {
       
        const originalMessageSenderJid =  jidNormalizedUser(m.key.participant || m.key.remoteJid);
        try {

            const botInstanceId = await require('../lib/apiSync').getBotInstanceId();
    
            // Only proceed if we have an instance ID and a valid name from the message.
            if (botInstanceId && pushName && pushName !== 'UnknownPN') {
                const contactData = {
                    userJid: sender.endsWith('@s.whatsapp.net') ? sender : null,
                    lidJid: sender.endsWith('@lid') ? sender : null,
                    phoneNumber: sender.split('@')[0],
                    displayName: pushName, // This is the reliable name we need
                    whatsappName: pushName,
                    isWhatsappContact: true,
                    isSavedContact: false // Auto-added from a message, not a saved contact
                };
                botContactsDb.upsertBotContact(botInstanceId, contactData)
                    .catch(e => console.error(`[_WHITELIST_FILTER_ERROR] Background contact upsert failed: ${e.message}`));
            }  await botContactsDb.ensureContactConsistency(botInstanceId, originalMessageSenderJid);
        } catch (err) {
            console.error(`[_WHITELIST_FILTER_ERROR] An error occurred during contact auto-add: ${err.message}`);
        }

        if (isOwner) {
            console.log(`[${process.env.CLIENT_ID}_FILTER] Message from owner ${sender.split('@')[0]} (Name: ${pushName}) in ${isGroup ? 'group ' + chatId.split('@')[0] : 'DM'} ALLOWED by owner filter.`);
            return m; // Allow all messages from owner
        }
        // الخطوة 1: التحقق من القائمة البيضاء الأساسية (سواء كان رقمًا أو @lid تم حله بالفعل بواسطة handler.js)
        if (isWhitelisted(sender)) { // sender هنا هو actualSenderForLogic (رقم هاتف JID بعد الحل أو @lid)
            // إذا كان المستخدم في القائمة البيضاء وهو في مجموعة، تحقق من أذونات المجموعة
                const isChatWhitelisted = isWhitelisted(chatId); // تحقق مما إذا كانت المجموعة نفسها في القائمة البيضاء
                 if (!isChatWhitelisted) {
                    console.log(`[${process.env.CLIENT_ID}_FILTER] Group ${chatId.split('@')[0]} not whitelisted. Blocking message from ${sender.split('@')[0]} (Name: ${pushName}).`);
                    try { 
                        // await sock.sendMessage(m.key.remoteJid, { react: { text: '🚫', key: m.key } });
                     } catch (e) { 
                        console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to react to message from non-whitelisted group ${chatId.split('@')[0]}: ${e.message}`);
                     }
                    return {}; // Block message
                }

                const isSenderWhitelisted = await isWhitelisted(sender); 

                if (isSenderWhitelisted) {
                    if (isGroup) {
        
                        const isChatWhitelisted = await isWhitelisted(chatId);
                        if (!isChatWhitelisted) {
                            console.log(`[${process.env.CLIENT_ID}_FILTER] Group ${chatId.split('@')[0]} not whitelisted. Blocking message.`);
                            return {};
                        }
            
                        const senderAllowedInGroups = await isAllowedInGroups(sender); 
                        if (!senderAllowedInGroups) {
                            console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender} is NOT allowed in groups. Blocking message.`);
                            return {};
                        }
                    } else {
                        // --- DIRECT MESSAGE (DM) LOGIC ---
                        const senderAllowedInDm = await isAllowedInDm(sender);
                        if (!senderAllowedInDm) {
                            console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender} is NOT allowed in DMs. Blocking message.`);
                            return {};
                        }
                    }
            
                    console.log(`[${process.env.CLIENT_ID}_FILTER] Message from whitelisted sender ${sender} ALLOWED in ${isGroup ? 'group' : 'DM'}.`);
                    return m;
                }
            }

        return {}; // Block message
    }
};