# Vrot Bot Platform & aiogram 3.x Guide

Платформа ботов мессенджера Vrot полностью совместима с протоколом **Telegram Bot API**. Это позволяет разрабатывать ботов на языке **Python** с использованием современной асинхронной библиотеки **aiogram 3.x** (а также `python-telegram-bot`, `telebot` и др.), просто указав кастомный базовый сервер API `https://vrot.fun`.

---

## 1. Создание бота через BotFather

1. Откройте мессенджер Vrot (веб-версию на [vrot.fun](https://vrot.fun) или iOS-приложение).
2. Найдите в поиске или списке контактов **@BotFather** (официальный отец ботов Vrot).
3. Напишите команду `/start` или нажмите кнопку **«Создать нового бота»** (`/newbot`).
4. Введите отображаемое имя для бота (например, `Помощник`).
5. Введите юзернейм для бота. 
   - **Правило:** Юзернейм бота обязан заканчиваться на `bot` (например: `my_helper_bot` или `HelperBot`).
6. BotFather пришлет вам секретный **API токен** вида `vrot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

---

## 2. Быстрый старт на Python (aiogram 3.x)

### Установка зависимостей
```bash
pip install aiogram aiohttp
```

### Код бота (`bot.py`)
```python
import asyncio
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import CommandStart, Command
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer

# Токен, полученный от @BotFather в Vrot
BOT_TOKEN = "ВАШ_ТОКЕН_ОТ_BOTFATHER"

# Настройка сессии для работы с сервером Vrot
session = AiohttpSession(
    api=TelegramAPIServer.from_base("https://vrot.fun")
)

bot = Bot(token=BOT_TOKEN, session=session)
dp = Dispatcher()

# Обработчик команды /start
@dp.message(CommandStart())
async def handle_start(message: types.Message):
    # Создание Inline-кнопок
    keyboard = types.InlineKeyboardMarkup(
        inline_keyboard=[
            [
                types.InlineKeyboardButton(text="🔥 Нажми меня", callback_data="btn_click"),
                types.InlineKeyboardButton(text="🌐 Сайт Vrot", url="https://vrot.fun")
            ],
            [
                types.InlineKeyboardButton(text="ℹ️ Помощь", callback_data="btn_help")
            ]
        ]
    )
    
    await message.answer(
        f"👋 Привет, **{message.from_user.first_name}**!\n"
        f"Я бот в мессенджере Vrot, работающий на **aiogram 3.x**!\n\n"
        f"Попробуй нажать на кнопки ниже:",
        reply_markup=keyboard,
        parse_mode="Markdown"
    )

# Обработчик нажатия на Inline-кнопку
@dp.callback_query(F.data == "btn_click")
async def handle_callback_click(callback: types.CallbackQuery):
    await callback.answer("Кнопка успешно нажата! 🎉")
    await callback.message.answer("Вы нажали интерактивную кнопку!")

@dp.callback_query(F.data == "btn_help")
async def handle_callback_help(callback: types.CallbackQuery):
    await callback.answer()
    await callback.message.answer(
        "💡 **Справка:**\n"
        "Этот бот работает через кастомный TelegramAPIServer на базе https://vrot.fun.\n"
        "Поддерживаются текстовые сообщения, команды, inline-кнопки и callback-запросы."
    )

# Эхо-обработчик обычных текстовых сообщений
@dp.message()
async def handle_echo(message: types.Message):
    await message.answer(f"Ты написал: {message.text}")

async def main():
    print("Бот запускается на сервере Vrot...")
    # Очистка очереди обновлений и старт поллинга
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
```

---

## 3. Особенности и правила ботов в Vrot

1. **Юзернейм:**
   - Всегда оканчивается на `bot` (без учета регистра).
   - Обычные пользователи не могут занимать имена, оканчивающиеся на `bot`.
2. **Статус:**
   - Вместо статусов «в сети» / «был(а) недавно» у бота всегда отображается бейдж **«БОТ»**.
   - Точка онлайн-присутствия скрыта.
   - В профиле четко указано, что аккаунт является ботом.
3. **Галочки (Верификация):**
   - Бот может иметь статус проверенного (`verified: true`), в таком случае рядом с именем отображается синяя галочка верификации (как у @BotFather).
4. **Интерфейс:**
   - Поддерживаются Inline-кнопки (`inline_keyboard`) с переходом по внешним/внутренним ссылкам (`url`) и обработкой кликов (`callback_data`).
   - Кнопки отображаются как в веб-версии, так и в iOS-клиенте.

---

## 4. Поддерживаемые методы HTTP API

Эндпоинты доступны по адресам `https://vrot.fun/bot<TOKEN>/<METHOD>` и `https://vrot.fun/api/bot/<TOKEN>/<METHOD>`:

- `GET /getMe` — получение информации о боте.
- `GET/POST /getUpdates` — получение новых событий (long-polling, поддерживает `offset`, `limit`, `timeout`).
- `POST /sendMessage` — отправка сообщения (параметры: `chat_id`, `text`, `reply_markup`, `parse_mode`).
- `POST /editMessageText` — редактирование сообщения.
- `POST /answerCallbackQuery` — ответ на нажатие inline-кнопки (`callback_query_id`, `text`).
- `POST /setWebhook` — настройка вебхука (`url`, `secret_token`).
- `POST /deleteWebhook` — удаление вебхука.
- `GET /getWebhookInfo` — информация о вебхуке.
