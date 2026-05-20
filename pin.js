const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot('8859549243:AAGRjjRjTWWr7P-Zx11Y85qQFS-ueTh2agQ', {});
bot.sendMessage('@husssleke',
  '👷 *Welcome to Husssle!*\n\nThe hustle marketplace for Nairobi.\n\n✅ Browse jobs below\n➕ Post a job anytime\n💰 Agree on price, get it done\n\nLets hustle! 🇰🇪',
  { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '➕ Post a hustle', url: 'https://t.me/nbohussle_bot?start=post' }]]}})
.then(msg => { bot.pinChatMessage('@husssleke', msg.message_id); console.log('Done!'); })
.catch(console.error);