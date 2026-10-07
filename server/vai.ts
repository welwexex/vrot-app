import fs from 'node:fs';
import path from 'node:path';
import { Server } from 'socket.io';
import { pool } from './db.js';
import { decrypt } from './crypto.js';
import { sendBotDm } from './bots.js';

export const V_AI_BOT_ID = '571e0139-02bf-498f-acab-87582cfcb7b0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42STlDRWI4ZEx5anhLZ2VoSjNtLWV6clN3RkJaSDlTX1JTaFBXbVZRMDVWdWc=', 'base64').toString('utf8');

// In-memory rate limiter (30 RPM total project limit)
const recentRequests: number[] = [];
const userLastRequest = new Map<string, number>();

function isRateLimited(userId: string): { limited: boolean; reason?: string } {
  const now = Date.now();
  // Per-user cooldown: 2 seconds between requests
  const userLast = userLastRequest.get(userId) || 0;
  if (now - userLast < 2000) {
    return { limited: true, reason: 'Пожалуйста, подождите пару секунд перед следующим вопросом.' };
  }

  // Global rate limit: 25 requests per 60 seconds
  while (recentRequests.length && now - recentRequests[0] > 60_000) {
    recentRequests.shift();
  }
  if (recentRequests.length >= 25) {
    return { limited: true, reason: 'Превышен минутный лимит запросов к ИИ. Пожалуйста, подождите минуту.' };
  }

  recentRequests.push(now);
  userLastRequest.set(userId, now);
  return { limited: false };
}

// Call Google AI Studio / Gemini API
async function generateAiContent(
  model: string,
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
  systemInstruction?: string
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body: any = {
    contents: [{ parts }],
    generationConfig: {
      maxOutputTokens: 1000,
      temperature: 0.7,
      topP: 0.9,
    },
  };
  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    if (response.status === 429) {
      throw new Error('Лимит бесплатных запросов к Gemini API временно исчерпан. Пожалуйста, подождите немного.');
    }
    throw new Error(`API error ${response.status}: ${errText.slice(0, 150)}`);
  }

  const data: any = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Пустой ответ от нейросети.');
  return text.trim();
}

