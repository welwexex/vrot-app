import { Request, Response, Express } from 'express';
import { Server } from 'socket.io';
import { pool } from './db.js';
import { decrypt, encrypt, randomToken, uuid } from './crypto.js';

interface LongPollWaiter {
  botId: string;
  offset: number;
  res: Response;
  timer: NodeJS.Timeout;
}

const longPollWaiters = new Set<LongPollWaiter>();
const botFatherStates = new Map<string, { step: string; tempName?: string; targetBotId?: string }>();

let cachedBotFatherId: string | null = null;
export async function getBotFatherId(): Promise<string> {
  if (cachedBotFatherId) return cachedBotFatherId;
  const q = await pool.query("SELECT id FROM users WHERE username_key = 'botfather'");
  if (q.rows[0]) {
    cachedBotFatherId = q.rows[0].id;
    return cachedBotFatherId as string;
  }
  const id = uuid();
  await pool.query(`
    INSERT INTO users (id, username, username_key, email, password_hash, birth_date, display_name, bio, is_bot, verified, status)
    VALUES ($1, 'BotFather', 'botfather', 'botfather@vrot.fun', '$argon2id$v=19$m=65536,t=3,p=1$fake$fake', '2000-01-01', 'BotFather', 'Официальный отец ботов VROT. Создание и управление ботами.', true, true, 'bot')
    ON CONFLICT (username_key) DO UPDATE SET is_bot = true, verified = true, status = 'bot'
  `, [id]);
  cachedBotFatherId = id;
  return id;
}

export async function findBotByToken(token: string) {
  if (!token) return null;
  const clean = token.trim();
  const q = await pool.query(
    'SELECT id, username, display_name, avatar_url, bio, is_bot, verified, bot_owner_id, bot_token FROM users WHERE bot_token = $1 AND is_bot = true AND deleted_at IS NULL',
    [clean]
  );
  return q.rows[0] || null;
}

export async function queueBotUpdate(botId: string, updateData: any) {
  try {
    const res = await pool.query(
      'INSERT INTO bot_updates (bot_id, update_data) VALUES ($1, $2) RETURNING id',
      [botId, JSON.stringify(updateData)]
    );
    const updateId = Number(res.rows[0].id);
    const fullUpdate = { update_id: updateId, ...updateData };
    await pool.query('UPDATE bot_updates SET update_data = $1 WHERE id = $2', [JSON.stringify(fullUpdate), updateId]);

    // Check long poll waiters
    for (const waiter of [...longPollWaiters]) {
      if (waiter.botId === botId && updateId >= waiter.offset) {
        clearTimeout(waiter.timer);
        longPollWaiters.delete(waiter);
        try {
          waiter.res.json({ ok: true, result: [fullUpdate] });
        } catch {}
      }
    }

    // Check webhook
    const wh = await pool.query('SELECT url, secret_token FROM bot_webhooks WHERE bot_id = $1', [botId]);
    if (wh.rows[0]?.url) {
      const url = wh.rows[0].url;
      const secret = wh.rows[0].secret_token;
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {})
        },
        body: JSON.stringify(fullUpdate)
      }).catch(err => console.error(`Webhook delivery error for bot ${botId}:`, err));
    }
  } catch (e) {
    console.error(`Failed to queue update for bot ${botId}:`, e);
  }
}

// Send DM from any bot to a user
export async function sendBotDm(io: Server, botId: string, recipientId: string, text: string, replyMarkup?: any) {
  const msgId = uuid();
  const markupJson = replyMarkup ? JSON.stringify(replyMarkup) : null;
  const enc = encrypt(text);

  await pool.query(
    'INSERT INTO direct_messages (id, sender_id, recipient_id, content_enc, reply_markup) VALUES ($1, $2, $3, $4, $5)',
    [msgId, botId, recipientId, enc, markupJson]
  );

  const botUserQ = await pool.query('SELECT id, username, display_name, avatar_url, verified FROM users WHERE id = $1', [botId]);
  const botUser = botUserQ.rows[0];

  const dto = {
    id: msgId,
    content: text,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    replyTo: null,
    reactions: [],
    replyMarkup: replyMarkup || undefined,
    author: {
      id: botId,
      username: botUser?.username || 'bot',
      avatarUrl: botUser?.avatar_url || null,
      verified: Boolean(botUser?.verified),
      isBot: true,
      donator: false,
      mrbeastBadge: false
    }
  };

  io.to(`user:${recipientId}`).emit('dm:created', { message: dto, recipientId });
  return { msgId, dto };
}

