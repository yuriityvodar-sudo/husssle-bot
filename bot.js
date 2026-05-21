/**
 * Husssle Bot — MVP
 * Telegram job marketplace for Nairobi
 */

const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const CHANNEL_ID = '@husssleke';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── In-memory store ──────────────────────────────────────────────────────────
const users = {};
const jobs = [];
let jobCounter = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUser(from) {
  if (!users[from.id]) {
    users[from.id] = {
      id: from.id,
      name: [from.first_name, from.last_name].filter(Boolean).join(' '),
      username: from.username || null,
      phone: null,
      rating: 0,
      ratingCount: 0,
    };
  }
  return users[from.id];
}

function getRatingStars(user) {
  if (!user.ratingCount) return '⭐ New';
  const avg = (user.rating / user.ratingCount).toFixed(1);
  return `⭐ ${avg} (${user.ratingCount} reviews)`;
}

function getJobStatus(job) {
  if (job.status === 'open')  return '🟢 Open';
  if (job.status === 'taken') return '🟡 Taken';
  if (job.status === 'done')  return '✅ Done';
  return job.status;
}

function formatChannelPost(job, poster) {
  return (
    `💼 *${job.title}*\n\n` +
    `📝 ${job.description}\n\n` +
    `💰 *KES ${job.pay}*\n` +
    `📍 ${job.location}\n\n` +
    `👤 Posted by: ${poster.name} — ${getRatingStars(poster)}\n` +
    `📌 Status: ${getJobStatus(job)}\n` +
    `🆔 Job: #${job.id}`
  );
}

const sessions = {};
function getSession(userId) {
  if (!sessions[userId]) sessions[userId] = { step: null, draft: {} };
  return sessions[userId];
}
function clearSession(userId) {
  sessions[userId] = { step: null, draft: {} };
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: '📋 Browse hustles',   callback_data: 'browse' }],
      [{ text: '➕ Post a hustle',    callback_data: 'post_start' }],
      [{ text: '📬 My applications',  callback_data: 'my_applications' }],
      [{ text: '📌 My posted jobs',   callback_data: 'my_jobs' }],
    ]
  };
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s(.+))?/, (msg, match) => {
  getUser(msg.from);
  const param = match[1];

  if (param === 'post') {
    startPostFlow(msg.chat.id, msg.from.id);
    return;
  }

  if (param && param.startsWith('apply_')) {
    const jobId = parseInt(param.replace('apply_', ''));
    showJobDetail(msg.chat.id, msg.from.id, jobId);
    return;
  }

  bot.sendMessage(msg.chat.id,
    `👋 *Karibu Husssle!*\n\nThe hustle marketplace for Nairobi.\nFind work or get work done. Simple.\n\nWhat do you want to do?`,
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );
});

bot.onText(/\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Main menu:', { reply_markup: mainMenu() });
});

