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

const BANNED_WORDS = [
  // Scam/Fraud
  'scam', 'fraud', 'fake', 'cheat', 'steal', 'hack',
  // Explicit/Adult
  'sex', 'porn', 'nude', 'naked', 'escort', 'prostitut',
  'onlyfans', 'adult', 'erotic', 'strip', 'hookup', 'sensual',
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
      [{ text: '📋 Browse hustles',          callback_data: 'browse' }],
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
  // update lang if changed
  const currentLang = getLang(from);
  if (data.lang !== currentLang) {
    await ref.update({ lang: currentLang });
    data.lang = currentLang;
  }
  return data;
}

async function updateUser(userId, data) {
  await db.collection('users').doc(String(userId)).update(data);
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
  await getUser(msg.from);
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
    '👋 *Karibu Husssle!*\n\nThe hustle marketplace for Nairobi.\nFind work or get work done. Simple.\n\nWhat do you want to do?',
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
    .where('status', 'in', ['done', 'cancelled'])
    .limit(20)
    .get();
  if (snap.empty) {
    bot.sendMessage(msg.chat.id, '✅ No completed or cancelled jobs.');
    return;
  }
  const jobs = snap.docs.map(d => ({ ...d.data(), docId: d.id }));
  const buttons = jobs.map(j => ([{
    text: `${getJobStatus(j.status)} ${j.title} — KES ${j.pay}`,
    callback_data: `admin_delete_${j.id}`
  }]));
  bot.sendMessage(msg.chat.id,
    `🔐 *Admin — completed jobs* (${jobs.length})\n\nTap to delete:`,
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
    if (apps.some(a => a.workerId === userId)) {
      bot.sendMessage(chatId, '✅ You already applied to this hustle.'); return;
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
    submitApplication(chatId, userId, user, jobId);
    return;
  }

  if (data === 'post_start') {
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
      const buttons = [];
      if (apps.length)         buttons.push([{ text: `👥 Applicants (${apps.length})`, callback_data: `view_applicants_${j.id}` }]);
      if (j.status === 'taken') buttons.push([{ text: '✅ Mark as Done', callback_data: `mark_done_${j.id}` }]);
      if (j.status === 'taken') buttons.push([{ text: '🔄 Re-open', callback_data: `reopen_job_${j.id}` }]);
      if (j.status === 'taken') buttons.push([{ text: '❌ Cancel', callback_data: `cancel_job_${j.id}` }]);
      if (j.status !== 'done')  buttons.push([{ text: '🗑️ Delete', callback_data: `delete_job_${j.id}` }]);

      await bot.sendMessage(chatId,
        `${getJobStatus(j.status)} *${j.title}*\nKES ${j.pay} · ${j.location}\n${j.urgency || ''}\n👥 ${apps.length} applicant(s)`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
      );
    }
    bot.sendMessage(chatId, '─────', { reply_markup: { inline_keyboard: [[{ text: '← Menu', callback_data: 'menu_back' }]] } });
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
    bot.sendMessage(chatId, '✅ Job deleted successfully.', { reply_markup: { inline_keyboard: [[{ text: '← My jobs', callback_data: 'my_jobs' }]] } });
    return;
  }

  if (data.startsWith('worker_job_')) {
    const jobId = data.replace('worker_job_', '');
    const job   = await getJob(jobId);
    if (!job) { bot.sendMessage(chatId, '❌ Job not found.'); return; }
    const poster = await db.collection('users').doc(String(job.posterId)).get();
    const posterData = poster.exists ? poster.data() : { name: 'Customer', phone: 'N/A' };
    bot.sendMessage(chatId,
      `━━━━━━━━━━━━━━━\n🚨 *ACTIVE JOB* 🚨\n━━━━━━━━━━━━━━━\n\n` +
      `🔨 *${job.title}*\n` +
      `💰 KES ${job.pay}\n` +
      `📍 ${job.location}\n\n` +
      `👤 Customer: *${posterData.name}*\n` +
      `📱 Phone: *${posterData.phone || 'N/A'}*\n\n` +
      `_Contact them to coordinate. When done, ask them to mark the job as complete._`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '← My Work', callback_data: 'my_applications' }]] } }
    );
    return;
  }

  if (data.startsWith('view_applicants_')) {
    showApplicants(chatId, userId, data.replace('view_applicants_', ''));
    return;
  }

  if (data.startsWith('accept_')) {
    const parts    = data.split('_');
    const jobId    = parts[1];
    const workerId = parseInt(parts[2]);
    acceptApplicant(chatId, userId, jobId, workerId);
    return;
  }

  if (data.startsWith('mark_done_')) {
    const jobId = data.replace('mark_done_', '');
    const job   = await getJob(jobId);
    if (!job || job.posterId !== userId) return;

    await db.collection('jobs').doc(String(jobId)).update({ status: 'done' });
    job.status = 'done';
    updateChannelPost(job);

    const apps = await getJobApplications(jobId);
    const acceptedApp = apps.find(a => a.status === 'accepted');
    if (acceptedApp) {
      const appSnap = await db.collection('applications').where('jobId', '==', String(jobId)).where('workerId', '==', acceptedApp.workerId).get();
      appSnap.docs.forEach(doc => doc.ref.update({ status: 'done' }));
      bot.sendMessage(chatId, `✅ *Job marked as Done!*\n\nPlease rate the worker:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '⭐1', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_1` },
          { text: '⭐2', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_2` },
          { text: '⭐3', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_3` },
          { text: '⭐4', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_4` },
          { text: '⭐5', callback_data: `rate_worker_${jobId}_${acceptedApp.workerId}_5` },
        ]] }
      });
      bot.sendMessage(acceptedApp.workerId, `✅ *${job.title}* has been marked as Done!\n\nPlease rate the customer:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '⭐1', callback_data: `rate_poster_${jobId}_${userId}_1` },
          { text: '⭐2', callback_data: `rate_poster_${jobId}_${userId}_2` },
          { text: '⭐3', callback_data: `rate_poster_${jobId}_${userId}_3` },
          { text: '⭐4', callback_data: `rate_poster_${jobId}_${userId}_4` },
          { text: '⭐5', callback_data: `rate_poster_${jobId}_${userId}_5` },
        ]] }
      }).catch(() => {});
    } else {
      bot.sendMessage(chatId, '✅ Job marked as Done!', { reply_markup: mainMenu() });
    }
    return;
  }

  if (data.startsWith('rate_worker_')) {
    const parts = data.split('_');
    const stars = parseInt(parts[parts.length - 1]);
    const wId   = parseInt(parts[3]);
    const wDoc  = await db.collection('users').doc(String(wId)).get();
    if (wDoc.exists) {
      const w = wDoc.data();
      await updateUser(wId, { rating: (w.rating || 0) + stars, ratingCount: (w.ratingCount || 0) + 1 });
    }
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    bot.sendMessage(chatId, `⭐ Thanks! You gave ${stars} star${stars > 1 ? 's' : ''}.`, { reply_markup: mainMenu() });
    return;
  }

  if (data.startsWith('rate_poster_')) {
    const parts = data.split('_');
    const stars = parseInt(parts[parts.length - 1]);
    const pId   = parseInt(parts[3]);
    const pDoc  = await db.collection('users').doc(String(pId)).get();
    if (pDoc.exists) {
      const p = pDoc.data();
      await updateUser(pId, { rating: (p.rating || 0) + stars, ratingCount: (p.ratingCount || 0) + 1 });
    }
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    bot.sendMessage(chatId, `⭐ Thanks! You gave ${stars} star${stars > 1 ? 's' : ''}.`, { reply_markup: mainMenu() });
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
    clearSession(userId);
    startPostFlow(chatId, userId);
    return;
  }

  if (s.step === 'post_title') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type a title.'); return; }
    const bannedTitle = containsBannedWords(text);
    if (bannedTitle) {
      bot.sendMessage(chatId, `⚠️ Your title contains inappropriate content. Please rephrase.`);
      return;
    }
    s.draft.title = text;
    s.step = 'post_description';
    bot.sendMessage(chatId,
      `✅ *Title:* ${text}\n\nStep 2 of 4\n\n*Describe the job:*\n_What needs to be done? Any details?_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    );
    return;
  }

  if (s.step === 'post_description') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type a description.'); return; }
    const bannedDesc = containsBannedWords(text);
    if (bannedDesc) {
      bot.sendMessage(chatId, `⚠️ Your description contains inappropriate content. Please rephrase.`);
      return;
    }
    s.draft.description = text;
    s.step = 'post_pay';
    bot.sendMessage(chatId,
      `✅ Got it.\n\nStep 3 of 4\n\n*How much are you paying? (KES)*\n_Just the number, e.g. 3000_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    );
    return;
  }

  if (s.step === 'post_pay') {
    const pay = parseInt(text.replace(/[^0-9]/g, ''));
    if (!pay || pay < 1) { bot.sendMessage(chatId, '⚠️ Please enter a valid amount, e.g. 3000'); return; }
    s.draft.pay = pay;
    s.step = 'post_location';
    bot.sendMessage(chatId,
      `✅ *Pay:* KES ${pay}\n\nStep 4 of 4\n\n*Where is the job? (location in Nairobi)*\n_e.g. Westlands, Karen, CBD_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    );
    return;
  }

  if (s.step === 'post_location') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type a location.'); return; }
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
        bot.sendMessage(chatId, `✅ Photo ${count} added! Send another photo or tap DONE when ready.`);
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

function startPostFlow(chatId, userId) {
  const s = getSession(userId);
  s.step  = 'post_title';
  s.draft = {};
  bot.sendMessage(chatId,
    '➕ *Post a Hustle*\n\nStep 1 of 4\n\n*What\'s the job title?*\n_e.g. Wall painting, Laptop repair, Catering_',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
  );
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
  await db.collection('applications').add(appData);

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
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📌 Manage my jobs', callback_data: 'my_jobs' }], [{ text: '← Menu', callback_data: 'menu_back' }]] } }
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
  const alreadyApplied = apps.some(a => a.workerId === userId);
  const isOwner        = job.posterId === userId;

  let buttons = [];
  if (!isOwner && !alreadyApplied && job.status === 'open') buttons.push([{ text: "✋ I'll do it!", callback_data: `apply_${jobId}` }]);
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

  const buttons = [];
  if (apps.length)        buttons.push([{ text: `👥 View applicants (${apps.length})`, callback_data: `view_applicants_${jobId}` }]);
  if (job.status === 'taken') buttons.push([{ text: '✅ Mark as Done', callback_data: `mark_done_${jobId}` }]);
  if (job.status === 'taken') buttons.push([{ text: '🔄 Re-open (worker disappeared)', callback_data: `reopen_job_${jobId}` }]);
  if (job.status === 'taken') buttons.push([{ text: '❌ Cancel job (notify worker)', callback_data: `cancel_job_${jobId}` }]);
  if (job.status !== 'done') buttons.push([{ text: '🗑️ Delete this job', callback_data: `delete_job_${jobId}` }]);
  buttons.push([{ text: '← My jobs', callback_data: 'my_jobs' }]);

  bot.sendMessage(chatId,
    `⚙️ *Manage: ${job.title}*\n\nStatus: ${getJobStatus(job.status)}\nApplicants: ${apps.length}\nPay: KES ${job.pay}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

async function showApplicants(chatId, userId, jobId) {
  const job  = await getJob(jobId);
  if (!job || job.posterId !== userId) return;
  const apps = await getJobApplications(jobId);

  if (!apps.length) {
    bot.sendMessage(chatId, 'No applications yet.', { reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `manage_job_${jobId}` }]] } });
    return;
  }
  const pending = apps.filter(a => a.status === 'pending');
  if (!pending.length) {
    bot.sendMessage(chatId, '✅ You have already accepted an applicant.', { reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `manage_job_${jobId}` }]] } });
    return;
  }

  let text = `👥 *Applicants for "${job.title}"*\n\n`;
  pending.forEach((a, i) => {
    text += `${i+1}. *${a.workerName}* — ${getRatingStars(a.rating, a.ratingCount)}\n📱 ${a.workerPhone}\n\n`;
  });
  text += 'Tap to accept:';

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
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Mark as Done later', callback_data: `manage_job_${jobId}` }]] } }
  );

  const workerMsg = await bot.sendMessage(workerId,
    `━━━━━━━━━━━━━━━\n🚨 *YOU GOT THE HUSTLE!* 🚨\n━━━━━━━━━━━━━━━\n\n🔨 *${job.title}*\n💰 KES ${job.pay}\n📍 ${job.location}\n\n📱 Customer: *${posterData.name}*\nPhone: *${posterData.phone || 'N/A'}*\n\nThey will contact you to arrange. Good luck! 💪\n\n_Go to My Work to track this job_`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📬 My Work', callback_data: 'my_applications' }]] } }
  ).catch(() => {});

  // Pin the message in the worker's chat
  if (workerMsg) {
    bot.pinChatMessage(workerId, workerMsg.message_id).catch(() => {});
  }

  apps.filter(a => a.workerId !== workerId).forEach(a => {
    bot.sendMessage(a.workerId,
      `ℹ️ Unfortunately, someone else was selected for *${job.title}*.\n\nKeep hustling! 💪`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });
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

console.log('🤖 Husssle bot is running with Firestore...');

bot.setMyCommands([
  { command: 'menu',   description: 'Main menu' },
  { command: 'work',   description: 'My active jobs & applications' },
  { command: 'jobs',   description: 'Browse open hustles' },
  { command: 'post',   description: 'Post a new hustle' },
  { command: 'banned', description: 'View banned users' },
  { command: 'admin',  description: 'Completed jobs (admin)' },
]).then(() => console.log('✅ Commands set!')).catch(console.error);
