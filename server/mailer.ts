import nodemailer from 'nodemailer';
import { createHmac } from 'node:crypto';

const smtpHost = process.env.SMTP_HOST || '';
const mailer = smtpHost
  ? nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT || 25),
      secure: process.env.SMTP_SECURE === 'true',
      ignoreTLS: smtpHost === 'host.docker.internal',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' }
        : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    })
  : null;

const SMTP_FROM = process.env.SMTP_FROM || 'VROT <noreply@vrot.fun>';

async function deliverMail(to: string, subject: string, text: string, html: string, code: string = '000000'): Promise<boolean> {
  const relayUrl = process.env.MAIL_RELAY_URL;
  if (relayUrl) {
    const secret = process.env.TURN_SECRET;
    if (secret) {
      try {
        const body = JSON.stringify({ to, subject, text, html, code });
        const timestamp = String(Date.now());
        const key = createHmac('sha256', secret).update('vrot-mail-relay-v1').digest();
        const signature = createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex');
        const response = await fetch(relayUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-vrot-time': timestamp,
            'x-vrot-signature': signature,
          },
          body,
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) return true;
        console.warn('Mail relay returned non-OK status:', response.status);
      } catch (e) {
        console.warn('Mail relay delivery error:', e);
      }
    }
  }

  if (mailer) {
    try {
      await mailer.sendMail({ from: SMTP_FROM, to, subject, text, html });
      return true;
    } catch (e) {
      console.warn('Direct SMTP delivery error:', e);
    }
  }

  // Fallback log for development / audit
  console.log(`[MAIL DISPATCHED] To: ${to} | Subject: "${subject}" | Code: ${code}\n${text}`);
  return false;
}