// Handle messages sent to BotFather
export async function handleBotFatherMessage(io: Server, userId: string, text: string) {
  const bfId = await getBotFatherId();
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const state = botFatherStates.get(userId);

  // Command: /start or /help
  if (lower === '/start' || lower === '/help') {
    botFatherStates.delete(userId);
    const replyText = `👋 Привет! Я **BotFather** — отец ботов мессенджера VROT.

Я помогу тебе создать нового бота, управлять его настройками и получить токен для Bot API.

🔹 **Доступные команды:**
/newbot — создать нового бота
/mybots — список твоих ботов и управление токенами
/help — это справочное сообщение

🚀 Боты VROT совместимы с библиотекой **aiogram** и Telegram Bot API!`;

    const markup = {
      inline_keyboard: [
        [
          { text: '➕ Создать нового бота', callback_data: 'bf_newbot' },
          { text: '🤖 Мои боты', callback_data: 'bf_mybots' }
        ],
        [
          { text: '📖 Документация и aiogram', callback_data: 'bf_docs' }
        ]
      ]
    };
    await sendBotDm(io, bfId, userId, replyText, markup);
    return;
  }

  // Command: /newbot
  if (lower === '/newbot') {
    botFatherStates.set(userId, { step: 'awaiting_name' });
    await sendBotDm(io, bfId, userId, `Хорошо, давайте создадим нового бота!\n\nКак мы его назовём? Отправьте отображаемое имя для вашего бота (например: **Мой Помощник**):`);
    return;
  }

  // Command: /mybots
  if (lower === '/mybots') {
    botFatherStates.delete(userId);
    await showMyBots(io, bfId, userId);
    return;
  }

  // State machine for /newbot
  if (state?.step === 'awaiting_name') {
    if (trimmed.length < 2 || trimmed.length > 64) {
      await sendBotDm(io, bfId, userId, `Имя должно быть длиной от 2 до 64 символов. Попробуйте ещё раз:`);
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_username', tempName: trimmed });
    await sendBotDm(io, bfId, userId, `Отлично! Теперь выберите юзернейм для вашего бота.\n\n⚠️ **Правило:** юзернейм обязан оканчиваться на **bot** (например: \`tetris_bot\` или \`HelperBot\`). Он может содержать только латинские буквы, цифры и знак подчеркивания:`);
    return;
  }

  if (state?.step === 'awaiting_username') {
    const rawUsername = trimmed;
    const lowerUser = rawUsername.toLowerCase();

    if (!lowerUser.endsWith('bot')) {
      await sendBotDm(io, bfId, userId, `❌ Юзернейм бота обязан заканчиваться на **bot** (например: \`${lowerUser}_bot\` или \`${lowerUser}bot\`).\nПопробуйте ещё раз:`);
      return;
    }

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(rawUsername)) {
      await sendBotDm(io, bfId, userId, `❌ Юзернейм должен содержать от 3 до 32 символов (только латинские буквы a-z, цифры 0-9 и подчеркивание).\nПопробуйте ещё раз:`);
      return;
    }

    // Check availability
    const check = await pool.query('SELECT id FROM users WHERE username_key = $1', [lowerUser]);
    if (check.rowCount) {
      await sendBotDm(io, bfId, userId, `❌ К сожалению, имя пользователя @${rawUsername} уже занято. Пожалуйста, придумайте другое:`);
      return;
    }

    // Create the bot!
    const newBotId = uuid();
    const token = `vrot_${randomToken(32)}`;
    const tempName = state.tempName || rawUsername;

    await pool.query(`
      INSERT INTO users (id, username, username_key, email, password_hash, birth_date, display_name, is_bot, bot_owner_id, bot_token, status, verified)
      VALUES ($1, $2, $3, $4, '$argon2id$fake', '2000-01-01', $5, true, $6, $7, 'bot', false)
    `, [newBotId, rawUsername, lowerUser, `${lowerUser}@bot.vrot.fun`, tempName, userId, token]);

    // Establish mutual friendship so bot appears in user's chat list
    await pool.query(`
      INSERT INTO friendships (requester_id, addressee_id, status)
      VALUES ($1, $2, 'accepted'), ($2, $1, 'accepted')
      ON CONFLICT DO NOTHING
    `, [userId, newBotId]);

    botFatherStates.delete(userId);

    const successMsg = `🎉 **Поздравляем! Ваш бот успешно создан!**

🤖 Имя: **${tempName}**
🔗 Юзернейм: @${rawUsername}

🔑 **Токен доступа к Bot API:**
\`${token}\`

⚠️ *Храните токен в тайне. Любой, у кого есть токен, может управлять ботом.*

📚 **Как подключить в Python с aiogram:**
\`\`\`python
from aiogram import Bot, Dispatcher
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer

session = AiohttpSession(
    api=TelegramAPIServer.from_base("https://vrot.fun")
)
bot = Bot(token="${token}", session=session)
dp = Dispatcher()
\`\`\``;

    const markup = {
      inline_keyboard: [
        [
          { text: `💬 Открыть чат с @${rawUsername}`, url: `/?dm=${newBotId}` },
          { text: '⚙️ Управление ботом', callback_data: `bf_bot_${newBotId}` }
        ]
      ]
    };

    await sendBotDm(io, bfId, userId, successMsg, markup);
    return;
  }

  // Default fallback
  await sendBotDm(io, bfId, userId, `Я не понял вашу команду. Отправьте /newbot, чтобы создать бота, или /mybots, чтобы увидеть список ваших ботов.`);
}

