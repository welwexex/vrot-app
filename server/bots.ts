import { Request, Response, Express } from 'express';
import { Server } from 'socket.io';
import { pool } from './db.js';
import { decrypt, encrypt, randomToken, uuid, sha256 } from './crypto.js';

interface LongPollWaiter {
  botId: string;
  offset: number;
  res: Response;
  timer: NodeJS.Timeout;
}

const longPollWaiters = new Set<LongPollWaiter>();
const botFatherStates = new Map<string, { step: string; tempName?: string; targetBotId?: string }>();

export const BOTFATHER_DEFAULT_COMMANDS = [
  { command: 'start', description: 'Главное меню BotFather' },
  { command: 'newbot', description: 'Создать нового бота' },
  { command: 'mybots', description: 'Мои боты и управление' },
  { command: 'setdescription', description: 'Изменить описание (bio) бота' },
  { command: 'deldescription', description: 'Очистить описание бота' },
  { command: 'setname', description: 'Изменить отображаемое имя бота' },
  { command: 'setcommands', description: 'Настроить меню команд бота' },
  { command: 'delcommands', description: 'Очистить меню команд бота' },
  { command: 'setuserpic', description: 'Сменить аватарку бота' },
  { command: 'deluserpic', description: 'Удалить аватарку бота' },
  { command: 'setbanner', description: 'Сменить шапку бота' },
  { command: 'delbanner', description: 'Удалить шапку бота' },
  { command: 'token', description: 'Получить API токен бота' },
  { command: 'help', description: 'Справка и документация' },
  { command: 'cancel', description: 'Отменить текущее действие' },
];

export async function getAuthUser(req: Request) {
  if (req.user) return req.user;
  const cookie = (req as any).cookies?.vrot_session;
  const authHeader = req.headers.authorization;
  const token = cookie || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
  if (!token) return null;
  const q = await pool.query(
    `SELECT u.id, u.username, u.email, u.avatar_url, u.display_name, u.bio, u.banner_url, u.status, u.verified, u.donator, u.mrbeast_badge, u.admin_role, u.frozen_at, u.banned_at, u.ban_reason, u.is_bot FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND u.deleted_at IS NULL`,
    [sha256(token)]
  );
  return q.rows[0] || null;
}

let cachedBotFatherId: string | null = null;
export async function getBotFatherId(): Promise<string> {
  if (cachedBotFatherId) return cachedBotFatherId;
  const q = await pool.query("SELECT id FROM users WHERE username_key = 'botfather'");
  if (q.rows[0]) {
    cachedBotFatherId = q.rows[0].id;
    await pool.query(
      "UPDATE users SET bot_commands = $1, is_bot = true, verified = true, status = 'bot' WHERE id = $2",
      [JSON.stringify(BOTFATHER_DEFAULT_COMMANDS), cachedBotFatherId]
    ).catch(() => {});
    return cachedBotFatherId as string;
  }
  const id = uuid();
  await pool.query(`
    INSERT INTO users (id, username, username_key, email, password_hash, birth_date, display_name, bio, is_bot, verified, status, bot_commands)
    VALUES ($1, 'BotFather', 'botfather', 'botfather@vrot.fun', '$argon2id$v=19$m=65536,t=3,p=1$fake$fake', '2000-01-01', 'BotFather', 'Официальный отец ботов VROT. Создание и управление ботами.', true, true, 'bot', $2::jsonb)
    ON CONFLICT (username_key) DO UPDATE SET is_bot = true, verified = true, status = 'bot', bot_commands = $2::jsonb
  `, [id, JSON.stringify(BOTFATHER_DEFAULT_COMMANDS)]);
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

  const res = await pool.query(
    'INSERT INTO direct_messages (id, sender_id, recipient_id, content_enc, reply_markup) VALUES ($1, $2, $3, $4, $5) RETURNING created_at',
    [msgId, botId, recipientId, enc, markupJson]
  );
  const createdAt = res.rows[0]?.created_at ? new Date(res.rows[0].created_at).toISOString() : new Date().toISOString();

  const botUserQ = await pool.query('SELECT id, username, display_name, avatar_url, verified FROM users WHERE id = $1', [botId]);
  const botUser = botUserQ.rows[0];

  const dto = {
    id: msgId,
    content: text,
    created_at: createdAt,
    edited_at: null,
    deleted_at: null,
    replyTo: null,
    reactions: [],
    replyMarkup: replyMarkup || undefined,
    recipientId,
    author: {
      id: botId,
      username: botUser?.username || 'bot',
      displayName: botUser?.display_name || botUser?.username || 'Bot',
      avatarUrl: botUser?.avatar_url || null,
      verified: Boolean(botUser?.verified),
      isBot: true,
      donator: false,
      mrbeastBadge: false
    }
  };

  io.to(`user:${recipientId}`).emit('dm:new', dto);
  io.to(`user:${botId}`).emit('dm:new', dto);
  return { msgId, dto };
}

