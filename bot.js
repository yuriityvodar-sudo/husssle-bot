/**
 * Husssle Bot — MVP with Firestore
 * Telegram job marketplace for Nairobi
 */

const TelegramBot  = require('node-telegram-bot-api');
const admin        = require('firebase-admin');
const path         = require('path');

// ─── Firebase init ────────────────────────────────────────────────────────────
let serviceAccount;
if (process.env.FIREBASE_CREDENTIALS) {
  serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
} else {
  serviceAccount = require('./huse-19bfc-firebase-adminsdk-fbsvc-f303cf85f0.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ─── Bot init ─────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const CHANNEL_ID = '@husssleke';
const ADMIN_ID   = 889114803;

// ─── Rate Limiter ────────────────────────────────────────────────────────────
const userActions = {}; // { userId: { count, firstAction, lastAction, blockedUntil } }

function checkRateLimit(userId, chatId) {
  const now = Date.now();
  if (!userActions[userId]) {
    userActions[userId] = { count: 1, firstAction: now, lastAction: now, blockedUntil: 0 };
    return true;
  }

  const u = userActions[userId];

  // Check if temp blocked
  if (u.blockedUntil > now) {
    const remaining = Math.ceil((u.blockedUntil - now) / 60000);
    bot.sendMessage(chatId, `🚫 You've been temporarily restricted. Try again in ${remaining} minute(s).`);
    return false;
  }

  // Reset counter if more than 1 minute since first action
  if (now - u.firstAction > 60000) {
    userActions[userId] = { count: 1, firstAction: now, lastAction: now, blockedUntil: 0 };
    return true;
  }

  // Level 1 — same action within 2s: silent ignore
  if (now - u.lastAction < 2000) {
    u.lastAction = now;
    return false;
  }

  u.count++;
  u.lastAction = now;

  // Level 4 — 25+ actions: notify admin
  if (u.count === 25) {
    bot.sendMessage(ADMIN_ID, `⚠️ *Spam alert*\n\nUser ID: ${userId} is hammering the bot (${u.count} actions in 1 min).`, { parse_mode: 'Markdown' }).catch(() => {});
  }

  // Level 3 — 15+ actions: temp block for 5 minutes
  if (u.count >= 15) {
    u.blockedUntil = now + 5 * 60 * 1000;
    bot.sendMessage(chatId, '🚫 You have been temporarily restricted for 5 minutes due to too many actions.');
    return false;
  }

  // Level 2 — 10+ actions: warn
  if (u.count >= 10) {
    bot.sendMessage(chatId, '⚠️ You\'re going too fast. Please slow down.');
    return true;
  }

  return true;
}

const BANNED_WORDS = [
  // Scam/Fraud
  'scam', 'fraud', 'fake', 'cheat', 'steal', 'hack',
  // Explicit/Adult
  'sex', 'porn', 'nude', 'naked', 'escort', 'prostitut',
  'onlyfans', 'adult', 'erotic', 'strip', 'hookup', 'sensual',
  // Profanity
  'shit', 'fuck', 'bitch', 'bastard', 'asshole', 'damn',
  'crap', 'piss', 'dick', 'cock', 'pussy', 'cunt', 'ass ',
  'suck', 'balls', 'butt', 'arse', 'boob', 'tit',
  // Weapons/Drugs
  'drug', 'cocaine', 'weed', 'gun', 'weapon', 'kill',
  // Spam
  'free money', 'guaranteed', 'get rich', 'bitcoin', 'crypto invest',
];

function containsBannedWords(text) {
  const lower = text.toLowerCase();
  return BANNED_WORDS.find(word => lower.includes(word)) || null;
}
const bot        = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── In-memory session store (sessions don't need to persist) ─────────────────
const sessions = {};
function getSession(userId) {
  if (!sessions[userId]) sessions[userId] = { step: null, draft: {} };
  return sessions[userId];
}
function clearSession(userId) {
  sessions[userId] = { step: null, draft: {} };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLang(from) {
  const code = from && from.language_code ? from.language_code.split('-')[0] : 'en';
  return ['uk', 'en'].includes(code) ? code : 'en';
}

function getRatingStars(rating, ratingCount) {
  if (!ratingCount) return '⭐ New';
  const avg = (rating / ratingCount).toFixed(1);
  return `⭐ ${avg} (${ratingCount} reviews)`;
}

function getJobStatus(status) {
  if (status === 'open')  return '🟢 Open';
  if (status === 'taken') return '🟡 Taken';
  if (status === 'done')  return '✅ Done';
  return status;
}

function formatChannelPost(job) {
  return (
    `💼 *${job.title}*\n\n` +
    `📝 ${job.description}\n\n` +
    `💰 *KES ${job.pay}*\n` +
    `📍 ${job.location}\n` +
    `${job.urgency || '⏰ Flexible'}\n\n` +
    `👤 Posted by: ${job.posterName} — ${getRatingStars(job.posterRating || 0, job.posterRatingCount || 0)}\n` +
    `📌 Status: ${getJobStatus(job.status)}\n` +
    `🆔 Job: #${job.id}`
  );
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: '➕ Post a hustle',            callback_data: 'post_start' }],
      [{ text: '📬 My applications', callback_data: 'my_applications' }],
      [{ text: '📌 My posted jobs',         callback_data: 'my_jobs' }],
    ]
  };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
async function getUser(from) {
  const ref = db.collection('users').doc(String(from.id));
  const doc = await ref.get();
  if (!doc.exists) {
    const user = {
      id:          from.id,
      name:        [from.first_name, from.last_name].filter(Boolean).join(' '),
      username:    from.username || null,
      phone:       null,
      rating:      0,
      ratingCount: 0,
      lang:        getLang(from),
      createdAt:   Date.now(),
    };
    await ref.set(user);
    return user;
  }
  const data = doc.data();
  const currentLang = getLang(from);
  const currentName = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const currentUsername = from.username || null;

  // sync name, username and lang if anything changed
  const updates = {};
  if (data.lang !== currentLang)         updates.lang     = currentLang;
  if (data.name !== currentName)         updates.name     = currentName;
  if (data.username !== currentUsername) updates.username = currentUsername;

  if (Object.keys(updates).length > 0) {
    await ref.update(updates);
    Object.assign(data, updates);
  }

  return data;
}

async function updateUser(userId, data) {
  await db.collection('users').doc(String(userId)).update(data);
}

async function hasPendingFeedback(userId) {
  const snap = await db.collection('pendingFeedback').where('fromUserId', '==', userId).limit(1).get();
  return snap.empty ? null : { ...snap.docs[0].data(), docId: snap.docs[0].id };
}

async function getJob(jobId) {
  const doc = await db.collection('jobs').doc(String(jobId)).get();
  if (!doc.exists) return null;
  return { ...doc.data(), docId: doc.id };
}

async function getOpenJobs() {
  const snap = await db.collection('jobs').where('status', '==', 'open').orderBy('createdAt', 'desc').limit(10).get();
  return snap.docs.map(d => ({ ...d.data(), docId: d.id }));
}

async function getUserJobs(userId) {
  const snap = await db.collection('jobs').where('posterId', '==', userId).orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => ({ ...d.data(), docId: d.id }));
}

async function getUserApplications(userId) {
  const snap = await db.collection('applications').where('workerId', '==', userId).orderBy('appliedAt', 'desc').get();
  return snap.docs.map(d => ({ ...d.data(), docId: d.id }));
}

async function getJobApplications(jobId) {
  const snap = await db.collection('applications').where('jobId', '==', jobId).orderBy('appliedAt', 'asc').get();
  return snap.docs.map(d => ({ ...d.data(), docId: d.id }));
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s(.+))?/, async (msg, match) => {
  const user = await getUser(msg.from);
  const param = match[1];

  if (param === 'post') { startPostFlow(msg.chat.id, msg.from.id); return; }

  if (param && param.startsWith('apply_')) {
    const jobId = param.replace('apply_', '');
    showJobDetail(msg.chat.id, msg.from.id, jobId);
    return;
  }


  // Ask for phone on first use
  if (!user.phone) {
    const s = getSession(msg.from.id);
    s.step = 'collect_phone_for_post';
    bot.sendMessage(msg.chat.id,
      '👋 *Karibu Husssle!*\n\nThe hustle marketplace for Nairobi.\nFind work or get work done. Simple.\n\n📱 First, what\'s your phone number?',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    );
    return;
  }

  bot.sendMessage(msg.chat.id,
    '👋 *Karibu Husssle!*\n\nThe hustle marketplace for Nairobi.\nFind work or get work done. Simple.\n\n🤖 *This bot is your personal hustle manager:*\n• Post a job → workers apply → you pick the best one\n• Looking for work → browse & apply in seconds\n• Everything happens here — no calls, no WhatsApp groups\n• Get rated after every job to build your reputation\n\nWhat do you want to do?',
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );
});