// ─── Callback query handler ───────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const userId = query.from.id;
  const data   = query.data;
  const user   = getUser(query.from);

  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'browse') { showJobList(chatId); return; }

  if (data.startsWith('view_job_')) {
    showJobDetail(chatId, userId, parseInt(data.replace('view_job_', '')));
    return;
  }

  if (data.startsWith('apply_')) {
    const jobId = parseInt(data.replace('apply_', ''));
    const job   = jobs.find(j => j.id === jobId);
    if (!job) { bot.sendMessage(chatId, '❌ Job not found.'); return; }
    if (job.posterId === userId) { bot.sendMessage(chatId, "⚠️ You can't apply to your own hustle."); return; }
    if (job.status !== 'open')  { bot.sendMessage(chatId, "⚠️ This hustle is no longer open."); return; }
    if (job.applications.some(a => a.workerId === userId)) {
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
    submitApplication(chatId, userId, jobId);
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
    const myApps = jobs.filter(j => j.applications.some(a => a.workerId === userId));
    if (!myApps.length) {
      bot.sendMessage(chatId,
        `📬 *Your Applications*\n\nYou haven't applied to any hustles yet.`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 Browse hustles', callback_data: 'browse' }]] } }
      );
      return;
    }
    let text = `📬 *Your Applications* (${myApps.length})\n\n`;
    myApps.forEach((j, i) => {
      const app = j.applications.find(a => a.workerId === userId);
      const statusLabel = app.status === 'accepted' ? '✅ Accepted' : app.status === 'rejected' ? '❌ Rejected' : '⏳ Pending';
      text += `${i+1}. *${j.title}*\nKES ${j.pay} · ${j.location}\n${statusLabel}\n\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '← Menu', callback_data: 'menu_back' }]] } });
    return;
  }

  if (data === 'my_jobs') {
    const myJobs = jobs.filter(j => j.posterId === userId);
    if (!myJobs.length) {
      bot.sendMessage(chatId,
        `📌 *Your Posted Hustles*\n\nYou haven't posted anything yet.`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '➕ Post a hustle', callback_data: 'post_start' }]] } }
      );
      return;
    }
    const buttons = myJobs.map(j => ([{ text: `${getJobStatus(j)} ${j.title} — KES ${j.pay}`, callback_data: `manage_job_${j.id}` }]));
    buttons.push([{ text: '← Menu', callback_data: 'menu_back' }]);
    bot.sendMessage(chatId, `📌 *Your Posted Hustles* (${myJobs.length})\n\nTap a job to manage it:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
    return;
  }

  if (data.startsWith('manage_job_')) {
    showManageJob(chatId, userId, parseInt(data.replace('manage_job_', '')));
    return;
  }

  if (data.startsWith('view_applicants_')) {
    showApplicants(chatId, userId, parseInt(data.replace('view_applicants_', '')));
    return;
  }

  if (data.startsWith('accept_')) {
    const parts    = data.split('_');
    const jobId    = parseInt(parts[1]);
    const workerId = parseInt(parts[2]);
    acceptApplicant(chatId, userId, jobId, workerId);
    return;
  }

  if (data.startsWith('mark_done_')) {
    const jobId = parseInt(data.replace('mark_done_', ''));
    const job   = jobs.find(j => j.id === jobId);
    if (!job || job.posterId !== userId) return;
    job.status = 'done';
    updateChannelPost(job);
    const acceptedApp = job.applications.find(a => a.status === 'accepted');
    if (acceptedApp) {
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
    if (users[wId]) { users[wId].rating += stars; users[wId].ratingCount += 1; }
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    bot.sendMessage(chatId, `⭐ Thanks! You gave ${stars} star${stars > 1 ? 's' : ''}.`, { reply_markup: mainMenu() });
    return;
  }

  if (data.startsWith('rate_poster_')) {
    const parts = data.split('_');
    const stars = parseInt(parts[parts.length - 1]);
    const pId   = parseInt(parts[3]);
    if (users[pId]) { users[pId].rating += stars; users[pId].ratingCount += 1; }
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    bot.sendMessage(chatId, `⭐ Thanks! You gave ${stars} star${stars > 1 ? 's' : ''}.`, { reply_markup: mainMenu() });
    return;
  }

  // ── Photo flow callbacks ──
  if (data === 'post_skip_photo' || data === 'post_photos_done') {
    const s = getSession(userId);
    if (s.step !== 'post_photo') return;
    if (!s.draft.photos) s.draft.photos = [];
    publishJob(chatId, userId, s.draft);
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
  const user   = getUser(msg.from);
  if (!s.step) return;

  const text = msg.text ? msg.text.trim() : '';

  if (s.step === 'collect_phone') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type your phone number.'); return; }
    user.phone = text;
    const jobId = s.draft.pendingJobId;
    clearSession(userId);
    submitApplication(chatId, userId, jobId);
    return;
  }

  if (s.step === 'collect_phone_for_post') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type your phone number.'); return; }
    user.phone = text;
    clearSession(userId);
    startPostFlow(chatId, userId);
    return;
  }

  if (s.step === 'post_title') {
    if (!text) { bot.sendMessage(chatId, '⚠️ Please type a title.'); return; }
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
    s.draft.photos = [];
    s.step = 'post_photo';
    bot.sendMessage(chatId,
      `✅ *Location:* ${text}\n\n📷 *Send photos of the job!*\n\nYou can send up to 5 photos one by one.\nWhen done tap *DONE* or type SKIP for no photos.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ DONE — post now', callback_data: 'post_photos_done' }],
        [{ text: 'SKIP — no photos',  callback_data: 'post_skip_photo' }],
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
        bot.sendMessage(chatId, `✅ ${count} photos added! Posting your hustle now...`);
        publishJob(chatId, userId, s.draft);
        clearSession(userId);
      } else {
        bot.sendMessage(chatId,
          `✅ Photo ${count} added! Send another or tap DONE.`,
          { reply_markup: { inline_keyboard: [[{ text: `✅ DONE (${count} photo${count>1?'s':''})`, callback_data: 'post_photos_done' }]] } }
        );
      }
    } else if (text.toLowerCase() === 'skip') {
      s.draft.photos = [];
      publishJob(chatId, userId, s.draft);
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
    `➕ *Post a Hustle*\n\nStep 1 of 4\n\n*What's the job title?*\n_e.g. Wall painting, Laptop repair, Catering_`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
  );
}