// Handle messages sent to BotFather
export async function handleBotFatherMessage(io: Server, userId: string, text: string, attachmentId?: string | null) {
  const bfId = await getBotFatherId();
  const trimmed = (text || '').trim();
  const lower = trimmed.toLowerCase();
  const state = botFatherStates.get(userId);

  // Command: /cancel or /stop
  if (lower === '/cancel' || lower === '/stop') {
    botFatherStates.delete(userId);
    await sendBotDm(io, bfId, userId, 'Действие отменено.', {
      inline_keyboard: [
        [{ text: 'Создать нового бота', callback_data: 'bf_newbot' }, { text: 'Мои боты', callback_data: 'bf_mybots' }]
      ]
    });
    return;
  }

  // Command: /start or /help
  if (lower === '/start' || lower === '/help') {
    botFatherStates.delete(userId);
    const replyText = `Привет! Я **BotFather** — официальный отец ботов мессенджера VROT.

Я помогу создать нового бота, настроить аватарку, шапку профиля, меню команд и получить API токен.

**Управление ботами:**
/newbot — создать нового бота
/mybots — список ваших ботов и подробные настройки
/setcommands — настроить команды меню бота
/delcommands — очистить команды меню
/setuserpic — установить или сменить аватарку бота
/deluserpic — удалить аватарку бота
/setbanner — установить или сменить шапку бота
/delbanner — удалить шапку бота
/token — получить API токен бота
/cancel — отменить текущую операцию

Боты VROT полностью совместимы с библиотекой **aiogram 3.x** и форматом Telegram Bot API!`;

    const markup = {
      inline_keyboard: [
        [
          { text: 'Создать нового бота', callback_data: 'bf_newbot' },
          { text: 'Мои боты', callback_data: 'bf_mybots' }
        ],
        [
          { text: 'Настроить команды меню', callback_data: 'bf_setcommands' },
          { text: 'Документация и aiogram', callback_data: 'bf_docs' }
        ]
      ]
    };
    await sendBotDm(io, bfId, userId, replyText, markup);
    return;
  }

  // Command: /newbot
  if (lower === '/newbot') {
    botFatherStates.set(userId, { step: 'awaiting_name' });
    await sendBotDm(io, bfId, userId, `Давайте создадим нового бота!\n\nКак мы его назовём? Отправьте отображаемое имя для вашего бота (например: **Мой Помощник**):\nДля отмены введите /cancel.`);
    return;
  }

  // Command: /mybots
  if (lower === '/mybots') {
    botFatherStates.delete(userId);
    await showMyBots(io, bfId, userId);
    return;
  }

  async function resolveTargetBot(uId: string, inputArg?: string) {
    if (inputArg) {
      const clean = inputArg.trim().replace(/^@/, '').toLowerCase();
      const q = await pool.query(
        'SELECT id, username, display_name FROM users WHERE username_key = $1 AND bot_owner_id = $2 AND is_bot = true AND deleted_at IS NULL',
        [clean, uId]
      );
      if (q.rows[0]) return q.rows[0];
    }
    const all = await pool.query(
      'SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL',
      [uId]
    );
    if (all.rows.length === 1) return all.rows[0];
    return null;
  }

  // Command: /token
  if (lower === '/token' || lower.startsWith('/token ')) {
    const arg = trimmed.split(/\s+/)[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      const tokQ = await pool.query('SELECT bot_token FROM users WHERE id = $1', [b.id]);
      await sendBotDm(io, bfId, userId, `API Токен для @${b.username}:\n\`${tokQ.rows[0]?.bot_token}\``);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов. Создайте бота с помощью /newbot.');
      return;
    }
    const buttons = q.rows.map(b => ([{ text: `${b.display_name} (@${b.username})`, callback_data: `bf_bot_${b.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для просмотра токена:', { inline_keyboard: buttons });
    return;
  }

  // Command: /setcommands
  if (lower === '/setcommands' || lower.startsWith('/setcommands ')) {
    const arg = trimmed.split(/\s+/)[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      botFatherStates.set(userId, { step: 'awaiting_commands_list', targetBotId: b.id });
      await sendBotDm(io, bfId, userId, `Пришлите список команд для @${b.username} в формате:\n\ncommand1 - Описание 1\ncommand2 - Описание 2\n\nПример:\nstart - Главное меню\nhelp - Помощь и справка\nsettings - Настройки\n\n(Чтобы очистить команды, отправьте /empty. Для отмены: /cancel)`);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов. Создайте бота с помощью /newbot.');
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_setcommands_bot' });
    const buttons = q.rows.map(b => ([{ text: `${b.display_name} (@${b.username})`, callback_data: `bf_cmd_bot_${b.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для настройки меню команд:', { inline_keyboard: buttons });
    return;
  }

  // Command: /delcommands
  if (lower === '/delcommands' || lower.startsWith('/delcommands ')) {
    const arg = trimmed.split(/\s+/)[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      await pool.query("UPDATE users SET bot_commands = '[]'::jsonb WHERE id = $1", [b.id]);
      await sendBotDm(io, bfId, userId, `Меню команд для бота @${b.username} очищено.`);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов.');
      return;
    }
    const buttons = q.rows.map(b => ([{ text: `${b.display_name} (@${b.username})`, callback_data: `bf_delcmd_bot_${b.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для очистки меню команд:', { inline_keyboard: buttons });
    return;
  }

  // Command: /setuserpic or /setavatar
  if (lower === '/setuserpic' || lower.startsWith('/setuserpic ') || lower === '/setavatar' || lower.startsWith('/setavatar ')) {
    const arg = trimmed.split(/\s+/)[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      botFatherStates.set(userId, { step: 'awaiting_avatar', targetBotId: b.id });
      await sendBotDm(io, bfId, userId, `Пришлите новую аватарку для @${b.username}.\n\nОтправьте фото через скрепку (📎) или прямую ссылку на изображение.\nДля отмены введите /cancel.`);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов. Создайте бота с помощью /newbot.');
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_avatar_bot' });
    const buttons = q.rows.map(b => ([{ text: `${b.display_name} (@${b.username})`, callback_data: `bf_avatar_bot_${b.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для смены аватарки:', { inline_keyboard: buttons });
    return;
  }

  // Command: /deluserpic or /delavatar
  if (lower === '/deluserpic' || lower.startsWith('/deluserpic ') || lower === '/delavatar' || lower.startsWith('/delavatar ')) {
    const arg = trimmed.split(/\s+/)[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      await pool.query('UPDATE users SET avatar_url = NULL WHERE id = $1', [b.id]);
      io.emit('user:update', { userId: b.id });
      await sendBotDm(io, bfId, userId, `Аватарка бота @${b.username} удалена.`);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов.');
      return;
    }
    const buttons = q.rows.map(b => ([{ text: `${b.display_name} (@${b.username})`, callback_data: `bf_delavatar_bot_${b.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для удаления аватарки:', { inline_keyboard: buttons });
    return;
  }

  // Command: /setbanner or /setheader
  if (lower === '/setbanner' || lower.startsWith('/setbanner ') || lower === '/setheader' || lower.startsWith('/setheader ')) {
    const arg = trimmed.split(/\s+/)[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      botFatherStates.set(userId, { step: 'awaiting_banner', targetBotId: b.id });
      await sendBotDm(io, bfId, userId, `Пришлите новую шапку профиля для @${b.username}.\n\nОтправьте фото через скрепку (📎) или прямую ссылку на изображение.\nДля отмены введите /cancel.`);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов. Создайте бота с помощью /newbot.');
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_banner_bot' });
    const buttons = q.rows.map(b => ([{ text: `${b.display_name} (@${b.username})`, callback_data: `bf_banner_bot_${b.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для смены шапки профиля:', { inline_keyboard: buttons });
    return;
  }

  // Command: /delbanner or /delheader
  if (lower === '/delbanner' || lower.startsWith('/delbanner ') || lower === '/delheader' || lower.startsWith('/delheader ')) {
    const arg = trimmed.split(/\s+/)[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      await pool.query('UPDATE users SET banner_url = NULL WHERE id = $1', [b.id]);
      io.emit('user:update', { userId: b.id });
      await sendBotDm(io, bfId, userId, `Шапка профиля бота @${b.username} удалена.`);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов.');
      return;
    }
    const buttons = q.rows.map(b => ([{ text: `${b.display_name} (@${b.username})`, callback_data: `bf_delbanner_bot_${b.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для удаления шапки:', { inline_keyboard: buttons });
    return;
  }
  // Command: /setdescription or /setdesc or /setabout
  if (lower === '/setdescription' || lower.startsWith('/setdescription ') || lower === '/setdesc' || lower.startsWith('/setdesc ') || lower === '/setabout' || lower.startsWith('/setabout ')) {
    const parts = trimmed.split(/\s+/);
    const arg = parts[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      const restText = parts.slice(arg?.startsWith('@') ? 2 : 1).join(' ').trim();
      if (restText) {
        await pool.query('UPDATE users SET bio = $1 WHERE id = $2', [restText.slice(0, 300), b.id]);
        io.emit('user:update', { userId: b.id });
        await sendBotDm(io, bfId, userId, `Описание для @${b.username} успешно обновлено! 📝`, {
          inline_keyboard: [[{ text: 'Управление ботом', callback_data: `bf_bot_${b.id}` }]]
        });
        return;
      }
      botFatherStates.set(userId, { step: 'awaiting_description', targetBotId: b.id });
      await sendBotDm(io, bfId, userId, `Пришлите новое описание (bio) для @${b.username} (до 300 символов):\nДля очистки отправьте /empty, для отмены — /cancel.`);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов. Создайте бота с помощью /newbot.');
      return;
    }
    const buttons = q.rows.map(bot => ([{ text: `${bot.display_name} (@${bot.username})`, callback_data: `bf_desc_bot_${bot.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для смены описания:', { inline_keyboard: buttons });
    return;
  }

  // Command: /deldescription or /deldesc
  if (lower === '/deldescription' || lower.startsWith('/deldescription ') || lower === '/deldesc' || lower.startsWith('/deldesc ')) {
    const arg = trimmed.split(/\s+/)[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      await pool.query('UPDATE users SET bio = \'\' WHERE id = $1', [b.id]);
      io.emit('user:update', { userId: b.id });
      await sendBotDm(io, bfId, userId, `Описание бота @${b.username} очищено.`);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов.');
      return;
    }
    const buttons = q.rows.map(bot => ([{ text: `${bot.display_name} (@${bot.username})`, callback_data: `bf_deldesc_bot_${bot.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для удаления описания:', { inline_keyboard: buttons });
    return;
  }

  // Command: /setname
  if (lower === '/setname' || lower.startsWith('/setname ')) {
    const parts = trimmed.split(/\s+/);
    const arg = parts[1];
    const b = await resolveTargetBot(userId, arg);
    if (b) {
      const restText = parts.slice(arg?.startsWith('@') ? 2 : 1).join(' ').trim();
      if (restText && restText.length >= 2 && restText.length <= 64) {
        await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [restText, b.id]);
        io.emit('user:update', { userId: b.id });
        await sendBotDm(io, bfId, userId, `Имя бота @${b.username} изменено на **${restText}**! ✏️`, {
          inline_keyboard: [[{ text: 'Управление ботом', callback_data: `bf_bot_${b.id}` }]]
        });
        return;
      }
      botFatherStates.set(userId, { step: 'awaiting_bot_name', targetBotId: b.id });
      await sendBotDm(io, bfId, userId, `Пришлите новое отображаемое имя для @${b.username} (от 2 до 64 символов):\nДля отмены введите /cancel.`);
      return;
    }
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов. Создайте бота с помощью /newbot.');
      return;
    }
    const buttons = q.rows.map(bot => ([{ text: `${bot.display_name} (@${bot.username})`, callback_data: `bf_name_bot_${bot.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для смены имени:', { inline_keyboard: buttons });
    return;
  }

  // State: awaiting_description
  if (state?.step === 'awaiting_description' && state.targetBotId) {
    if (lower === '/empty' || lower === '/clear' || lower === 'empty') {
      await pool.query('UPDATE users SET bio = \'\' WHERE id = $1 AND bot_owner_id = $2', [state.targetBotId, userId]);
    } else {
      await pool.query('UPDATE users SET bio = $1 WHERE id = $2 AND bot_owner_id = $3', [trimmed.slice(0, 300), state.targetBotId, userId]);
    }
    const botQ = await pool.query('SELECT username FROM users WHERE id = $1', [state.targetBotId]);
    const botName = botQ.rows[0]?.username || 'бота';
    const savedBotId = state.targetBotId;
    botFatherStates.delete(userId);
    io.emit('user:update', { userId: savedBotId });
    await sendBotDm(io, bfId, userId, `Описание (bio) для бота @${botName} успешно сохранено! 📝`, {
      inline_keyboard: [[{ text: 'Управление ботом', callback_data: `bf_bot_${savedBotId}` }]]
    });
    return;
  }

  // State: awaiting_bot_name
  if (state?.step === 'awaiting_bot_name' && state.targetBotId) {
    if (trimmed.length < 2 || trimmed.length > 64) {
      await sendBotDm(io, bfId, userId, 'Имя бота должно содержать от 2 до 64 символов. Попробуйте ещё раз (или /cancel):');
      return;
    }
    await pool.query('UPDATE users SET display_name = $1 WHERE id = $2 AND bot_owner_id = $3', [trimmed, state.targetBotId, userId]);
    const botQ = await pool.query('SELECT username FROM users WHERE id = $1', [state.targetBotId]);
    const botName = botQ.rows[0]?.username || 'бота';
    const savedBotId = state.targetBotId;
    botFatherStates.delete(userId);
    io.emit('user:update', { userId: savedBotId });
    await sendBotDm(io, bfId, userId, `Отображаемое имя для бота @${botName} изменено на **${trimmed}**! ✏️`, {
      inline_keyboard: [[{ text: 'Управление ботом', callback_data: `bf_bot_${savedBotId}` }]]
    });
    return;
  }
  // State: awaiting_avatar
  if (state?.step === 'awaiting_avatar' && state.targetBotId) {
    let newAvatarUrl: string | null = null;
    if (attachmentId) {
      newAvatarUrl = `/api/uploads/${attachmentId}`;
    } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/api/uploads/')) {
      newAvatarUrl = trimmed;
    }

    if (!newAvatarUrl) {
      await sendBotDm(io, bfId, userId, `Пожалуйста, отправьте фото через скрепку (📎) или пришлите прямую ссылку на изображение.\nДля отмены введите /cancel.`);
      return;
    }

    await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2 AND bot_owner_id = $3', [newAvatarUrl, state.targetBotId, userId]);
    const botQ = await pool.query('SELECT username FROM users WHERE id = $1', [state.targetBotId]);
    const botName = botQ.rows[0]?.username || 'бота';
    const savedBotId = state.targetBotId;
    botFatherStates.delete(userId);
    io.emit('user:update', { userId: savedBotId });
    await sendBotDm(io, bfId, userId, `Аватарка для бота @${botName} успешно обновлена! 🖼`, {
      inline_keyboard: [[{ text: 'Управление ботом', callback_data: `bf_bot_${savedBotId}` }]]
    });
    return;
  }

  // State: awaiting_banner
  if (state?.step === 'awaiting_banner' && state.targetBotId) {
    let newBannerUrl: string | null = null;
    if (attachmentId) {
      newBannerUrl = `/api/uploads/${attachmentId}`;
    } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/api/uploads/')) {
      newBannerUrl = trimmed;
    }

    if (!newBannerUrl) {
      await sendBotDm(io, bfId, userId, `Пожалуйста, отправьте фото через скрепку (📎) или пришлите прямую ссылку на изображение.\nДля отмены введите /cancel.`);
      return;
    }

    await pool.query('UPDATE users SET banner_url = $1 WHERE id = $2 AND bot_owner_id = $3', [newBannerUrl, state.targetBotId, userId]);
    const botQ = await pool.query('SELECT username FROM users WHERE id = $1', [state.targetBotId]);
    const botName = botQ.rows[0]?.username || 'бота';
    const savedBotId = state.targetBotId;
    botFatherStates.delete(userId);
    io.emit('user:update', { userId: savedBotId });
    await sendBotDm(io, bfId, userId, `Шапка профиля для бота @${botName} успешно обновлена! 🎨`, {
      inline_keyboard: [[{ text: 'Управление ботом', callback_data: `bf_bot_${savedBotId}` }]]
    });
    return;
  }

  // State: awaiting_commands_list
  if (state?.step === 'awaiting_commands_list' && state.targetBotId) {
    if (lower === '/empty' || lower === '/clear' || lower === 'empty') {
      await pool.query("UPDATE users SET bot_commands = '[]'::jsonb WHERE id = $1 AND bot_owner_id = $2", [state.targetBotId, userId]);
      const botQ = await pool.query('SELECT username FROM users WHERE id = $1', [state.targetBotId]);
      const botName = botQ.rows[0]?.username || 'бота';
      const savedBotId = state.targetBotId;
      botFatherStates.delete(userId);
      await sendBotDm(io, bfId, userId, `Меню команд для @${botName} очищено.`, {
        inline_keyboard: [[{ text: 'Управление ботом', callback_data: `bf_bot_${savedBotId}` }]]
      });
      return;
    }

    const lines = trimmed.split('\n');
    const commandsList: { command: string; description: string }[] = [];
    for (const line of lines) {
      const parts = line.split(/[-–—:]/);
      if (parts.length >= 2) {
        const cmd = parts[0].trim().replace(/^\//, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
        const desc = parts.slice(1).join('-').trim();
        if (cmd && desc) {
          commandsList.push({ command: cmd, description: desc });
        }
      }
    }
    if (!commandsList.length) {
      await sendBotDm(io, bfId, userId, `Не удалось распознать команды. Пришлите список строками вида:\n\ncommand - Описание\n\nНапример:\nstart - Главное меню\nhelp - Справка\n\nДля очистки команд отправьте /empty, для отмены — /cancel.`);
      return;
    }

    await pool.query('UPDATE users SET bot_commands = $1 WHERE id = $2 AND bot_owner_id = $3', [JSON.stringify(commandsList), state.targetBotId, userId]);
    const botQ = await pool.query('SELECT username FROM users WHERE id = $1', [state.targetBotId]);
    const botName = botQ.rows[0]?.username || 'бота';
    const savedBotId = state.targetBotId;
    botFatherStates.delete(userId);
    await sendBotDm(io, bfId, userId, `Успешно! Список команд для @${botName} сохранён.\nТеперь кнопка «Меню» в чате с ботом отображает эти команды. 📋`, {
      inline_keyboard: [[{ text: 'Управление ботом', callback_data: `bf_bot_${savedBotId}` }]]
    });
    return;
  }

  // State: awaiting_name
  if (state?.step === 'awaiting_name') {
    if (trimmed.length < 2 || trimmed.length > 64) {
      await sendBotDm(io, bfId, userId, `Имя должно быть длиной от 2 до 64 символов. Попробуйте ещё раз:`);
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_username', tempName: trimmed });
    await sendBotDm(io, bfId, userId, `Отлично! Теперь выберите юзернейм для вашего бота.\n\nПравило: юзернейм обязан оканчиваться на bot (например: tetris_bot или HelperBot). Допустимы латинские буквы, цифры и подчеркивание:`);
    return;
  }

  // State: awaiting_username
  if (state?.step === 'awaiting_username') {
    const rawUsername = trimmed.replace(/^@/, '');
    const lowerUser = rawUsername.toLowerCase();

    if (!lowerUser.endsWith('bot')) {
      await sendBotDm(io, bfId, userId, `Юзернейм бота обязан заканчиваться на bot (например: ${lowerUser}_bot или ${lowerUser}bot).\nПопробуйте ещё раз:`);
      return;
    }

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(rawUsername)) {
      await sendBotDm(io, bfId, userId, `Юзернейм должен содержать от 3 до 32 символов (только латинские буквы a-z, цифры 0-9 и подчеркивание).\nПопробуйте ещё раз:`);
      return;
    }

    const check = await pool.query('SELECT id FROM users WHERE username_key = $1', [lowerUser]);
    if (check.rowCount) {
      await sendBotDm(io, bfId, userId, `К сожалению, имя пользователя @${rawUsername} уже занято. Пожалуйста, придумайте другое:`);
      return;
    }

    const newBotId = uuid();
    const token = `vrot_${randomToken(32)}`;
    const tempName = state.tempName || rawUsername;

    await pool.query(`
      INSERT INTO users (id, username, username_key, email, password_hash, birth_date, display_name, is_bot, bot_owner_id, bot_token, status, verified, bot_commands)
      VALUES ($1, $2, $3, $4, '$argon2id$fake', '2000-01-01', $5, true, $6, $7, 'bot', false, '[{"command":"start","description":"Запустить бота"},{"command":"help","description":"Помощь"}]'::jsonb)
    `, [newBotId, rawUsername, lowerUser, `${lowerUser}@bot.vrot.fun`, tempName, userId, token]);

    await pool.query(`
      INSERT INTO friendships (requester_id, addressee_id, status)
      VALUES ($1, $2, 'accepted'), ($2, $1, 'accepted')
      ON CONFLICT DO NOTHING
    `, [userId, newBotId]);

    botFatherStates.delete(userId);

    const successMsg = `Поздравляем! Ваш бот успешно создан!

Имя: **${tempName}**
Юзернейм: @${rawUsername}

**API Токен:**
\`${token}\`

*Храните токен в тайне. С его помощью можно управлять ботом через Bot API.*

**Подключение в Python (aiogram 3.x):**
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
          { text: `Открыть чат с @${rawUsername}`, url: `/?dm=${newBotId}` },
          { text: 'Настроить команды меню', callback_data: `bf_cmd_bot_${newBotId}` }
        ],
        [
          { text: 'Установить аватарку', callback_data: `bf_avatar_bot_${newBotId}` },
          { text: 'Установить шапку', callback_data: `bf_banner_bot_${newBotId}` }
        ]
      ]
    };

    await sendBotDm(io, bfId, userId, successMsg, markup);
    return;
  }

  // Conversational response to any greeting or unhandled message
  const fallbackMsg = `Привет! Я BotFather — официальный отец ботов VROT.

Чем я могу помочь?
/newbot — создать бота
/mybots — список моих ботов
/setcommands — настроить команды меню бота
/delcommands — очистить команды меню
/setuserpic — установить аватарку
/setbanner — установить шапку профиля
/help — справка и примеры кода`;

  const fallbackMarkup = {
    inline_keyboard: [
      [
        { text: 'Создать нового бота', callback_data: 'bf_newbot' },
        { text: 'Мои боты', callback_data: 'bf_mybots' }
      ],
      [
        { text: 'Настроить команды меню', callback_data: 'bf_setcommands' },
        { text: 'Документация и aiogram', callback_data: 'bf_docs' }
      ]
    ]
  };
  await sendBotDm(io, bfId, userId, fallbackMsg, fallbackMarkup);
}

async function showMyBots(io: Server, bfId: string, userId: string) {
  const q = await pool.query(
    'SELECT id, username, display_name, bot_token, verified, avatar_url, banner_url, bot_commands FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL ORDER BY created_at DESC',
    [userId]
  );
  if (!q.rows.length) {
    const markup = {
      inline_keyboard: [[{ text: 'Создать первого бота', callback_data: 'bf_newbot' }]]
    };
    await sendBotDm(io, bfId, userId, `У вас пока нет созданных ботов. Нажмите кнопку ниже или введите /newbot, чтобы создать своего первого бота:`, markup);
    return;
  }

  const buttons = q.rows.map(b => ([
    { text: `${b.display_name} (@${b.username})${b.verified ? ' [Подтверждён]' : ''}`, callback_data: `bf_bot_${b.id}` }
  ]));
  buttons.push([{ text: 'Создать ещё одного бота', callback_data: 'bf_newbot' }]);

  await sendBotDm(io, bfId, userId, `**Ваши боты в VROT:**\nВыберите бота для просмотра настроек и токена:`, { inline_keyboard: buttons });
}

// Handle inline button callback for BotFather
export async function handleBotFatherCallback(io: Server, userId: string, callbackData: string) {
  const bfId = await getBotFatherId();

  if (callbackData === 'bf_newbot') {
    botFatherStates.set(userId, { step: 'awaiting_name' });
    await sendBotDm(io, bfId, userId, `Хорошо, давайте создадим нового бота!\n\nКак мы его назовём? Отправьте отображаемое имя для вашего бота (например: **Мой Помощник**):\nДля отмены введите /cancel.`);
    return;
  }

  if (callbackData === 'bf_mybots') {
    await showMyBots(io, bfId, userId);
    return;
  }

  if (callbackData === 'bf_setcommands') {
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL', [userId]);
    if (!q.rows.length) {
      await sendBotDm(io, bfId, userId, 'У вас пока нет созданных ботов. Создайте бота с помощью /newbot.');
      return;
    }
    if (q.rows.length === 1) {
      const b = q.rows[0];
      botFatherStates.set(userId, { step: 'awaiting_commands_list', targetBotId: b.id });
      await sendBotDm(io, bfId, userId, `Пришлите список команд для @${b.username} в формате:\n\ncommand1 - Описание 1\ncommand2 - Описание 2\n\nПример:\nstart - Главное меню\nhelp - Помощь и справка\nsettings - Настройки\n\n(Чтобы очистить команды, отправьте /empty. Для отмены: /cancel)`);
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_setcommands_bot' });
    const buttons = q.rows.map(b => ([{ text: `${b.display_name} (@${b.username})`, callback_data: `bf_cmd_bot_${b.id}` }]));
    await sendBotDm(io, bfId, userId, 'Выберите бота для настройки меню команд:', { inline_keyboard: buttons });
    return;
  }

  if (callbackData.startsWith('bf_cmd_bot_')) {
    const botId = callbackData.replace('bf_cmd_bot_', '');
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true', [botId, userId]);
    const b = q.rows[0];
    if (!b) {
      await sendBotDm(io, bfId, userId, 'Бот не найден или у вас нет доступа.');
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_commands_list', targetBotId: b.id });
    await sendBotDm(io, bfId, userId, `Пришлите список команд для @${b.username} в формате:\n\ncommand1 - Описание 1\ncommand2 - Описание 2\n\nПример:\nstart - Главное меню\nhelp - Помощь и справка\nsettings - Настройки\n\n(Чтобы очистить команды, отправьте /empty. Для отмены: /cancel)`);
    return;
  }

  if (callbackData.startsWith('bf_delcmd_bot_')) {
    const botId = callbackData.replace('bf_delcmd_bot_', '');
    const q = await pool.query('UPDATE users SET bot_commands = \'[]\'::jsonb WHERE id = $1 AND bot_owner_id = $2 RETURNING username', [botId, userId]);
    if (q.rows[0]) {
      await sendBotDm(io, bfId, userId, `Меню команд бота @${q.rows[0].username} очищено.`);
      await handleBotFatherCallback(io, userId, `bf_bot_${botId}`);
    }
    return;
  }

  if (callbackData.startsWith('bf_avatar_bot_')) {
    const botId = callbackData.replace('bf_avatar_bot_', '');
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true', [botId, userId]);
    const b = q.rows[0];
    if (!b) {
      await sendBotDm(io, bfId, userId, 'Бот не найден или у вас нет доступа.');
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_avatar', targetBotId: b.id });
    await sendBotDm(io, bfId, userId, `Пришлите новую аватарку для @${b.username}.\n\nОтправьте фото через скрепку (📎) или пришлите прямую ссылку на изображение.\nДля отмены введите /cancel.`);
    return;
  }

  if (callbackData.startsWith('bf_delavatar_bot_')) {
    const botId = callbackData.replace('bf_delavatar_bot_', '');
    const q = await pool.query('UPDATE users SET avatar_url = NULL WHERE id = $1 AND bot_owner_id = $2 RETURNING username', [botId, userId]);
    if (q.rows[0]) {
      io.emit('user:update', { userId: botId });
      await sendBotDm(io, bfId, userId, `Аватарка бота @${q.rows[0].username} удалена.`);
      await handleBotFatherCallback(io, userId, `bf_bot_${botId}`);
    }
    return;
  }

  if (callbackData.startsWith('bf_banner_bot_')) {
    const botId = callbackData.replace('bf_banner_bot_', '');
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true', [botId, userId]);
    const b = q.rows[0];
    if (!b) {
      await sendBotDm(io, bfId, userId, 'Бот не найден или у вас нет доступа.');
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_banner', targetBotId: b.id });
    await sendBotDm(io, bfId, userId, `Пришлите новую шапку профиля для @${b.username}.\n\nОтправьте фото через скрепку (📎) или пришлите прямую ссылку на изображение.\nДля отмены введите /cancel.`);
    return;
  }

  if (callbackData.startsWith('bf_delbanner_bot_')) {
    const botId = callbackData.replace('bf_delbanner_bot_', '');
    const q = await pool.query('UPDATE users SET banner_url = NULL WHERE id = $1 AND bot_owner_id = $2 RETURNING username', [botId, userId]);
    if (q.rows[0]) {
      io.emit('user:update', { userId: botId });
      await sendBotDm(io, bfId, userId, `Шапка профиля бота @${q.rows[0].username} удалена.`);
      await handleBotFatherCallback(io, userId, `bf_bot_${botId}`);
    }
    return;
  }

  if (callbackData.startsWith('bf_desc_bot_')) {
    const botId = callbackData.replace('bf_desc_bot_', '');
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true', [botId, userId]);
    const b = q.rows[0];
    if (!b) {
      await sendBotDm(io, bfId, userId, 'Бот не найден или у вас нет доступа.');
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_description', targetBotId: b.id });
    await sendBotDm(io, bfId, userId, `Пришлите новое описание (bio) для @${b.username} (до 300 символов):\nДля очистки отправьте /empty, для отмены — /cancel.`);
    return;
  }

  if (callbackData.startsWith('bf_deldesc_bot_')) {
    const botId = callbackData.replace('bf_deldesc_bot_', '');
    const q = await pool.query('UPDATE users SET bio = \'\' WHERE id = $1 AND bot_owner_id = $2 RETURNING username', [botId, userId]);
    if (q.rows[0]) {
      io.emit('user:update', { userId: botId });
      await sendBotDm(io, bfId, userId, `Описание бота @${q.rows[0].username} очищено.`);
      await handleBotFatherCallback(io, userId, `bf_bot_${botId}`);
    }
    return;
  }

  if (callbackData.startsWith('bf_name_bot_')) {
    const botId = callbackData.replace('bf_name_bot_', '');
    const q = await pool.query('SELECT id, username, display_name FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true', [botId, userId]);
    const b = q.rows[0];
    if (!b) {
      await sendBotDm(io, bfId, userId, 'Бот не найден или у вас нет доступа.');
      return;
    }
    botFatherStates.set(userId, { step: 'awaiting_bot_name', targetBotId: b.id });
    await sendBotDm(io, bfId, userId, `Пришлите новое отображаемое имя для @${b.username} (от 2 до 64 символов):\nДля отмены введите /cancel.`);
    return;
  }

  if (callbackData === 'bf_docs') {
    const docs = `**Документация Bot API для VROT**

Наш API полностью совместим с форматом **Telegram Bot API**! Это значит, что вы можете использовать любую популярную библиотеку:
- **Python:** \`aiogram\`, \`python-telegram-bot\`, \`telebot\`
- **Node.js:** \`telegraf\`, \`grammy\`

**Base API URL:** \`https://vrot.fun\` (или \`https://api.vrot.fun\`)

**Пример с aiogram 3.x:**
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
        [{ text: 'Мои боты', callback_data: 'bf_mybots' }, { text: 'Создать бота', callback_data: 'bf_newbot' }]
      ]
    });
    return;
  }

  if (callbackData.startsWith('bf_bot_')) {
    const botId = callbackData.replace('bf_bot_', '');
    const q = await pool.query(
      'SELECT id, username, display_name, bio, bot_token, verified, avatar_url, banner_url, bot_commands, created_at FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true',
      [botId, userId]
    );
    const bot = q.rows[0];
    if (!bot) {
      await sendBotDm(io, bfId, userId, `Бот не найден или у вас нет доступа.`);
      return;
    }

    const cmdCount = Array.isArray(bot.bot_commands) ? bot.bot_commands.length : 0;
    const info = `**Управление ботом @${bot.username}**

• **Имя:** ${bot.display_name}
• **Юзернейм:** @${bot.username}
• **Описание:** ${bot.bio ? bot.bio : '(не установлено)'}
• **Аватарка:** ${bot.avatar_url ? 'Установлена 🖼' : 'Не установлена (по умолчанию)'}
• **Шапка профиля:** ${bot.banner_url ? 'Установлена 🎨' : 'Не установлена'}
• **Команд в меню:** ${cmdCount}
• **Верификация:** ${bot.verified ? 'Подтверждён' : 'Обычный'}
• **Токен:** \`${bot.bot_token}\`

Выберите действие:`;

    const markup = {
      inline_keyboard: [
        [
          { text: '📝 Изменить описание', callback_data: `bf_desc_bot_${bot.id}` },
          { text: '✏️ Сменить имя', callback_data: `bf_name_bot_${bot.id}` }
        ],
        [
          { text: '🖼 Сменить аватарку', callback_data: `bf_avatar_bot_${bot.id}` },
          { text: '🎨 Сменить шапку', callback_data: `bf_banner_bot_${bot.id}` }
        ],
        [
          { text: '📋 Меню команд', callback_data: `bf_cmd_bot_${bot.id}` },
          { text: '🔑 Новый токен', callback_data: `bf_token_${bot.id}` }
        ],
        [
          { text: '❌ Сбросить описание', callback_data: `bf_deldesc_bot_${bot.id}` },
          { text: '❌ Сбросить аватарку', callback_data: `bf_delavatar_bot_${bot.id}` }
        ],
        [
          { text: '❌ Сбросить шапку', callback_data: `bf_delbanner_bot_${bot.id}` },
          { text: '🗑 Очистить команды', callback_data: `bf_delcmd_bot_${bot.id}` }
        ],
        [
          { text: '💬 Открыть чат', url: `/?dm=${bot.id}` },
          { text: '⚠️ Удалить бота', callback_data: `bf_del_${bot.id}` }
        ],
        [
          { text: '⬅️ Назад к списку', callback_data: 'bf_mybots' }
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
      await sendBotDm(io, bfId, userId, `**Новый токен для @${q.rows[0].username}:**\n\`${newToken}\`\n\nСтарый токен аннулирован.`);
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
      await sendBotDm(io, bfId, userId, `Бот **@${q.rows[0].username}** успешно удалён.`);
      await showMyBots(io, bfId, userId);
    }
    return;
  }
}

// Setup all Bot API routes (compatible with aiogram & standard Telegram Bot API)
export function setupBotRoutes(app: Express, io: Server, authMiddleware?: any) {
  const requireAuth = async (req: Request, res: Response, next: any) => {
    if (req.user) return next();
    if (authMiddleware) {
      return authMiddleware(req, res, next);
    }
    const u = await getAuthUser(req);
    if (!u) return res.status(401).json({ error: 'Нужен вход' });
    req.user = u;
    next();
  };

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

        case 'setmycommands': {
          let cmds = params.commands;
          if (typeof cmds === 'string') {
            try { cmds = JSON.parse(cmds); } catch { cmds = []; }
          }
          if (!Array.isArray(cmds)) {
            return res.status(400).json({ ok: false, error_code: 400, description: 'commands must be an array of BotCommand objects' });
          }
          const cleanList = cmds.map((c: any) => ({
            command: String(c.command || '').trim().replace(/^\//, '').toLowerCase().replace(/[^a-z0-9_]/g, ''),
            description: String(c.description || '').trim()
          })).filter(c => c.command && c.description);

          await pool.query('UPDATE users SET bot_commands = $1 WHERE id = $2', [JSON.stringify(cleanList), bot.id]);
          return res.json({ ok: true, result: true });
        }

        case 'getmycommands': {
          const q = await pool.query('SELECT bot_commands FROM users WHERE id = $1', [bot.id]);
          const cmds = q.rows[0]?.bot_commands || [];
          return res.json({ ok: true, result: cmds });
        }

        case 'deletemycommands': {
          await pool.query("UPDATE users SET bot_commands = '[]'::jsonb WHERE id = $1", [bot.id]);
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
  app.post('/api/bots/callback', requireAuth, async (req: Request, res: Response) => {
    const user = req.user || await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Нужен вход' });

    const { messageId, callbackData } = req.body;
    if (!callbackData) {
      return res.status(400).json({ error: 'callbackData required' });
    }

    // Direct routing for BotFather actions
    if (callbackData.startsWith('bf_')) {
      await handleBotFatherCallback(io, user.id, callbackData);
      return res.json({ ok: true });
    }

    if (!messageId) {
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
  app.get('/api/bots/my', requireAuth, async (req: Request, res: Response) => {
    const user = req.user || await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Нужен вход' });
    const q = await pool.query(
      'SELECT id, username, display_name, avatar_url, banner_url, bio, bot_token, bot_commands, verified, created_at FROM users WHERE bot_owner_id = $1 AND is_bot = true AND deleted_at IS NULL ORDER BY created_at DESC',
      [user.id]
    );
    res.json({
      bots: q.rows.map(r => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name || r.username,
        avatarUrl: r.avatar_url,
        bannerUrl: r.banner_url,
        bio: r.bio || '',
        token: r.bot_token,
        botCommands: r.bot_commands || [],
        verified: Boolean(r.verified),
        createdAt: r.created_at
      }))
    });
  });

  // REST API: Open or get BotFather chat for user
  app.post('/api/bots/botfather/open', requireAuth, async (req: Request, res: Response) => {
    const user = req.user || await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Нужен вход' });
    const bfId = await getBotFatherId();
    // Ensure mutual friendship
    await pool.query(`
      INSERT INTO friendships (requester_id, addressee_id, status)
      VALUES ($1, $2, 'accepted'), ($2, $1, 'accepted')
      ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status = 'accepted'
    `, [user.id, bfId]);

    // Check if there are any existing messages
    const existing = await pool.query(
      'SELECT id FROM direct_messages WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1) LIMIT 1',
      [user.id, bfId]
    );
    if (!existing.rows.length) {
      await handleBotFatherMessage(io, user.id, '/start');
    }

    const bfUser = await pool.query('SELECT id, username, display_name, avatar_url, banner_url, verified FROM users WHERE id = $1', [bfId]);
    const row = bfUser.rows[0];
    return res.json({
      ok: true,
      botFather: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        bannerUrl: row.banner_url,
        verified: true,
        isBot: true,
        status: 'bot',
        presence: 'bot'
      }
    });
  });

  // REST API: Create bot directly from web UI
  app.post('/api/bots/create', requireAuth, async (req: Request, res: Response) => {
    const user = req.user || await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Нужен вход' });
    const { displayName, username } = req.body;
    if (!displayName || !username) {
      return res.status(400).json({ error: 'Укажите имя и юзернейм бота' });
    }
    const cleanName = String(displayName).trim().slice(0, 64);
    const cleanUser = String(username).trim();
    const lowerUser = cleanUser.toLowerCase();

    if (!lowerUser.endsWith('bot')) {
      return res.status(400).json({ error: 'Юзернейм бота обязан заканчиваться на bot (например: my_bot)' });
    }
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(cleanUser)) {
      return res.status(400).json({ error: 'Юзернейм должен содержать от 3 до 32 символов (латиница, цифры, _)' });
    }

    const check = await pool.query('SELECT id FROM users WHERE username_key = $1', [lowerUser]);
    if (check.rowCount) {
      return res.status(409).json({ error: 'Юзернейм уже занят' });
    }

    const newBotId = uuid();
    const token = `vrot_${randomToken(32)}`;

    await pool.query(`
      INSERT INTO users (id, username, username_key, email, password_hash, birth_date, display_name, is_bot, bot_owner_id, bot_token, status, verified, bot_commands)
      VALUES ($1, $2, $3, $4, '$argon2id$fake', '2000-01-01', $5, true, $6, $7, 'bot', false, '[{"command":"start","description":"Запустить бота"},{"command":"help","description":"Помощь"}]'::jsonb)
    `, [newBotId, cleanUser, lowerUser, `${lowerUser}@bot.vrot.fun`, cleanName, user.id, token]);

    // Establish mutual friendship with owner so it immediately appears in chats
    await pool.query(`
      INSERT INTO friendships (requester_id, addressee_id, status)
      VALUES ($1, $2, 'accepted'), ($2, $1, 'accepted')
      ON CONFLICT DO NOTHING
    `, [user.id, newBotId]);

    return res.json({
      ok: true,
      bot: {
        id: newBotId,
        username: cleanUser,
        displayName: cleanName,
        token,
        verified: false,
        isBot: true,
        status: 'bot',
        presence: 'bot'
      }
    });
  });

  // REST API: Update bot profile (display name, bio, avatar, banner, commands)
  app.patch('/api/bots/:id/profile', requireAuth, async (req: Request, res: Response) => {
    const user = req.user || await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Нужен вход' });
    const { id } = req.params;
    const botQ = await pool.query('SELECT id, username FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true AND deleted_at IS NULL', [id, user.id]);
    if (!botQ.rows[0]) return res.status(404).json({ error: 'Бот не найден или вы не являетесь его владельцем' });

    const { displayName, bio, avatarUrl, bannerUrl, botCommands } = req.body;
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (displayName !== undefined) {
      updates.push(`display_name = $${idx++}`);
      values.push(String(displayName).trim().slice(0, 64));
    }
    if (bio !== undefined) {
      updates.push(`bio = $${idx++}`);
      values.push(String(bio).slice(0, 256));
    }
    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${idx++}`);
      values.push(avatarUrl ? String(avatarUrl).trim() : null);
    }
    if (bannerUrl !== undefined) {
      updates.push(`banner_url = $${idx++}`);
      values.push(bannerUrl ? String(bannerUrl).trim() : null);
    }
    if (botCommands !== undefined && Array.isArray(botCommands)) {
      const cleanList = botCommands.map((c: any) => ({
        command: String(c.command || '').trim().replace(/^\//, '').toLowerCase().replace(/[^a-z0-9_]/g, ''),
        description: String(c.description || '').trim()
      })).filter(c => c.command && c.description);
      updates.push(`bot_commands = $${idx++}`);
      values.push(JSON.stringify(cleanList));
    }

    if (updates.length > 0) {
      values.push(id);
      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    }

    const updatedQ = await pool.query('SELECT id, username, display_name, avatar_url, banner_url, bio, bot_commands, verified FROM users WHERE id = $1', [id]);
    const b = updatedQ.rows[0];
    io.emit('user:update', { userId: id });
    return res.json({
      ok: true,
      bot: {
        id: b.id,
        username: b.username,
        displayName: b.display_name,
        avatarUrl: b.avatar_url,
        bannerUrl: b.banner_url,
        bio: b.bio,
        botCommands: b.bot_commands || [],
        verified: Boolean(b.verified)
      }
    });
  });

  // REST API: Regenerate bot token
  app.post('/api/bots/:id/regenerate-token', requireAuth, async (req: Request, res: Response) => {
    const user = req.user || await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Нужен вход' });
    const { id } = req.params;
    const botQ = await pool.query('SELECT id FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true', [id, user.id]);
    if (!botQ.rows[0]) return res.status(404).json({ error: 'Бот не найден или вы не являетесь его владельцем' });

    const newToken = `vrot_${randomToken(32)}`;
    await pool.query('UPDATE users SET bot_token = $1 WHERE id = $2', [newToken, id]);
    return res.json({ ok: true, token: newToken });
  });

  // REST API: Delete bot
  app.delete('/api/bots/:id', requireAuth, async (req: Request, res: Response) => {
    const user = req.user || await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Нужен вход' });
    const { id } = req.params;
    const botQ = await pool.query('SELECT id FROM users WHERE id = $1 AND bot_owner_id = $2 AND is_bot = true', [id, user.id]);
    if (!botQ.rows[0]) return res.status(404).json({ error: 'Бот не найден или вы не являетесь его владельцем' });

    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [id]);
    await pool.query('DELETE FROM bot_webhooks WHERE bot_id = $1', [id]);
    return res.json({ ok: true });
  });

  // REST API: Get commands for a bot
  app.get('/api/bots/:id/commands', async (req: Request, res: Response) => {
    const { id } = req.params;
    const botQ = await pool.query('SELECT id, username, bot_commands, is_bot FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!botQ.rows[0] || !botQ.rows[0].is_bot) {
      return res.status(404).json({ error: 'Бот не найден' });
    }
    return res.json({ ok: true, commands: botQ.rows[0].bot_commands || [] });
  });
}