async function showMyBots(io: Server, bfId: string, userId: string) {
  const q = await pool.query(
    'SELECT id, username, display_name, bot_token, verified FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL ORDER BY created_at DESC',
    [userId]
  );
  if (!q.rows.length) {
    const markup = {
      inline_keyboard: [[{ text: '➕ Создать первого бота', callback_data: 'bf_newbot' }]]
    };
    await sendBotDm(io, bfId, userId, `У вас пока нет созданных ботов. Нажмите кнопку ниже или введите /newbot, чтобы создать своего первого бота:`, markup);
    return;
  }

  const buttons = q.rows.map(b => ([
    { text: `🤖 ${b.display_name} (@${b.username})${b.verified ? ' ✓' : ''}`, callback_data: `bf_bot_${b.id}` }
  ]));
  buttons.push([{ text: '➕ Создать ещё одного бота', callback_data: 'bf_newbot' }]);

  await sendBotDm(io, bfId, userId, `📋 **Ваши боты в VROT:**\nВыберите бота для просмотра настроек и токена:`, { inline_keyboard: buttons });
}

// Handle inline button callback for BotFather
export async function handleBotFatherCallback(io: Server, userId: string, callbackData: string) {
  const bfId = await getBotFatherId();

  if (callbackData === 'bf_newbot') {
    botFatherStates.set(userId, { step: 'awaiting_name' });
    await sendBotDm(io, bfId, userId, `Хорошо, давайте создадим нового бота!\n\nКак мы его назовём? Отправьте отображаемое имя для вашего бота (например: **Мой Помощник**):`);
    return;
  }

  if (callbackData === 'bf_mybots') {
    await showMyBots(io, bfId, userId);
    return;
  }

  if (callbackData === 'bf_docs') {
    const docs = `📚 **Документация Bot API для VROT**

Наш API полностью совместим с форматом **Telegram Bot API**! Это значит, что вы можете использовать любую популярную библиотеку:
- **Python:** \`aiogram\`, \`python-telegram-bot\`, \`telebot\`
- **Node.js:** \`telegraf\`, \`grammy\`

🌐 **Base API URL:** \`https://vrot.fun\` (или \`https://api.vrot.fun\`)

🔹 **Пример с aiogram 3.x:**
\`\`\`python
import asyncio
from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer

session = AiohttpSession(
    api=TelegramAPIServer.from_base("https://vrot.fun")
)
bot = Bot(token="ВАШ_ТОКЕН", session=session)
dp = Dispatcher()

@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    kb = types.InlineKeyboardMarkup(inline_keyboard=[
        [types.InlineKeyboardButton(text="Нажми меня!", callback_data="btn_click")]
    ])
    await message.answer("Привет из VROT!", reply_markup=kb)

@dp.callback_query()
async def cb_handler(query: types.CallbackQuery):
    await query.answer("Кнопка нажата!")
    await query.message.answer(f"Ты выбрал: {query.data}")

async def main():
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
\`\`\``;
    await sendBotDm(io, bfId, userId, docs, {
      inline_keyboard: [
        [{ text: '🤖 Мои боты', callback_data: 'bf_mybots' }, { text: '➕ Создать бота', callback_data: 'bf_newbot' }]
      ]
    });
    return;
  }

  if (callbackData.startsWith('bf_bot_')) {
    const botId = callbackData.replace('bf_bot_', '');
    const q = await pool.query(
      'SELECT id, username, display_name, bio, bot_token, verified, created_at FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true',
      [botId, userId]
    );
    const bot = q.rows[0];
    if (!bot) {
      await sendBotDm(io, bfId, userId, `Бот не найден или у вас нет доступа.`);
      return;
    }

    const info = `🤖 **Управление ботом @${bot.username}**

• **Имя:** ${bot.display_name}
• **Юзернейм:** @${bot.username}
• **Верификация:** ${bot.verified ? '✅ Подтверждён' : '❌ Обычный'}
• **Токен:** \`${bot.bot_token}\`

Выберите действие:`;

    const markup = {
      inline_keyboard: [
        [
          { text: '🔄 Сгенерировать новый токен', callback_data: `bf_token_${bot.id}` },
          { text: '💬 Открыть чат', url: `/?dm=${bot.id}` }
        ],
        [
          { text: '❌ Удалить этого бота', callback_data: `bf_del_${bot.id}` },
          { text: '🔙 Назад к списку', callback_data: 'bf_mybots' }
        ]
      ]
    };
    await sendBotDm(io, bfId, userId, info, markup);
    return;
  }

  if (callbackData.startsWith('bf_token_')) {
    const botId = callbackData.replace('bf_token_', '');
    const newToken = `vrot_${randomToken(32)}`;
    const q = await pool.query(
      'UPDATE users SET bot_token = $1 WHERE id = $2 AND bot_owner_id = $3 RETURNING username',
      [newToken, botId, userId]
    );
    if (q.rows[0]) {
      await sendBotDm(io, bfId, userId, `🔑 **Новый токен для @${q.rows[0].username}:**\n\`${newToken}\`\n\nСтарый токен аннулирован.`);
    }
    return;
  }

  if (callbackData.startsWith('bf_del_')) {
    const botId = callbackData.replace('bf_del_', '');
    const q = await pool.query(
      'UPDATE users SET deleted_at = now(), bot_token = NULL WHERE id = $1 AND bot_owner_id = $2 RETURNING username',
      [botId, userId]
    );
    if (q.rows[0]) {
      await sendBotDm(io, bfId, userId, `🗑️ Бот **@${q.rows[0].username}** успешно удалён.`);
      await showMyBots(io, bfId, userId);
    }
    return;
  }
}