function submitApplication(chatId, userId, jobId) {
  const job  = jobs.find(j => j.id === jobId);
  const user = users[userId];
  if (!job) { bot.sendMessage(chatId, '❌ Job not found.'); return; }

  job.applications.push({
    workerId:       userId,
    workerName:     user.name,
    workerPhone:    user.phone,
    workerUsername: user.username,
    rating:         user.rating,
    ratingCount:    user.ratingCount,
    status:         'pending',
    appliedAt:      Date.now(),
  });

  bot.sendMessage(job.posterId,
    `🔔 *New application on your hustle!*\n\nJob: *${job.title}*\nApplicant: ${user.name} — ${getRatingStars(user)}\nTotal applicants: ${job.applications.length}\n\nTap to review:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '👥 Review applicants', callback_data: `view_applicants_${jobId}` }]] } }
  ).catch(() => {});

  bot.sendMessage(chatId,
    `✅ *Application sent!*\n\n*${job.title}*\nKES ${job.pay} · ${job.location}\n\nThe poster will review and get back to you. Good luck! 🤞`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 Browse more', callback_data: 'browse' }], [{ text: '📬 My applications', callback_data: 'my_applications' }]] } }
  );
}

function publishJob(chatId, userId, draft) {
  const user = users[userId];
  const job  = {
    id:           jobCounter++,
    title:        draft.title,
    description:  draft.description,
    pay:          draft.pay,
    location:     draft.location,
    photos:       draft.photos || [],
    posterId:     userId,
    posterName:   user.name,
    status:       'open',
    applications: [],
    channelMsgId: null,
    createdAt:    Date.now(),
  };
  jobs.push(job);

  bot.sendMessage(chatId,
    `🎉 *Hustle posted!*\n\n*${job.title}*\nKES ${job.pay} · ${job.location}\n\nYour hustle is now live in the channel!`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📌 Manage my jobs', callback_data: 'my_jobs' }], [{ text: '← Menu', callback_data: 'menu_back' }]] } }
  );

  const caption   = formatChannelPost(job, user);
  const applyUrl  = `https://t.me/nbohussle_bot?start=apply_${job.id}`;
  const keyboard  = { inline_keyboard: [[{ text: "✋ I'll do it!", url: applyUrl }]] };

  if (job.photos.length === 0) {
    bot.sendMessage(CHANNEL_ID, caption, { parse_mode: 'Markdown', reply_markup: keyboard })
      .then(sent => { job.channelMsgId = sent.message_id; })
      .catch(e => console.log('Channel post error:', e.message));
  } else if (job.photos.length === 1) {
    bot.sendPhoto(CHANNEL_ID, job.photos[0], { caption, parse_mode: 'Markdown', reply_markup: keyboard })
      .then(sent => { job.channelMsgId = sent.message_id; })
      .catch(e => console.log('Channel post error:', e.message));
  } else {
    const mediaGroup = job.photos.map((photoId, i) => ({
      type: 'photo',
      media: photoId,
      ...(i === 0 ? { caption, parse_mode: 'Markdown' } : {})
    }));
    bot.sendMediaGroup(CHANNEL_ID, mediaGroup)
      .then(msgs => { job.channelMsgId = msgs[0].message_id; })
      .catch(e => console.log('Channel post error:', e.message));
  }
}

function showJobList(chatId) {
  const openJobs = jobs.filter(j => j.status === 'open');
  if (!openJobs.length) {
    bot.sendMessage(chatId,
      `📋 *Available Hustles*\n\nNo open hustles right now. Be the first to post one!`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '➕ Post a hustle', callback_data: 'post_start' }]] } }
    );
    return;
  }
  const buttons = openJobs.slice(0, 10).map(j => ([{ text: `${j.title} — KES ${j.pay} · ${j.location}`, callback_data: `view_job_${j.id}` }]));
  buttons.push([{ text: '➕ Post a hustle', callback_data: 'post_start' }]);
  bot.sendMessage(chatId,
    `📋 *Open Hustles* (${openJobs.length})\n\nTap any hustle to see details and apply:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

function showJobDetail(chatId, userId, jobId) {
  const job    = jobs.find(j => j.id === jobId);
  if (!job) { bot.sendMessage(chatId, '❌ Hustle not found.'); return; }
  const poster = users[job.posterId] || { name: job.posterName, rating: 0, ratingCount: 0 };
  const alreadyApplied = job.applications.some(a => a.workerId === userId);
  const isOwner        = job.posterId === userId;

  let buttons = [];
  if (!isOwner && !alreadyApplied && job.status === 'open') buttons.push([{ text: "✋ I'll do it!", callback_data: `apply_${jobId}` }]);
  if (alreadyApplied) buttons.push([{ text: '✅ Already applied', callback_data: 'noop' }]);
  if (isOwner)        buttons.push([{ text: '⚙️ Manage this hustle', callback_data: `manage_job_${jobId}` }]);
  buttons.push([{ text: '← Back to list', callback_data: 'browse' }]);

  const text =
    `💼 *${job.title}*\n\n` +
    `📝 ${job.description}\n\n` +
    `💰 *KES ${job.pay}*\n` +
    `📍 ${job.location}\n` +
    `📌 ${getJobStatus(job)}\n` +
    `👤 ${poster.name} — ${getRatingStars(poster)}\n` +
    `👥 ${job.applications.length} applicant(s)`;

  if (job.photos && job.photos.length > 0) {
    bot.sendPhoto(chatId, job.photos[0], { caption: text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  }
}

function showManageJob(chatId, userId, jobId) {
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.posterId !== userId) return;

  const buttons = [];
  if (job.applications.length) buttons.push([{ text: `👥 View applicants (${job.applications.length})`, callback_data: `view_applicants_${jobId}` }]);
  if (job.status === 'taken')  buttons.push([{ text: '✅ Mark as Done', callback_data: `mark_done_${jobId}` }]);
  buttons.push([{ text: '← My jobs', callback_data: 'my_jobs' }]);

  bot.sendMessage(chatId,
    `⚙️ *Manage: ${job.title}*\n\nStatus: ${getJobStatus(job)}\nApplicants: ${job.applications.length}\nPay: KES ${job.pay}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

function showApplicants(chatId, userId, jobId) {
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.posterId !== userId) return;

  if (!job.applications.length) {
    bot.sendMessage(chatId, 'No applications yet.', { reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `manage_job_${jobId}` }]] } });
    return;
  }
  const pending = job.applications.filter(a => a.status === 'pending');
  if (!pending.length) {
    bot.sendMessage(chatId, '✅ You have already accepted an applicant.', { reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: `manage_job_${jobId}` }]] } });
    return;
  }

  let text = `👥 *Applicants for "${job.title}"*\n\n`;
  pending.forEach((a, i) => {
    const stars = a.ratingCount ? `⭐ ${(a.rating / a.ratingCount).toFixed(1)}` : '⭐ New';
    text += `${i+1}. *${a.workerName}* — ${stars}\n📱 ${a.workerPhone}\n\n`;
  });
  text += 'Tap to accept:';

  const buttons = pending.map(a => ([{ text: `✅ Accept ${a.workerName}`, callback_data: `accept_${jobId}_${a.workerId}` }]));
  buttons.push([{ text: '← Back', callback_data: `manage_job_${jobId}` }]);
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