bot.onText(/\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Main menu:', { reply_markup: mainMenu() });
});

bot.onText(/\/work/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Loading your work...', { reply_markup: { inline_keyboard: [[{ text: '📬 My Work', callback_data: 'my_applications' }]] } });
});

bot.onText(/\/jobs/, (msg) => {
  showJobList(msg.chat.id);
});

bot.onText(/\/post/, (msg) => {
  startPostFlow(msg.chat.id, msg.from.id);
});

bot.onText(/\/admin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const snap = await db.collection('jobs')
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  if (snap.empty) {
    bot.sendMessage(msg.chat.id, '✅ No jobs found.');
    return;
  }
  const jobs = snap.docs.map(d => ({ ...d.data(), docId: d.id }));
  const buttons = jobs.map(j => ([{
    text: `${getJobStatus(j.status)} ${j.title} — KES ${j.pay}`,
    callback_data: `admin_delete_${j.id}`
  }]));
  bot.sendMessage(msg.chat.id,
    `🔐 *Admin — all jobs* (${jobs.length})\n\nTap to delete:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
});

bot.onText(/\/banned/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const snap = await db.collection('users').where('banned', '==', true).get();
  if (snap.empty) {
    bot.sendMessage(msg.chat.id, '✅ No banned users.');
    return;
  }
  const buttons = snap.docs.map(doc => {
    const u = doc.data();
    return [{ text: `🔓 Unban ${u.name} (${u.id})`, callback_data: `unban_user_${u.id}` }];
  });
  const text = `🚫 *Banned Users* (${snap.size})\n\nTap to unban:`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
});

// ─── Callback query handler ───────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const userId = query.from.id;
  const data   = query.data;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  // Always clear buttons from the tapped message, except noop
  if (data !== 'noop') {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
  }

  if (!checkRateLimit(userId, chatId)) return;

  const user = await getUser(query.from);
  if (user.banned && userId !== ADMIN_ID) {
    bot.sendMessage(chatId, '🚫 You have been banned from Husssle.\n\nIf you think this is a mistake, contact support.');
    return;
  }

  if (data === 'browse') { showJobList(chatId); return; }

  if (data.startsWith('view_job_')) {
    showJobDetail(chatId, userId, data.replace('view_job_', ''));
    return;
  }

  if (data.startsWith('apply_')) {
    const jobId = data.replace('apply_', '');
    const job   = await getJob(jobId);
    if (!job) { bot.sendMessage(chatId, '❌ Job not found.'); return; }
    if (job.posterId === userId) { bot.sendMessage(chatId, "⚠️ You can't apply to your own hustle."); return; }
    if (job.status !== 'open')  { bot.sendMessage(chatId, "⚠️ This hustle is no longer open."); return; }

    const apps = await getJobApplications(jobId);
    const myApp = apps.find(a => a.workerId === userId);
    if (myApp) {
      if (myApp.status === 'rejected') {
        // Allow one re-apply after rejection
        await db.collection('applications').doc(myApp.docId || `${jobId}_${userId}`).update({ status: 'pending', appliedAt: Date.now() });
        bot.sendMessage(chatId, `✅ *Re-application sent!*\n\n${job.title}\nKES ${job.pay} · ${job.location}\n\nGood luck this time! 🤞`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📬 My applications', callback_data: 'my_applications' }]] } });
        // Notify poster
        bot.sendMessage(job.posterId,
          `🔔 *${user.name}* re-applied to your hustle *${job.title}*\n\nTap to review:`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '👥 Review applicants', callback_data: `view_applicants_${jobId}` }]] } }
        ).catch(() => {});
        return;
      }
      bot.sendMessage(chatId, '✅ You already applied to this hustle.'); return;
    }

    // Check pending feedback first
    const pendingFb = await hasPendingFeedback(userId);
    if (pendingFb) {
      const s = getSession(userId);
      s.step = 'write_review_pending';
      s.draft.pendingFeedbackDocId = pendingFb.docId;
      s.draft.pendingFeedbackToId  = pendingFb.toUserId;
      s.draft.pendingFeedbackStars = null;
      s.draft.afterFeedback = { action: 'apply', jobId };
      bot.sendMessage(chatId,
        `⚠️ *Before you can apply, you need to leave feedback!*\n\nJob: *${pendingFb.jobTitle}*\n\nFirst, rate your experience (1-5 stars):`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '⭐1', callback_data: `pending_fb_stars_1` },
          { text: '⭐2', callback_data: `pending_fb_stars_2` },
          { text: '⭐3', callback_data: `pending_fb_stars_3` },
          { text: '⭐4', callback_data: `pending_fb_stars_4` },
          { text: '⭐5', callback_data: `pending_fb_stars_5` },
        ]] }}
      );
      return;
    }

    if (!user.phone) {
      const s = getSession(userId);
      s.step = 'collect_phone';
      s.draft.pendingJobId = jobId;
      bot.sendMessage(chatId,
        `📱 Before applying, we need your phone number.\n\nPlease type your phone number:`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
      );
      return;
    }
    // Confirm phone before applying
    const s = getSession(userId);
    s.draft.pendingJobId = jobId;
    bot.sendMessage(chatId,
      `📱 Your contact number:\n*${user.phone}*\n\nIs this correct?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, use this', callback_data: `confirm_phone_apply_${jobId}` }],
        [{ text: '✏️ Change number', callback_data: `change_phone_apply_${jobId}` }],
      ]}}
    );
    return;
  }

  if (data === 'post_start') {
    // Check pending feedback first
    const pendingFb = await hasPendingFeedback(userId);
    if (pendingFb) {
      const s = getSession(userId);
      s.step = 'write_review_pending';
      s.draft.pendingFeedbackDocId = pendingFb.docId;
      s.draft.pendingFeedbackToId  = pendingFb.toUserId;
      s.draft.pendingFeedbackStars = null;
      s.draft.afterFeedback = { action: 'post' };
      bot.sendMessage(chatId,
        `⚠️ *Before you can post, you need to leave feedback!*\n\nJob: *${pendingFb.jobTitle}*\n\nFirst, rate your experience (1-5 stars):`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '⭐1', callback_data: `pending_fb_stars_1` },
          { text: '⭐2', callback_data: `pending_fb_stars_2` },
          { text: '⭐3', callback_data: `pending_fb_stars_3` },
          { text: '⭐4', callback_data: `pending_fb_stars_4` },
          { text: '⭐5', callback_data: `pending_fb_stars_5` },
        ]] }}
      );
      return;
    }
    if (!user.phone) {
      const s = getSession(userId);
      s.step = 'collect_phone_for_post';
      bot.sendMessage(chatId,
        `📱 Before posting, we need your phone number.\n\nPlease type your phone number:`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
      );
      return;
    }
    startPostFlow(chatId, userId);
    return;
  }

  if (data === 'my_applications') {
    const apps = await getUserApplications(userId);
    if (!apps.length) {
      bot.sendMessage(chatId,
        `📬 *My Work*\n\nYou haven't applied to any hustles yet.`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 Browse hustles', callback_data: 'browse' }]] } }
      );
      return;
    }

    const active   = apps.filter(a => a.status === 'accepted');
    const done     = apps.filter(a => a.status === 'done');
    const pending  = apps.filter(a => a.status === 'pending');
    const rejected = apps.filter(a => a.status === 'rejected');

    let text = '📬 *My Work*\n\n';
    const buttons = [];

    if (active.length) {
      text += '━━━━━━━━━━━━━━━\n🚨 *ACTIVE JOBS* 🚨\n━━━━━━━━━━━━━━━\n\n';
      active.forEach(a => {
        text += `🔨 *${a.jobTitle}* · KES ${a.jobPay}\n`;
        buttons.push([{ text: `🔨 ${a.jobTitle} — KES ${a.jobPay}`, callback_data: `worker_job_${a.jobId}` }]);
      });
      text += '\n';
    }

    if (pending.length) {
      text += `⏳ *Pending (${pending.length})*\n`;
      pending.forEach(a => { text += `• ${a.jobTitle} · KES ${a.jobPay}\n`; });
      text += '\n';
    }

    if (rejected.length) {
      text += `❌ *Not selected (${rejected.length})*\n`;
      rejected.forEach(a => { text += `• ${a.jobTitle}\n`; });
      text += '\n';
    }

    if (done.length) {
      text += `✅ *Done (${done.length})*\n`;
      done.forEach(a => { text += `• ${a.jobTitle} · KES ${a.jobPay}\n`; });
    }

    buttons.push([{ text: '📋 Browse more', callback_data: 'browse' }]);
    buttons.push([{ text: '← Menu', callback_data: 'menu_back' }]);

    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (data === 'my_jobs') {
    const myJobs = await getUserJobs(userId);
    if (!myJobs.length) {
      bot.sendMessage(chatId,
        `📌 *Your Posted Hustles*\n\nYou haven't posted anything yet.`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '➕ Post a hustle', callback_data: 'post_start' }]] } }
      );
      return;
    }

    // Show each job with its action buttons directly
    for (const j of myJobs) {
      const apps = await getJobApplications(j.id);
      const pending  = apps.filter(a => a.status === 'pending').length;
      const accepted = apps.filter(a => a.status === 'accepted').length;
      const buttons = [];
      if (pending)              buttons.push([{ text: `⏳ Pending (${pending})`, callback_data: `view_applicants_${j.id}` }]);
      if (accepted)             buttons.push([{ text: `✅ Accepted (${accepted})`, callback_data: `view_accepted_${j.id}` }]);
      if (j.status === 'taken') buttons.push([{ text: '✅ Mark as Done', callback_data: `mark_done_${j.id}` }]);
      if (j.status === 'taken') buttons.push([{ text: '🔄 Re-open', callback_data: `reopen_job_${j.id}` }]);
      if (j.status === 'taken') buttons.push([{ text: '❌ Cancel', callback_data: `cancel_job_${j.id}` }]);
      if (j.status !== 'done')  buttons.push([{ text: '🗑️ Delete', callback_data: `delete_job_${j.id}` }]);
      buttons.push([{ text: '← Menu', callback_data: 'menu_back' }]);

      await bot.sendMessage(chatId,
        `${getJobStatus(j.status)} *${j.title}*\nKES ${j.pay} · ${j.location}\n${j.urgency || ''}\n⏳ ${pending} pending · ✅ ${accepted} accepted`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
      );
    }
    return;
  }

  if (data.startsWith('manage_job_')) {
    showManageJob(chatId, userId, data.replace('manage_job_', ''));
    return;
  }

  if (data.startsWith('admin_delete_')) {
    if (userId !== ADMIN_ID) return;
    const jobId = data.replace('admin_delete_', '');
    const job = await getJob(jobId);
    if (!job) { bot.sendMessage(chatId, '❌ Job not found.'); return; }
    bot.sendMessage(chatId,
      `🗑️ *Delete "${job.title}"?*\n\nThis will remove the job from the channel and database.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, delete', callback_data: `confirm_admin_delete_${jobId}` }],
        [{ text: '❌ Cancel', callback_data: 'browse' }],
      ]}}
    );
    return;
  }

  if (data.startsWith('confirm_admin_delete_')) {
    if (userId !== ADMIN_ID) return;
    const jobId = data.replace('confirm_admin_delete_', '');
    const job = await getJob(jobId);
    if (!job) { bot.sendMessage(chatId, '❌ Job not found.'); return; }
    if (job.channelMsgId) {
      await bot.deleteMessage(CHANNEL_ID, job.channelMsgId).catch(() => {});
    }
    const apps = await getJobApplications(jobId);
    for (const app of apps) {
      await db.collection('applications').doc(app.docId).delete().catch(() => {});
    }
    await db.collection('jobs').doc(String(jobId)).delete();
    bot.sendMessage(chatId, `✅ Job "${job.title}" deleted.`, { reply_markup: mainMenu() });
    return;
  }

  if (data.startsWith('unban_user_')) {
    if (userId !== ADMIN_ID) return;
    const targetId = parseInt(data.replace('unban_user_', ''));
    await db.collection('users').doc(String(targetId)).update({ banned: false });
    const targetDoc = await db.collection('users').doc(String(targetId)).get();
    const targetName = targetDoc.exists ? targetDoc.data().name : 'Unknown';
    bot.sendMessage(targetId, '✅ You have been unbanned from Husssle. Welcome back!').catch(() => {});
    bot.sendMessage(chatId, `✅ *${targetName}* has been unbanned.`, { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('ban_user_')) {
    if (userId !== ADMIN_ID) return;
    const targetId = parseInt(data.replace('ban_user_', ''));
    const targetDoc = await db.collection('users').doc(String(targetId)).get();
    const targetName = targetDoc.exists ? targetDoc.data().name : 'Unknown';
    bot.sendMessage(chatId,
      `🚫 *Ban ${targetName}?*\n\nThis will prevent them from using the bot.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, ban them', callback_data: `confirm_ban_${targetId}` }],
        [{ text: '❌ Cancel', callback_data: 'cancel' }],
      ]}}
    );
    return;
  }

  if (data.startsWith('confirm_ban_')) {
    if (userId !== ADMIN_ID) return;
    const targetId = parseInt(data.replace('confirm_ban_', ''));
    await db.collection('users').doc(String(targetId)).update({ banned: true });
    const targetDoc = await db.collection('users').doc(String(targetId)).get();
    const targetName = targetDoc.exists ? targetDoc.data().name : 'Unknown';
    bot.sendMessage(targetId, '🚫 You have been banned from Husssle.\n\nIf you think this is a mistake, contact support.').catch(() => {});
    bot.sendMessage(chatId, `✅ *${targetName}* has been banned.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '← Menu', callback_data: 'menu_back' }]] } });
    return;
  }

  if (data.startsWith('reopen_job_')) {
    const jobId = data.replace('reopen_job_', '');
    const job = await getJob(jobId);
    if (!job || job.posterId !== userId) return;
    // Find accepted worker and notify them
    const apps = await getJobApplications(jobId);
    const acceptedApp = apps.find(a => a.status === 'accepted');
    if (acceptedApp) {
      await db.collection('applications').doc(`${jobId}_${acceptedApp.workerId}`).update({ status: 'rejected' });
      bot.sendMessage(acceptedApp.workerId,
        `ℹ️ *Job Update*\n\nThe job *${job.title}* has been re-opened by the customer. Your application has been cancelled.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
    await db.collection('jobs').doc(String(jobId)).update({ status: 'open' });
    await updateChannelPost({ ...job, status: 'open' });
    updateUserPin(userId).catch(() => {});
    bot.sendMessage(chatId, "🔄 Job re-opened! It's back to Open status.", { reply_markup: { inline_keyboard: [[{ text: '← My jobs', callback_data: 'my_jobs' }]] } });
    return;
  }

  if (data.startsWith('cancel_job_')) {
    const jobId = data.replace('cancel_job_', '');
    const job = await getJob(jobId);
    if (!job || job.posterId !== userId) return;
    // Notify accepted worker
    const apps = await getJobApplications(jobId);
    const acceptedApp = apps.find(a => a.status === 'accepted');
    if (acceptedApp) {
      await db.collection('applications').doc(`${jobId}_${acceptedApp.workerId}`).update({ status: 'rejected' });
      bot.sendMessage(acceptedApp.workerId,
        `⚠️ *Job Cancelled*\n\nThe job *${job.title}* (KES ${job.pay}) has been cancelled by the customer.\n\nSorry for the inconvenience. Keep hustling! 💪`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
    await db.collection('jobs').doc(String(jobId)).update({ status: 'cancelled' });
    await updateChannelPost({ ...job, status: 'cancelled' });
    if (acceptedApp) updateUserPin(acceptedApp.workerId).catch(() => {});
    updateUserPin(userId).catch(() => {});
    bot.sendMessage(chatId, '❌ Job cancelled. Worker has been notified.', { reply_markup: { inline_keyboard: [[{ text: '← My jobs', callback_data: 'my_jobs' }]] } });
    return;
  }

  if (data.startsWith('delete_job_')) {
    const jobId = data.replace('delete_job_', '');
    const job = await getJob(jobId);
    if (!job || job.posterId !== userId) return;
    // Ask for confirmation
    bot.sendMessage(chatId,
      `🗑️ *Delete "${job.title}"?*\n\nThis will remove the job from the channel and database. This cannot be undone.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, delete it', callback_data: `confirm_delete_${jobId}` }],
        [{ text: '❌ Cancel', callback_data: `manage_job_${jobId}` }],
      ]}}
    );
    return;
  }

  if (data.startsWith('confirm_delete_')) {
    const jobId = data.replace('confirm_delete_', '');
    const job = await getJob(jobId);
    if (!job || job.posterId !== userId) return;

    // Notify accepted worker if job is taken
    if (job.status === 'taken') {
      const apps = await getJobApplications(jobId);
      const acceptedApp = apps.find(a => a.status === 'accepted');
      if (acceptedApp) {
        bot.sendMessage(acceptedApp.workerId,
          `⚠️ *Job Cancelled*\n\nThe job *${job.title}* (KES ${job.pay}) has been cancelled by the customer.\n\nSorry for the inconvenience. Keep hustling! 💪`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }

    // Delete channel message
    if (job.channelMsgId) {
      await bot.deleteMessage(CHANNEL_ID, job.channelMsgId).catch(() => {});
    }
    // Delete all applications
    const apps = await getJobApplications(jobId);
    for (const app of apps) {
      await db.collection('applications').doc(`${jobId}_${app.workerId}`).delete().catch(() => {});
    }
    // Delete job from Firebase
    await db.collection('jobs').doc(String(jobId)).delete();
    updateUserPin(userId).catch(() => {});
    bot.sendMessage(chatId, '✅ Job deleted successfully.', { reply_markup: { inline_keyboard: [[{ text: '← My jobs', callback_data: 'my_jobs' }]] } });
    return;
  }

  if (data.startsWith('worker_job_')) {
    const jobId = data.replace('worker_job_', '');
    const job   = await getJob(jobId);
    if (!job) { bot.sendMessage(chatId, '❌ Job not found.'); return; }
    const poster = await db.collection('users').doc(String(job.posterId)).get();
    const posterData = poster.exists ? poster.data() : { name: 'Customer', phone: 'N/A' };
    // Clear previous worker_job message for this job
    const s = getSession(userId);
    const prevWorkerKey = `workerMsg_${jobId}`;
    if (s.draft[prevWorkerKey]) {
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.draft[prevWorkerKey] }).catch(() => {});
    }
    const workerViewMsg = await bot.sendMessage(chatId,
      `━━━━━━━━━━━━━━━\n🚨 *ACTIVE JOB* 🚨\n━━━━━━━━━━━━━━━\n\n` +
      `🔨 *${job.title}*\n` +
      `💰 KES ${job.pay}\n` +
      `📍 ${job.location}\n\n` +
      `👤 Customer: *${posterData.name}*\n` +
      `📱 Phone: *${posterData.phone || 'N/A'}*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Request completion', callback_data: `request_done_${jobId}` }],
        [{ text: '🚪 Leave this job', callback_data: `request_leave_${jobId}` }],
        [{ text: '⚠️ Report to admin', callback_data: `report_job_${jobId}` }],
      ]}}
    );
    s.draft[prevWorkerKey] = workerViewMsg.message_id;
    return;
  }

  if (data.startsWith('confirm_phone_apply_')) {
    const jobId = data.replace('confirm_phone_apply_', '');
    submitApplication(chatId, userId, user, jobId);
    return;
  }

  if (data.startsWith('change_phone_apply_')) {
    const jobId = data.replace('change_phone_apply_', '');
    const s = getSession(userId);
    s.step = 'collect_phone';
    s.draft.pendingJobId = jobId;
    bot.sendMessage(chatId,
      `📱 Please type your new phone number:`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    );
    return;
  }

  if (data.startsWith('confirm_phone_accept_')) {
    const parts = data.replace('confirm_phone_accept_', '').split('_');
    const jobId = parts[0];
    const workerId = parseInt(parts[1]);
    acceptApplicant(chatId, userId, jobId, workerId);
    return;
  }

  if (data.startsWith('change_phone_accept_')) {
    const parts = data.replace('change_phone_accept_', '').split('_');
    const jobId = parts[0];
    const workerId = parseInt(parts[1]);
    const s = getSession(userId);
    s.step = 'collect_phone_for_post';
    s.draft.pendingAccept = { jobId, workerId };
    bot.sendMessage(chatId,
      `📱 Please type your new phone number:`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    );
    return;
  }

  if (data.startsWith('request_done_')) {
    const jobId = data.replace('request_done_', '');
    const job = await getJob(jobId);
    if (!job) return;
    bot.sendMessage(job.posterId,
      `✅ *Completion Request*\n\n*${user.name}* says the job *${job.title}* is done.\n\nConfirm?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, mark as done!', callback_data: `mark_done_${jobId}` }],
        [{ text: '❌ Not yet', callback_data: `decline_done_${jobId}_${userId}` }],
      ]}}
    ).catch(() => {});
    bot.sendMessage(chatId, '✅ Request sent to customer. Waiting for confirmation.', { reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `worker_job_${jobId}` }]] } });
    return;
  }

  if (data.startsWith('decline_done_')) {
    const parts = data.replace('decline_done_', '').split('_');
    const jobId = parts[0];
    const workerId = parseInt(parts[1]);
    bot.sendMessage(workerId, `ℹ️ The customer says the job isn't done yet. Keep going! 💪`).catch(() => {});
    bot.sendMessage(chatId, '✅ Worker has been notified.', { reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `manage_job_${jobId}` }]] } });
    return;
  }

  if (data.startsWith('request_leave_')) {
    const jobId = data.replace('request_leave_', '');
    const job = await getJob(jobId);
    if (!job) return;
    bot.sendMessage(job.posterId,
      `🚪 *Leave Request*\n\n*${user.name}* wants to leave the job *${job.title}*.\n\nApprove?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Approve', callback_data: `approve_leave_${jobId}_${userId}` }],
      ]}}
    ).catch(() => {});
    bot.sendMessage(chatId, '✅ Request sent to customer. Waiting for response.', { reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `worker_job_${jobId}` }]] } });
    return;
  }

  if (data.startsWith('approve_leave_')) {
    const parts = data.replace('approve_leave_', '').split('_');
    const jobId = parts[0];
    const workerId = parseInt(parts[1]);
    const job = await getJob(jobId);
    if (!job) return;
    const appSnap = await db.collection('applications')
      .where('jobId', '==', String(jobId))
      .where('workerId', '==', workerId)
      .get();
    appSnap.docs.forEach(doc => doc.ref.update({ status: 'rejected' }));
    await db.collection('jobs').doc(String(jobId)).update({ status: 'open' });
    await updateChannelPost({ ...job, status: 'open' });
    updateUserPin(userId).catch(() => {});
    updateUserPin(workerId).catch(() => {});
    bot.sendMessage(workerId, `✅ The customer approved your request. You've been removed from *${job.title}*.`, { parse_mode: 'Markdown' }).catch(() => {});
    bot.sendMessage(chatId, `✅ *${job.title}* is back to Open. Worker has been notified.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '← My jobs', callback_data: 'my_jobs' }]] } });
    return;
  }

  if (data.startsWith('report_job_')) {
    const jobId = data.replace('report_job_', '');
    const job = await getJob(jobId);
    if (!job) return;
    const poster = await db.collection('users').doc(String(job.posterId)).get();
    const posterData = poster.exists ? poster.data() : { name: 'N/A', phone: 'N/A' };
    bot.sendMessage(ADMIN_ID,
      `⚠️ *Worker Report*\n\n` +
      `🔨 Job: *${job.title}* (KES ${job.pay})\n` +
      `📍 ${job.location}\n\n` +
      `👷 Worker: *${user.name}* (ID: ${userId})\n` +
      `📱 ${user.phone || 'N/A'}\n\n` +
      `👤 Customer: *${posterData.name}* (ID: ${job.posterId})\n` +
      `📱 ${posterData.phone || 'N/A'}\n\n` +
      `🆔 Job ID: ${jobId}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🔐 Ban customer', callback_data: `ban_user_${job.posterId}` }],
        [{ text: '🗑️ Delete job', callback_data: `admin_delete_${jobId}` }],
      ]}}
    ).catch(() => {});
    bot.sendMessage(chatId, '✅ Report sent to admin. We will review the situation.', { reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `worker_job_${jobId}` }]] } });
    return;
  }

  if (data.startsWith('view_applicants_')) {
    showApplicants(chatId, userId, data.replace('view_applicants_', ''));
    return;
  }

  if (data.startsWith('view_rejected_')) {
    const jobId = data.replace('view_rejected_', '');
    const job = await getJob(jobId);
    if (!job || job.posterId !== userId) return;
    const apps = await getJobApplications(jobId);
    const rejected = apps.filter(a => a.status === 'rejected');
    if (!rejected.length) { bot.sendMessage(chatId, 'No rejected applicants.'); return; }
    let text = `❌ *Rejected applicants for "${job.title}"*\n\n`;
    rejected.forEach(a => { text += `• *${a.workerName}* — ${getRatingStars(a.rating, a.ratingCount)}\n📱 ${a.workerPhone}\n\n`; });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `manage_job_${jobId}` }]] } });
    return;
  }

  if (data.startsWith('view_accepted_')) {
    const jobId = data.replace('view_accepted_', '');
    const job = await getJob(jobId);
    if (!job || job.posterId !== userId) return;
    const apps = await getJobApplications(jobId);
    const accepted = apps.filter(a => a.status === 'accepted');
    if (!accepted.length) { bot.sendMessage(chatId, 'No accepted applicants.'); return; }
    let text = `✅ *Accepted applicants for "${job.title}"*\n\n`;
    accepted.forEach(a => { text += `• *${a.workerName}* — ${getRatingStars(a.rating, a.ratingCount)}\n📱 ${a.workerPhone}\n\n`; });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `manage_job_${jobId}` }]] } });
    return;
  }

  if (data.startsWith('accept_')) {
    const parts    = data.split('_');
    const jobId    = parts[1];
    const workerId = parseInt(parts[2]);

    // Confirm phone before accepting
    bot.sendMessage(chatId,
      `📱 Your number will be shared with the worker:\n*${user.phone || 'No phone set'}*\n\nIs this correct?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, confirm', callback_data: `confirm_phone_accept_${jobId}_${workerId}` }],
        [{ text: '✏️ Change number', callback_data: `change_phone_accept_${jobId}_${workerId}` }],
      ]}}
    );
    return;
  }

  if (data.startsWith('mark_done_')) {
    const jobId = data.replace('mark_done_', '');
    const job   = await getJob(jobId);
    if (!job || job.posterId !== userId) return;

    const deleteAt = Date.now() + 24 * 60 * 60 * 1000;
    await db.collection('jobs').doc(String(jobId)).update({ status: 'done', deleteAt });
    job.status = 'done';
    job.deleteAt = deleteAt;

    const apps = await getJobApplications(jobId);
    const acceptedApp = apps.find(a => a.status === 'accepted');

    // Update channel post with completion summary
    updateDoneChannelPost(job, acceptedApp).catch(() => {});

    if (acceptedApp) {
      const appSnap = await db.collection('applications').where('jobId', '==', String(jobId)).where('workerId', '==', acceptedApp.workerId).get();
      await Promise.all(appSnap.docs.map(doc => doc.ref.update({ status: 'done' })));

      // Create pending feedback records for both sides
      const feedbackBase = { jobId: String(jobId), jobTitle: job.title, createdAt: Date.now() };
      await db.collection('pendingFeedback').doc(`${jobId}_${userId}_poster`).set({
        ...feedbackBase, fromUserId: userId, toUserId: acceptedApp.workerId, type: 'poster'
      });
      await db.collection('pendingFeedback').doc(`${jobId}_${acceptedApp.workerId}_worker`).set({
        ...feedbackBase, fromUserId: acceptedApp.workerId, toUserId: userId, type: 'worker'
      });

      updateUserPin(userId).catch(() => {});
      updateUserPin(acceptedApp.workerId).catch(() => {});

      bot.sendMessage(chatId,
        `✅ *Job marked as Done!*\n\n⭐ *Rate & review the worker*\n_Tap a star, then type your comment below:_`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '⭐1', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_1` },
          { text: '⭐2', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_2` },
          { text: '⭐3', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_3` },
          { text: '⭐4', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_4` },
          { text: '⭐5', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_5` },
        ]] }}
      );
      bot.sendMessage(acceptedApp.workerId,
        `✅ *${job.title}* has been marked as Done!\n\n⭐ *Rate & review the customer*\n_Tap a star, then type your comment below:_`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '⭐1', callback_data: `rate_poster_${jobId}_${userId}_1` },
          { text: '⭐2', callback_data: `rate_poster_${jobId}_${userId}_2` },
          { text: '⭐3', callback_data: `rate_poster_${jobId}_${userId}_3` },
          { text: '⭐4', callback_data: `rate_poster_${jobId}_${userId}_4` },
          { text: '⭐5', callback_data: `rate_poster_${jobId}_${userId}_5` },
        ]] }}
      ).catch(() => {});
    } else {
      bot.sendMessage(chatId, '✅ Job marked as Done!', { reply_markup: mainMenu() });
    }
    return;
  }

  if (data.startsWith('rate_worker_')) {
    const parts = data.split('_');
    const stars = parseInt(parts[parts.length - 1]);
    const wId   = parseInt(parts[3]);
    const jobId = parts[2];
    const s = getSession(userId);
    s.step = 'write_review';
    s.draft.reviewStars  = stars;
    s.draft.reviewTarget = wId;
    s.draft.reviewJobId  = jobId;
    s.draft.reviewType   = 'worker';
    s.draft.lastMsgId    = msgId;
    // Edit the same message to confirm stars and prompt for comment
    bot.editMessageText(
      `✅ *Job marked as Done!*\n\n⭐ *${stars} star${stars > 1 ? 's' : ''}* selected!\n\n✍️ Now type your review below (min 10 characters):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    ).catch(() => {});
    return;
  }

  if (data.startsWith('rate_poster_')) {
    const parts = data.split('_');
    const stars = parseInt(parts[parts.length - 1]);
    const pId   = parseInt(parts[3]);
    const jobId = parts[2];
    const s = getSession(userId);
    s.step = 'write_review';
    s.draft.reviewStars  = stars;
    s.draft.reviewTarget = pId;
    s.draft.reviewJobId  = jobId;
    s.draft.reviewType   = 'poster';
    s.draft.lastMsgId    = msgId;
    // Edit the same message to confirm stars and prompt for comment
    bot.editMessageText(
      `✅ *Job marked as Done!*\n\n⭐ *${stars} star${stars > 1 ? 's' : ''}* selected!\n\n✍️ Now type your review below (min 10 characters):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    ).catch(() => {});
    return;
  }

  if (data.startsWith('urgency_')) {
    const s = getSession(userId);
    if (s.step !== 'post_urgency') return;
    const map = {
      urgency_asap:     '⏰ Deadline: ASAP (today/tomorrow)',
      urgency_week:     '⏰ Deadline: This week',
      urgency_month:    '⏰ Deadline: This month',
      urgency_flexible: '⏰ Deadline: Flexible — no rush',
    };
    s.draft.urgency = map[data] || '⏰ Flexible';
    s.draft.photos = [];
    s.step = 'post_photo';
    bot.sendMessage(chatId,
      `✅ *Availability:* ${s.draft.urgency}\n\n📷 *Send photos of the job!*\n\nYou can send up to 5 photos one by one.\nWhen done tap *DONE* or tap SKIP for no photos.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ DONE — post now',  callback_data: 'post_photos_done' }],
        [{ text: 'SKIP — no photos',   callback_data: 'post_skip_photo' }],
      ]}}
    );
    return;
  }

  if (data === 'post_skip_photo' || data === 'post_photos_done') {
    const s = getSession(userId);
    if (s.step !== 'post_photo') return;
    if (!s.draft.photos) s.draft.photos = [];
    publishJob(chatId, userId, user, s.draft);
    clearSession(userId);
    return;
  }

  if (data.startsWith('pending_fb_stars_')) {
    const stars = parseInt(data.replace('pending_fb_stars_', ''));
    const s = getSession(userId);
    if (s.step !== 'write_review_pending') return;
    s.draft.pendingFeedbackStars = stars;
    s.step = 'write_review_pending_comment';
    s.draft.lastMsgId = msgId;
    bot.editMessageText(
      `⚠️ *Feedback required!*\n\n⭐ *${stars} star${stars > 1 ? 's' : ''}* selected!\n\n✍️ Now type your review below (min 10 characters):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    ).catch(() => {});
    return;
  }

  if (data === 'cancel') {
    clearSession(userId);
    bot.sendMessage(chatId, '❌ Cancelled.', { reply_markup: mainMenu() });
    return;
  }

  if (data === 'menu_back') {
    bot.sendMessage(chatId, 'Main menu:', { reply_markup: mainMenu() });
    return;
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const s      = getSession(userId);
  if (!s.step) return;

  const user = await getUser(msg.from);
  const text = msg.text ? msg.text.trim() : '';

  if (s.step === 'collect_phone') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type your phone number.'); return; }
    await updateUser(userId, { phone: text });
    const jobId = s.draft.pendingJobId;
    clearSession(userId);
    submitApplication(chatId, userId, { ...user, phone: text }, jobId);
    return;
  }

  if (s.step === 'collect_phone_for_post') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type your phone number.'); return; }
    await updateUser(userId, { phone: text });
    const pendingAccept = s.draft.pendingAccept;
    clearSession(userId);
    if (pendingAccept) {
      acceptApplicant(chatId, userId, pendingAccept.jobId, pendingAccept.workerId);
    } else {
      startPostFlow(chatId, userId);
    }
    return;
  }

  if (s.step === 'write_review') {
    if (!text || text.length < 10) {
      bot.sendMessage(chatId, '⚠️ Review must be at least 10 characters. Please write a bit more:');
      return;
    }
    const { reviewStars, reviewTarget, reviewJobId, reviewType } = s.draft;
    // Save rating + review to target user
    const targetDoc = await db.collection('users').doc(String(reviewTarget)).get();
    if (targetDoc.exists) {
      const t = targetDoc.data();
      await updateUser(reviewTarget, { rating: (t.rating || 0) + reviewStars, ratingCount: (t.ratingCount || 0) + 1 });
      await db.collection('users').doc(String(reviewTarget)).collection('reviews').add({
        fromUserId: userId,
        fromName:   user.name,
        stars:      reviewStars,
        comment:    text,
        jobId:      reviewJobId,
        type:       reviewType,
        createdAt:  Date.now(),
      });
    }
    // Delete pending feedback (doc is named by who LEFT the review, not who was rated)
    const fbDocId = reviewType === 'worker'
      ? `${reviewJobId}_${userId}_poster`
      : `${reviewJobId}_${userId}_worker`;
    await db.collection('pendingFeedback').doc(fbDocId).delete().catch(() => {});
    if (s.draft.lastMsgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.draft.lastMsgId }).catch(() => {});
    clearSession(userId);
    bot.sendMessage(chatId, `✅ *Review submitted!*\n\n⭐ ${reviewStars} star${reviewStars > 1 ? 's' : ''} — "${text}"\n\nThanks for the feedback! 🙏`, { parse_mode: 'Markdown', reply_markup: mainMenu() });
    return;
  }

  if (s.step === 'write_review_pending_comment') {
    if (!text || text.length < 10) {
      bot.sendMessage(chatId, '⚠️ Review must be at least 10 characters. Please write a bit more:');
      return;
    }
    const { pendingFeedbackDocId, pendingFeedbackToId, pendingFeedbackStars, afterFeedback } = s.draft;
    // Save rating + review
    const targetDoc = await db.collection('users').doc(String(pendingFeedbackToId)).get();
    if (targetDoc.exists) {
      const t = targetDoc.data();
      await updateUser(pendingFeedbackToId, { rating: (t.rating || 0) + pendingFeedbackStars, ratingCount: (t.ratingCount || 0) + 1 });
      await db.collection('users').doc(String(pendingFeedbackToId)).collection('reviews').add({
        fromUserId: userId,
        fromName:   user.name,
        stars:      pendingFeedbackStars,
        comment:    text,
        createdAt:  Date.now(),
      });
    }
    // Delete pending feedback doc
    await db.collection('pendingFeedback').doc(pendingFeedbackDocId).delete().catch(() => {});
    if (s.draft.lastMsgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.draft.lastMsgId }).catch(() => {});
    clearSession(userId);
    bot.sendMessage(chatId, `✅ *Review submitted!* Thanks 🙏\n\n⭐ ${pendingFeedbackStars} star${pendingFeedbackStars > 1 ? 's' : ''} — "${text}"`, { parse_mode: 'Markdown' });
    // Continue with what they were trying to do
    if (afterFeedback.action === 'apply') {
      showJobDetail(chatId, userId, afterFeedback.jobId);
    } else if (afterFeedback.action === 'post') {
      startPostFlow(chatId, userId);
    }
    return;
  }

  if (s.step === 'post_title') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type a title.'); return; }
    const bannedTitle = containsBannedWords(text);
    if (bannedTitle) {
      bot.sendMessage(chatId, `⚠️ Your title contains inappropriate content. Please rephrase.`);
      return;
    }
    if (s.draft.lastMsgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.draft.lastMsgId }).catch(() => {});
    s.draft.title = text;
    s.step = 'post_description';
    bot.sendMessage(chatId,
      `✅ *Title:* ${text}\n\nStep 2 of 4\n\n*Describe the job:*\n_What needs to be done? Any details?_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    ).then(m => { s.draft.lastMsgId = m.message_id; });
    return;
  }

  if (s.step === 'post_description') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type a description.'); return; }
    const bannedDesc = containsBannedWords(text);
    if (bannedDesc) {
      bot.sendMessage(chatId, `⚠️ Your description contains inappropriate content. Please rephrase.`);
      return;
    }
    if (s.draft.lastMsgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.draft.lastMsgId }).catch(() => {});
    s.draft.description = text;
    s.step = 'post_pay';
    bot.sendMessage(chatId,
      `✅ Got it.\n\nStep 3 of 4\n\n*How much are you paying? (KES)*\n_Just the number, e.g. 3000_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    ).then(m => { s.draft.lastMsgId = m.message_id; });
    return;
  }

  if (s.step === 'post_pay') {
    const pay = parseInt(text.replace(/[^0-9]/g, ''));
    if (!pay || pay < 1) { bot.sendMessage(chatId, '⚠️ Please enter a valid amount, e.g. 3000'); return; }
    if (s.draft.lastMsgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.draft.lastMsgId }).catch(() => {});
    s.draft.pay = pay;
    s.step = 'post_location';
    bot.sendMessage(chatId,
      `✅ *Pay:* KES ${pay}\n\nStep 4 of 4\n\n*Where is the job? (location in Nairobi)*\n_e.g. Westlands, Karen, CBD_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    ).then(m => { s.draft.lastMsgId = m.message_id; });
    return;
  }

  if (s.step === 'post_location') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type a location.'); return; }
    if (s.draft.lastMsgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.draft.lastMsgId }).catch(() => {});
    s.draft.location = text;
    s.step = 'post_urgency';
    bot.sendMessage(chatId,
      `✅ *Location:* ${text}\n\n📅 *When do you need this done?*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '⚡ ASAP — today or tomorrow', callback_data: 'urgency_asap' }],
        [{ text: '📅 This week',                callback_data: 'urgency_week' }],
        [{ text: '🗓️ This month',               callback_data: 'urgency_month' }],
        [{ text: '⏰ Flexible — no rush',        callback_data: 'urgency_flexible' }],
      ]}}
    );
    return;
  }

  if (s.step === 'post_photo') {
    if (msg.photo) {
      if (!s.draft.photos) s.draft.photos = [];
      s.draft.photos.push(msg.photo[msg.photo.length - 1].file_id);
      const count = s.draft.photos.length;
      if (count >= 5) {
        bot.sendMessage(chatId, `✅ 5 photos added! Posting your hustle now...`);
        publishJob(chatId, userId, user, s.draft);
        clearSession(userId);
      } else {
        bot.sendMessage(chatId,
          `✅ Photo ${count} added! Send another or post now:`,
          { reply_markup: { inline_keyboard: [
            [{ text: '🚀 Post it!', callback_data: 'post_photos_done' }],
          ]}}
        );
      }
    } else if (text.toLowerCase() === 'skip') {
      s.draft.photos = [];
      publishJob(chatId, userId, user, s.draft);
      clearSession(userId);
    } else {
      bot.sendMessage(chatId, '⚠️ Please send a photo or tap DONE/SKIP.');
    }
    return;
  }
});