function baseHtmlTemplate(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #0b0e14; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f2f3f5; }
    .container { max-width: 540px; margin: 40px auto; background: linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)); border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; padding: 36px 30px; box-shadow: 0 16px 40px rgba(0,0,0,0.5); }
    .logo { font-size: 24px; font-weight: 800; letter-spacing: 2px; color: #5865f2; margin-bottom: 24px; }
    h1 { font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 0; }
    p { font-size: 14px; line-height: 1.6; color: #b5bac1; }
    .code-box { background: rgba(88,101,242,0.15); border: 1px solid rgba(88,101,242,0.4); border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0; }
    .code { font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #ffffff; font-family: monospace; }
    .btn { display: inline-block; background: #5865f2; color: #ffffff !important; text-decoration: none; padding: 14px 28px; border-radius: 12px; font-weight: 600; font-size: 15px; margin: 20px 0; }
    .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 12px; color: #72767d; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">VROT</div>
    ${bodyContent}
    <div class="footer">
      Это автоматическое сообщение от социальной сети VROT.<br>
      Если вы не совершали данное действие, немедленно проверьте активные сеансы.
    </div>
  </div>
</body>
</html>`;
}

export async function sendVerificationEmail(to: string, username: string, token: string, code: string = ''): Promise<boolean> {
  const origin = process.env.PUBLIC_ORIGIN || 'https://vrot.fun';
  const link = `${origin}/verify-email?token=${token}`;
  const subject = 'Подтверждение email в VROT';
  const text = code
    ? `Здравствуйте, ${username}!\n\nВаш 6-значный код подтверждения email в VROT: ${code}\n\nЛибо перейдите по прямой ссылке для подтверждения:\n${link}\n\nКод и ссылка действительны 24 часа. Если вы не регистрировались на VROT, проигнорируйте это письмо.`
    : `Здравствуйте, ${username}!\n\nДля подтверждения вашего адреса электронной почты в VROT перейдите по ссылке:\n${link}\n\nСсылка действительна 24 часа. Если вы не регистрировались на VROT, проигнорируйте это письмо.`;

  const codeHtml = code ? `
    <div class="code-box">
      <div class="code">${code}</div>
    </div>
    <p style="text-align: center; color: #b5bac1;">Введите этот 6-значный код на сайте или подтвердите нажатием кнопки:</p>
  ` : '';

  const html = baseHtmlTemplate('Подтверждение email', `
    <h1>Подтверждение почты</h1>
    <p>Здравствуйте, <b>${username}</b>! Спасибо за регистрацию в социальной сети VROT.</p>
    ${codeHtml}
    <div style="text-align: center;">
      <a href="${link}" class="btn">Подтвердить email</a>
    </div>
    <p style="font-size: 12px; margin-top: 16px;">Или перейдите по ссылке: <a href="${link}" style="color: #5865f2;">${link}</a></p>
  `);
  return deliverMail(to, subject, text, html, code || '000000');
}

export async function sendPasswordResetEmail(to: string, code: string): Promise<boolean> {
  const origin = process.env.PUBLIC_ORIGIN || 'https://vrot.fun';
  const link = `${origin}/reset-password?email=${encodeURIComponent(to)}&code=${code}`;
  const subject = 'Код восстановления пароля VROT';
  const text = `Ваш код для восстановления пароля VROT: ${code}\n\nОн действует 10 минут.\nЛибо перейдите по ссылке: ${link}\n\nЕсли вы не запрашивали восстановление, проигнорируйте это письмо.`;
  const html = baseHtmlTemplate('Восстановление пароля', `
    <h1>Восстановление пароля</h1>
    <p>Вы запросили сброс пароля для вашей учетной записи VROT.</p>
    <div class="code-box">
      <div class="code">${code}</div>
    </div>
    <p>Код действует в течение 10 минут.</p>
    <div style="text-align: center;">
      <a href="${link}" class="btn">Сбросить пароль</a>
    </div>
  `);
  return deliverMail(to, subject, text, html, code);
}

export async function sendSecurityAlertEmail(
  to: string,
  username: string,
  eventType: 'new_login' | 'password_changed' | '2fa_enabled' | '2fa_disabled' | 'passkey_added',
  details: { device?: string; ip?: string; time?: string; location?: string } = {}
): Promise<boolean> {
  const origin = process.env.PUBLIC_ORIGIN || 'https://vrot.fun';
  const secLink = `${origin}/settings?tab=security`;

  let eventTitle = 'Уведомление о безопасности';
  let eventDesc = 'В вашем аккаунте VROT произошли изменения.';

  if (eventType === 'new_login') {
    eventTitle = 'Новый вход в ваш аккаунт VROT';
    eventDesc = 'Мы зафиксировали вход в ваш аккаунт с нового устройства или IP-адреса.';
  } else if (eventType === 'password_changed') {
    eventTitle = 'Пароль успешно изменён';
    eventDesc = 'Пароль от вашей учётной записи VROT был успешно обновлён.';
  } else if (eventType === '2fa_enabled') {
    eventTitle = 'Двухфакторная аутентификация включена';
    eventDesc = 'Для вашего аккаунта была активирована защита TOTP (двухфакторная аутентификация).';
  } else if (eventType === '2fa_disabled') {
    eventTitle = 'ВНИМАНИЕ: Двухфакторная аутентификация отключена';
    eventDesc = 'Двухфакторная аутентификация для вашего аккаунта была отключена.';
  } else if (eventType === 'passkey_added') {
    eventTitle = 'Добавлен новый Passkey (ключ доступа)';
    eventDesc = 'К вашей учётной записи был привязан новый биометрический ключ Passkey.';
  }

  const subject = eventTitle;
  const dev = details.device || 'Неизвестное устройство';
  const ip = details.ip || 'Не указан';
  const time = details.time || new Date().toLocaleString('ru-RU');
  const loc = details.location || 'Не определено';

  const text = `Здравствуйте, ${username}!\n\n${eventTitle}\n${eventDesc}\n\nУстройство: ${dev}\nIP-адрес: ${ip}\nПриблизительное местоположение: ${loc}\nДата и время: ${time}\n\nЕсли это были не вы, немедленно проверьте активные сеансы и смените пароль:\n${secLink}`;

  const html = baseHtmlTemplate(eventTitle, `
    <h1>${eventTitle}</h1>
    <p>Здравствуйте, <b>${username}</b>!</p>
    <p>${eventDesc}</p>
    <div style="background: rgba(255,255,255,0.04); border-radius: 12px; padding: 16px; margin: 18px 0; font-size: 13px;">
      <p style="margin: 4px 0;">📱 <b>Устройство:</b> ${dev}</p>
      <p style="margin: 4px 0;">🌐 <b>IP-адрес:</b> ${ip}</p>
      <p style="margin: 4px 0;">📍 <b>Местоположение:</b> ${loc}</p>
      <p style="margin: 4px 0;">🕒 <b>Время:</b> ${time}</p>
    </div>
    <div style="text-align: center;">
      <a href="${secLink}" class="btn">Проверить безопасность аккаунта</a>
    </div>
  `);

  return deliverMail(to, subject, text, html);
}
