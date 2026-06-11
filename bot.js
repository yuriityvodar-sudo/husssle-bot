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
  if (userId === ADMIN_ID) return true; // admin is never rate-limited
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
  'blowjob', 'blow job', 'handjob', 'hand job', 'anal', 'fetish',
  'whore', 'slut', 'nigga', 'nigger',
  // Weapons/Drugs
  'drug', 'cocaine', 'weed', 'gun', 'weapon', 'kill',
  // Spam
  'free money', 'guaranteed', 'get rich', 'bitcoin', 'crypto invest',
];

function containsBannedWords(text) {
  const lower = text.toLowerCase();
  return BANNED_WORDS.find(word => lower.includes(word)) || null;
}
function escapeMarkdown(text) {
  if (!text) return '';
  // Markdown v1 only needs _ * ` [ escaped
  return String(text).replace(/[_*`[]/g, '\\$&');
}

function generateHashtags(job) {
  const tags = [];
  // Location tag (e.g. #westlands #karen #cbd)
  if (job.location) {
    const loc = job.location.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/gi, '');
    if (loc.length > 1) tags.push(`#${loc}`);
  }
  // Urgency tag
  if (job.urgency) {
    if (job.urgency.includes('ASAP')) tags.push('#urgent');
    else if (job.urgency.includes('week')) tags.push('#thisweek');
    else if (job.urgency.includes('month')) tags.push('#thismonth');
    else tags.push('#flexible');
  }
  // Price range tag (KES)
  const pay = parseInt(job.pay) || 0;
  if (pay > 0 && pay <= 500)   tags.push('#kes100_500');
  else if (pay <= 2000)        tags.push('#kes500_2000');
  else if (pay <= 5000)        tags.push('#kes2000_5000');
  else if (pay > 5000)         tags.push('#kes5000plus');
  // First word of title (e.g. #cleaning)
  if (job.title) {
    const firstWord = job.title.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/gi, '');
    if (firstWord.length > 2) tags.push(`#${firstWord}`);
  }
  return tags.join(' ');
}

const bot        = new TelegramBot(BOT_TOKEN, { polling: true });
// Force-evict any other bot instance still polling with this token (fixes 409 Conflict)
bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});

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
  if (status === 'taken') return '🟡 Someone grabbed this — work started';
  if (status === 'done')  return '✅ Done';
  return status;
}

async function formatChannelPost(job) {
  // Fetch poster's real totalSpent and recent reviews
  const posterDoc = await db.collection('users').doc(String(job.posterId)).get();
  const totalSpent = posterDoc.exists ? (posterDoc.data().totalSpent || 0) : 0;

  const reviewsSnap = await db.collection('users').doc(String(job.posterId))
    .collection('reviews').orderBy('createdAt', 'desc').limit(2).get();
  let reviewsText = '';
  if (!reviewsSnap.empty) {
    const stars = n => '⭐'.repeat(n) + '☆'.repeat(5 - n);
    reviewsText = '\n💬 *Recent reviews:*\n' + reviewsSnap.docs.map(d => {
      const r = d.data();
      return `${stars(r.stars)} _"${escapeMarkdown(r.comment)}"_ — ${escapeMarkdown(r.fromName)}`;
    }).join('\n');
  }

  const statusText = job.status === 'open' ? '🟢 Looking for someone to do this' :
                     job.status === 'taken' ? '🟡 Someone grabbed this — work started' :
                     job.status === 'done'  ? '✅ Done' :
                     job.status === 'cancelled' ? '❌ Cancelled by the customer' : '🟢 Open';

  const hashtags = generateHashtags(job);

  return (
    `${statusText}\n\n` +
    `💼 *${escapeMarkdown(job.title)}*\n\n` +
    `📝 ${escapeMarkdown(job.description)}\n\n` +
    `💰 *KES ${job.pay}*\n` +
    `📍 ${escapeMarkdown(job.location)}\n` +
    `${job.urgency || '⏰ Flexible'}\n\n` +
    `👤 Posted by: ${escapeMarkdown(job.posterName)} — ${getRatingStars(job.posterRating || 0, job.posterRatingCount || 0)}\n` +
    (totalSpent > 0 ? `💸 KES ${totalSpent.toLocaleString()} · paid to real people in Nairobi\n` : '') +
    (reviewsText ? `\n${reviewsText}` : '') +
    (hashtags ? `\n\n${hashtags}` : '')
  );
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: '🔴 Husssle Live 🔴', callback_data: 'live_now' }, { text: '➕ Post a hustle', callback_data: 'post_start' }],
      [{ text: '📬 My Applications', callback_data: 'my_applications' }, { text: '💼 Hustles I posted', callback_data: 'my_jobs' }],
    ]
  };
}

async function showState(chatId, userId, text, options = {}) {
  const userDoc = await db.collection('users').doc(String(userId)).get();
  const stateMsgId = userDoc.exists ? userDoc.data().stateMsgId : null;
  const menuMsgId = userDoc.exists ? userDoc.data().menuMsgId : null;
  if (stateMsgId) await bot.deleteMessage(chatId, stateMsgId).catch(() => {});
  if (menuMsgId) {
    await bot.deleteMessage(chatId, menuMsgId).catch(() => {});
    await db.collection('users').doc(String(userId)).update({ menuMsgId: null }).catch(() => {});
  }
  let sent;
  if (options.photo) {
    sent = await bot.sendPhoto(chatId, options.photo, { caption: text, parse_mode: 'Markdown', reply_markup: options.reply_markup });
  } else if (options.media_group) {
    await bot.sendMediaGroup(chatId, options.media_group);
    sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: options.reply_markup });
  } else {
    sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: options.reply_markup });
  }
  await db.collection('users').doc(String(userId)).update({ stateMsgId: sent.message_id }).catch(() => {});
  return sent;
}

async function showMenu(chatId, userId, text = 'What do you want to do?') {
  const userDoc = await db.collection('users').doc(String(userId)).get();
  const menuMsgId = userDoc.exists ? userDoc.data().menuMsgId : null;
  const stateMsgId = userDoc.exists ? userDoc.data().stateMsgId : null;
  // Delete old menu and state messages
  if (menuMsgId) await bot.deleteMessage(chatId, menuMsgId).catch(() => {});
  if (stateMsgId) await bot.deleteMessage(chatId, stateMsgId).catch(() => {});
  const sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: mainMenu() });
  await db.collection('users').doc(String(userId)).update({ menuMsgId: sent.message_id }).catch(() => {});
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

// Shared delete core — single source of truth for removing a job everywhere.
// Handles: channel post, applications, job doc, channelPosts record.
// Returns { ok, channelDeleted, affectedUserIds } — caller handles auth, notifications, pins, replies.
async function deleteJobCompletely(job, logTag = 'DELETE') {
  const jobId = job.id;
  let channelDeleted = true;
  if (job.channelMsgId) {
    console.log(`[${logTag}] attempting channel delete — msgId=${job.channelMsgId}`);
    try {
      await bot.deleteMessage(CHANNEL_ID, job.channelMsgId);
      console.log(`[${logTag}] channel post deleted OK`);
    } catch (e) {
      const alreadyGone = e.message && (e.message.includes('message to delete not found') || e.message.includes('MESSAGE_ID_INVALID'));
      if (alreadyGone) {
        console.log(`[${logTag}] channel post already gone — ${e.message}`);
      } else {
        console.log(`[${logTag}] channel delete FAILED — ${e.message}`);
        channelDeleted = false;
      }
    }
  } else {
    console.log(`[${logTag}] no channelMsgId — skipping channel delete`);
  }

  // Delete extra photo messages (multi-photo posts)
  if (job.extraChannelMsgIds && job.extraChannelMsgIds.length) {
    for (const mid of job.extraChannelMsgIds) {
      await bot.deleteMessage(CHANNEL_ID, mid).catch(() => {});
    }
  }

  console.log(`[${logTag}] fetching applications...`);
  const apps = await getJobApplications(jobId);
  console.log(`[${logTag}] got ${apps.length} application(s)`);
  const affectedUserIds = new Set([job.posterId]);
  for (const app of apps) {
    if (app.status === 'accepted') affectedUserIds.add(app.workerId);
  }
  // Delete applications in parallel
  await Promise.all(apps.map(app => db.collection('applications').doc(app.docId).delete().catch(() => {})));

  console.log(`[${logTag}] deleting job doc from Firestore...`);
  await db.collection('jobs').doc(String(jobId)).delete();
  console.log(`[${logTag}] job doc deleted OK ✅`);
  if (job.channelMsgId) {
    if (channelDeleted) {
      await db.collection('channelPosts').doc(String(job.channelMsgId)).delete().catch(() => {});
    } else {
      // Channel post still live — KEEP the tracking record so the 30-min safety net retries it
      await db.collection('channelPosts').doc(String(job.channelMsgId)).set({
        channelMsgId: job.channelMsgId,
        jobId: String(jobId),
        jobTitle: job.title,
        channelDeleteFailed: true,
        createdAt: Date.now(),
      }, { merge: true }).catch(() => {});
      console.log(`[${logTag}] channel post ORPHANED — safety net will retry within 30 min`);
    }
  }

  return { ok: true, channelDeleted, affectedUserIds };
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

  // Restore pin if missing
  updateUserPin(msg.from.id, true).catch(() => {});

  bot.sendMessage(msg.chat.id,
    '👋 *Karibu Husssle!*\n\nThe hustle marketplace for Nairobi.\nFind work or get work done. Simple.\n\n🤖 *This bot is your personal hustle manager:*\n• Post a job → workers apply → you pick the best one\n• Looking for work → browse & apply in seconds\n• Everything happens here — no calls, no WhatsApp groups\n• Get rated after every job to build your reputation\n\nWhat do you want to do?',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/rules/, async (msg) => {
  const rulesText =
    `📋 *Husssle Rules*\n\n` +
    `*What you can and cannot do:*\n\n` +
    `1️⃣ *Posting jobs* — You can post up to 20 jobs at a time. Close or delete an existing job before posting a new one.\n\n` +
    `2️⃣ *Applying to jobs* — You can apply to up to 20 jobs at a time. Withdraw an application before applying to more.\n\n` +
    `3️⃣ *Working on jobs* — You can only work on 1 job at a time. Complete or leave your current job before taking another.\n\n` +
    `4️⃣ *Accepting workers* — Only 1 worker can be accepted per job. Once accepted, no one else can apply.\n\n` +
    `5️⃣ *Completion requests* — You can only send 1 completion request at a time. Wait for the customer to respond before sending another.\n\n` +
    `6️⃣ *Leave requests* — You can only send 1 leave request at a time. Wait for the customer to respond before sending another.\n\n` +
    `7️⃣ *Reapplying* — You can reapply to the same job up to 3 times after being rejected. After the 3rd rejection you are permanently blocked from that job.\n\n` +
    `8️⃣ *Reporting jobs* — You can only report the same job once.\n\n` +
    `9️⃣ *Reviews* — You can only leave 1 review per job. It cannot be edited after submission.\n\n` +
    `🔟 *Taken jobs* — No limit on how many jobs can be worked on for you at the same time.\n\n` +
    `1️⃣1️⃣ *Applications per job* — No limit on how many people can apply to your job.\n\n` +
    `1️⃣2️⃣ *Job re-opens* — A job can be re-opened up to 5 times if a worker leaves or disappears. After the 5th re-open the job is automatically deleted.\n\n` +
    `1️⃣3️⃣ *Job closing* — Once the worker submits their review the job is closed immediately. The poster's review gate remains open until they submit their review.\n\n` +
    `1️⃣4️⃣ *Cancelling jobs* — Cancelling a job that already has an accepted worker counts as a strike. After 3 strikes you receive a warning. After 6 strikes admin is notified.\n\n` +
    `1️⃣5️⃣ *Declining completion* — If you decline a worker's completion request 3 or more times on the same job, admin is automatically notified to review the situation.\n\n` +
    `1️⃣6️⃣ *Declining leave* — If you decline a worker's leave request 3 times on the same job, they are automatically released and the job goes back to open.\n\n` +
    `1️⃣7️⃣ *Reports & bans* — Reports are reviewed manually by admin. There is currently no automatic ban threshold.\n\n` +
    `1️⃣8️⃣ *Daily report limit* — You can send up to 10 reports per day across all jobs. After 10 you are blocked from reporting until the next day.\n\n` +
    `1️⃣9️⃣ *Job expiry (open)* — Jobs that have been open for 30 days with no worker are automatically deleted. You will be notified and can re-post if needed.\n\n` +
    `2️⃣0️⃣ *Job expiry (taken)* — Jobs that have been in progress for 30 days are automatically closed. Both sides are notified to leave a review.`;
  await showState(msg.chat.id, msg.from.id, rulesText, {
    reply_markup: { inline_keyboard: [[{ text: '← Menu', callback_data: 'menu_back' }]] }
  });
});

bot.onText(/\/menu/, (msg) => {
  showMenu(msg.chat.id, msg.from.id);
  updateUserPin(msg.from.id).catch(() => {});
});

bot.onText(/\/work/, async (msg) => {
  const userId = msg.from.id;
  await getUser(msg.from);
  updateUserPin(userId).catch(() => {});

  // Worker side — applications
  const apps = await getUserApplications(userId);
  const active   = apps.filter(a => a.status === 'accepted');
  const pending  = apps.filter(a => a.status === 'pending');
  const rejected = apps.filter(a => a.status === 'rejected');

  // Poster side — posted jobs that are active
  const postedSnap = await db.collection('jobs')
    .where('posterId', '==', userId)
    .where('status', 'in', ['open', 'taken'])
    .get();
  const postedJobs = postedSnap.docs.map(d => d.data());

  const hasAnything = active.length || pending.length || rejected.length || postedJobs.length;

  if (!hasAnything) {
    await showState(msg.chat.id, userId, '📬 *My Active Jobs*\n\nYou have no active jobs or applications.', { reply_markup: { inline_keyboard: [[{ text: '← Menu', callback_data: 'menu_back' }]] } });
    return;
  }

  let text = '📬 *My Active Jobs*\n\n';
  const buttons = [];

  // Posted jobs section
  if (postedJobs.length) {
    text += '📌 *Jobs I posted:*\n';
    postedJobs.forEach(j => {
      const status = j.status === 'open' ? '🟢 Open' : '🟡 In progress';
      text += `${status} *${escapeMarkdown(j.title)}* · KES ${j.pay}\n`;
      buttons.push([{ text: `${j.status === 'open' ? '🟢' : '🟡'} ${j.title} — KES ${j.pay}`, callback_data: `manage_job_${j.id}` }]);
    });
    text += '\n';
  }

  // Active worker jobs
  if (active.length) {
    text += '🔨 *Jobs I\'m working on:*\n';
    active.forEach(a => {
      text += `🔨 *${a.jobTitle}* · KES ${a.jobPay}\n`;
      buttons.push([{ text: `🔨 ${a.jobTitle} — KES ${a.jobPay}`, callback_data: `worker_job_${a.jobId}` }]);
    });
    text += '\n';
  }

  // Pending applications
  if (pending.length) {
    text += `⏳ *Pending applications (${pending.length})*\n`;
    pending.forEach(a => { text += `• ${a.jobTitle} · KES ${a.jobPay}\n`; });
    text += '\n';
  }

  buttons.push([{ text: '← Menu', callback_data: 'menu_back' }]);
  await showState(msg.chat.id, userId, text, { reply_markup: { inline_keyboard: buttons } });
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
    await showState(msg.chat.id, msg.from.id, '✅ No jobs found.');
    return;
  }
  const jobs = snap.docs.map(d => ({ ...d.data(), docId: d.id }));
  const buttons = jobs.map(j => ([{
    text: `${getJobStatus(j.status)} ${j.title} — KES ${j.pay}`,
    callback_data: `admin_delete_${j.id}`
  }]));
  await showState(msg.chat.id, msg.from.id,
    `🔐 *Admin — all jobs* (${jobs.length})\n\nTap to delete:`,
    { reply_markup: { inline_keyboard: buttons } }
  );
});