// ─── Flow functions ───────────────────────────────────────────────────────────

async function startPostFlow(chatId, userId) {
  const s = getSession(userId);
  s.step  = 'post_title';
  s.draft = {};
  const step1Msg = await bot.sendMessage(chatId,
    '➕ *Post a Hustle*\n\nStep 1 of 4\n\n*What\'s the job title?*\n_e.g. Wall painting, Laptop repair, Catering_',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
  );
  s.draft.lastMsgId = step1Msg.message_id;
}

async function submitApplication(chatId, userId, user, jobId) {
  const job = await getJob(jobId);
  if (!job) { bot.sendMessage(chatId, '❌ Job not found.'); return; }

  const appData = {
    jobId:       String(jobId),
    jobTitle:    job.title,
    jobPay:      job.pay,
    jobLocation: job.location,
    workerId:    userId,
    workerName:  user.name,
    workerPhone: user.phone,
    rating:      user.rating || 0,
    ratingCount: user.ratingCount || 0,
    status:      'pending',
    appliedAt:   Date.now(),
  };
  const appRef = db.collection('applications').doc(`${appData.jobId}_${appData.workerId}`);
  const existing = await appRef.get();
  if (existing.exists) {
    bot.sendMessage(chatId, '✅ You already applied to this hustle.');
    return;
  }
  await appRef.set(appData);

  // update applicant count on job
  await db.collection('jobs').doc(String(jobId)).update({
    applicantCount: admin.firestore.FieldValue.increment(1)
  });

  bot.sendMessage(job.posterId,
    `🔔 *New application on your hustle!*\n\nJob: *${job.title}*\nApplicant: ${user.name} — ${getRatingStars(user.rating, user.ratingCount)}\n\nTap to review:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '👥 Review applicants', callback_data: `view_applicants_${jobId}` }]] } }
  ).catch(() => {});

  bot.sendMessage(chatId,
    `✅ *Application sent!*\n\n*${job.title}*\nKES ${job.pay} · ${job.location}\n\nThe poster will review and get back to you. Good luck! 🤞`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 Browse more', callback_data: 'browse' }], [{ text: '📬 My applications', callback_data: 'my_applications' }]] } }
  );
}

async function publishJob(chatId, userId, user, draft) {
  const jobRef = db.collection('jobs').doc();
  const jobId  = jobRef.id;

  const job = {
    id:               jobId,
    title:            draft.title,
    description:      draft.description,
    pay:              draft.pay,
    location:         draft.location,
    photos:           draft.photos || [],
    posterId:         userId,
    posterName:       user.name,
    posterRating:     user.rating || 0,
    posterRatingCount: user.ratingCount || 0,
    status:           'open',
    urgency:          draft.urgency || '⏰ Flexible',
    applicantCount:   0,
    channelMsgId:     null,
    createdAt:        Date.now(),
  };

  await jobRef.set(job);

  bot.sendMessage(chatId,
    `🎉 *Hustle posted!*\n\n*${job.title}*\nKES ${job.pay} · ${job.location}\n\nYour hustle is now live in the channel!`,
    { parse_mode: 'Markdown' }
  );

  const caption  = formatChannelPost(job);
  const applyUrl = `https://t.me/nbohussle_bot?start=apply_${jobId}`;
  const keyboard = { inline_keyboard: [[{ text: "✋ I'll do it!", url: applyUrl }]] };

  let channelMsg;
  if (job.photos.length === 0) {
    channelMsg = await bot.sendMessage(CHANNEL_ID, caption, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(e => console.log('Channel error:', e.message));
  } else if (job.photos.length === 1) {
    channelMsg = await bot.sendPhoto(CHANNEL_ID, job.photos[0], { caption, parse_mode: 'Markdown', reply_markup: keyboard }).catch(e => console.log('Channel error:', e.message));
  } else {
    const mediaGroup = job.photos.map((photoId, i) => ({
      type: 'photo', media: photoId,
      ...(i === 0 ? { caption, parse_mode: 'Markdown' } : {})
    }));
    await bot.sendMediaGroup(CHANNEL_ID, mediaGroup).catch(e => console.log('Channel error:', e.message));
    channelMsg = await bot.sendMessage(CHANNEL_ID, '👆 See photos above', { reply_markup: keyboard }).catch(e => console.log('Channel error:', e.message));
  }

  if (channelMsg) {
    await jobRef.update({ channelMsgId: channelMsg.message_id });
  }

  updateUserPin(userId).catch(() => {});
}

async function showJobList(chatId) {
  const openJobs = await getOpenJobs();
  if (!openJobs.length) {
    bot.sendMessage(chatId,
      `📋 *Available Hustles*\n\nNo open hustles right now. Be the first to post one!`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '➕ Post a hustle', callback_data: 'post_start' }]] } }
    );
    return;
  }
  const buttons = openJobs.map(j => ([{ text: `${j.title} — KES ${j.pay} · ${j.location}`, callback_data: `view_job_${j.id}` }]));
  buttons.push([{ text: '➕ Post a hustle', callback_data: 'post_start' }]);
  bot.sendMessage(chatId,
    `📋 *Open Hustles* (${openJobs.length})\n\nTap any hustle to see details and apply:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

async function showJobDetail(chatId, userId, jobId) {
  const job = await getJob(jobId);
  if (!job) { bot.sendMessage(chatId, '❌ Hustle not found.'); return; }

  const apps           = await getJobApplications(jobId);
  const myApp        = apps.find(a => a.workerId === userId);
  const alreadyApplied = myApp && myApp.status !== 'rejected';
  const wasRejected    = myApp && myApp.status === 'rejected';
  const isOwner        = job.posterId === userId;

  let buttons = [];
  if (!isOwner && !alreadyApplied && !wasRejected && job.status === 'open') buttons.push([{ text: "✋ I'll do it!", callback_data: `apply_${jobId}` }]);
  if (wasRejected && job.status === 'open') buttons.push([{ text: '🔄 Re-apply', callback_data: `apply_${jobId}` }]);
  if (alreadyApplied) buttons.push([{ text: '✅ Already applied', callback_data: 'noop' }]);
  if (isOwner)        buttons.push([{ text: '⚙️ Manage this hustle', callback_data: `manage_job_${jobId}` }]);
  if (userId === ADMIN_ID && !isOwner) buttons.push([{ text: `🔐 Ban poster (${job.posterName})`, callback_data: `ban_user_${job.posterId}` }]);
  if (userId === ADMIN_ID && job.status === 'done') buttons.push([{ text: '🗑️ Delete (admin)', callback_data: `admin_delete_${jobId}` }]);
  buttons.push([{ text: '← Back to list', callback_data: 'browse' }]);

  const text =
    `💼 *${job.title}*\n\n` +
    `📝 ${job.description}\n\n` +
    `💰 *KES ${job.pay}*\n` +
    `📍 ${job.location}\n` +
    `📌 ${getJobStatus(job.status)}\n` +
    `👤 ${job.posterName} — ${getRatingStars(job.posterRating, job.posterRatingCount)}\n` +
    `👥 ${apps.length} applicant(s)`;

  if (job.photos && job.photos.length > 0) {
    bot.sendPhoto(chatId, job.photos[0], { caption: text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  }
}

async function showManageJob(chatId, userId, jobId) {
  const job  = await getJob(jobId);
  if (!job || job.posterId !== userId) return;
  const apps = await getJobApplications(jobId);

  const pending  = apps.filter(a => a.status === 'pending');
  const rejected = apps.filter(a => a.status === 'rejected');
  const accepted = apps.filter(a => a.status === 'accepted');

  const buttons = [];
  if (pending.length)  buttons.push([{ text: `👥 Review pending (${pending.length})`, callback_data: `view_applicants_${jobId}` }]);
  if (rejected.length) buttons.push([{ text: `❌ View rejected (${rejected.length})`, callback_data: `view_rejected_${jobId}` }]);
  if (accepted.length) buttons.push([{ text: `✅ View accepted (${accepted.length})`, callback_data: `view_accepted_${jobId}` }]);
  if (job.status === 'taken') buttons.push([{ text: '✅ Mark as Done', callback_data: `mark_done_${jobId}` }]);
  if (job.status === 'taken') buttons.push([{ text: '🔄 Re-open (worker disappeared)', callback_data: `reopen_job_${jobId}` }]);
  if (job.status === 'taken') buttons.push([{ text: '❌ Cancel job (notify worker)', callback_data: `cancel_job_${jobId}` }]);
  if (job.status !== 'done') buttons.push([{ text: '🗑️ Delete this job', callback_data: `delete_job_${jobId}` }]);
  buttons.push([{ text: '← My jobs', callback_data: 'my_jobs' }]);

  // Clear buttons from previous manage message for this job
  const s = getSession(userId);
  const prevKey = `manageMsg_${jobId}`;
  if (s.draft[prevKey]) {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.draft[prevKey] }).catch(() => {});
  }
  const sentMsg = await bot.sendMessage(chatId,
    `⚙️ *Manage: ${job.title}*\n\nStatus: ${getJobStatus(job.status)}\nApplicants: ${apps.length}\nPay: KES ${job.pay}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
  s.draft[prevKey] = sentMsg.message_id;
}