function acceptApplicant(chatId, posterId, jobId, workerId) {
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.posterId !== posterId) return;
  const app = job.applications.find(a => a.workerId === workerId);
  if (!app) return;

  job.applications.forEach(a => { a.status = a.workerId === workerId ? 'accepted' : 'rejected'; });
  job.status = 'taken';
  updateChannelPost(job);

  const poster = users[posterId];

  bot.sendMessage(chatId,
    `✅ *You accepted ${app.workerName}!*\n\n📱 Their phone: *${app.workerPhone}*\n\nContact them to arrange the work. Once done, mark the job as Done.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Mark as Done later', callback_data: `manage_job_${jobId}` }]] } }
  );

  bot.sendMessage(workerId,
    `🎉 *You got the hustle!*\n\nJob: *${job.title}*\nPay: KES ${job.pay} · ${job.location}\n\n📱 Customer: *${poster ? poster.name : 'Customer'}*\nPhone: *${poster ? poster.phone : 'N/A'}*\n\nThey will contact you. Good luck! 💪`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});

  job.applications.filter(a => a.status === 'rejected').forEach(a => {
    bot.sendMessage(a.workerId,
      `ℹ️ Unfortunately, someone else was selected for *${job.title}*.\n\nKeep hustling! 💪`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });
}

function updateChannelPost(job) {
  if (!job.channelMsgId) return;
  const poster  = users[job.posterId] || { name: job.posterName, rating: 0, ratingCount: 0 };
  const newText = formatChannelPost(job, poster);
  if (job.photos && job.photos.length > 0) {
    bot.editMessageCaption(newText, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown' }).catch(() => {});
  } else {
    bot.editMessageText(newText, { chat_id: CHANNEL_ID, message_id: job.channelMsgId, parse_mode: 'Markdown' }).catch(() => {});
  }
}

console.log('🤖 Husssle bot is running...');
