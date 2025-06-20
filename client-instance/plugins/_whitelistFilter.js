// client-instance/plugins/_whitelistFilter.js
// This plugin handles the whitelist filtering for all messages for an individual client bot.
// Underscore prefix ensures it loads early.

// استيراد الدوال الجديدة من whitelist.js
const { isWhitelisted, getAskedLidsCache, saveAskedLidsFile, getPendingLidIdentifications, savePendingIdsFile } = require('./whitelist');
const { jidNormalizedUser } = require('@whiskeysockets/baileys'); // تأكد من استيراد jidNormalizedUser
let process = require('process');
const ASK_LID_COOLDOWN_MS = 5 * 60 * 1000; // 5 دقائق قبل إعادة سؤال نفس @lid

const botContactsDb = require('../../database/botContactsDb');
module.exports = {
    all: async function (m, { /* sock, */ chatId, sender, isGroup, isOwner, pushName /* pushName now passed in ctx */ }) {
        // sender هنا هو actualSenderForLogic من handler.js (قد يكون @lid أو رقم هاتف محلول)
        // originalMessageSenderJid هو JID المرسل الأصلي (m.key.participant || m.key.remoteJid)

        // الحصول على كاشات الذاكرة الدائمة
        const askedLidsMap =await getAskedLidsCache();
        const pendingIdentificationsMap =await getPendingLidIdentifications();

        // يجب أن نستخدم JID المرسل الأصلي للتحقق من كاش @lid و pendingIdentificationsMap
        const originalMessageSenderJid =  jidNormalizedUser(m.key.participant || m.key.remoteJid);
        try {
            // We need the numeric botInstanceId to interact with the database.
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
                
                // This is a "fire-and-forget" call for performance.
                // It will handle the insert or merge in the background.
                botContactsDb.upsertBotContact(botInstanceId, contactData)
                    .catch(e => console.error(`[_WHITELIST_FILTER_ERROR] Background contact upsert failed: ${e.message}`));
            }
        } catch (err) {
            console.error(`[_WHITELIST_FILTER_ERROR] An error occurred during contact auto-add: ${err.message}`);
        }

        if (isOwner) {
            console.log(`[${process.env.CLIENT_ID}_FILTER] Message from owner ${sender.split('@')[0]} (Name: ${pushName}) in ${isGroup ? 'group ' + chatId.split('@')[0] : 'DM'} ALLOWED by owner filter.`);
            return m; // Allow all messages from owner
        }
        
        // إذا كان المرسل @lid وينتظر تعريفًا بالفعل، دعه يمر إلى handler.js ليعالج الرد
        if (originalMessageSenderJid.endsWith('@lid') && pendingIdentificationsMap.has(originalMessageSenderJid)) {
            console.log(`[${process.env.CLIENT_ID}_FILTER] @lid ${originalMessageSenderJid} (Name: ${pushName}) is pending identification. Allowing to pass to handler for potential phone number reply.`);
            return m;
        }


        // الخطوة 1: التحقق من القائمة البيضاء الأساسية (سواء كان رقمًا أو @lid تم حله بالفعل بواسطة handler.js)
        if (isWhitelisted(sender)) { // sender هنا هو actualSenderForLogic (رقم هاتف JID بعد الحل أو @lid)
            // إذا كان المستخدم في القائمة البيضاء وهو في مجموعة، تحقق من أذونات المجموعة
            if (isGroup) {
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

                // sender هنا هو رقم الهاتف JID بعد الحل
                const senderAllowedInGroups = global.userGroupPermissions && global.userGroupPermissions[sender] && global.userGroupPermissions[sender].allowed_in_groups === true;
                if (!senderAllowedInGroups) {
                    console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender.split('@')[0]} (Name: ${pushName}) is whitelisted but NOT allowed in groups. Blocking message in group ${chatId.split('@')[0]}.`);
                    try { 
                        // await sock.sendMessage(m.key.remoteJid, { react: { text: ' Restricted Access 🚫', key: m.key } }); 
                    } catch (e) { 
                        console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to react to message from non-whitelisted group ${chatId.split('@')[0]}: ${e.message}`);
                     }
                    return {}; // Block message
                }
            }
            // إذا كان المستخدم في القائمة البيضاء (وليس في مجموعة أو مسموح له في المجموعات)، اسمح بالرسالة
            console.log(`[${process.env.CLIENT_ID}_FILTER] Message from whitelisted sender ${sender.split('@')[0]} (Name: ${pushName}) ALLOWED.`);
            return m;
        }

        // الخطوة 2: إذا لم يكن في القائمة البيضاء وكان originalMessageSenderJid هو @lid لم يتم حله بعد
        // (أي أن sender لا يزال @lid ولم يتم العثور عليه في الكاش أو groupMetadata)
        if (originalMessageSenderJid.endsWith('@lid')) {
            const lastAskedTime = askedLidsMap.get(originalMessageSenderJid);
            if (lastAskedTime && (Date.now() - lastAskedTime < ASK_LID_COOLDOWN_MS)) {
                console.log(`[${process.env.CLIENT_ID}_FILTER] Already asked @lid ${originalMessageSenderJid} (Name: ${pushName}) for identification recently. Blocking silently.`);
                return {}; // منع الرسالة بصمت لتجنب الإزعاج
            }

            console.log(`[${process.env.CLIENT_ID}_FILTER] Unresolved @lid ${originalMessageSenderJid} (Name: ${pushName}) is not whitelisted. Requesting identification.`);
            try {
                // const sentMsg = await sock.sendMessage(m.key.remoteJid, {
                //     text: `مرحبًا ${pushName || ''}! لم نتمكن من التحقق من هويتك تلقائيًا. للوصول إلى خدمات البوت، يرجى إرسال رقم هاتفك الكامل المسجل لدينا (مع مفتاح الدولة، مثال: +967xxxxxxxxx).`
                // });
                askedLidsMap.set(originalMessageSenderJid, Date.now());
                saveAskedLidsFile(); // حفظ تحديث الكاش
                
                // تسجيل أننا في انتظار رد من هذا الـ LID
                pendingIdentificationsMap.set(originalMessageSenderJid, { timestamp: Date.now(), messageKey: m.key });
                savePendingIdsFile(); // حفظ تحديث الكاش
                
                // console.log(`[${process.env.CLIENT_ID}_FILTER] Identification request sent to @lid ${originalMessageSenderJid}. Message ID: ${sentMsg.key.id}`);
            } catch (e) {
                console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to send identification request to @lid ${originalMessageSenderJid}: ${e.message}`);
            }
            return {}; // منع الرسالة الحالية حتى يتم التحقق
        }

        // الخطوة 3: إذا لم يكن مالكًا، ولم يكن في القائمة البيضاء، وليس @lid (أي أنه رقم هاتف غير مدرج)
        console.log(`[${process.env.CLIENT_ID}_FILTER] Sender ${sender.split('@')[0]} (Name: ${pushName}) is not whitelisted and not an unresolved @lid. Blocking message.`);
        if (!isGroup) { // إرسال رسالة رفض فقط في الخاص
            try {
                // await m.reply(`عذراً ${pushName || ''}! لا يمكنك استخدام هذا البوت. يرجى التواصل مع المسؤول إذا كنت تعتقد أن هذا خطأ.`);
            } catch (e) { console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to send DM rejection to non-whitelisted user ${sender.split('@')[0]}: ${e.message}`); }
        } else { // في المجموعات، يمكن وضع رد فعل فقط
             try { 
                // await sock.sendMessage(m.key.remoteJid, { react: { text: '🚫', key: m.key } });
             } catch (e) {
                console.error(`[${process.env.CLIENT_ID}_FILTER_ERROR] Failed to react to message from non-whitelisted user ${sender.split('@')[0]}: ${e.message}`);
              }
        }
        return {}; // Block message
    }
};