async function showApplicants(chatId, userId, jobId) {
  const job  = await getJob(jobId);
  if (!job || job.posterId !== userId) return;
  const apps = await getJobApplications(jobId);

  if (!apps.length) {
    bot.sendMessage(chatId, 'No applications yet.', { reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `manage_job_${jobId}` }]] } });
    return;
  }
  const pending  = apps.filter(a => a.status === 'pending');
  const accepted = apps.filter(a => a.status === 'accepted');
  const rejected = apps.filter(a => a.status === 'rejected');

  let text = `👥 *Applicants for "${job.title}"* (${apps.length})\n\n`;

  if (accepted.length) {
    text += `✅ *Accepted:*\n`;
    accepted.forEach(a => {
      text += `• *${a.workerName}* — ${getRatingStars(a.rating, a.ratingCount)}\n📱 ${a.workerPhone}\n\n`;
    });
  }

  if (pending.length) {
    text += `⏳ *Pending (${pending.length}):*\n`;
    pending.forEach((a, i) => {
      text += `${i+1}. *${a.workerName}* — ${getRatingStars(a.rating, a.ratingCount)}\n📱 ${a.workerPhone}\n\n`;
    });
    text += 'Tap to accept:';
  }

  if (rejected.length) {
    text += `❌ *Not selected (${rejected.length}):*\n`;
    rejected.forEach(a => {
      text += `• *${a.workerName}* — ${getRatingStars(a.rating, a.ratingCount)}\n`;
    });
  }

  const buttons = pending.map(a => ([{ text: `✅ Accept ${a.workerName}`, callback_data: `accept_${jobId}_${a.workerId}` }]));
  buttons.push([{ text: '← Back', callback_data: `manage_job_${jobId}` }]);
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