// Search user's messages strictly with privacy enforcement
async function searchUserMessages(userId: string, query: string): Promise<string> {
  const cleanQ = query.trim().toLowerCase();
  // Fetch recent messages where the user is sender or recipient (max 200 messages)
  const q = await pool.query(
    `SELECT m.id, m.content_enc, m.created_at, m.sender_id, m.recipient_id,
            su.username as sender_username, su.display_name as sender_name,
            ru.username as recipient_username, ru.display_name as recipient_name
     FROM direct_messages m
     JOIN users su ON su.id = m.sender_id
     JOIN users ru ON ru.id = m.recipient_id
     WHERE (m.sender_id = $1 OR m.recipient_id = $1)
       AND m.sender_id <> $2 AND m.recipient_id <> $2
       AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC
     LIMIT 200`,
    [userId, V_AI_BOT_ID]
  );

  const matched: Array<{ text: string; author: string; date: string; id: string }> = [];

  for (const row of q.rows) {
    try {
      const decrypted = decrypt(row.content_enc);
      if (cleanQ === '' || decrypted.toLowerCase().includes(cleanQ)) {
        const isFromMe = row.sender_id === userId;
        const author = isFromMe ? 'Вы' : (row.sender_name || row.sender_username);
        const dateStr = new Date(row.created_at).toLocaleDateString('ru-RU', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
        matched.push({
          id: row.id,
          text: decrypted,
          author,
          date: dateStr,
        });
        if (matched.length >= 5) break; // Limit to 5 most relevant
      }
    } catch {}
  }

  if (matched.length === 0) {
    return 'В ваших личных переписках ничего подходящего не найдено.';
  }

  let result = 'Вот что я нашёл в ваших сообщениях:\n\n';
  for (const item of matched) {
    result += `💬 **${item.author}** (${item.date}):\n«${item.text}»\n\n`;
  }
  return result.trim();
}

// Conversation memory helpers
async function getMemory(userId: string): Promise<string> {
  const q = await pool.query('SELECT compact_summary FROM v_ai_memory WHERE user_id = $1', [userId]);
  return q.rows[0]?.compact_summary || '';
}

async function updateMemory(userId: string, userText: string, aiReply: string) {
  const turn = `U: ${userText.slice(0, 100)}\nA: ${aiReply.slice(0, 150)}\n`;
  await pool.query(
    `INSERT INTO v_ai_memory (user_id, compact_summary, last_interaction_at, turns_count)
     VALUES ($1, $2, now(), 1)
     ON CONFLICT (user_id) DO UPDATE SET
       compact_summary = RIGHT(v_ai_memory.compact_summary || $2, 600),
       last_interaction_at = now(),
       turns_count = v_ai_memory.turns_count + 1`,
    [userId, turn]
  );
}

// Main processing function for incoming message to V AI
export async function processVAIMessage(
  io: Server,
  userId: string,
  content: string,
  attachmentId?: string | null
) {
  const text = (content || '').trim();

  // Fast path for static bot commands
  if (text === '/start') {
    const welcome = `Привет! Я **V AI** — твой персональный ИИ-помощник в VROT 2.0 ⚡️\n\n` +
      `Чем я могу помочь:\n` +
      `• Отвечать на любые вопросы и общаться на русском и других языках\n` +
      `• Анализировать фотографии и картинки — просто пришли изображение!\n` +
      `• Искать информацию в твоих переписках (например: «Найди где мы говорили про билеты»)\n` +
      `• Делать краткие саммари и выделять главное\n\n` +
      `Попробуй задать вопрос или отправь картинку!`;
    await sendBotDm(io, V_AI_BOT_ID, userId, welcome);
    return;
  }

  if (text === '/clear') {
    await pool.query('DELETE FROM v_ai_memory WHERE user_id = $1', [userId]);
    await sendBotDm(io, V_AI_BOT_ID, userId, 'Память нашего диалога очищена. Начнём с чистого листа!');
    return;
  }

  if (text === '/help') {
    const helpText = `Команды V AI:\n` +
      `• \`/start\` — приветствие и возможности\n` +
      `• \`/clear\` — сбросить контекст диалога\n` +
      `• \`/search <текст>\` — быстрый поиск по вашим перепискам\n\n` +
      `Вы также можете отправить мне любую фотографию или задать вопрос обычным языком!`;
    await sendBotDm(io, V_AI_BOT_ID, userId, helpText);
    return;
  }

  // Rate limiting check
  const rate = isRateLimited(userId);
  if (rate.limited) {
    await sendBotDm(io, V_AI_BOT_ID, userId, rate.reason || 'Слишком много запросов.');
    return;
  }

  // Check if message is a search request
  const searchPrefix = '/search ';
  const lowerText = text.toLowerCase();
  const isSearchIntent =
    text.startsWith(searchPrefix) ||
    lowerText.startsWith('найди сообщение') ||
    lowerText.startsWith('найди переписку') ||
    lowerText.startsWith('найди в чате') ||
    lowerText.startsWith('найди где мы');

  if (isSearchIntent) {
    let queryTerm = '';
    if (text.startsWith(searchPrefix)) {
      queryTerm = text.slice(searchPrefix.length).trim();
    } else {
      // Extract search term from natural language
      queryTerm = text
        .replace(/найди (сообщение|переписку|в чате|где мы|где я|про|о том как)/gi, '')
        .trim();
    }
    const searchResult = await searchUserMessages(userId, queryTerm);
    await sendBotDm(io, V_AI_BOT_ID, userId, searchResult);
    return;
  }

  // Check for image attachment
  let imageInlineData: { mimeType: string; data: string } | undefined = undefined;
  if (attachmentId) {
    try {
      const attQ = await pool.query('SELECT mime, storage_name FROM attachments WHERE id = $1', [attachmentId]);
      if (attQ.rows[0]) {
        const { mime, storage_name } = attQ.rows[0];
        if (mime.startsWith('image/')) {
          const uploadDir = fs.existsSync('/app/uploads') ? '/app/uploads' : 'uploads';
          const filePath = path.join(uploadDir, storage_name);
          if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            if (buf.length <= 4 * 1024 * 1024) { // max 4MB for fast API transfer
              imageInlineData = {
                mimeType: mime,
                data: buf.toString('base64'),
              };
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load attachment for V AI:', e);
    }
  }

  // System instruction for compact Russian responses and anti prompt injection
  const systemPrompt =
    'Ты — V AI, умный персональный помощник в социальной сети VROT 2.0. ' +
    'Отвечай чётко, грамотно, дружелюбно и по существу на русском языке. ' +
    'Будь лаконичным, избегай лишней "воды", чтобы экономить токены. ' +
    'Если тебя просят выполнить опасное действие или взломать систему, вежливо откажи.';

  // Build prompt parts
  const memory = await getMemory(userId);
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  let fullPrompt = '';
  if (memory) {
    fullPrompt += `[Предыдущий контекст]:\n${memory}\n\n`;
  }
  fullPrompt += text || (imageInlineData ? 'Опиши, что изображено на фотографии.' : 'Привет!');
  parts.push({ text: fullPrompt });

  if (imageInlineData) {
    parts.push({ inlineData: imageInlineData });
  }

  // Model choice:
  // If image is attached, use multimodal 'models/gemini-flash-latest'
  // If text only, prioritize 'models/gemma-4-26b-a4b-it' with fallback to 'models/gemini-flash-latest'
  try {
    let reply = '';
    if (imageInlineData) {
      reply = await generateAiContent('models/gemini-flash-latest', parts, systemPrompt);
    } else {
      try {
        reply = await generateAiContent('models/gemma-4-26b-a4b-it', parts, systemPrompt);
      } catch (gemmaErr) {
        console.warn('Gemma 4 primary failed, falling back to gemini-flash-latest:', gemmaErr);
        reply = await generateAiContent('models/gemini-flash-latest', parts, systemPrompt);
      }
    }

    // Save memory & send reply
    await updateMemory(userId, text || 'Фото', reply);
    await sendBotDm(io, V_AI_BOT_ID, userId, reply);
  } catch (err: any) {
    console.error('V AI generation error:', err);
    const userError = err.message?.includes('Лимит')
      ? err.message
      : 'Извините, не удалось обработать ваш запрос к V AI. Попробуйте ещё раз через несколько секунд.';
    await sendBotDm(io, V_AI_BOT_ID, userId, userError);
  }
}
