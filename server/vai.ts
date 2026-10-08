import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { pool } from './db.js';
import { decrypt } from './crypto.js';
import { sendBotDm } from './bots.js';

export const V_AI_BOT_ID = '571e0139-02bf-498f-acab-87582cfcb7b0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42STlDRWI4ZEx5anhLZ2VoSjNtLWV6clN3RkJaSDlTX1JTaFBXbVZRMDVWdWc=', 'base64').toString('utf8');

// Base URL for API requests. Defaults to the Cloudflare Worker relay to bypass geo-blocks.
const AI_RELAY_BASE = process.env.AI_RELAY_BASE || 'https://ai.vrot.fun';

// In-memory rate limiter (25 RPM global limit, 2s per-user cooldown)
const recentRequests: number[] = [];
const userLastRequest = new Map<string, number>();

function isRateLimited(userId: string): { limited: boolean; reason?: string } {
  const now = Date.now();
  // Per-user cooldown: 2 seconds between queries
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

// Call Google Generative AI via relay or direct endpoint
async function generateAiContent(
  model: string,
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
  systemInstruction?: string,
  reqId = randomUUID().slice(0, 8)
): Promise<string> {
  const startTime = Date.now();
  const url = `${AI_RELAY_BASE}/v1beta/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body: any = {
    contents: [{ parts }],
    generationConfig: {
      maxOutputTokens: 1200,
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
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VROT-AI/2.1',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error(`[V_AI_ERR:${reqId}] model=${model} status=${response.status} duration=${durationMs}ms`);
    if (response.status === 429) {
      throw new Error('Лимит бесплатных запросов к ИИ временно исчерпан. Пожалуйста, подождите минуту.');
    }
    if (response.status === 400 && errText.includes('location')) {
      throw new Error('Сервис временно недоступен в вашем регионе.');
    }
    throw new Error(`API error ${response.status}`);
  }

  const data: any = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Пустой ответ от нейросети.');

  console.log(`[V_AI_OK:${reqId}] model=${model} duration=${durationMs}ms tokens_out=${data?.usageMetadata?.candidatesTokenCount || 'N/A'}`);
  return text.trim();
}

// Search user's messages strictly with privacy enforcement
async function searchUserMessages(userId: string, query: string): Promise<string> {
  const cleanQ = query.trim().toLowerCase();
  if (!cleanQ || cleanQ.length < 2) {
    return 'Уточните, что именно вы хотите найти в ваших сообщениях.';
  }

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
     LIMIT 250`,
    [userId, V_AI_BOT_ID]
  );

  const matched: Array<{ text: string; author: string; date: string; id: string }> = [];

  for (const row of q.rows) {
    try {
      const decrypted = decrypt(row.content_enc);
      if (decrypted.toLowerCase().includes(cleanQ)) {
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
        if (matched.length >= 5) break; // Limit to 5 most relevant matches
      }
    } catch {}
  }

  if (matched.length === 0) {
    return `По запросу «${query}» в ваших личных переписках ничего не найдено.`;
  }

  let result = `🔎 Вот что я нашёл в ваших сообщениях по запросу «${query}»:\n\n`;
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
       compact_summary = RIGHT(COALESCE(v_ai_memory.compact_summary, '') || $2, 600),
       last_interaction_at = now(),
       turns_count = v_ai_memory.turns_count + 1`,
    [userId, turn]
  );
}

// Detect search intent naturally
function extractSearchQuery(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('/search ')) {
    return trimmed.slice('/search '.length).trim();
  }

  // Regex patterns for natural search intent in Russian
  const patterns = [
    /^(?:найди|поищи|найди мне|найди пожалуйста)\s+(?:сообщение|сообщения|переписку|где|про|о том как|о том|в чате|информацию)?\s*(.+)/i,
    /^(?:где\s+(?:мы|я|было)|что\s+(?:мы|я|ты)\s+(?:писали|обсуждали|говорили))\s+(?:про|о|об)?\s*(.+)/i,
    /^(?:поиск|ищи)\s*:\s*(.+)/i,
  ];

  for (const p of patterns) {
    const match = trimmed.match(p);
    if (match && match[1] && match[1].trim().length > 1) {
      return match[1].trim().replace(/[?!.]+$/, '');
    }
  }

  return null;
}

// Main processing function for incoming message to V AI
export async function processVAIMessage(
  io: Server,
  userId: string,
  content: string,
  attachmentId?: string | null
) {
  const text = (content || '').trim();
  const reqId = randomUUID().slice(0, 8);

  // Optional slash commands for backwards compatibility
  if (text === '/start') {
    const welcome = `Привет! Я **V AI** — твой персональный ИИ-помощник в VROT 2.1 ⚡️\n\n` +
      `Я умею:\n` +
      `• Общаться естественным языком и отвечать на любые вопросы\n` +
      `• Находить информацию в твоих переписках (просто напиши: «Найди где мы говорили про билеты»)\n` +
      `• Анализировать фотографии и картинки (просто пришли изображение)\n` +
      `• Помогать с текстами, идеями и кодом\n\n` +
      `Никаких специальных команд вводить не нужно — просто пиши как обычному собеседнику!`;
    await sendBotDm(io, V_AI_BOT_ID, userId, welcome);
    return;
  }

  if (text === '/clear') {
    await pool.query('DELETE FROM v_ai_memory WHERE user_id = $1', [userId]);
    await sendBotDm(io, V_AI_BOT_ID, userId, 'Память нашего диалога очищена. Начнём с чистого листа!');
    return;
  }

  if (text === '/help') {
    const helpText = `Я — V AI, искусственный интеллект социальной сети VROT.\n\n` +
      `Вы можете общаться со мной совершенно естественно без всяких команд:\n` +
      `• Задавайте любые вопросы\n` +
      `• Присылайте фотографии для описания и анализа\n` +
      `• Просите найти сообщения в ваших чатах («Найди сообщение про поездку»)\n\n` +
      `Команды для управления: \`/clear\` — очистить контекст диалога.`;
    await sendBotDm(io, V_AI_BOT_ID, userId, helpText);
    return;
  }

  // Rate limiting check
  const rate = isRateLimited(userId);
  if (rate.limited) {
    await sendBotDm(io, V_AI_BOT_ID, userId, rate.reason || 'Слишком много запросов.');
    return;
  }

  // Check if message is a natural search request
  const searchQuery = extractSearchQuery(text);
  if (searchQuery) {
    console.log(`[V_AI_SEARCH:${reqId}] user=${userId} query="${searchQuery.slice(0, 40)}"`);
    const searchResult = await searchUserMessages(userId, searchQuery);
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

  // System instruction for compact Russian responses and safety
  const systemPrompt =
    'Ты — V AI, умный персональный помощник в социальной сети VROT 2.1. ' +
    'Отвечай чётко, грамотно, дружелюбно и по существу на русском языке. ' +
    'Будь лаконичным, избегай лишней "воды". ' +
    'Если тебя просят выполнить опасное действие или взломать систему, вежливо откажи.';

  // Build prompt parts
  const memory = await getMemory(userId);
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  let fullPrompt = '';
  if (memory) {
    fullPrompt += `[Контекст предыдущего общения]:\n${memory}\n\n`;
  }
  fullPrompt += text || (imageInlineData ? 'Опиши, что изображено на этой фотографии.' : 'Привет!');
  parts.push({ text: fullPrompt });

  if (imageInlineData) {
    parts.push({ inlineData: imageInlineData });
  }

  // Model choice:
  // - If image is attached: use multimodal 'models/gemini-flash-latest' (fallback to 'models/gemini-flash-lite-latest')
  // - If text only: use primary 'models/gemma-4-26b-a4b-it' (fallback to 'models/gemini-flash-latest' or 'models/gemini-flash-lite-latest')
  try {
    let reply = '';
    if (imageInlineData) {
      try {
        reply = await generateAiContent('models/gemini-flash-latest', parts, systemPrompt, reqId);
      } catch {
        reply = await generateAiContent('models/gemini-flash-lite-latest', parts, systemPrompt, reqId);
      }
    } else {
      try {
        reply = await generateAiContent('models/gemma-4-26b-a4b-it', parts, systemPrompt, reqId);
      } catch (gemmaErr) {
        console.warn(`[V_AI_FALLBACK:${reqId}] Gemma 4 failed, falling back to gemini-flash-latest`);
        try {
          reply = await generateAiContent('models/gemini-flash-latest', parts, systemPrompt, reqId);
        } catch {
          reply = await generateAiContent('models/gemini-flash-lite-latest', parts, systemPrompt, reqId);
        }
      }
    }

    // Save memory & send reply
    await updateMemory(userId, text || 'Фото', reply);
    await sendBotDm(io, V_AI_BOT_ID, userId, reply);
  } catch (err: any) {
    console.error(`[V_AI_FAIL:${reqId}] user=${userId} error=`, err?.message || err);
    const userError = err.message?.includes('Лимит')
      ? err.message
      : 'Извините, не удалось обработать ваш запрос к V AI. Попробуйте ещё раз через несколько секунд.';
    await sendBotDm(io, V_AI_BOT_ID, userId, userError);
  }
}