async function acceptApplicant(chatId, posterId, jobId, workerId) {
  const job  = await getJob(jobId);
  if (!job || job.posterId !== posterId) return;
  const apps = await getJobApplications(jobId);
  const app  = apps.find(a => a.workerId === workerId);
  if (!app) return;

  // update all applications
  const batch = db.batch();
  const appsSnap = await db.collection('applications').where('jobId', '==', String(jobId)).get();
  appsSnap.docs.forEach(doc => {
    batch.update(doc.ref, { status: doc.data().workerId === workerId ? 'accepted' : 'rejected' });
  });
  batch.update(db.collection('jobs').doc(String(jobId)), { status: 'taken' });
  await batch.commit();

  job.status = 'taken';
  updateChannelPost(job);

  const poster = await db.collection('users').doc(String(posterId)).get();
  const posterData = poster.exists ? poster.data() : { name: 'Customer', phone: 'N/A' };

  bot.sendMessage(chatId,
    `✅ *You accepted ${app.workerName}!*\n\n📱 Their phone: *${app.workerPhone}*\n\nContact them to arrange the work. Once done, mark the job as Done.`,
    { parse_mode: 'Markdown' }
  );

  const workerMsg = await bot.sendMessage(workerId,
    `━━━━━━━━━━━━━━━\n🚨 *YOU GOT THE HUSTLE!* 🚨\n━━━━━━━━━━━━━━━\n\n🔨 *${job.title}*\n💰 KES ${job.pay}\n📍 ${job.location}\n\n📱 Customer: *${posterData.name}*\nPhone: *${posterData.phone || 'N/A'}*\n\nThey will contact you to arrange. Good luck! 💪\n\n_Go to My Work to track this job_`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📬 My Work', callback_data: 'my_applications' }]] } }
  ).catch(() => {});

  // Pin the message in the worker's chat
  if (workerMsg) {
    bot.pinChatMessage(workerId, workerMsg.message_id).catch(() => {});
  }

  // Update dynamic pins for both users
  updateUserPin(posterId).catch(() => {});
  updateUserPin(workerId).catch(() => {});

  apps.filter(a => a.workerId !== workerId).forEach(a => {
    bot.sendMessage(a.workerId,
      `ℹ️ Unfortunately, someone else was selected for *${job.title}*.\n\nKeep hustling! 💪`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });
}

async function updateUserPin(userId) {
  try {
    const workerSnap = await db.collection('applications')
      .where('workerId', '==', userId)
      .where('status', '==', 'accepted')
      .get();
    const workerJobs = workerSnap.docs.map(d => d.data());

    const takenSnap = await db.collection('jobs')
      .where('posterId', '==', userId)
      .where('status', '==', 'taken')
      .get();
    const takenJobs = takenSnap.docs.map(d => ({ ...d.data(), docId: d.id }));

    const openSnap = await db.collection('jobs')
      .where('posterId', '==', userId)
      .where('status', '==', 'open')
      .get();
    const openJobs = openSnap.docs.map(d => ({ ...d.data(), docId: d.id }));

    const buttons = [];
    workerJobs.forEach(a => {
      buttons.push([{ text: `🚨 Working: ${a.jobTitle} — KES ${a.jobPay}`, callback_data: `worker_job_${a.jobId}` }]);
    });
    takenJobs.forEach(j => {
      buttons.push([{ text: `🔨 In progress: ${j.title} — KES ${j.pay}`, callback_data: `manage_job_${j.id}` }]);
    });
    openJobs.forEach(j => {
      buttons.push([{ text: `🟢 Searching: ${j.title} — KES ${j.pay}`, callback_data: `manage_job_${j.id}` }]);
    });

    const userDoc = await db.collection('users').doc(String(userId)).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    if (userData.pinnedMsgId) {
      await bot.unpinChatMessage(userId, { message_id: userData.pinnedMsgId }).catch(() => {});
      await bot.deleteMessage(userId, userData.pinnedMsgId).catch(() => {});
    }

    if (buttons.length === 0) {
      await bot.unpinAllChatMessages(userId).catch(() => {});
      await db.collection('users').doc(String(userId)).update({ pinnedMsgId: null });
      return;
    }

    const total = workerJobs.length + takenJobs.length + openJobs.length;
    const pinMsg = await bot.sendMessage(userId,
      `🚨 *Active hustles (${total})*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
    await bot.pinChatMessage(userId, pinMsg.message_id, { disable_notification: true }).catch(() => {});
    await db.collection('users').doc(String(userId)).update({ pinnedMsgId: pinMsg.message_id });
  } catch (e) {
    console.log('updateUserPin error:', e.message);
  }
}

async function updateChannelPost(job) {
  if (!job.channelMsgId) return;
  const text = formatChannelPost(job);
  // For multi-photo jobs, channelMsgId is a text message (the one with the button)
  // For single photo or no photo, it's the photo/text message
  if (job.photos && job.photos.length === 1) {
    bot.editMessageCaption(text, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown' }).catch(() => {});
  } else {
    bot.editMessageText(text, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown' }).catch(() => {});
  }
}

// ─── Done channel post ────────────────────────────────────────────────────────
async function updateDoneChannelPost(job, acceptedApp) {
  if (!job.channelMsgId) return;
  const workerName   = acceptedApp ? acceptedApp.workerName : 'Unknown';
  const workerRating = acceptedApp ? getRatingStars(acceptedApp.rating, acceptedApp.ratingCount) : '';
  const deleteTime   = new Date(job.deleteAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

  const text =
    `✅ *HUSTLE COMPLETED!*\n\n` +
    `🔨 *${job.title}*\n` +
    `💰 KES ${job.pay} earned by *${workerName}*\n` +
    `${workerRating}\n` +
    `📍 ${job.location}\n\n` +
    `👤 Posted by: ${job.posterName} — ${getRatingStars(job.posterRating || 0, job.posterRatingCount || 0)}\n\n` +
    `🏆 Another successful hustle on Husssle!\n\n` +
    `⏳ This post will be removed on ${deleteTime}`;

  if (job.photos && job.photos.length === 1) {
    bot.editMessageCaption(text, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown' }).catch(() => {});
  } else {
    bot.editMessageText(text, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown' }).catch(() => {});
  }
}

// ─── Cleanup expired done jobs ─────────────────────────────────────────────────
async function cleanupExpiredJobs() {
  try {
    const now  = Date.now();
    const snap = await db.collection('jobs')
      .where('status', '==', 'done')
      .where('deleteAt', '<=', now)
      .get();

    if (snap.empty) return;
    console.log(`🧹 Cleaning up ${snap.size} expired job(s)...`);

    for (const doc of snap.docs) {
      const job = doc.data();
      // Delete channel message
      if (job.channelMsgId) {
        await bot.deleteMessage(CHANNEL_ID, job.channelMsgId).catch(() => {});
      }
      // Delete all applications
      const appsSnap = await db.collection('applications').where('jobId', '==', String(job.id)).get();
      for (const appDoc of appsSnap.docs) {
        await appDoc.ref.delete().catch(() => {});
      }
      // Delete job
      await doc.ref.delete();
      console.log(`✅ Deleted expired job: ${job.title}`);
    }
  } catch (e) {
    console.log('cleanupExpiredJobs error:', e.message);
  }
}

console.log('🤖 Husssle bot is running with Firestore...');

bot.setMyCommands([
  { command: 'menu',   description: 'Main menu' },
  { command: 'work',   description: 'My active jobs & applications' },
  { command: 'jobs',   description: 'Browse open hustles' },
  { command: 'post',   description: 'Post a new hustle' },
  { command: 'banned', description: 'View banned users' },
  { command: 'admin',  description: 'Completed jobs (admin)' },
]).then(() => console.log('✅ Commands set!')).catch(console.error);

// Run cleanup on startup + every 30 minutes
cleanupExpiredJobs();
setInterval(cleanupExpiredJobs, 30 * 60 * 1000);