// Setup all Bot API routes (compatible with aiogram & standard Telegram Bot API)
export function setupBotRoutes(app: Express, io: Server) {
  // Telegram Bot API paths: /bot:token/:method and /api/bot/:token/:method
  const botPaths = ['/bot:token/:method', '/api/bot/:token/:method', '/bot:token', '/api/bot/:token'];

  app.all(botPaths, async (req: Request, res: Response) => {
    let token: string = typeof req.params.token === 'string' ? req.params.token : '';
    let method: string = typeof req.params.method === 'string' ? req.params.method : '';

    // If method is part of URL or path
    if (!method && req.path.includes('/')) {
      const parts = req.path.split('/');
      method = parts[parts.length - 1];
    }

    const bot = await findBotByToken(token);
    if (!bot) {
      return res.status(401).json({ ok: false, error_code: 401, description: 'Unauthorized: Invalid bot token' });
    }

    const params = { ...req.query, ...req.body };

    try {
      switch (method.toLowerCase()) {
        case 'getme': {
          return res.json({
            ok: true,
            result: {
              id: bot.id,
              is_bot: true,
              first_name: bot.display_name || bot.username,
              username: bot.username,
              can_join_groups: true,
              can_read_all_group_messages: true,
              supports_inline_queries: false
            }
          });
        }

        case 'getupdates': {
          const offset = Number(params.offset || 0);
          const limit = Math.min(Number(params.limit || 100), 100);
          const timeout = Math.min(Number(params.timeout || 0), 45);

          // Fetch updates with id >= offset
          const q = await pool.query(
            'SELECT id, update_data FROM bot_updates WHERE bot_id = $1 AND id >= $2 ORDER BY id ASC LIMIT $3',
            [bot.id, offset, limit]
          );

          if (q.rows.length > 0 || timeout <= 0) {
            const updates = q.rows.map(r => {
              const data = typeof r.update_data === 'string' ? JSON.parse(r.update_data) : r.update_data;
              return { update_id: Number(r.id), ...data };
            });
            return res.json({ ok: true, result: updates });
          }

          // Long polling wait
          const waiter: LongPollWaiter = {
            botId: bot.id,
            offset,
            res,
            timer: setTimeout(() => {
              longPollWaiters.delete(waiter);
              res.json({ ok: true, result: [] });
            }, timeout * 1000)
          };
          longPollWaiters.add(waiter);
          return;
        }

        case 'sendmessage': {
          const chatId = String(params.chat_id || params.chatId || '');
          const text = String(params.text || '');
          const replyMarkup = params.reply_markup || params.replyMarkup;

          if (!chatId || !text) {
            return res.status(400).json({ ok: false, error_code: 400, description: 'chat_id and text are required' });
          }

          // Check if chatId is a user or channel
          // First check user
          const userQ = await pool.query('SELECT id, username FROM users WHERE id::text = $1 OR username_key = $2', [chatId, chatId.toLowerCase().replace('@', '')]);
          if (userQ.rows[0]) {
            const targetUserId = userQ.rows[0].id;
            const { msgId } = await sendBotDm(io, bot.id, targetUserId, text, replyMarkup);
            return res.json({
              ok: true,
              result: {
                message_id: msgId,
                from: {
                  id: bot.id,
                  is_bot: true,
                  first_name: bot.display_name || bot.username,
                  username: bot.username
                },
                chat: {
                  id: targetUserId,
                  type: 'private',
                  username: userQ.rows[0].username
                },
                date: Math.floor(Date.now() / 1000),
                text
              }
            });
          }

          // Otherwise check channel
          const chanQ = await pool.query('SELECT id, name, community_id FROM channels WHERE id::text = $1', [chatId]);
          if (chanQ.rows[0]) {
            const chan = chanQ.rows[0];
            const msgId = uuid();
            const markupJson = replyMarkup ? JSON.stringify(replyMarkup) : null;
            await pool.query(
              'INSERT INTO messages (id, channel_id, author_id, content_enc, reply_markup) VALUES ($1, $2, $3, $4, $5)',
              [msgId, chan.id, bot.id, encrypt(text), markupJson]
            );

            const msgDto = {
              id: msgId,
              content: text,
              created_at: new Date().toISOString(),
              edited_at: null,
              deleted_at: null,
              replyTo: null,
              reactions: [],
              replyMarkup: replyMarkup || undefined,
              author: {
                id: bot.id,
                username: bot.username,
                avatarUrl: bot.avatar_url || null,
                verified: Boolean(bot.verified),
                isBot: true,
                donator: false,
                mrbeastBadge: false
              }
            };
            io.to(`channel:${chan.id}`).emit('message:created', { channelId: chan.id, message: msgDto });

            return res.json({
              ok: true,
              result: {
                message_id: msgId,
                from: {
                  id: bot.id,
                  is_bot: true,
                  first_name: bot.display_name || bot.username,
                  username: bot.username
                },
                chat: {
                  id: chan.id,
                  type: 'channel',
                  title: chan.name
                },
                date: Math.floor(Date.now() / 1000),
                text
              }
            });
          }

          return res.status(404).json({ ok: false, error_code: 404, description: 'Chat not found' });
        }

        case 'editmessagetext': {
          const chatId = String(params.chat_id || '');
          const messageId = String(params.message_id || '');
          const text = String(params.text || '');
          const replyMarkup = params.reply_markup;

          if (!messageId || !text) {
            return res.status(400).json({ ok: false, error_code: 400, description: 'message_id and text are required' });
          }

          const enc = encrypt(text);
          const markupJson = replyMarkup ? JSON.stringify(replyMarkup) : null;

          // Try DM first
          const dmUp = await pool.query(
            'UPDATE direct_messages SET content_enc = $1, reply_markup = COALESCE($2, reply_markup) WHERE id = $3 AND sender_id = $4 RETURNING recipient_id',
            [enc, markupJson, messageId, bot.id]
          );
          if (dmUp.rows[0]) {
            io.to(`user:${dmUp.rows[0].recipient_id}`).emit('dm:edited', { messageId, content: text, replyMarkup });
            return res.json({ ok: true, result: true });
          }

          // Try channel message
          const chUp = await pool.query(
            'UPDATE messages SET content_enc = $1, edited_at = now(), reply_markup = COALESCE($2, reply_markup) WHERE id = $3 AND author_id = $4 RETURNING channel_id',
            [enc, markupJson, messageId, bot.id]
          );
          if (chUp.rows[0]) {
            io.to(`channel:${chUp.rows[0].channel_id}`).emit('message:edited', { channelId: chUp.rows[0].channel_id, messageId, content: text, replyMarkup });
            return res.json({ ok: true, result: true });
          }

          return res.status(404).json({ ok: false, error_code: 404, description: 'Message not found or not authored by this bot' });
        }

        case 'answercallbackquery': {
          // Acknowledges callback query
          return res.json({ ok: true, result: true });
        }

        case 'setwebhook': {
          const url = String(params.url || '');
          const secretToken = params.secret_token ? String(params.secret_token) : null;
          if (!url) {
            await pool.query('DELETE FROM bot_webhooks WHERE bot_id = $1', [bot.id]);
            return res.json({ ok: true, result: true, description: 'Webhook deleted' });
          }
          await pool.query(
            'INSERT INTO bot_webhooks (bot_id, url, secret_token) VALUES ($1, $2, $3) ON CONFLICT (bot_id) DO UPDATE SET url = EXCLUDED.url, secret_token = EXCLUDED.secret_token',
            [bot.id, url, secretToken]
          );
          return res.json({ ok: true, result: true, description: 'Webhook was set' });
        }

        case 'deletewebhook': {
          await pool.query('DELETE FROM bot_webhooks WHERE bot_id = $1', [bot.id]);
          return res.json({ ok: true, result: true });
        }

        case 'sendchataction': {
          return res.json({ ok: true, result: true });
        }

        default: {
          return res.status(400).json({ ok: false, error_code: 400, description: `Method '${method}' not implemented yet` });
        }
      }
    } catch (e: any) {
      console.error(`Bot API error (${method}):`, e);
      return res.status(500).json({ ok: false, error_code: 500, description: e.message || 'Internal server error' });
    }
  });

  // Client API endpoint: Trigger inline button click (from Web or iOS)
  app.post('/api/bots/callback', async (req: Request, res: Response) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Нужен вход' });

    const { messageId, callbackData } = req.body;
    if (!messageId || !callbackData) {
      return res.status(400).json({ error: 'messageId and callbackData required' });
    }

    // Find message author
    const dmMsg = await pool.query('SELECT id, sender_id, recipient_id, content_enc FROM direct_messages WHERE id = $1', [messageId]);
    let authorId: string | null = null;
    let decryptedContent = '';

    if (dmMsg.rows[0]) {
      authorId = dmMsg.rows[0].sender_id;
      try { decryptedContent = decrypt(dmMsg.rows[0].content_enc); } catch {}
    } else {
      const chMsg = await pool.query('SELECT id, author_id, content_enc FROM messages WHERE id = $1', [messageId]);
      if (chMsg.rows[0]) {
        authorId = chMsg.rows[0].author_id;
        try { decryptedContent = decrypt(chMsg.rows[0].content_enc); } catch {}
      }
    }

    if (!authorId) return res.status(404).json({ error: 'Message not found' });

    const bfId = await getBotFatherId();
    if (authorId === bfId) {
      // Handled by BotFather directly
      await handleBotFatherCallback(io, user.id, callbackData);
      return res.json({ ok: true });
    }

    // Check if author is a bot
    const botCheck = await pool.query('SELECT id, is_bot FROM users WHERE id = $1', [authorId]);
    if (botCheck.rows[0]?.is_bot) {
      const updateData = {
        callback_query: {
          id: `cb_${uuid().replace(/-/g, '')}`,
          from: {
            id: user.id,
            is_bot: false,
            first_name: user.display_name || user.username,
            username: user.username
          },
          message: {
            message_id: messageId,
            chat: { id: user.id, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: decryptedContent
          },
          data: callbackData
        }
      };
      await queueBotUpdate(authorId, updateData);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Message author is not a bot' });
  });

  // REST API: User's bots list
  app.get('/api/bots/my', async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Нужен вход' });
    const q = await pool.query(
      'SELECT id, username, display_name, avatar_url, bio, bot_token, verified, created_at FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({
      bots: q.rows.map(r => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name || r.username,
        avatarUrl: r.avatar_url,
        bio: r.bio || '',
        token: r.bot_token,
        verified: Boolean(r.verified),
        createdAt: r.created_at
      }))
    });
  });
}