bot.onText(/\/banned/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const snap = await db.collection('users').where('banned', '==', true).get();
  if (snap.empty) {
    await showState(msg.chat.id, msg.from.id, '✅ No banned users.');
    return;
  }
  const buttons = snap.docs.map(doc => {
    const u = doc.data();
    return [{ text: `🔓 Unban ${u.name} (${u.id})`, callback_data: `unban_user_${u.id}` }];
  });
  const text = `🚫 *Banned Users* (${snap.size})\n\nTap to unban:`;
  await showState(msg.chat.id, msg.from.id, text, { reply_markup: { inline_keyboard: buttons } });
});

// ─── Callback query handler ───────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  // Wrap entire handler for better error visibility
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const userId = query.from.id;
  const data   = query.data;
  console.log(`[IN] tap: ${data} — user=${userId}`);

  bot.answerCallbackQuery(query.id).catch(() => {});

  // Always clear buttons from the tapped message, except noop
  if (data !== 'noop' && data !== 'pin_live_now') {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
  }

  if (!checkRateLimit(userId, chatId)) { console.log(`[RATE] blocked — user=${userId}`); return; }

  // getUser with short timeout — a slow database must not freeze every button
  let userTimedOut = false;
  const user = await Promise.race([
    getUser(query.from),
    new Promise(resolve => setTimeout(() => { userTimedOut = true; resolve(null); }, 1500)),
  ]).catch(() => null) || { id: userId, name: query.from.first_name || 'User', banned: false };
  if (userTimedOut) console.log(`[IN] getUser TIMEOUT — using fallback for ${data}`);
  console.log(`[IN] user loaded — routing ${data}`);
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
    if (!job) {
      // Job no longer exists — clean up stale application
      await db.collection('applications').where('jobId', '==', String(jobId)).where('workerId', '==', userId).get()
        .then(snap => snap.docs.forEach(d => d.ref.update({ status: 'done' }))).catch(() => {});
      updateUserPin(userId, true).catch(() => {});
      bot.sendMessage(chatId, '⚠️ This job no longer exists. Your status has been updated.');
      return;
    }
    if (job.posterId === userId) { bot.sendMessage(chatId, "⚠️ You can't apply to your own hustle."); return; }
    if (job.status !== 'open')  { bot.sendMessage(chatId, "⚠️ This hustle is no longer open."); return; }
    // Rule 2: Max 20 pending applications at once
    const allMyApps = await getUserApplications(userId);
    const pendingApps = allMyApps.filter(a => a.status === 'pending');
    if (pendingApps.length >= 20) {
      bot.sendMessage(chatId, '⚠️ You can only apply to 20 jobs at a time. Withdraw an existing application before applying again.');
      return;
    }
    // Rule 3: Max 1 job working on at once
    const activeWork = allMyApps.filter(a => a.status === 'accepted');
    if (activeWork.length >= 1) {
      bot.sendMessage(chatId, '⚠️ You can only work on 1 job at a time. Complete or leave your current job before applying to another.');
      updateUserPin(userId).catch(() => {});
      return;
    }

    const apps = await getJobApplications(jobId);
    const myApp = apps.find(a => a.workerId === userId);
    if (myApp) {
      if (myApp.status === 'rejected') {
        // Rule 7: Max 3 reapplications after rejection
        const reapplyCount = myApp.reapplyCount || 0;
        if (reapplyCount >= 3) {
          bot.sendMessage(chatId, '⚠️ You have been rejected from this job 3 times. You cannot apply again.');
          return;
        }
        await db.collection('applications').doc(myApp.docId || `${jobId}_${userId}`).update({ status: 'pending', appliedAt: Date.now(), reapplyCount: reapplyCount + 1 });
        bot.sendMessage(chatId, `✅ *Re-application sent!*\n\n${escapeMarkdown(job.title)}\nKES ${job.pay} · ${escapeMarkdown(job.location)}\n\nGood luck this time! 🤞`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📬 My applications', callback_data: 'my_applications' }]] } });
        // Notify poster
        bot.sendMessage(job.posterId,
          `🔔 *${escapeMarkdown(user.name)}* re-applied to your hustle *${escapeMarkdown(job.title)}*\n\nTap to review:`,
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
    // Rule 1: Max 20 jobs posted at once
    const postedSnap = await db.collection('jobs').where('posterId', '==', userId).where('status', 'in', ['open', 'taken']).get();
    if (postedSnap.size >= 20) {
      bot.sendMessage(chatId, '⚠️ You can only post 20 jobs at a time. Close or delete an existing job before posting a new one.');
      return;
    }
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
    const pending = apps.filter(a => a.status === 'pending');

    if (!pending.length) {
      await showState(chatId, userId,
        `📬 *My Applications*\n\nYou have no pending applications right now.\n\nBrowse open hustles and apply to one!`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🔍 Browse hustles', callback_data: 'browse' }],
          [{ text: '← Menu', callback_data: 'menu_back' }],
        ]}}
      );
      return;
    }

    let text = `📬 *My Applications*\n\n`;
    text += `You have *${pending.length}* pending application${pending.length > 1 ? 's' : ''}:\n\n`;
    const buttons = [];

    for (const a of pending) {
      const job = await getJob(a.jobId);
      text += `🔨 *${a.jobTitle}* · KES ${a.jobPay}\n`;
      if (job) text += `📍 ${escapeMarkdown(job.location)} · Posted by ${escapeMarkdown(job.posterName)}\n`;
      text += `⏳ Waiting for response\n\n`;
      buttons.push([{ text: `❌ Withdraw: ${a.jobTitle}`, callback_data: `withdraw_application_${a.jobId}` }]);
    }

    buttons.push([{ text: '← Menu', callback_data: 'menu_back' }]);
    await showState(chatId, userId, text, { reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (data.startsWith('withdraw_application_')) {
    const jobId = data.replace('withdraw_application_', '');
    const job = await getJob(jobId);
    const appSnap = await db.collection('applications')
      .where('jobId', '==', String(jobId))
      .where('workerId', '==', userId)
      .get();
    if (!appSnap.empty) {
      await appSnap.docs[0].ref.delete();
      // Decrement applicant count
      if (job) await db.collection('jobs').doc(String(jobId)).update({ applicantCount: admin.firestore.FieldValue.increment(-1) }).catch(() => {});
    }
    showMenu(chatId, userId, `✅ Application withdrawn from *${job ? job.title : 'the job'}*.`);
    return;
  }

  if (data === 'my_jobs') {
    const allJobs = await getUserJobs(userId);
    const myJobs = allJobs.filter(j => j.status === 'open' || j.status === 'taken');

    if (!myJobs.length) {
      await showState(chatId, userId,
        `📌 *My Posted Jobs*\n\nNo active posted jobs.`,
        { reply_markup: { inline_keyboard: [[{ text: '➕ Post a hustle', callback_data: 'post_start' }, { text: '← Menu', callback_data: 'menu_back' }]] } }
      );
      return;
    }

    let text = '📌 *My Posted Jobs*\n\n';
    const buttons = [];

    for (const j of myJobs) {
      const apps = await getJobApplications(j.id);
      const pending  = apps.filter(a => a.status === 'pending').length;
      const accepted = apps.filter(a => a.status === 'accepted').length;
      const statusIcon = j.status === 'open' ? '🟢' : '🟡';
      text += `${statusIcon} *${escapeMarkdown(j.title)}* · KES ${j.pay}\n`;
      if (pending) text += `   ⏳ ${pending} waiting\n`;
      if (accepted) text += `   ✅ ${accepted} accepted\n`;
      text += '\n';
      buttons.push([{ text: `${statusIcon} Manage: ${j.title}`, callback_data: `manage_job_${j.id}` }]);
    }

    buttons.push([{ text: '← Menu', callback_data: 'menu_back' }]);
    await showState(chatId, userId, text, { reply_markup: { inline_keyboard: buttons } });
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
      `🗑️ *Delete "${escapeMarkdown(job.title)}"?*\n\nThis will remove the job from the channel and database.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, delete', callback_data: `confirm_admin_delete_${jobId}` }],
        [{ text: '❌ Cancel', callback_data: 'browse' }],
      ]}}
    );
    return;
  }

  if (data.startsWith('confirm_admin_delete_')) {
    if (userId !== ADMIN_ID) { console.log(`[ADMIN-DEL] ABORT — not admin (userId=${userId})`); return; }
    const jobId = data.replace('confirm_admin_delete_', '');
    console.log(`[ADMIN-DEL] confirm tapped — jobId=${jobId}`);

    // Instant feedback BEFORE any network calls
    const progress = await bot.sendMessage(chatId, '🗑 Deleting...').catch(() => null);

    const job = await getJob(jobId);
    console.log(`[ADMIN-DEL] getJob returned — found=${!!job}`);
    if (!job) {
      if (progress) bot.editMessageText('❌ Job not found.', { chat_id: chatId, message_id: progress.message_id }).catch(() => {});
      return;
    }
    console.log(`[ADMIN-DEL] guard passed — status=${job.status}, channelMsgId=${job.channelMsgId}`);

    try {
      const result = await deleteJobCompletely(job, 'ADMIN-DEL');
      if (!result.channelDeleted) {
        bot.sendMessage(chatId, `⚠️ Could not delete channel post (msgId: ${job.channelMsgId}). Please delete it manually from @husssleke.`).catch(() => {});
      }
      // Clear pins in the background — no need to make the admin wait
      for (const uid of result.affectedUserIds) {
        bot.unpinAllChatMessages(uid).catch(() => {});
        db.collection('users').doc(String(uid)).update({ pinnedMsgId: null }).catch(() => {});
        updateUserPin(uid).catch(() => {});
      }
      if (progress) {
        bot.editMessageText(`✅ Job *"${escapeMarkdown(job.title)}"* deleted.`, { chat_id: chatId, message_id: progress.message_id, parse_mode: 'Markdown' }).catch(() => {});
      }
    } catch (e) {
      console.log(`[ADMIN-DEL] EXCEPTION — ${e.stack || e.message}`);
      if (progress) bot.editMessageText('❌ Something went wrong deleting that job. Please try again.', { chat_id: chatId, message_id: progress.message_id }).catch(() => {});
    }
    return;
  }

  if (data.startsWith('unban_user_')) {
    if (userId !== ADMIN_ID) return;
    const targetId = parseInt(data.replace('unban_user_', ''));
    await db.collection('users').doc(String(targetId)).update({ banned: false });
    const targetDoc = await db.collection('users').doc(String(targetId)).get();
    const targetName = targetDoc.exists ? targetDoc.data().name : 'Unknown';
    bot.sendMessage(targetId, '✅ You have been unbanned from Husssle. Welcome back!').catch(() => {});
    bot.sendMessage(chatId, `✅ *${escapeMarkdown(targetName)}* has been unbanned.`, { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('ban_user_')) {
    if (userId !== ADMIN_ID) return;
    const targetId = parseInt(data.replace('ban_user_', ''));
    const targetDoc = await db.collection('users').doc(String(targetId)).get();
    const targetName = targetDoc.exists ? targetDoc.data().name : 'Unknown';
    bot.sendMessage(chatId,
      `🚫 *Ban ${escapeMarkdown(targetName)}?*\n\nThis will prevent them from using the bot.`,
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
    bot.sendMessage(chatId, `✅ *${escapeMarkdown(targetName)}* has been banned.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '← Menu', callback_data: 'menu_back' }]] } });
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
        `ℹ️ *Job Update*\n\nThe job *${escapeMarkdown(job.title)}* has been re-opened by the customer. Your application has been cancelled.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
    const reopenCount = (job.reopenCount || 0) + 1;
    if (reopenCount > 5) {
      // Auto-delete after 5th re-open
      await db.collection('jobs').doc(String(jobId)).delete();
      bot.sendMessage(chatId, `❌ *${escapeMarkdown(job.title)}* has been re-opened too many times and has been automatically deleted. Please post a new job if you still need help.`, { parse_mode: 'Markdown' });
      updateUserPin(userId, true).catch(() => {});
      return;
    }
    await db.collection('jobs').doc(String(jobId)).update({ status: 'open', reopenCount });
    await updateChannelPost({ ...job, status: 'open' });
    updateUserPin(userId).catch(() => {});
    bot.sendMessage(chatId, `🔄 Job re-opened! It's back to Open status. _(Re-open ${reopenCount}/5)_`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '← My jobs', callback_data: 'my_jobs' }]] } });
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
        `⚠️ *Job Cancelled*\n\nThe job *${escapeMarkdown(job.title)}* (KES ${job.pay}) has been cancelled by the customer.\n\nSorry for the inconvenience. Keep hustling! 💪`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      // Track cancellations with accepted workers
      const userRef = db.collection('users').doc(String(userId));
      const cancelCount = (user.cancelCount || 0) + 1;
      await userRef.update({ cancelCount });
      if (cancelCount === 3) {
        bot.sendMessage(userId,
          `⚠️ *Warning*\n\nYou have cancelled 3 jobs that had accepted workers. This is harmful to workers who invested their time.\n\nPlease be more careful when accepting workers. Further cancellations will be reported to admin.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      } else if (cancelCount >= 6 && cancelCount % 3 === 0) {
        bot.sendMessage(ADMIN_ID,
          `🚨 *Poster flagged*\n\nUser *${escapeMarkdown(user.name)}* (ID: ${userId}) has cancelled ${cancelCount} jobs with accepted workers.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }
    const cancelDeleteAt = Date.now() + 24 * 60 * 60 * 1000;
    await db.collection('jobs').doc(String(jobId)).update({ status: 'cancelled', deleteAt: cancelDeleteAt });
    // Show "cancelled" on the channel post (cleanup deletes it after 24h)
    await updateChannelPost({ ...job, status: 'cancelled' });
    if (acceptedApp) updateUserPin(acceptedApp.workerId).catch(() => {});
    updateUserPin(userId).catch(() => {});
    bot.sendMessage(chatId, '❌ Job cancelled. Worker has been notified.', { reply_markup: { inline_keyboard: [[{ text: '← My jobs', callback_data: 'my_jobs' }]] } });
    return;
  }

  if (data.startsWith('delete_job_')) {
    const jobId = data.replace('delete_job_', '');
    console.log(`[DELETE] delete_job_ tapped — jobId=${jobId}, userId=${userId}`);
    const job = await getJob(jobId);
    if (!job) { console.log(`[DELETE] delete_job_ ABORT — job not found`); return; }
    if (job.posterId !== userId) {
      console.log(`[DELETE] delete_job_ ABORT — posterId(${job.posterId}, ${typeof job.posterId}) !== userId(${userId}, ${typeof userId})`);
      return;
    }
    // Ask for confirmation
    bot.sendMessage(chatId,
      `🗑️ *Delete "${escapeMarkdown(job.title)}"?*\n\nThis will remove the job from the channel and database. This cannot be undone.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, delete it', callback_data: `confirm_delete_${jobId}` }],
        [{ text: '❌ Cancel', callback_data: `manage_job_${jobId}` }],
      ]}}
    );
    return;
  }

  if (data.startsWith('confirm_delete_')) {
    const jobId = data.replace('confirm_delete_', '');
    console.log(`[DELETE] confirm_delete_ tapped — jobId=${jobId}, userId=${userId}`);

    // Instant feedback BEFORE any network calls
    const progress = await bot.sendMessage(chatId, '🗑 Deleting your job...').catch(() => null);

    const job = await getJob(jobId);
    console.log(`[DELETE] getJob returned — found=${!!job}`);
    if (!job) {
      if (progress) bot.editMessageText('⚠️ Job not found.', { chat_id: chatId, message_id: progress.message_id }).catch(() => {});
      return;
    }
    if (job.posterId !== userId) {
      console.log(`[DELETE] confirm ABORT — posterId(${job.posterId}, ${typeof job.posterId}) !== userId(${userId}, ${typeof userId})`);
      if (progress) bot.editMessageText('⚠️ Not your job.', { chat_id: chatId, message_id: progress.message_id }).catch(() => {});
      return;
    }
    console.log(`[DELETE] guard passed — status=${job.status}, channelMsgId=${job.channelMsgId}`);

    try {
      // Notify accepted worker if job is taken
      if (job.status === 'taken') {
        const acceptedApps = await getJobApplications(jobId);
        const acceptedApp = acceptedApps.find(a => a.status === 'accepted');
        if (acceptedApp) {
          bot.sendMessage(acceptedApp.workerId,
            `⚠️ *Job Cancelled*\n\nThe job *${escapeMarkdown(job.title)}* (KES ${job.pay}) has been cancelled by the customer.\n\nSorry for the inconvenience. Keep hustling! 💪`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      }

      const result = await deleteJobCompletely(job, 'DELETE');
      const channelWarning = result.channelDeleted ? '' :
        '\n\n⚠️ Removed from the database, but I could not remove it from the channel — please delete it manually, and check that the bot is still an admin of the channel with delete permission.';

      updateUserPin(userId).catch(() => {});
      if (progress) {
        bot.editMessageText('✅ Job deleted successfully.' + channelWarning, { chat_id: chatId, message_id: progress.message_id, parse_mode: 'Markdown' }).catch(() => {});
      } else {
        bot.sendMessage(chatId, '✅ Job deleted successfully.' + channelWarning, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.log(`[DELETE] EXCEPTION — ${e.stack || e.message}`);
      if (progress) bot.editMessageText('❌ Something went wrong deleting that job. Please try again.', { chat_id: chatId, message_id: progress.message_id }).catch(() => {});
      else bot.sendMessage(chatId, '❌ Something went wrong deleting that job. Please try again.');
    }
    return;
  }

  if (data.startsWith('worker_job_')) {
    const jobId = data.replace('worker_job_', '');
    const job   = await getJob(jobId);
    if (!job) {
      // Job no longer exists — clean up stale application
      await db.collection('applications').where('jobId', '==', String(jobId)).where('workerId', '==', userId).get()
        .then(snap => snap.docs.forEach(d => d.ref.update({ status: 'done' }))).catch(() => {});
      updateUserPin(userId, true).catch(() => {});
      bot.sendMessage(chatId, '⚠️ This job no longer exists. Your status has been updated.');
      return;
    }
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
      `🔨 *${escapeMarkdown(job.title)}*\n` +
      `💰 KES ${job.pay}\n` +
      `📍 ${escapeMarkdown(job.location)}\n\n` +
      `👤 Customer: *${posterData.name}*\n` +
      `📱 Phone: *${posterData.phone || 'N/A'}*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Request completion', callback_data: `request_done_${jobId}` }],
        [{ text: '🚪 Leave this job', callback_data: `request_leave_${jobId}` }],
        [{ text: '⚠️ Report to admin', callback_data: `report_job_${jobId}` }],
        [{ text: '← Back', callback_data: 'my_applications' }],
      ]}}
    );
    s.draft[prevWorkerKey] = workerViewMsg.message_id;
    await db.collection('users').doc(String(userId)).update({ stateMsgId: workerViewMsg.message_id }).catch(() => {});
    return;
  }

  if (data.startsWith('confirm_phone_apply_')) {
    const jobId = data.replace('confirm_phone_apply_', '');
    // Show consent before applying
    bot.sendMessage(chatId,
      `📋 *Before you apply*\n\nBy applying for this hustle, you agree that:\n\n• The customer may message you on Telegram to discuss details\n• Your phone number will be visible to the customer if you're accepted\n\nContinue?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ I agree, apply', callback_data: `consent_apply_${jobId}` }],
        [{ text: '❌ Cancel', callback_data: 'cancel' }],
      ]}}
    );
    return;
  }

  if (data.startsWith('consent_apply_')) {
    const jobId = data.replace('consent_apply_', '');
    const job = await getJob(jobId);
    if (!job) { bot.sendMessage(chatId, '⚠️ Job not found.'); return; }
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
    await acceptApplicant(chatId, userId, jobId, workerId);
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
    // Check if completion request already exists
    const existingReq = await db.collection('completionRequests').doc(String(jobId)).get();
    if (existingReq.exists) {
      bot.sendMessage(chatId, '⏳ You already sent a completion request. Waiting for the customer to confirm.');
      return;
    }
    // Save completion request to Firestore
    await db.collection('completionRequests').doc(String(jobId)).set({
      jobId: String(jobId),
      jobTitle: job.title,
      workerId: userId,
      workerName: user.name,
      posterId: job.posterId,
      requestedAt: Date.now(),
    });
    await showState(job.posterId, job.posterId,
      `✅ *Completion Request*\n\n*${escapeMarkdown(user.name)}* says the job *${escapeMarkdown(job.title)}* is done.\n\nConfirm?`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, mark as done!', callback_data: `mark_done_${jobId}` }],
        [{ text: '❌ Not yet', callback_data: `decline_done_${jobId}_${userId}` }],
      ]}}
    ).catch(() => {});
    updateUserPin(job.posterId).catch(() => {});
    showMenu(chatId, userId, '✅ Request sent to customer. Waiting for confirmation.');
    return;
  }

  if (data.startsWith('decline_done_')) {
    const parts = data.replace('decline_done_', '').split('_');
    const jobId = parts[0];
    const workerId = parseInt(parts[1]);
    const job = await getJob(jobId);
    if (!job) return;
    // Ask poster for a reason
    const s = getSession(userId);
    s.step = 'decline_reason';
    s.draft.declineJobId = jobId;
    s.draft.declineWorkerId = workerId;
    s.draft.declineJobTitle = job.title;
    await showState(chatId, userId,
      `❌ *Not done yet?*\n\nTell the worker why. Type your reason below:`,
      {}
    );
    return;
  }

  if (data.startsWith('request_leave_')) {
    const jobId = data.replace('request_leave_', '');
    const job = await getJob(jobId);
    if (!job) return;
    // Check if leave request already exists
    const existingLeave = await db.collection('leaveRequests').doc(String(jobId)).get();
    if (existingLeave.exists) {
      bot.sendMessage(chatId, '⏳ You already sent a leave request. Waiting for the customer to respond.');
      return;
    }
    // Ask worker for reason
    const s = getSession(userId);
    s.step = 'leave_reason';
    s.draft.leaveJobId = jobId;
    s.draft.leaveJobTitle = job.title;
    s.draft.leavePosterId = job.posterId;
    await showState(chatId, userId,
      `🚪 *Leave this job?*\n\nTell the customer why you want to leave. Type your reason:`,
      {}
    );
    return;
  }

  if (data.startsWith('approve_leave_')) {
    const parts = data.replace('approve_leave_', '').split('_');
    const jobId = parts[0];
    const workerId = parseInt(parts[1]);
    const job = await getJob(jobId);
    if (!job) return;
    // Clear leave request
    await db.collection('leaveRequests').doc(String(jobId)).delete().catch(() => {});
    const appSnap = await db.collection('applications')
      .where('jobId', '==', String(jobId))
      .where('workerId', '==', workerId)
      .get();
    appSnap.docs.forEach(doc => doc.ref.update({ status: 'rejected' }));
    const reopenCount2 = (job.reopenCount || 0) + 1;
    if (reopenCount2 > 5) {
      await db.collection('jobs').doc(String(jobId)).delete();
      await showState(workerId, workerId, `✅ You have been released from *${escapeMarkdown(job.title)}*. The job has been automatically deleted as it has been re-opened too many times.`, {}).catch(() => {});
      showMenu(chatId, userId, `❌ *${escapeMarkdown(job.title)}* has been automatically deleted — re-opened too many times.`);
      updateUserPin(userId, true).catch(() => {});
      updateUserPin(workerId, true).catch(() => {});
      return;
    }
    await db.collection('jobs').doc(String(jobId)).update({ status: 'open', reopenCount: reopenCount2 });
    await updateChannelPost({ ...job, status: 'open' });
    updateUserPin(userId, true).catch(() => {});
    updateUserPin(workerId, true).catch(() => {});
    await showState(workerId, workerId,
      `✅ *Leave approved*\n\nThe customer approved your request. You've been removed from *${escapeMarkdown(job.title)}*.`,
      {}
    ).catch(() => {});
    showMenu(chatId, userId, `✅ *${escapeMarkdown(job.title)}* is back to Open. Worker has been notified.`);
    return;
  }

  if (data.startsWith('decline_leave_')) {
    const parts = data.replace('decline_leave_', '').split('_');
    const jobId = parts[0];
    const workerId = parseInt(parts[1]);
    const job = await getJob(jobId);
    if (!job) return;
    // Clear leave request
    await db.collection('leaveRequests').doc(String(jobId)).delete().catch(() => {});
    // Track leave decline count
    const leaveDeclineCount = (job.leaveDeclineCount || 0) + 1;
    await db.collection('jobs').doc(String(jobId)).update({ leaveDeclineCount });

    if (leaveDeclineCount >= 3) {
      // Auto-release worker after 3 declines
      const appSnap = await db.collection('applications').where('jobId', '==', String(jobId)).where('workerId', '==', workerId).get();
      appSnap.docs.forEach(doc => doc.ref.update({ status: 'rejected' }));
      const reopenCount = (job.reopenCount || 0) + 1;
      await db.collection('jobs').doc(String(jobId)).update({ status: 'open', reopenCount, leaveDeclineCount: 0 });
      await updateChannelPost({ ...job, status: 'open' });
      await showState(workerId, workerId,
        `✅ *You've been released*\n\nThe customer declined your leave request 3 times. You have been automatically released from *${escapeMarkdown(job.title)}*. The job is back to open.`,
        {}
      ).catch(() => {});
      updateUserPin(workerId, true).catch(() => {});
      updateUserPin(userId, true).catch(() => {});
      showMenu(chatId, userId, `⚠️ You declined the worker's leave request 3 times. They have been automatically released from *${escapeMarkdown(job.title)}*.`);
    } else {
      await showState(workerId, workerId,
        `❌ *Leave declined*\n\nThe customer wants you to stay on the job. Keep going! 💪\n\n_Note: After 3 declines you will be automatically released._`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🔧 Manage this job', callback_data: `worker_job_${jobId}` }],
        ]}}
      ).catch(() => {});
      showMenu(chatId, userId, `✅ Worker has been notified. _(Decline ${leaveDeclineCount}/3)_`);
    }
    return;
  }

  if (data.startsWith('report_job_')) {
    const jobId = data.replace('report_job_', '');
    const job = await getJob(jobId);
    if (!job) return;
    // Rule 8: Max 1 report per job per user
    const reportSnap = await db.collection('reports').doc(`${jobId}_${userId}`).get();
    if (reportSnap.exists) {
      bot.sendMessage(chatId, '⚠️ You have already reported this job.');
      return;
    }
    // Rule 7: Max 10 reports per day
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const dailyReportsSnap = await db.collection('reports')
      .where('userId', '==', userId)
      .where('reportedAt', '>=', todayStart.getTime())
      .get();
    if (dailyReportsSnap.size >= 10) {
      bot.sendMessage(chatId, '⚠️ You have reached the daily report limit of 10. Try again tomorrow.');
      return;
    }
    await db.collection('reports').doc(`${jobId}_${userId}`).set({ jobId, userId, reportedAt: Date.now() });
    const poster = await db.collection('users').doc(String(job.posterId)).get();
    const posterData = poster.exists ? poster.data() : { name: 'N/A', phone: 'N/A' };
    bot.sendMessage(ADMIN_ID,
      `⚠️ *Worker Report*\n\n` +
      `🔨 Job: *${escapeMarkdown(job.title)}* (KES ${job.pay})\n` +
      `📍 ${escapeMarkdown(job.location)}\n\n` +
      `👷 Worker: *${escapeMarkdown(user.name)}* (ID: ${userId})\n` +
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
    if (!rejected.length) { await showState(chatId, userId, 'No rejected applicants.'); return; }
    let text = `❌ *Rejected applicants for "${escapeMarkdown(job.title)}"*\n\n`;
    rejected.forEach(a => { text += `• *${escapeMarkdown(a.workerName)}* — ${getRatingStars(a.rating, a.ratingCount)}\n📱 ${a.workerPhone}\n\n`; });
    await showState(chatId, userId, text, { reply_markup: { inline_keyboard: [] } });
    return;
  }

  if (data.startsWith('view_accepted_')) {
    const jobId = data.replace('view_accepted_', '');
    const job = await getJob(jobId);
    if (!job || job.posterId !== userId) return;
    const apps = await getJobApplications(jobId);
    const accepted = apps.filter(a => a.status === 'accepted');
    if (!accepted.length) { await showState(chatId, userId, 'No accepted applicants.'); return; }
    let text = `✅ *Accepted applicants for "${escapeMarkdown(job.title)}"*\n\n`;
    accepted.forEach(a => { text += `• *${escapeMarkdown(a.workerName)}* — ${getRatingStars(a.rating, a.ratingCount)}\n📱 ${a.workerPhone}\n\n`; });
    await showState(chatId, userId, text, { reply_markup: { inline_keyboard: [] } });
    return;
  }

  if (data.startsWith('reject_')) {
    const parts  = data.split('_');
    const jobId  = parts[1];
    const wId    = parseInt(parts[2]);
    const job    = await getJob(jobId);
    if (!job || job.posterId !== userId) return;
    await db.collection('applications').doc(`${jobId}_${wId}`).update({ status: 'rejected' });
    const workerDoc = await db.collection('users').doc(String(wId)).get();
    const workerName = workerDoc.exists ? workerDoc.data().name : 'Worker';
    bot.sendMessage(wId,
      `ℹ️ Unfortunately, someone else was selected for *${escapeMarkdown(job.title)}*.

Keep hustling! 💪`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    bot.sendMessage(chatId, `❌ *${workerName}* rejected.`, { parse_mode: 'Markdown' });
    showApplicants(chatId, userId, jobId);
    return;
  }

  if (data.startsWith('accept_')) {
    const parts    = data.split('_');
    const jobId    = parts[1];
    const workerId = parseInt(parts[2]);

    // Confirm phone before accepting
    const phoneConfirmMsg = await showState(chatId, userId,
      `📱 Your number will be shared with the worker:\n*${user.phone || 'No phone set'}*\n\nIs this correct?`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, confirm', callback_data: `confirm_phone_accept_${jobId}_${workerId}` }],
        [{ text: '✏️ Change number', callback_data: `change_phone_accept_${jobId}_${workerId}` }],
      ]}}
    );
    return;
  }

  if (data.startsWith('mark_done_')) {
    const jobId = data.replace('mark_done_', '');
    // Clear completion request
    await db.collection('completionRequests').doc(String(jobId)).delete().catch(() => {});
    const job   = await getJob(jobId);
    if (!job || String(job.posterId) !== String(userId)) return;

    const apps = await getJobApplications(jobId);
    const acceptedApp = apps.find(a => String(a.status) === 'accepted');

    if (!acceptedApp) {
      // No worker, just close it
      const deleteAt = Date.now() + 24 * 60 * 60 * 1000;
      await db.collection('jobs').doc(String(jobId)).update({ status: 'done', deleteAt });
      showMenu(chatId, userId, '✅ Job marked as Done!');
      return;
    }

    // Send confirmation request to worker
    bot.sendMessage(acceptedApp.workerId,
      `✅ *Job Completion Request*\n\n*${escapeMarkdown(job.posterName)}* says the job *${escapeMarkdown(job.title)}* is done.\n\nDo you confirm?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: "✅ Yes, it's done!", callback_data: `worker_confirm_done_${jobId}_${userId}` }],
        [{ text: '❌ Not yet', callback_data: `worker_decline_done_${jobId}_${userId}` }],
      ]}}
    ).catch(() => {});

    showMenu(chatId, userId,
      `✅ *Completion request sent!*\n\nWaiting for *${escapeMarkdown(acceptedApp.workerName)}* to confirm\. You'll both be asked to leave a review once confirmed\.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (data.startsWith('worker_confirm_done_')) {
    const parts = data.replace('worker_confirm_done_', '').split('_');
    const jobId = parts[0];
    const posterId = parseInt(parts[1]);
    const job = await getJob(jobId);
    if (!job) return;

    const apps = await getJobApplications(jobId);
    const acceptedApp = apps.find(a => String(a.workerId) === String(userId));
    if (!acceptedApp) return;

    // Create pendingFeedback docs for both sides to enforce gate
    const feedbackBase = { jobId: String(jobId), jobTitle: job.title, createdAt: Date.now() };
    await db.collection('pendingFeedback').doc(`${jobId}_${posterId}_poster`).set({
      ...feedbackBase, fromUserId: posterId, toUserId: userId, type: 'poster'
    });
    await db.collection('pendingFeedback').doc(`${jobId}_${userId}_worker`).set({
      ...feedbackBase, fromUserId: userId, toUserId: posterId, type: 'worker'
    });

    // Now ask both sides to leave review
    const posterSession = getSession(posterId);
    posterSession.step = 'completion_review_comment';
    posterSession.draft.completionJobId      = jobId;
    posterSession.draft.completionWorkerId   = userId;
    posterSession.draft.completionWorkerName = user.name;
    posterSession.draft.completionRole       = 'poster';

    showState(posterId, posterId,
      `🎉 *${escapeMarkdown(user.name)} confirmed the job is done!*\n\n👋 How did *"${escapeMarkdown(job.title)}"* go?\n\nTell us in a few words — what was done, how it went. This closes the job and builds your reputation on Husssle 🌟`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    ).then(m => { if (m) posterSession.draft.lastMsgId = m.message_id; }).catch(() => {});

    const workerSession = getSession(userId);
    workerSession.step = 'completion_review_comment';
    workerSession.draft.completionJobId      = jobId;
    workerSession.draft.completionPosterId   = posterId;
    workerSession.draft.completionPosterName = job.posterName;
    workerSession.draft.completionRole       = 'worker';

    showState(chatId, userId,
      `👋 How did *"${escapeMarkdown(job.title)}"* go?\n\nTell us in a few words — what was done, how it went. This closes the job and builds your reputation on Husssle 🌟`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    ).then(m => { if (m) workerSession.draft.lastMsgId = m.message_id; }).catch(() => {});
    return;
  }

  if (data.startsWith('worker_decline_done_')) {
    const parts = data.replace('worker_decline_done_', '').split('_');
    const jobId = parts[0];
    const posterId = parseInt(parts[1]);
    const job = await getJob(jobId);
    bot.sendMessage(posterId,
      `ℹ️ *${escapeMarkdown(user.name)}* says the job isn't done yet. Keep in touch! 💪`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    bot.sendMessage(chatId, `✅ Customer has been notified.`);
    return;
  }

  if (data.startsWith('rate_worker_')) {
    const parts = data.split('_');
    const stars = parseInt(parts[parts.length - 1]);
    const wId   = parseInt(parts[3]);
    const jobId = parts[2];
    const s = getSession(userId);
    s.draft.completionStars = stars;
    s.draft.lastMsgId = msgId;
    bot.editMessageText(
      `⭐ *${stars} star${stars > 1 ? 's' : ''}* selected!\n\nThanks! Your review is being submitted...`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    ).catch(() => {});
    // Submit the review
    await submitCompletionReview(chatId, userId, jobId, wId, stars, s.draft.completionComment, 'poster');
    clearSession(userId);
    return;
  }

  if (data.startsWith('rate_poster_')) {
    const parts = data.split('_');
    const stars = parseInt(parts[parts.length - 1]);
    const pId   = parseInt(parts[3]);
    const jobId = parts[2];
    const s = getSession(userId);
    s.draft.completionStars = stars;
    s.draft.lastMsgId = msgId;
    bot.editMessageText(
      `⭐ *${stars} star${stars > 1 ? 's' : ''}* selected!\n\nThanks! Your review is being submitted...`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    ).catch(() => {});
    await submitCompletionReview(chatId, userId, jobId, pId, stars, s.draft.completionComment, 'worker');
    clearSession(userId);
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
      `✅ *Availability:* ${s.draft.urgency}\n\n📷 *Send a photo or video of the job!*\n\nOne photo or one video — it will be shown on your post. Or tap *DONE* to post without media.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ DONE — post now', callback_data: 'post_photos_done' }],
        [{ text: '❌ Cancel',          callback_data: 'cancel' }],
      ]}}
    ).then(m => { s.draft.photoPromptId = m.message_id; });
    return;
  }

  if (data === 'post_skip_photo' || data === 'post_photos_done') {
    const s = getSession(userId);
    if (s.step !== 'post_photo') return;
    if (!s.draft.photos) s.draft.photos = [];
    // Clear wizard buttons before posting
    if (s.draft.photoPromptId) bot.deleteMessage(chatId, s.draft.photoPromptId).catch(() => {});
    if (s.draft.photoStatusId) bot.deleteMessage(chatId, s.draft.photoStatusId).catch(() => {});
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

  if (data === 'confirm_phone_post') {
    const s = getSession(userId);
    const phone = s.draft.confirmedPhone;
    if (!phone) { bot.sendMessage(chatId, '⚠️ Please type your phone number again.'); return; }
    await updateUser(userId, { phone });
    const pendingAccept = s.draft.pendingAccept;
    clearSession(userId);
    if (pendingAccept) {
      acceptApplicant(chatId, userId, pendingAccept.jobId, pendingAccept.workerId);
    } else {
      startPostFlow(chatId, userId);
    }
    return;
  }

  if (data === 'change_phone_post') {
    const s = getSession(userId);
    s.step = 'collect_phone_for_post';
    bot.sendMessage(chatId, '📱 Please type your phone number:', { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } });
    return;
  }

  if (data === 'cancel') {
    clearSession(userId);
    showMenu(chatId, userId, '❌ Cancelled.');
    return;
  }

  if (data === 'show_rules') {
    const rulesText =
      `📋 *Husssle Rules*\n\n` +
      `*What you can and cannot do:*\n\n` +
      `1️⃣ *Posting jobs* — You can post up to 20 jobs at a time. Close or delete an existing job before posting a new one.\n\n` +
      `2️⃣ *Applying to jobs* — You can apply to up to 20 jobs at a time. Withdraw an application before applying to more.\n\n` +
      `3️⃣ *Working on jobs* — You can only work on 1 job at a time. Complete or leave your current job before taking another.\n\n` +
      `4️⃣ *Accepting workers* — Only 1 worker can be accepted per job. Once accepted, no one else can apply.\n\n` +
      `5️⃣ *Completion requests* — You can only send 1 completion request at a time. Wait for the customer to respond before sending another.\n\n` +
      `6️⃣ *Leave requests* — You can only send 1 leave request at a time. Wait for the customer to respond before sending another.\n\n` +
      `7️⃣ *Reapplying* — You can reapply to the same job up to 3 times after being rejected. After the 3rd rejection you are permanently blocked from that job.\n\n` +
      `8️⃣ *Reporting jobs* — You can only report the same job once.\n\n` +
      `9️⃣ *Reviews* — You can only leave 1 review per job. It cannot be edited after submission.\n\n` +
      `🔟 *Taken jobs* — No limit on how many jobs can be worked on for you at the same time.\n\n` +
      `1️⃣1️⃣ *Applications per job* — No limit on how many people can apply to your job.\n\n` +
      `1️⃣2️⃣ *Job re-opens* — A job can be re-opened up to 5 times if a worker leaves or disappears. After the 5th re-open the job is automatically deleted.\n\n` +
    `1️⃣3️⃣ *Job closing* — Once the worker submits their review the job is closed immediately. The poster's review gate remains open until they submit their review.\n\n` +
    `1️⃣4️⃣ *Cancelling jobs* — Cancelling a job that already has an accepted worker counts as a strike. After 3 strikes you receive a warning. After 6 strikes admin is notified.\n\n` +
    `1️⃣5️⃣ *Declining completion* — If you decline a worker's completion request 3 or more times on the same job, admin is automatically notified to review the situation.\n\n` +
    `1️⃣6️⃣ *Declining leave* — If you decline a worker's leave request 3 times on the same job, they are automatically released and the job goes back to open.\n\n` +
    `1️⃣7️⃣ *Reports & bans* — Reports are reviewed manually by admin. There is currently no automatic ban threshold.\n\n` +
    `1️⃣8️⃣ *Daily report limit* — You can send up to 10 reports per day across all jobs. After 10 you are blocked from reporting until the next day.\n\n` +
    `1️⃣9️⃣ *Job expiry (open)* — Jobs that have been open for 30 days with no worker are automatically deleted. You will be notified and can re-post if needed.\n\n` +
    `2️⃣0️⃣ *Job expiry (taken)* — Jobs that have been in progress for 30 days are automatically closed. Both sides are notified to leave a review.`;
    await showState(chatId, userId, rulesText, {
      reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: 'menu_back' }]] }
    });
    return;
  }

  if (data === 'noop') {
    bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
    return;
  }



  if (data === 'menu_back') {
    showMenu(chatId, userId);
    updateUserPin(userId).catch(() => {});
    return;
  }

  if (data === 'pin_live_now') {
    // Re-add button to pin message explicitly after tap
    bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: "🟢 What's live", callback_data: 'pin_live_now' }]] },
      { chat_id: chatId, message_id: msgId }
    ).catch(() => {});
  }

  if (data === 'live_now' || data === 'pin_live_now') {
    // Fetch all relevant data
    const workerApps = await getUserApplications(userId);
    const working = workerApps.filter(a => a.status === 'accepted');
    const pendingApps = workerApps.filter(a => a.status === 'pending');

    const takenSnap = await db.collection('jobs').where('posterId', '==', userId).where('status', '==', 'taken').get();
    const hiring = takenSnap.docs.map(d => d.data());

    const openSnap = await db.collection('jobs').where('posterId', '==', userId).where('status', '==', 'open').get();
    const openJobs = openSnap.docs.map(d => d.data());

    // Urgent: applications to my open jobs that i havent responded to
    const urgentApplicants = [];
    for (const job of openJobs) {
      const appSnap = await db.collection('applications').where('jobId', '==', String(job.id)).where('status', '==', 'pending').get();
      if (!appSnap.empty) urgentApplicants.push({ job, count: appSnap.size });
    }

    // Urgent: completion requests pending my confirmation (as poster)
    const completionSnap = await db.collection('completionRequests').where('posterId', '==', userId).get();
    const pendingCompletions = completionSnap.docs.map(d => d.data());

    // Info: my completion requests pending worker confirmation (as worker)
    const myCompletionSnap = await db.collection('completionRequests').where('workerId', '==', userId).get();
    const myPendingCompletions = myCompletionSnap.docs.map(d => d.data());

    // Urgent: leave requests pending my confirmation (as poster)
    const leaveSnap = await db.collection('leaveRequests').where('posterId', '==', userId).get();
    const pendingLeaves = leaveSnap.docs.map(d => d.data());

    // Info: my leave requests pending poster confirmation (as worker)
    const myLeaveSnap = await db.collection('leaveRequests').where('workerId', '==', userId).get();
    const myPendingLeaves = myLeaveSnap.docs.map(d => d.data());

    const totalActive = working.length + hiring.length;

    if (totalActive === 0 && urgentApplicants.length === 0 && pendingApps.length === 0) {
      const userDoc = await db.collection('users').doc(String(userId)).get();
      if (userDoc.exists && userDoc.data().pinnedMsgId) {
        await bot.unpinAllChatMessages(chatId).catch(() => {});
        await db.collection('users').doc(String(userId)).update({ pinnedMsgId: null });
      }
      await showState(chatId, userId,
        `🔴 *Husssle Live*\n\nNothing active right now.\n\nPost a hustle or apply to one to get started!`,
        { reply_markup: { inline_keyboard: [
          [{ text: '➕ Post a hustle', callback_data: 'post_start' }],
        ]}}
      );
      return;
    }

    const userDoc = await db.collection('users').doc(String(userId)).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Pinned job — top priority worker job
    const pinnedJob = working.length > 0 ? working[0] : (hiring.length > 0 ? hiring[0] : null);
    const isPinnedWorker = working.length > 0;

    let text = '🔴 *Husssle Live*\n\n';

    // URGENT section
    const hasUrgent = urgentApplicants.length > 0 || pendingCompletions.length > 0 || pendingLeaves.length > 0;
    if (hasUrgent) {
      text += `⚠️ *Needs your attention*\n`;
      urgentApplicants.forEach(({ job, count }) => {
        text += `• ${count} applicant${count > 1 ? 's' : ''} waiting on *${escapeMarkdown(job.title)}*\n`;
      });
      pendingCompletions.forEach(req => {
        text += `• *${req.jobTitle}* — ${req.workerName} says it's done\. Confirm?\n`;
      });
      pendingLeaves.forEach(req => {
        text += `• *${req.jobTitle}* — ${req.workerName} wants to leave\. Reason: ${req.reason}\n`;
      });
      text += '\n';
    }

    // Worker's pending requests
    if (myPendingCompletions.length > 0 || myPendingLeaves.length > 0) {
      text += `⏳ *Awaiting confirmation*\n`;
      myPendingCompletions.forEach(req => {
        text += `• *${req.jobTitle}* — completion requested, waiting for customer\n`;
      });
      myPendingLeaves.forEach(req => {
        text += `• *${req.jobTitle}* — leave requested, waiting for customer\n`;
      });
      text += '\n';
    }

    // PINNED JOB section
    if (pinnedJob) {
      if (isPinnedWorker) {
        text += `📌 *You're working on:*\n`;
        text += `*${pinnedJob.jobTitle}* · KES ${pinnedJob.jobPay}\n`;
        text += `_This is your pinned hustle_\n\n`;
      } else {
        text += `📌 *Working for you:*\n`;
        text += `*${pinnedJob.title}* · KES ${pinnedJob.pay}\n`;
        text += `_This is your pinned hustle_\n\n`;
      }
    }

    // IN PROGRESS section
    const otherWorking = working.slice(1);
    const otherHiring = isPinnedWorker ? hiring : hiring.slice(1);

    if (otherWorking.length > 0 || otherHiring.length > 0) {
      text += `🟡 *Also in progress*\n`;
      otherWorking.forEach(a => { text += `• 🔨 ${a.jobTitle} · KES ${a.jobPay}\n`; });
      otherHiring.forEach(j => { text += `• 👀 ${escapeMarkdown(j.title)} · KES ${j.pay}\n`; });
      text += '\n';
    }

    // WAITING section
    if (pendingApps.length > 0 || openJobs.filter(j => !urgentApplicants.find(u => u.job.id === j.id)).length > 0) {
      text += `⚪ *Waiting*\n`;
      pendingApps.forEach(a => { text += `• Applied to *${a.jobTitle}* — waiting for response\n`; });
      openJobs.filter(j => !urgentApplicants.find(u => u.job.id === j.id)).forEach(j => { text += `• *${escapeMarkdown(j.title)}* — open, no applicants yet\n`; });
    }

    // Buttons
    const buttons = [];
    // Add confirm buttons for pending completions
    pendingCompletions.forEach(req => {
      buttons.push([
        { text: `✅ Confirm: ${req.jobTitle}`, callback_data: `mark_done_${req.jobId}` },
        { text: '❌ Not yet', callback_data: `decline_done_${req.jobId}_${req.workerId}` },
      ]);
    });
    pendingLeaves.forEach(req => {
      buttons.push([
        { text: `✅ Let them go: ${req.jobTitle}`, callback_data: `approve_leave_${req.jobId}_${req.workerId}` },
        { text: '❌ Stay', callback_data: `decline_leave_${req.jobId}_${req.workerId}` },
      ]);
    });
    if (pinnedJob) {
      const manageCallback = isPinnedWorker ? `worker_job_${pinnedJob.jobId}` : `manage_job_${pinnedJob.id}`;
      buttons.push([{ text: '🔧 Manage pinned job', callback_data: manageCallback }]);
    }
    if (totalActive > 1) {
      buttons.push([{ text: '📌 Switch pin', callback_data: 'switch_pin' }]);
    }
    buttons.push([{ text: '📋 Manage husssle', callback_data: 'manage_husssle' }]);

    await showState(chatId, userId, text, { reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (data === 'switch_pin') {
    const workerApps = await getUserApplications(userId);
    const working = workerApps.filter(a => a.status === 'accepted');
    const takenSnap = await db.collection('jobs').where('posterId', '==', userId).where('status', '==', 'taken').get();
    const hiring = takenSnap.docs.map(d => d.data());

    const buttons = [
      ...working.map(a => [{ text: `🔨 ${a.jobTitle} — KES ${a.jobPay}`, callback_data: `pin_job_${a.jobId}_worker` }]),
      ...hiring.map(j => [{ text: `👀 ${j.title} — KES ${j.pay}`, callback_data: `pin_job_${j.id}_poster` }]),
    ];
    await showState(chatId, userId, '📌 *Switch pin*\n\nChoose which job to pin:', { reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (data === 'manage_husssle') {
    const openSnap = await db.collection('jobs').where('posterId', '==', userId).where('status', '==', 'open').get();
    const openJobs = openSnap.docs.map(d => d.data());
    const workerApps = await getUserApplications(userId);
    const pendingApps = workerApps.filter(a => a.status === 'pending');

    let text = '📋 *Manage Husssle*\n\n';
    const buttons = [];

    if (openJobs.length > 0) {
      text += '💼 *Your open jobs:*\n';
      openJobs.forEach(j => {
        text += `• *${escapeMarkdown(j.title)}* · KES ${j.pay}\n`;
        buttons.push([{ text: `💼 ${j.title}`, callback_data: `manage_job_${j.id}` }]);
      });
      text += '\n';
    }

    if (pendingApps.length > 0) {
      text += '📝 *Your pending applications:*\n';
      pendingApps.forEach(a => {
        text += `• *${a.jobTitle}* — waiting\n`;
      });
      text += '\n';
    }

    if (openJobs.length === 0 && pendingApps.length === 0) {
      text += 'Nothing to manage right now.';
    }

    buttons.push([{ text: '← Back', callback_data: 'live_now' }]);
    await showState(chatId, userId, text, { reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (data.startsWith('pin_job_')) {
    const parts = data.split('_');
    const jobId = parts[2];
    const role  = parts[3]; // worker or poster
    // Update pinnedJobId in Firebase then refresh pin
    await db.collection('users').doc(String(userId)).update({ pinnedJobId: jobId });
    await updateUserPin(userId);
    bot.sendMessage(chatId, `📌 Pin updated!`).catch(() => {});
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
  console.log(`[IN] msg: step=${s.step}, ${msg.photo ? 'photo' : 'text'} — user=${userId}`);

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
    s.draft.confirmedPhone = text.trim();
    s.step = 'confirm_phone_for_post';
    bot.sendMessage(chatId,
      `📱 Your contact number:\n*${escapeMarkdown(s.draft.confirmedPhone)}*\n\nIs this correct?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, confirm', callback_data: 'confirm_phone_post' }],
        [{ text: '✏️ Change it', callback_data: 'change_phone_post' }],
      ]}}
    );
    return;
  }

  if (s.step === 'confirm_phone_for_post') {
    // handled by callback buttons
    return;
  }

  if (s.step === 'leave_reason') {
    const reason = text && text.trim();
    if (!reason || reason.length < 3) {
      bot.sendMessage(chatId, '⚠️ Please type a reason (at least 3 characters):');
      return;
    }
    const jobId = s.draft.leaveJobId;
    const jobTitle = s.draft.leaveJobTitle;
    const posterId = s.draft.leavePosterId;
    clearSession(userId);
    // Save leave request
    await db.collection('leaveRequests').doc(String(jobId)).set({
      jobId: String(jobId),
      jobTitle,
      workerId: userId,
      workerName: user.name,
      posterId,
      reason,
      requestedAt: Date.now(),
    });
    // Notify poster
    await showState(posterId, posterId,
      `🚪 *Leave Request*\n\n*${escapeMarkdown(user.name)}* wants to leave *${escapeMarkdown(jobTitle)}*\n\nReason: _${reason}_\n\nDo you approve?`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Approve', callback_data: `approve_leave_${jobId}_${userId}` }],
        [{ text: '❌ Decline', callback_data: `decline_leave_${jobId}_${userId}` }],
      ]}}
    ).catch(() => {});
    updateUserPin(posterId).catch(() => {});
    showMenu(chatId, userId, '✅ Leave request sent. Waiting for customer to respond.');
    return;
  }

  if (s.step === 'decline_reason') {
    const reason = text && text.trim();
    if (!reason || reason.length < 3) {
      bot.sendMessage(chatId, '⚠️ Please type a reason (at least 3 characters):');
      return;
    }
    const jobId = s.draft.declineJobId;
    const workerId = s.draft.declineWorkerId;
    const jobTitle = s.draft.declineJobTitle;
    clearSession(userId);
    // Clear completion request
    await db.collection('completionRequests').doc(String(jobId)).delete().catch(() => {});
    // Track decline count on job
    const jobDoc = await db.collection('jobs').doc(String(jobId)).get();
    const declineCount = (jobDoc.exists ? (jobDoc.data().declineCount || 0) : 0) + 1;
    await db.collection('jobs').doc(String(jobId)).update({ declineCount });
    // Notify worker with reason and manage button
    await showState(workerId, workerId,
      `❌ *Not done yet*\n\n*${escapeMarkdown(jobTitle)}*\n\nYour customer says:\n_${reason}_\n\nKeep going! 💪`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🔧 Manage this job', callback_data: `worker_job_${jobId}` }],
      ]}}
    ).catch(() => {});
    // After 3rd decline — notify admin
    if (declineCount >= 3) {
      const workerDoc = await db.collection('users').doc(String(workerId)).get();
      const workerName = workerDoc.exists ? workerDoc.data().name : 'Worker';
      bot.sendMessage(ADMIN_ID,
        `🚨 *Dispute Alert*\n\nJob: *${escapeMarkdown(jobTitle)}*\nPoster: *${escapeMarkdown(user.name)}* (ID: ${userId})\nWorker: *${workerName}* (ID: ${workerId})\n\nThe poster has declined completion ${declineCount} times.\nReason this time: _${reason}_\n\nPlease review this situation.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
    showMenu(chatId, userId, '✅ Worker has been notified with your feedback.');
    return;
  }

  if (s.step === 'completion_review_comment') {
    if (!text || text.length < 10) {
      bot.sendMessage(chatId, '⚠️ Please write at least 10 characters to describe how it went:');
      return;
    }
    // Save comment, ask for stars
    if (s.draft.lastMsgId) bot.deleteMessage(chatId, s.draft.lastMsgId).catch(() => {});
    s.draft.completionComment = text;
    s.step = 'completion_review_stars';

    const isWorker = s.draft.completionRole === 'worker';
    const targetName = isWorker ? s.draft.completionPosterName : s.draft.completionWorkerName;
    const jobId = s.draft.completionJobId;
    const targetId = isWorker ? s.draft.completionPosterId : s.draft.completionWorkerId;
    const prefix = isWorker ? 'rate_poster' : 'rate_worker';

    const ratingMsg = await bot.sendMessage(chatId,
      `✍️ *"${text}"*\n\nNow rate ${escapeMarkdown(targetName)}:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '⭐1', callback_data: `${prefix}_${jobId}_${targetId}_1` },
        { text: '⭐2', callback_data: `${prefix}_${jobId}_${targetId}_2` },
        { text: '⭐3', callback_data: `${prefix}_${jobId}_${targetId}_3` },
        { text: '⭐4', callback_data: `${prefix}_${jobId}_${targetId}_4` },
        { text: '⭐5', callback_data: `${prefix}_${jobId}_${targetId}_5` },
      ]] }}
    );
    s.draft.lastMsgId = ratingMsg.message_id;
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
    if (s.draft.lastMsgId) bot.deleteMessage(chatId, s.draft.lastMsgId).catch(() => {});
    clearSession(userId);
    showMenu(chatId, userId, `✅ *Review submitted!*\n\n⭐ ${reviewStars} star${reviewStars > 1 ? 's' : ''} — "${text}"\n\nThanks for the feedback! 🙏`);
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
    if (s.draft.lastMsgId) bot.deleteMessage(chatId, s.draft.lastMsgId).catch(() => {});
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
    // Gate: check pending feedback even mid-flow
    const pendingFbCheck = await hasPendingFeedback(userId);
    if (pendingFbCheck) {
      clearSession(userId);
      const s2 = getSession(userId);
      s2.step = 'write_review_pending';
      s2.draft.pendingFeedbackDocId = pendingFbCheck.docId;
      s2.draft.pendingFeedbackToId  = pendingFbCheck.toUserId;
      s2.draft.pendingFeedbackStars = null;
      s2.draft.afterFeedback = { action: 'post' };
      bot.sendMessage(chatId,
        `⚠️ *Before you can post, you need to leave feedback!*\n\nJob: *${escapeMarkdown(pendingFbCheck.jobTitle)}*\n\nFirst, rate your experience (1-5 stars):`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '⭐1', callback_data: 'pending_fb_stars_1' },
          { text: '⭐2', callback_data: 'pending_fb_stars_2' },
          { text: '⭐3', callback_data: 'pending_fb_stars_3' },
          { text: '⭐4', callback_data: 'pending_fb_stars_4' },
          { text: '⭐5', callback_data: 'pending_fb_stars_5' },
        ]] }}
      );
      return;
    }
    const bannedTitle = containsBannedWords(text);
    if (bannedTitle) {
      bot.sendMessage(chatId, `⚠️ Your title contains inappropriate content. Please rephrase.`);
      return;
    }
    if (s.draft.lastMsgId) bot.deleteMessage(chatId, s.draft.lastMsgId).catch(() => {});
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
    if (s.draft.lastMsgId) bot.deleteMessage(chatId, s.draft.lastMsgId).catch(() => {});
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
    if (pay > 10000000) { bot.sendMessage(chatId, '⚠️ Amount too high. Max is KES 10,000,000'); return; }
    if (s.draft.lastMsgId) bot.deleteMessage(chatId, s.draft.lastMsgId).catch(() => {});
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
    if (s.draft.lastMsgId) bot.deleteMessage(chatId, s.draft.lastMsgId).catch(() => {});
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
    if (msg.photo || msg.video) {
      if (!s.draft.photos) s.draft.photos = [];
      const already = s.draft.photos.length > 0 || s.draft.video;
      if (!already) {
        if (msg.video) s.draft.video = msg.video.file_id;
        else s.draft.photos.push(msg.photo[msg.photo.length - 1].file_id);
      }
      // Wait until the album finishes arriving, then show ONE confirmation
      if (s.photoTimer) clearTimeout(s.photoTimer);
      s.photoTimer = setTimeout(async () => {
        if (s.step !== 'post_photo') return;
        const count = s.draft.photos.length;
        if (s.draft.photoPromptId) {
          await bot.deleteMessage(chatId, s.draft.photoPromptId).catch(() => {});
          s.draft.photoPromptId = null;
        }
        const what = s.draft.video ? 'Video' : 'Photo';
        const extraNote = msg.media_group_id ? '\n\nℹ️ Only one photo or video is allowed per post — I kept the first one.' : '';
        const statusText = `✅ ${what} added!${extraNote}\n\nReady to post?`;
        const statusKb = { inline_keyboard: [
          [{ text: '🚀 Post it!', callback_data: 'post_photos_done' }],
          [{ text: '❌ Cancel',   callback_data: 'cancel' }],
        ]};
        if (s.draft.photoStatusId) {
          await bot.editMessageText(statusText, { chat_id: chatId, message_id: s.draft.photoStatusId, reply_markup: statusKb }).catch(() => {});
        } else {
          const m = await bot.sendMessage(chatId, statusText, { reply_markup: statusKb }).catch(() => null);
          if (m) s.draft.photoStatusId = m.message_id;
        }
      }, 1000);
    } else if (text.toLowerCase() === 'skip') {
      s.draft.photos = [];
      publishJob(chatId, userId, user, s.draft);
      clearSession(userId);
    } else {
      bot.sendMessage(chatId, '⚠️ Please send a photo or tap DONE to post.');
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
    workerUsername: user.username || null,
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

  // Use showState so new application notifications replace old ones
  await showState(job.posterId, job.posterId,
    `🔔 *New application on your hustle!*\n\nJob: *${escapeMarkdown(job.title)}*\nApplicant: ${escapeMarkdown(user.name)} — ${getRatingStars(user.rating, user.ratingCount)}\n\nTap to review:`,
    { reply_markup: { inline_keyboard: [[{ text: '👥 Review applicants', callback_data: `view_applicants_${jobId}` }]] } }
  ).catch(() => {});

  showMenu(chatId, userId,
    `✅ *Application sent!*\n\n*${escapeMarkdown(job.title)}* · KES ${job.pay}\n\n${escapeMarkdown(job.posterName)} will review and get back to you\. Good luck! 🤞`
  );
}

async function publishJob(chatId, userId, user, draft) {
  console.log(`[POST] publishing — user=${userId}, title="${draft.title}", photos=${(draft.photos || []).length}`);
  const jobRef = db.collection('jobs').doc();
  const jobId  = jobRef.id;

  const job = {
    id:               jobId,
    title:            draft.title,
    description:      draft.description,
    pay:              draft.pay,
    location:         draft.location,
    photos:           draft.photos || [],
    video:            draft.video || null,
    posterId:         userId,
    posterName:       user.name,
    posterRating:      user.rating || 0,
    posterRatingCount: user.ratingCount || 0,
    posterTotalSpent:  user.totalSpent || 0,
    status:           'open',
    urgency:          draft.urgency || '⏰ Flexible',
    applicantCount:   0,
    channelMsgId:     null,
    createdAt:        Date.now(),
  };

  await jobRef.set(job);

  bot.sendMessage(chatId,
    `🎉 *Hustle posted!*\n\n*${escapeMarkdown(job.title)}*\nKES ${job.pay} · ${escapeMarkdown(job.location)}\n\nYour hustle is now live in the channel!`,
    { parse_mode: 'Markdown' }
  );

  const caption  = await formatChannelPost(job);
  const applyUrl = `https://t.me/nbohussle_bot?start=apply_${jobId}`;
  const keyboard = { inline_keyboard: [[{ text: "✋ I'll do it!", url: applyUrl }]] };
  const plainCaption = () => caption.replace(/[*_`[]/g, '');

  let channelMsg;
  if (job.video) {
    channelMsg = await bot.sendVideo(CHANNEL_ID, job.video, { caption, parse_mode: 'Markdown', reply_markup: keyboard })
      .catch(async e => {
        console.log('Channel error, retrying plain:', e.message);
        return bot.sendVideo(CHANNEL_ID, job.video, { caption: plainCaption(), reply_markup: keyboard }).catch(e2 => console.log('Channel error:', e2.message));
      });
  } else if (job.photos.length === 0) {
    channelMsg = await bot.sendMessage(CHANNEL_ID, caption, { parse_mode: 'Markdown', reply_markup: keyboard })
      .catch(async e => {
        console.log('Channel error, retrying plain:', e.message);
        return bot.sendMessage(CHANNEL_ID, plainCaption(), { reply_markup: keyboard }).catch(e2 => console.log('Channel error:', e2.message));
      });
  } else {
    channelMsg = await bot.sendPhoto(CHANNEL_ID, job.photos[0], { caption, parse_mode: 'Markdown', reply_markup: keyboard })
      .catch(async e => {
        console.log('Channel error, retrying plain:', e.message);
        return bot.sendPhoto(CHANNEL_ID, job.photos[0], { caption: plainCaption(), reply_markup: keyboard }).catch(e2 => console.log('Channel error:', e2.message));
      });
  }

  if (channelMsg) {
    console.log(`[POST] channel post OK — msgId=${channelMsg.message_id}`);
    await jobRef.update({ channelMsgId: channelMsg.message_id });
    await db.collection('channelPosts').doc(String(channelMsg.message_id)).set({
      channelMsgId: channelMsg.message_id,
      jobId:        jobId,
      jobTitle:     job.title,
      createdAt:    Date.now(),
    });
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

  // Fetch last 3 reviews of the poster
  const reviewsSnap = await db.collection('users').doc(String(job.posterId))
    .collection('reviews').orderBy('createdAt', 'desc').limit(2).get();
  let reviewsText = '';
  if (!reviewsSnap.empty) {
    const stars = n => '⭐'.repeat(n) + '☆'.repeat(5 - n);
    reviewsText = '\n\n💬 *Recent reviews:*\n' + reviewsSnap.docs.map(d => {
      const r = d.data();
      return `${stars(r.stars)} _"${escapeMarkdown(r.comment)}"_ — ${escapeMarkdown(r.fromName)}`;
    }).join('\n');
  }

  let buttons = [];
  if (!isOwner && !alreadyApplied && !wasRejected && job.status === 'open') buttons.push([{ text: "✋ I'll do it!", callback_data: `apply_${jobId}` }]);
  if (wasRejected && job.status === 'open') buttons.push([{ text: '🔄 Re-apply', callback_data: `apply_${jobId}` }]);
  if (alreadyApplied) buttons.push([{ text: '✅ Already applied', callback_data: 'noop' }]);
  if (isOwner)        buttons.push([{ text: '⚙️ Manage this hustle', callback_data: `manage_job_${jobId}` }]);
  if (userId === ADMIN_ID && !isOwner) buttons.push([{ text: `🔐 Ban poster (${job.posterName})`, callback_data: `ban_user_${job.posterId}` }]);
  if (userId === ADMIN_ID && !isOwner) buttons.push([{ text: '🗑️ Delete job (admin)', callback_data: `admin_delete_${jobId}` }]);

  // Fetch poster's totalSpent
  const posterDoc = await db.collection('users').doc(String(job.posterId)).get();
  const posterTotalSpent = posterDoc.exists ? (posterDoc.data().totalSpent || 0) : 0;

  const text =
    `💼 *${escapeMarkdown(job.title)}*\n\n` +
    `📝 ${escapeMarkdown(job.description)}\n\n` +
    `💰 *KES ${job.pay}*\n` +
    `📍 ${escapeMarkdown(job.location)}\n` +
    `📌 ${getJobStatus(job.status)}\n` +
    `👤 ${escapeMarkdown(job.posterName)} — ${getRatingStars(job.posterRating, job.posterRatingCount)}\n` +
    (posterTotalSpent > 0 ? `💵 Has paid out KES ${posterTotalSpent.toLocaleString()} to workers\n` : '') +
    `👥 ${apps.length} applicant(s)` +
    reviewsText;

  if (job.photos && job.photos.length > 0) {
    await showState(chatId, userId, text, { photo: job.photos[0], reply_markup: { inline_keyboard: buttons } });
  } else {
    await showState(chatId, userId, text, { reply_markup: { inline_keyboard: buttons } });
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
  if (pending.length)  buttons.push([{ text: `👥 ${pending.length} applicant${pending.length > 1 ? 's' : ''} waiting — Review now`, callback_data: `view_applicants_${jobId}` }]);
  if (rejected.length) buttons.push([{ text: `❌ View rejected (${rejected.length})`, callback_data: `view_rejected_${jobId}` }]);
  if (accepted.length) buttons.push([{ text: `✅ View accepted (${accepted.length})`, callback_data: `view_accepted_${jobId}` }]);
  if (job.status === 'taken') buttons.push([{ text: '✅ Mark as Done', callback_data: `mark_done_${jobId}` }]);
  if (job.status === 'taken') buttons.push([{ text: '🔄 Re-open (worker disappeared)', callback_data: `reopen_job_${jobId}` }]);
  if (job.status === 'taken') buttons.push([{ text: '❌ Cancel job (notify worker)', callback_data: `cancel_job_${jobId}` }]);
  if (job.status !== 'done') buttons.push([{ text: '🗑️ Delete this job', callback_data: `delete_job_${jobId}` }]);

  await showState(chatId, userId,
    `⚙️ *Manage: ${escapeMarkdown(job.title)}*\n\nStatus: ${getJobStatus(job.status)}\nApplicants: ${apps.length}\nPay: KES ${job.pay}`,
    { reply_markup: { inline_keyboard: buttons } }
  );
}

async function showApplicants(chatId, userId, jobId) {
  const job  = await getJob(jobId);
  if (!job || job.posterId !== userId) return;
  const apps = await getJobApplications(jobId);

  if (!apps.length) {
    await showState(chatId, userId, 'No applications yet.');
    return;
  }
  const pending  = apps.filter(a => a.status === 'pending');
  const accepted = apps.filter(a => a.status === 'accepted');
  const rejected = apps.filter(a => a.status === 'rejected');

  let text = `👥 *Applicants for "${escapeMarkdown(job.title)}"* (${apps.length})\n\n`;

  if (accepted.length) {
    text += `✅ *Accepted:*\n`;
    accepted.forEach(a => {
      text += `• *${escapeMarkdown(a.workerName)}* — ${getRatingStars(a.rating, a.ratingCount)}\n📱 ${a.workerPhone}\n\n`;
    });
  }

  if (pending.length) {
    text += `⏳ *Pending (${pending.length}):*\n\n`;
    for (let i = 0; i < pending.length; i++) {
      const a = pending[i];
      // Fetch worker profile
      const workerDoc = await db.collection('users').doc(String(a.workerId)).get();
      const w = workerDoc.exists ? workerDoc.data() : {};
      const joinDate = w.createdAt ? new Date(w.createdAt).toLocaleDateString('en-KE', { month: 'short', year: 'numeric' }) : 'Unknown';
      const totalEarned = w.totalEarned || 0;
      const completedJobs = w.completedJobs || 0;

      // Fetch last 2 reviews
      const reviewsSnap = await db.collection('users').doc(String(a.workerId))
        .collection('reviews').orderBy('createdAt', 'desc').limit(2).get();
      let reviewsText = '';
      if (!reviewsSnap.empty) {
        const stars = n => '⭐'.repeat(n) + '☆'.repeat(5 - n);
        reviewsText = '\n💬 ' + reviewsSnap.docs.map(d => {
          const r = d.data();
          return `${stars(r.stars)} _"${r.comment}"_`;
        }).join(' · ');
      }

      text += `${i+1}. *${escapeMarkdown(a.workerName)}* — ${getRatingStars(a.rating, a.ratingCount)}\n`;
      text += `📱 ${a.workerPhone}\n`;
      text += `📅 Member since ${joinDate}\n`;
      text += `💰 Total earned: KES ${totalEarned.toLocaleString()}\n`;
      if (completedJobs > 0) text += `✅ ${completedJobs} job${completedJobs > 1 ? 's' : ''} completed\n`;
      text += reviewsText + '\n\n';
    }
    text += 'Tap to accept:';
  }

  if (rejected.length) {
    text += `\n❌ *Not selected (${rejected.length}):*\n`;
    rejected.forEach(a => {
      text += `• *${escapeMarkdown(a.workerName)}* — ${getRatingStars(a.rating, a.ratingCount)}\n`;
    });
  }

  const buttons = pending.flatMap(a => {
    const chatUrl = a.workerUsername ? `https://t.me/${a.workerUsername}` : `tg://user?id=${a.workerId}`;
    return [
      [{ text: `💬 Message ${a.workerName}`, url: chatUrl }],
      [{ text: `✅ Accept ${a.workerName}`, callback_data: `accept_${jobId}_${a.workerId}` },
       { text: `❌ Reject`, callback_data: `reject_${jobId}_${a.workerId}` }]
    ];
  });
  await showState(chatId, userId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function acceptApplicant(chatId, posterId, jobId, workerId) {
  const job  = await getJob(jobId);
  if (!job) { bot.sendMessage(chatId, '❌ Job not found.'); return; }
  // Compare as strings to avoid type mismatch
  if (String(job.posterId) !== String(posterId)) { bot.sendMessage(chatId, '❌ Not your job.'); return; }
  const apps = await getJobApplications(jobId);
  const app  = apps.find(a => String(a.workerId) === String(workerId));
  if (!app) { bot.sendMessage(chatId, '❌ Applicant not found.'); return; }

  // update all applications
  const batch = db.batch();
  const appsSnap = await db.collection('applications').where('jobId', '==', String(jobId)).get();
  appsSnap.docs.forEach(doc => {
    batch.update(doc.ref, { status: String(doc.data().workerId) === String(workerId) ? 'accepted' : 'rejected' });
  });
  batch.update(db.collection('jobs').doc(String(jobId)), { status: 'taken' });
  await batch.commit();

  job.status = 'taken';
  updateChannelPost(job);

  const poster = await db.collection('users').doc(String(posterId)).get();
  const posterData = poster.exists ? poster.data() : { name: 'Customer', phone: 'N/A' };

  // Build chat buttons based on usernames
  const workerDoc = await db.collection('users').doc(String(workerId)).get();
  const workerData = workerDoc.exists ? workerDoc.data() : {};
  const posterUsername = posterData.username || null;
  const workerUsername = workerData.username || null;

  // Notify poster — with button to open worker's DM
  const workerChatUrl = workerUsername ? `https://t.me/${workerUsername}` : `tg://user?id=${workerId}`;
  const posterButtons = [
    [{ text: `💬 Message ${app.workerName}`, url: workerChatUrl }],
    [{ text: '💼 Manage job', callback_data: `manage_job_${jobId}` }],
  ];

  bot.sendMessage(chatId,
    `✅ *You accepted ${escapeMarkdown(app.workerName)}!*\n\n📱 Their phone: *${app.workerPhone}*\n` +
    (workerUsername ? `💬 Telegram: @${workerUsername}\n` : '') +
    `\nContact them to arrange the work. Once done, mark the job as Done.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: posterButtons } }
  );

  // Notify worker — with button to open poster's DM
  const posterChatUrl = posterUsername ? `https://t.me/${posterUsername}` : `tg://user?id=${posterId}`;
  const workerButtons = [
    [{ text: `💬 Message ${posterData.name}`, url: posterChatUrl }],
    [{ text: '📬 My Work', callback_data: 'my_applications' }],
  ];

  const workerMsg = await bot.sendMessage(workerId,
    `━━━━━━━━━━━━━━━\n🚨 *YOU GOT THE HUSTLE!* 🚨\n━━━━━━━━━━━━━━━\n\n🔨 *${escapeMarkdown(job.title)}*\n💰 KES ${job.pay}\n📍 ${escapeMarkdown(job.location)}\n\n📱 Customer: *${escapeMarkdown(posterData.name)}*\nPhone: *${posterData.phone || 'N/A'}*\n` +
    (posterUsername ? `💬 Telegram: @${posterUsername}\n` : '') +
    `\nThey will contact you to arrange. Good luck! 💪\n\n_Go to My Work to track this job_`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: workerButtons } }
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
      `ℹ️ Unfortunately, someone else was selected for *${escapeMarkdown(job.title)}*.\n\nKeep hustling! 💪`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });
}

async function submitCompletionReview(chatId, fromUserId, jobId, toUserId, stars, comment, role) {
  try {
    const job = await getJob(jobId);
    if (!job) return;

    // Save rating + review on target user
    const targetDoc = await db.collection('users').doc(String(toUserId)).get();
    if (targetDoc.exists) {
      const t = targetDoc.data();
      await db.collection('users').doc(String(toUserId)).update({
        rating: (t.rating || 0) + stars,
        ratingCount: (t.ratingCount || 0) + 1
      });
      await db.collection('users').doc(String(toUserId)).collection('reviews').add({
        fromUserId, fromName: (await db.collection('users').doc(String(fromUserId)).get()).data()?.name || 'Unknown',
        stars, comment, jobId: String(jobId), type: role, createdAt: Date.now()
      });
    }

    // Delete pending feedback
    const fbDocId = role === 'worker'
      ? `${jobId}_${fromUserId}_worker`
      : `${jobId}_${fromUserId}_poster`;
    await db.collection('pendingFeedback').doc(fbDocId).delete().catch(() => {});

    // Mark this side as reviewed on the job
    const reviewField = role === 'poster' ? 'posterReviewed' : 'workerReviewed';
    await db.collection('jobs').doc(String(jobId)).update({ [reviewField]: true });

    await showMenu(chatId, fromUserId, `✅ *Review submitted!* Thanks 🙏\n\n⭐ ${stars} star${stars > 1 ? 's' : ''} — _"${comment || ''}"_`);

    // Close job when worker reviews — don't wait for poster
    const updatedJob = await getJob(jobId);
    const shouldClose = role === 'worker' || (role === 'poster' && updatedJob.workerReviewed);

    if (shouldClose && updatedJob.status !== 'done') {
      const deleteAt = Date.now() + 24 * 60 * 60 * 1000;
      await db.collection('jobs').doc(String(jobId)).update({ status: 'done', deleteAt });
      updatedJob.status = 'done';
      updatedJob.deleteAt = deleteAt;

      const apps = await getJobApplications(jobId);
      const acceptedApp = apps.find(a => String(a.workerId) === String(role === 'poster' ? toUserId : fromUserId) || String(a.workerId) === String(role === 'worker' ? fromUserId : toUserId));

      if (acceptedApp) {
        const appSnap = await db.collection('applications').where('jobId', '==', String(jobId)).where('workerId', '==', acceptedApp.workerId).get();
        await Promise.all(appSnap.docs.map(doc => doc.ref.update({ status: 'done' })));

        await db.collection('users').doc(String(acceptedApp.workerId)).update({
          totalEarned:   admin.firestore.FieldValue.increment(job.pay),
          completedJobs: admin.firestore.FieldValue.increment(1),
        });
        await db.collection('users').doc(String(job.posterId)).update({
          totalSpent: admin.firestore.FieldValue.increment(job.pay)
        });
      }

      updateUserPin(job.posterId, true).catch(() => {});
      if (acceptedApp) updateUserPin(acceptedApp.workerId, true).catch(() => {});
      updateDoneChannelPost(updatedJob, acceptedApp).catch(() => {});
    }
  } catch (e) {
    console.error('submitCompletionReview error:', e.stack || e.message);
    bot.sendMessage(chatId, '❌ Something went wrong submitting your review. Please try again.').catch(() => {});
  }
}

async function updateUserPin(userId, force = false) {
  try {
    const workerSnap = await db.collection('applications')
      .where('workerId', '==', userId)
      .where('status', '==', 'accepted')
      .get();
    const workerJobsRaw = workerSnap.docs.map(d => d.data()).sort((a, b) => (a.appliedAt || 0) - (b.appliedAt || 0));
    const workerJobs = await Promise.all(workerJobsRaw.map(async a => {
      // Get posterId from job doc, then fetch poster user
      const jobDoc = await db.collection('jobs').doc(String(a.jobId)).get();
      if (jobDoc.exists) {
        const posterId = jobDoc.data().posterId;
        if (posterId) {
          const posterDoc = await db.collection('users').doc(String(posterId)).get();
          if (posterDoc.exists) {
            const pd = posterDoc.data();
            a.posterName = pd.name || a.posterName || '';
            a.posterPhone = pd.phone || '';
          }
        }
      }
      return a;
    }));

    const takenSnap = await db.collection('jobs')
      .where('posterId', '==', userId)
      .where('status', '==', 'taken')
      .get();
    const takenJobs = await Promise.all(takenSnap.docs.map(async d => {
      const jobData = { ...d.data(), docId: d.id };
      const appSnap = await db.collection('applications')
        .where('jobId', '==', String(jobData.id))
        .where('status', '==', 'accepted')
        .limit(1).get();
      if (!appSnap.empty) {
        const appData = appSnap.docs[0].data();
        jobData.workerName = appData.workerName || '';
        if (appData.workerId) {
          const workerDoc = await db.collection('users').doc(String(appData.workerId)).get();
          if (workerDoc.exists) jobData.workerPhone = workerDoc.data().phone || '';
        }
      }
      return jobData;
    }));

    const openSnap = await db.collection('jobs')
      .where('posterId', '==', userId)
      .where('status', '==', 'open')
      .get();
    const openJobs = openSnap.docs.map(d => ({ ...d.data(), docId: d.id }));

    const userDoc = await db.collection('users').doc(String(userId)).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Auto-priority always: worker job (oldest first) → taken job → open job
    let pinnedJob = null;
    let pinnedCallback = 'live_now';
    if (workerJobs.length)     { pinnedJob = { title: workerJobs[0].jobTitle, pay: workerJobs[0].jobPay }; pinnedCallback = `worker_job_${workerJobs[0].jobId}`; }
    else if (takenJobs.length) { pinnedJob = { title: takenJobs[0].title,     pay: takenJobs[0].pay };     pinnedCallback = `manage_job_${takenJobs[0].id}`; }
    else if (openJobs.length)  { pinnedJob = { title: openJobs[0].title,      pay: openJobs[0].pay };      pinnedCallback = `manage_job_${openJobs[0].id}`; }

    const total = workerJobs.length + takenJobs.length; // open jobs don't count as 'in motion'
    if (total === 0) {
      await bot.unpinAllChatMessages(userId).catch(() => {});
      await db.collection('users').doc(String(userId)).update({ pinnedMsgId: null });
      return;
    }

    // If pin already exists in Telegram and not forced, don't republish
    if (!force && userData.pinnedMsgId) {
      try {
        const chat = await bot.getChat(userId);
        const pinnedMsgId = userData.pinnedMsgId;
        if (chat.pinned_message && chat.pinned_message.message_id === pinnedMsgId) {
          return; // Pin is still there, skip
        }
        // Pin is gone — clear and republish
        await db.collection('users').doc(String(userId)).update({ pinnedMsgId: null });
      } catch(e) {
        await db.collection('users').doc(String(userId)).update({ pinnedMsgId: null });
      }
    } else if (force && userData.pinnedMsgId) {
      // Force republish — delete old pin first
      await bot.unpinChatMessage(userId, { message_id: userData.pinnedMsgId }).catch(() => {});
      await bot.deleteMessage(userId, userData.pinnedMsgId).catch(() => {});
    }

    // Clear old menu message when publishing pin
    const menuMsgId = userData.menuMsgId;
    if (menuMsgId) {
      await bot.deleteMessage(userId, menuMsgId).catch(() => {});
      await db.collection('users').doc(String(userId)).update({ menuMsgId: null }).catch(() => {});
    }

    // Build rich pin message text
    let pinText = '';

    if (workerJobs.length) {
      pinText += `🔴 *Working: ${workerJobs[0].jobTitle}*\n`;
    } else if (takenJobs.length) {
      pinText += `🔴 *In progress: ${takenJobs[0].title}*\n`;
    } else if (openJobs.length) {
      pinText += `🔴 *Open: ${openJobs[0].title}*\n`;
    } else {
      pinText += `🔴 *Husssle Live*\n`;
    }

    if (workerJobs.length) {
      pinText += `\n${total} hustle${total > 1 ? 's' : ''} in motion right now\n`;
      pinText += `\n🔨 *Active job*\n`;
      workerJobs.forEach(a => {
        pinText += `*${a.jobTitle}* · KES ${a.jobPay}\n`;
        if (a.jobLocation) pinText += `📍 ${a.jobLocation}\n`;
        if (a.posterName)  pinText += `👤 Customer: ${a.posterName}\n`;
        if (a.posterPhone) pinText += `📱 Reach them: ${a.posterPhone}\n`;
        pinText += `${a.posterName ? a.posterName : 'Your customer'} is counting on you. Go!\n`;
        pinText += `\n`;
      });
    }

    if (takenJobs.length) {
      pinText += `\n▱▱▱\n\n`;
      pinText += `👀 *Being done for you*\n`;
      takenJobs.forEach(j => {
        const workerName = j.workerName || '';
        pinText += `*${escapeMarkdown(j.title)}* · KES ${j.pay}\n`;
        if (j.location)    pinText += `📍 ${j.location}\n`;
        if (workerName)    pinText += `👤 Worker: ${workerName}\n`;
        if (j.workerPhone) pinText += `📱 Reach them: ${j.workerPhone}\n`;
        pinText += `Let them work. Stay patient.\n`;
        pinText += `\n`;
      });
    }

    const pinMsg = await bot.sendMessage(userId,
      pinText.trim(),
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🟢 What's live", callback_data: 'pin_live_now' }]] }}
    );
    await bot.pinChatMessage(userId, pinMsg.message_id, { disable_notification: true }).catch(() => {});
    await db.collection('users').doc(String(userId)).update({ pinnedMsgId: pinMsg.message_id });
  } catch (e) {
    console.error('updateUserPin error:', e.stack || e.message);
  }
}

async function updateChannelPost(job) {
  if (!job.channelMsgId) return;
  const text = await formatChannelPost(job);
  const applyUrl = `https://t.me/nbohussle_bot?start=apply_${job.id}`;
  const keyboard = job.status === 'open'
    ? { inline_keyboard: [[{ text: "✋ I'll do it!", url: applyUrl }]] }
    : { inline_keyboard: [] };

  if (job.video || (job.photos && job.photos.length >= 1)) {
    bot.editMessageCaption(text, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
  } else {
    bot.editMessageText(text, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
  }
}

// ─── Done channel post ────────────────────────────────────────────────────────
async function updateDoneChannelPost(job, acceptedApp) {
  if (!job.channelMsgId) return;
  const workerName = acceptedApp ? acceptedApp.workerName : 'Unknown';
  const deleteTime = new Date(job.deleteAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

  // Fetch worker data
  let workerRating = 0, workerRatingCount = 0, workerCompletedJobs = 0;
  if (acceptedApp) {
    const workerDoc = await db.collection('users').doc(String(acceptedApp.workerId)).get();
    if (workerDoc.exists) {
      const w = workerDoc.data();
      workerRating = w.rating || 0;
      workerRatingCount = w.ratingCount || 0;
      workerCompletedJobs = w.completedJobs || 0;
    }
  }

  // Fetch poster data
  const posterDoc = await db.collection('users').doc(String(job.posterId)).get();
  const posterData = posterDoc.exists ? posterDoc.data() : {};
  const posterTotalSpent = posterData.totalSpent || 0;
  const posterRating = posterData.rating || 0;
  const posterRatingCount = posterData.ratingCount || 0;

  // Fetch latest worker review left by poster
  let workerReviewText = '';
  const workerReviewSnap = await db.collection('users').doc(String(acceptedApp?.workerId))
    .collection('reviews').orderBy('createdAt', 'desc').limit(1).get();
  if (!workerReviewSnap.empty) {
    const r = workerReviewSnap.docs[0].data();
    const stars = n => '⭐'.repeat(n) + '☆'.repeat(5 - n);
    workerReviewText = `\n💬 *Worker review:*\n${stars(r.stars)} _"${r.comment}"_ — ${r.fromName}`;
  }

  // Fetch latest poster review left by worker
  let posterReviewText = '';
  const posterReviewSnap = await db.collection('users').doc(String(job.posterId))
    .collection('reviews').orderBy('createdAt', 'desc').limit(1).get();
  if (!posterReviewSnap.empty) {
    const r = posterReviewSnap.docs[0].data();
    const stars = n => '⭐'.repeat(n) + '☆'.repeat(5 - n);
    posterReviewText = `\n💬 *Customer review:*\n${stars(r.stars)} _"${r.comment}"_ — ${r.fromName}`;
  }

  const workerRatingDisplay = workerRating > 0 ? `⭐ ${(workerRating / workerRatingCount).toFixed(1)} · ${workerRatingCount} reviews` : '⭐ New';
  const posterRatingDisplay = posterRating > 0 ? `⭐ ${(posterRating / posterRatingCount).toFixed(1)} · ${posterRatingCount} reviews` : '⭐ New';

  const text =
    `✅ *HUSTLE COMPLETED!*\n\n` +
    `🔨 *${escapeMarkdown(job.title)}* — ${escapeMarkdown(job.location)}\n\n` +
    `💰 KES ${job.pay} earned by *${workerName}*\n` +
    `${workerRatingDisplay}` + (workerCompletedJobs > 0 ? ` · ${workerCompletedJobs} jobs done` : '') + `\n\n` +
    `👤 Posted by ${escapeMarkdown(job.posterName)}\n` +
    `${posterRatingDisplay}\n` + (posterTotalSpent > 0 ? `💸 KES ${posterTotalSpent.toLocaleString()} · paid to real people in Nairobi\n` : '') +
    workerReviewText +
    posterReviewText +
    `\n\n🤝 Another hustle done in Nairobi!\n` +
    `⏳ Removed on ${deleteTime}`;

  if (job.video || (job.photos && job.photos.length >= 1)) {
    bot.editMessageCaption(text, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown' }).catch(() => {});
  } else {
    bot.editMessageText(text, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown' }).catch(() => {});
  }
}

// ─── Cleanup expired done jobs ─────────────────────────────────────────────────
async function cleanupExpiredJobs() {
  console.log('🧹 cleanupExpiredJobs running...');
  try {
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    // 1. Clean up done jobs with deleteAt
    const doneSnap = await db.collection('jobs')
      .where('status', '==', 'done')
      .where('deleteAt', '<=', now)
      .get();

    if (!doneSnap.empty) {
      console.log(`🧹 Cleaning up ${doneSnap.size} expired done job(s)...`);
      for (const doc of doneSnap.docs) {
        const job = doc.data();
        if (job.channelMsgId) {
          try {
            await bot.deleteMessage(CHANNEL_ID, job.channelMsgId);
          } catch (e) {
            const alreadyGone = e.message && (e.message.includes('message to delete not found') || e.message.includes('MESSAGE_ID_INVALID'));
            if (!alreadyGone) {
              console.error(`❌ Failed to delete channel post for "${job.title}" (msgId: ${job.channelMsgId}): ${e.message}`);
              await doc.ref.update({ channelDeleteFailed: true }).catch(() => {});
              continue; // leave Firestore record intact so we retry next cycle
            }
            // already deleted from channel — proceed to clean up Firestore
          }
        }
        const appsSnap = await db.collection('applications').where('jobId', '==', String(job.id)).get();
        for (const appDoc of appsSnap.docs) await appDoc.ref.delete().catch(() => {});
        await doc.ref.delete();
        if (job.channelMsgId) await db.collection('channelPosts').doc(String(job.channelMsgId)).delete().catch(() => {});
        console.log(`✅ Deleted expired done job: ${job.title}`);
      }
    }

    // 2. Auto-expire open jobs older than 30 days
    const openSnap = await db.collection('jobs')
      .where('status', '==', 'open')
      .where('createdAt', '<=', thirtyDaysAgo)
      .get();

    if (!openSnap.empty) {
      console.log(`🧹 Auto-expiring ${openSnap.size} open job(s) older than 30 days...`);
      for (const doc of openSnap.docs) {
        const job = doc.data();
        if (job.channelMsgId) await bot.deleteMessage(CHANNEL_ID, job.channelMsgId).catch(() => {});
        const appsSnap = await db.collection('applications').where('jobId', '==', String(job.id)).get();
        for (const appDoc of appsSnap.docs) await appDoc.ref.delete().catch(() => {});
        await doc.ref.delete();
        // Notify poster
        bot.sendMessage(job.posterId,
          `⏰ *Job Expired*\n\nYour job *${escapeMarkdown(job.title)}* (KES ${job.pay}) has been automatically removed after 30 days with no worker found.\n\nFeel free to post it again if you still need help!`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        console.log(`✅ Auto-expired open job: ${job.title}`);
      }
    }

    // 3. Auto-expire taken jobs older than 30 days
    const takenSnap = await db.collection('jobs')
      .where('status', '==', 'taken')
      .where('createdAt', '<=', thirtyDaysAgo)
      .get();

    if (!takenSnap.empty) {
      console.log(`🧹 Auto-expiring ${takenSnap.size} taken job(s) older than 30 days...`);
      for (const doc of takenSnap.docs) {
        const job = doc.data();
        const appsSnap = await db.collection('applications').where('jobId', '==', String(job.id)).get();
        const acceptedApp = appsSnap.docs.map(d => d.data()).find(a => a.status === 'accepted');
        // Update job status to done
        const deleteAt = Date.now() + 24 * 60 * 60 * 1000;
        await doc.ref.update({ status: 'done', deleteAt });
        if (job.channelMsgId) await bot.deleteMessage(CHANNEL_ID, job.channelMsgId).catch(() => {});
        // Notify both sides
        bot.sendMessage(job.posterId,
          `⏰ *Job Auto-Closed*\n\nYour job *${escapeMarkdown(job.title)}* has been automatically closed after 30 days. Please leave a review if you haven't already.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        if (acceptedApp) {
          bot.sendMessage(acceptedApp.workerId,
            `⏰ *Job Auto-Closed*\n\n*${escapeMarkdown(job.title)}* has been automatically closed after 30 days. Please leave a review if you haven't already.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
          updateUserPin(acceptedApp.workerId, true).catch(() => {});
        }
        updateUserPin(job.posterId, true).catch(() => {});
        console.log(`✅ Auto-expired taken job: ${job.title}`);
      }
    }

    // 4. Clean up cancelled jobs with deleteAt
    const cancelledSnap = await db.collection('jobs')
      .where('status', '==', 'cancelled')
      .where('deleteAt', '<=', now)
      .get();

    if (!cancelledSnap.empty) {
      console.log(`🧹 Cleaning up ${cancelledSnap.size} expired cancelled job(s)...`);
      for (const doc of cancelledSnap.docs) {
        const job = doc.data();
        if (job.channelMsgId) {
          try {
            await bot.deleteMessage(CHANNEL_ID, job.channelMsgId);
          } catch (e) {
            const alreadyGone = e.message && (e.message.includes('message to delete not found') || e.message.includes('MESSAGE_ID_INVALID'));
            if (!alreadyGone) {
              console.error(`❌ Failed to delete channel post for "${job.title}" (msgId: ${job.channelMsgId}): ${e.message}`);
              await doc.ref.update({ channelDeleteFailed: true }).catch(() => {});
              continue;
            }
          }
        }
        const appsSnap = await db.collection('applications').where('jobId', '==', String(job.id)).get();
        for (const appDoc of appsSnap.docs) await appDoc.ref.delete().catch(() => {});
        await doc.ref.delete();
        if (job.channelMsgId) await db.collection('channelPosts').doc(String(job.channelMsgId)).delete().catch(() => {});
        console.log(`✅ Deleted expired cancelled job: ${job.title}`);
      }
    }

    // 5. Safety net — scan channelPosts for orphaned channel messages
    // Catches cases where Firestore job was deleted but channel message wasn't
    const channelPostsSnap = await db.collection('channelPosts').get();
    if (!channelPostsSnap.empty) {
      for (const doc of channelPostsSnap.docs) {
        const cp = doc.data();
        const job = await getJob(cp.jobId).catch(() => null);
        const jobGone   = !job;
        const jobExpired = job && job.status === 'done' && job.deleteAt && job.deleteAt <= now;
        if (jobGone || jobExpired) {
          try {
            await bot.deleteMessage(CHANNEL_ID, cp.channelMsgId);
            console.log(`✅ Safety net deleted channel post for "${cp.jobTitle}" (msgId: ${cp.channelMsgId})`);
          } catch (e) {
            const alreadyGone = e.message && (e.message.includes('message to delete not found') || e.message.includes('MESSAGE_ID_INVALID'));
            if (!alreadyGone) {
              console.error(`❌ Safety net failed for "${cp.jobTitle}": ${e.message}`);
              bot.sendMessage(ADMIN_ID,
                `⚠️ *Stuck channel post*

Job: *${escapeMarkdown(cp.jobTitle)}*
Msg ID: ${cp.channelMsgId}

Please delete manually from @husssleke.`,
                { parse_mode: 'Markdown' }
              ).catch(() => {});
              continue;
            }
          }
          await doc.ref.delete();
        }
      }
    }

    // 6. Retry previously failed channel deletes
    const failedSnap = await db.collection('jobs')
      .where('channelDeleteFailed', '==', true)
      .get();

    if (!failedSnap.empty) {
      console.log(`🔁 Retrying ${failedSnap.size} failed channel delete(s)...`);
      for (const doc of failedSnap.docs) {
        const job = doc.data();
        if (!job.channelMsgId) {
          await doc.ref.update({ channelDeleteFailed: false }).catch(() => {});
          continue;
        }
        try {
          await bot.deleteMessage(CHANNEL_ID, job.channelMsgId);
          await doc.ref.update({ channelDeleteFailed: false, channelMsgId: null });
          console.log(`✅ Retry succeeded for "${job.title}"`);
          // If the job itself is also expired, clean it up now
          if (job.deleteAt && job.deleteAt <= Date.now()) {
            const appsSnap = await db.collection('applications').where('jobId', '==', String(job.id)).get();
            for (const appDoc of appsSnap.docs) await appDoc.ref.delete().catch(() => {});
            await doc.ref.delete();
            console.log(`✅ Cleaned up Firestore for "${job.title}" after retry`);
          }
        } catch (e) {
          const alreadyGone = e.message && (e.message.includes('message to delete not found') || e.message.includes('MESSAGE_ID_INVALID'));
          if (alreadyGone) {
            await doc.ref.update({ channelDeleteFailed: false, channelMsgId: null }).catch(() => {});
            console.log(`✅ Channel post for "${job.title}" already gone — cleared flag`);
          } else {
            console.error(`❌ Retry failed for "${job.title}": ${e.message}`);
            // Notify admin if it keeps failing
            bot.sendMessage(ADMIN_ID,
              `⚠️ *Channel delete still failing*

Job: *${escapeMarkdown(job.title)}*
Msg ID: ${job.channelMsgId}
Error: ${e.message}

May need manual deletion from @husssleke.`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          }
        }
      }
    }

  } catch (e) {
    console.error('cleanupExpiredJobs error:', e.stack || e.message);
  }
}

async function sendChannelWelcome() {
  try {
    const chat = await bot.getChat(CHANNEL_ID);
    if (chat.pinned_message) return; // Already has a pinned message
    const msg = await bot.sendMessage(CHANNEL_ID,
      `🤖 *Welcome to Husssle Nairobi!*\n\nThe hustle marketplace for Nairobi.\nFind work or find someone to do the job. Simple.\n\n✅ New hustles are posted here automatically.\nTo apply — tap the button under the post.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '➕ Post a hustle', url: 'https://t.me/nbohussle_bot?start=post' }]] } }
    );
    await bot.pinChatMessage(CHANNEL_ID, msg.message_id, { disable_notification: true }).catch(() => {});
    console.log('✅ Channel welcome message sent!');
  } catch (e) {
    console.error('Channel welcome error:', e.message);
  }
}
sendChannelWelcome();

// Stop polling immediately when Railway replaces this deploy (prevents 409 fights)
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — stopping polling...');
  try { await bot.stopPolling(); } catch (e) {}
  process.exit(0);
});

// Heartbeat — if these go missing in Railway logs, the log pipeline itself is dropping data
setInterval(() => console.log(`[HB] alive ${new Date().toISOString()}`), 60 * 1000);

console.log('🤖 Husssle bot is running with Firestore...');

// Set commands for regular users
bot.setMyCommands([
  { command: 'menu',  description: 'Main menu' },
  { command: 'work',  description: 'My active hustles' },
  { command: 'post',  description: 'Post a new hustle' },
  { command: 'rules', description: 'View the rules' },
]).then(() => console.log('✅ Commands set!')).catch(console.error);

// Set extra commands for admin only
bot.setMyCommands([
  { command: 'menu',   description: 'Main menu' },
  { command: 'work',   description: 'My active hustles' },
  { command: 'post',   description: 'Post a new hustle' },
  { command: 'rules',  description: 'View the rules' },
  { command: 'banned', description: 'View banned users' },
  { command: 'admin',  description: 'All jobs (admin)' },
], { scope: { type: 'chat', chat_id: 889114803 } }).then(() => console.log('✅ Admin commands set!')).catch(console.error);

// Run cleanup on startup + every 30 minutes
cleanupExpiredJobs();
setInterval(cleanupExpiredJobs, 30 * 60 * 1000);

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.stack || err.message);
});
