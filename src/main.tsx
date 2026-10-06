import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
import "./styles.css";

// Keep a visible release marker so browsers/CDNs fetch a new hashed bundle
// after an emergency frontend deployment instead of reusing a stale script.
document.documentElement.dataset.vrotRelease = "2026-10-06.1";

type User = {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  bio?: string;
  status?: "online" | "idle" | "dnd" | "offline" | "bot";
  verified?: boolean;
  donator?: boolean;
  mrbeastBadge?: boolean;
  adminRole?: string;
  frozen?: boolean;
  isBot?: boolean;
  botCommands?: { command: string; description: string }[];
};
type Community = {
  id: string;
  name: string;
  description: string;
  role: string;
  avatarUrl?: string | null;
  verified?: boolean;
};
type Channel = {
  id: string;
  name: string;
  description?: string;
  avatarUrl?: string | null;
  kind: "text" | "voice";
};
type CommunityRole = {
  id: string;
  name: string;
  color: string;
  position: number;
  kind: "everyone" | "admin" | "custom";
  permissions: {
    sendMessages: boolean;
    joinVoice: boolean;
    invite: boolean;
    manageChannels: boolean;
  };
};
type MemberRole = Pick<CommunityRole, "id" | "name" | "color" | "position">;
type Attachment = {
  id: string;
  mime: string;
  name: string;
  size: number;
  url: string;
};
type MessageReaction = {
  emoji: string;
  count: number;
  users: string[];
  reacted: boolean;
};
type MessageReplyTo = {
  id: string;
  authorUsername: string;
  content: string;
  deleted: boolean;
};
type InlineKeyboardButton = {
  text: string;
  url?: string;
  callback_data?: string;
};
type ReplyMarkup = {
  inline_keyboard?: InlineKeyboardButton[][];
};
type Message = {
  id: string;
  content: string;
  created_at: string;
  deleted_at: string | null;
  replyTo?: MessageReplyTo | null;
  reactions?: MessageReaction[];
  attachment?: Attachment | null;
  replyMarkup?: ReplyMarkup;
  author: {
    id: string | null;
    username: string;
    avatarUrl?: string | null;
    verified?: boolean;
    donator?: boolean;
    mrbeastBadge?: boolean;
    isBot?: boolean;
  };
};
type Friend = {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string | null;
  presence?: "online" | "idle" | "dnd" | "offline" | "bot";
  verified?: boolean;
  donator?: boolean;
  mrbeastBadge?: boolean;
  isBot?: boolean;
  botCommands?: { command: string; description: string }[];
  status: "pending" | "accepted";
  direction: "incoming" | "outgoing";
};
type Member = {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string | null;
  presence?: "online" | "idle" | "dnd" | "offline" | "bot";
  verified?: boolean;
  donator?: boolean;
  mrbeastBadge?: boolean;
  isBot?: boolean;
  role: string;
  roles?: MemberRole[];
  joined_at: string;
};
type CallTarget = { kind: "channel" | "friend"; id: string };
type ActiveCall = { target: CallTarget; label: string; video: boolean; callId?: string };
type IncomingCall = { from: User; video: boolean; callId: string; expiresAt: number };
const tr = (ru: string, en: string) => localStorage.getItem("vrot_language") === "en" ? en : ru;
type CommunityInvitation = {
  id: string;
  communityId: string;
  communityName: string;
  inviterUsername: string;
  inviterAvatarUrl?: string | null;
  createdAt: string;
};
type Config = {
  registrationMode: string;
  minimumAge: number;
  siteName?: string;
  siteSlogan?: string;
  announcement?: string;
  customLogoUrl?: string | null;
  customFaviconUrl?: string | null;
  operator: { name: string; inn: string; email: string; address: string };
};
type AdminUser = User & {
  email: string;
  createdAt: string;
  banned: boolean;
  banReason?: string;
  donator?: boolean;
  mrbeastBadge?: boolean;
};
const API_ORIGIN =
  typeof window !== "undefined" &&
  ["vrot.fun", "www.vrot.fun"].includes(window.location.hostname)
    ? "https://api.vrot.fun"
    : "";
const apiUrl = (url: string) =>
  url.startsWith("/api/") ? `${API_ORIGIN}${url}` : url;
function normalizeApiUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeApiUrls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === "string" && key.toLowerCase().endsWith("url")
          ? apiUrl(item)
          : normalizeApiUrls(item),
      ]),
    );
  return value;
}
async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const r = await fetch(apiUrl(url), {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || "Ошибка запроса");
  }
  if (r.status === 204) return undefined as T;
  return normalizeApiUrls(await r.json()) as T;
}
async function uploadFile(file: File) {
  if (file.size > 20 * 1024 * 1024)
    throw new Error("Файл должен быть меньше 20 МБ");
  const r = await fetch(apiUrl("/api/uploads"), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Не удалось загрузить файл");
  return normalizeApiUrls(d) as Attachment;
}

if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function subscribeToPush(
  requestPermissionIfNeeded: boolean = false,
): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window))
    return false;
  try {
    let perm = Notification.permission;
    if (perm !== "granted") {
      if (!requestPermissionIfNeeded) return false;
      perm = await Notification.requestPermission();
      if (perm !== "granted") return false;
    }

    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      const keyData = await api<{ publicKey: string }>(
        "/api/push/public-key",
      ).catch(() => null);
      if (keyData?.publicKey && "PushManager" in window) {
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
          });
        }
        const json = sub.toJSON();
        if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
          await api("/api/push/subscriptions", {
            method: "POST",
            body: JSON.stringify({
              endpoint: json.endpoint,
              keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
            }),
          }).catch(() => {});
        }
      }
      if (requestPermissionIfNeeded) {
        await reg
          .showNotification("VROT: Уведомления включены!", {
            body: "Теперь вы будете получать сообщения и звонки прямо в систему.",
            icon: "/icon.svg",
            badge: "/icon.svg",
            tag: "vrot-welcome",
          })
          .catch(() => {});
      }
      return true;
    } else {
      if (requestPermissionIfNeeded) {
        new Notification("VROT: Уведомления включены!", {
          body: "Теперь вы будете получать сообщения и звонки прямо в систему.",
          icon: "/icon.svg",
        });
      }
      return true;
    }
  } catch (err) {
    console.warn("Push subscription failed:", err);
  }
  return false;
}

const FaqContext = React.createContext<(topic?: string) => void>(() => {});
export const useFaq = () => React.useContext(FaqContext);

function VrotLogo({
  className = "",
  size = 28,
  customUrl,
}: {
  className?: string;
  size?: number;
  customUrl?: string | null;
}) {
  if (customUrl) {
    return (
      <img
        src={apiUrl(customUrl)}
        alt="VROT"
        className={`vrot-logo-img ${className}`}
        style={{ width: size, height: size, objectFit: "contain" }}
      />
    );
  }
  return (
    <svg
      className={`vrot-logo-svg ${className}`}
      width={size}
      height={size}
      viewBox="0 0 2000 2000"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M909.57 700.015C893.135 684.954 893.135 659.046 909.57 643.985L1287.83 297.34C1312.2 275.003 1351.5 292.293 1351.5 325.355V1018.64C1351.5 1051.71 1312.2 1069 1287.83 1046.66L909.57 700.015Z" />
      <path d="M1090.43 1299.98C1106.86 1315.05 1106.86 1340.95 1090.43 1356.02L712.174 1702.66C687.8 1725 648.5 1707.71 648.5 1674.64L648.5 981.355C648.5 948.293 687.799 931.003 712.174 953.34L1090.43 1299.98Z" />
    </svg>
  );
}

function FormattedText({ text }: { text: string }) {
  const [spoilerRevealed, setSpoilerRevealed] = useState<
    Record<number, boolean>
  >({});

  const elements = useMemo(() => {
    if (!text) return null;

    // Check for code blocks ```...``` first
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, pIdx) => {
      if (part.startsWith("```") && part.endsWith("```")) {
        const codeContent = part.slice(3, -3).replace(/^\n/, "");
        return (
          <pre key={`pre-${pIdx}`}>
            <code>{codeContent}</code>
          </pre>
        );
      }

      // Process lines for blockquotes
      const lines = part.split("\n");
      return (
        <span key={`p-${pIdx}`}>
          {lines.map((line, lIdx) => {
            const isQuote = line.startsWith("> ");
            const lineContent = isQuote ? line.slice(2) : line;

            // Tokenize inline markdown: **bold**, *italic*, ~~strike~~, `code`, ||spoiler||, URL
            const tokens = lineContent.split(
              /(\*\*.*?\*\*|\*.*?\*|~~.*?~~|`.*?`|\|\|.*?\|\||https?:\/\/[^\s]+)/g,
            );

            const renderedTokens = tokens.map((token, tIdx) => {
              if (
                token.startsWith("**") &&
                token.endsWith("**") &&
                token.length >= 4
              ) {
                return <strong key={tIdx}>{token.slice(2, -2)}</strong>;
              }
              if (
                token.startsWith("*") &&
                token.endsWith("*") &&
                token.length >= 2
              ) {
                return <em key={tIdx}>{token.slice(1, -1)}</em>;
              }
              if (
                token.startsWith("~~") &&
                token.endsWith("~~") &&
                token.length >= 4
              ) {
                return <del key={tIdx}>{token.slice(2, -2)}</del>;
              }
              if (
                token.startsWith("`") &&
                token.endsWith("`") &&
                token.length >= 2
              ) {
                return <code key={tIdx}>{token.slice(1, -1)}</code>;
              }
              if (
                token.startsWith("||") &&
                token.endsWith("||") &&
                token.length >= 4
              ) {
                const spKey = pIdx * 1000 + lIdx * 50 + tIdx;
                const revealed = Boolean(spoilerRevealed[spKey]);
                return (
                  <span
                    key={tIdx}
                    className={`spoiler ${revealed ? "revealed" : ""}`}
                    onClick={() =>
                      setSpoilerRevealed((prev) => ({
                        ...prev,
                        [spKey]: !prev[spKey],
                      }))
                    }
                    title={revealed ? "Спойлер" : "Нажмите, чтобы показать"}
                  >
                    {token.slice(2, -2)}
                  </span>
                );
              }
              if (/^https?:\/\/[^\s]+$/.test(token)) {
                return (
                  <a
                    key={tIdx}
                    href={token}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {token}
                  </a>
                );
              }
              return token;
            });

            if (isQuote) {
              return (
                <blockquote key={`q-${lIdx}`}>{renderedTokens}</blockquote>
              );
            }

            return (
              <React.Fragment key={`l-${lIdx}`}>
                {lIdx > 0 && "\n"}
                {renderedTokens}
              </React.Fragment>
            );
          })}
        </span>
      );
    });
  }, [text, spoilerRevealed]);

  return <span className="formatted-text">{elements}</span>;
}

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🔥", "💎", "🚀", "🎉", "💩"];

function MessageActions({
  message,
  currentUserId,
  canDelete,
  onReply,
  onReact,
  onDelete,
}: {
  message: Message;
  currentUserId: string;
  canDelete: boolean;
  onReply: (m: Message) => void;
  onReact: (emoji: string) => void;
  onDelete: (id: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);

  return (
    <div className="message-actions-bar" onClick={(e) => e.stopPropagation()}>
      {showPicker && (
        <div className="reaction-popover">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="reaction-picker-btn"
              onClick={() => {
                onReact(emoji);
                setShowPicker(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="msg-act-btn"
        title="Добавить реакцию"
        onClick={() => setShowPicker(!showPicker)}
      >
        😊
      </button>
      <button
        type="button"
        className="msg-act-btn"
        title="Ответить"
        onClick={() => onReply(message)}
      >
        ↩️
      </button>
      {canDelete && !message.deleted_at && (
        <button
          type="button"
          className="msg-act-btn danger"
          title="Удалить сообщение"
          onClick={() => onDelete(message.id)}
        >
          🗑️
        </button>
      )}
    </div>
  );
}

function FormattingBar({
  onInsert,
}: {
  onInsert: (before: string, after: string) => void;
}) {
  return (
    <div className="formatting-bar">
      <button
        type="button"
        className="format-btn"
        title="Жирный (**текст**)"
        onClick={() => onInsert("**", "**")}
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        className="format-btn"
        title="Курсив (*текст*)"
        onClick={() => onInsert("*", "*")}
      >
        <em>I</em>
      </button>
      <button
        type="button"
        className="format-btn"
        title="Зачёркнутый (~~текст~~)"
        onClick={() => onInsert("~~", "~~")}
      >
        <del>S</del>
      </button>
      <button
        type="button"
        className="format-btn"
        title="Код (`код`)"
        onClick={() => onInsert("`", "`")}
      >
        &lt;/&gt;
      </button>
      <button
        type="button"
        className="format-btn"
        title="Спойлер (||спойлер||)"
        onClick={() => onInsert("||", "||")}
      >
        👁️
      </button>
      <button
        type="button"
        className="format-btn"
        title="Цитата (> цитата)"
        onClick={() => onInsert("> ", "")}
      >
        ❝
      </button>
    </div>
  );
}

function MessageItem({
  message,
  currentUserId,
  canDelete,
  roleColor,
  onReply,
  onReact,
  onDelete,
  onJumpToMessage,
}: {
  message: Message;
  currentUserId: string;
  canDelete: boolean;
  roleColor?: string;
  onReply: (m: Message) => void;
  onReact: (m: Message, emoji: string) => void;
  onDelete: (id: string) => void;
  onJumpToMessage?: (id: string) => void;
}) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - touchStart.current.x;
    const dy = e.touches[0].clientY - touchStart.current.y;
    // Only handle horizontal left-swipe
    if (Math.abs(dx) > Math.abs(dy) && dx < 0) {
      const limited = Math.max(-80, dx);
      setSwipeOffset(limited);
    }
  };

  const handleTouchEnd = () => {
    if (swipeOffset < -45) {
      onReply(message);
    }
    setSwipeOffset(0);
    touchStart.current = null;
  };

  return (
    <article
      id={`msg-${message.id}`}
      className={`message ${swipeOffset < -20 ? "swiping" : ""}`}
      style={{
        transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <span className="swipe-reply-icon">↩️</span>
      <ProfileButton user={message.author} small />
      <div style={{ minWidth: 0, width: "100%" }}>
        {message.replyTo && (
          <div
            className="message-reply-quote"
            onClick={() => onJumpToMessage?.(message.replyTo!.id)}
            title="Перейти к сообщению"
          >
            <div className="reply-spine" />
            <span className="reply-quote-author">
              @{message.replyTo.authorUsername}
            </span>
            <span className="reply-quote-snippet">
              {message.replyTo.deleted
                ? "[удалённое сообщение]"
                : message.replyTo.content || "[вложение]"}
            </span>
          </div>
        )}
        <div>
          <strong style={roleColor ? { color: roleColor } : undefined}>
            {message.author.username}
            <UserBadges user={message.author} />
          </strong>{" "}
          <time>
            {new Date(message.created_at).toLocaleString("ru-RU", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        {(message.deleted_at || message.content) && (
          <div className={message.deleted_at ? "deleted" : ""}>
            {message.deleted_at ? (
              <em>Сообщение удалено</em>
            ) : (
              <FormattedText text={message.content} />
            )}
          </div>
        )}
        {!message.deleted_at && message.attachment && (
          <AttachmentView file={message.attachment} />
        )}
        {!message.deleted_at && message.replyMarkup?.inline_keyboard && (
          <div className="message-inline-keyboard">
            {message.replyMarkup.inline_keyboard.map((row, rowIdx) => (
              <div key={rowIdx} className="inline-keyboard-row">
                {row.map((btn, btnIdx) => (
                  <button
                    key={btnIdx}
                    type="button"
                    className="inline-keyboard-button"
                    onClick={async () => {
                      if (btn.url) {
                        if (btn.url.startsWith('/') || btn.url.startsWith('?')) {
                          window.location.href = btn.url;
                        } else {
                          window.open(btn.url, "_blank", "noopener,noreferrer");
                        }
                      } else if (btn.callback_data) {
                        try {
                          await api("/api/bots/callback", {
                            method: "POST",
                            body: JSON.stringify({
                              messageId: message.id,
                              authorId: message.author.id,
                              callbackData: btn.callback_data,
                            }),
                          });
                        } catch (e) {
                          console.error("Callback error", e);
                        }
                      }
                    }}
                  >
                    {btn.text}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {!message.deleted_at &&
          message.reactions &&
          message.reactions.length > 0 && (
            <div className="message-reactions">
              {message.reactions.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  className={`reaction-badge ${r.reacted ? "reacted" : ""}`}
                  onClick={() => onReact(message, r.emoji)}
                  title={r.users.join(", ")}
                >
                  <span>{r.emoji}</span>
                  <span className="reaction-count">{r.count}</span>
                </button>
              ))}
            </div>
          )}
      </div>
      {!message.deleted_at && (
        <MessageActions
          message={message}
          currentUserId={currentUserId}
          canDelete={canDelete}
          onReply={onReply}
          onReact={(emoji) => onReact(message, emoji)}
          onDelete={onDelete}
        />
      )}
    </article>
  );
}

function BadgeWithTooltip({
  type,
  onOpenFaq,
}: {
  type: "verified" | "donator";
  onOpenFaq?: (topic?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const openFaqContext = React.useContext(FaqContext);
  const handleOpenFaq = onOpenFaq || openFaqContext;

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = window.setTimeout(() => {
      setOpen(false);
    }, 280);
  };

  const isVerified = type === "verified";
  const title = isVerified ? "Верифицирован" : "Донатер проекта";
  const desc = isVerified
    ? "Данный пользователь верифицирован администрацией VROT."
    : "Пользователь пожертвовал деньги на разработку и развитие платформы VROT.";
  const topic = isVerified ? "verification" : "donations";

  return (
    <span
      className="badge-wrapper"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      role="button"
      tabIndex={0}
      aria-label={title}
    >
      <span className={isVerified ? "verified-badge" : "donator-badge"}>
        {isVerified ? "✓" : "💎"}
      </span>
      {open && (
        <span
          className="badge-tooltip"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="tooltip-header">
            <span
              className={
                isVerified ? "tooltip-icon verified" : "tooltip-icon donator"
              }
            >
              {isVerified ? "✓" : "💎"}
            </span>
            <strong>{title}</strong>
          </span>
          <span className="tooltip-desc">{desc}</span>
          <button
            type="button"
            className="tooltip-link"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              handleOpenFaq?.(topic);
            }}
          >
            Подробнее →
          </button>
        </span>
      )}
    </span>
  );
}

function UserBadges({
  user,
  onOpenFaq,
}: {
  user?: {
    verified?: boolean;
    donator?: boolean;
    mrbeastBadge?: boolean;
    isBot?: boolean;
  } | null;
  onOpenFaq?: (topic?: string) => void;
}) {
  if (!user || (!user.verified && !user.donator && !user.mrbeastBadge && !user.isBot))
    return null;
  return (
    <span className="user-badges">
      {user.isBot && (
        <span className="bot-badge" title="Официальный бот платформы VROT">
          БОТ
        </span>
      )}
      {user.verified && (
        <BadgeWithTooltip type="verified" onOpenFaq={onOpenFaq} />
      )}
      {user.donator && (
        <BadgeWithTooltip type="donator" onOpenFaq={onOpenFaq} />
      )}
      {user.mrbeastBadge && (
        <img
          className="mrbeast-badge"
          src="/mrbeast-badge.png"
          alt="Фан-бейдж MrBeast"
          title="Фан-бейдж MrBeast · неофициальный, без связи с MrBeast"
        />
      )}
    </span>
  );
}

function Avatar({
  user,
  small = false,
}: {
  user: { username: string; avatarUrl?: string | null };
  small?: boolean;
}) {
  return (
    <span className={`avatar${small ? " small" : ""}`}>
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" />
      ) : (
        user.username[0]?.toUpperCase()
      )}
    </span>
  );
}

function ProfileButton({
  user,
  small = false,
  label = false,
}: {
  user: {
    id?: string | null;
    username: string;
    displayName?: string;
    avatarUrl?: string | null;
    presence?: string;
    status?: string;
    verified?: boolean;
    donator?: boolean;
    role?: string;
    roles?: MemberRole[];
  };
  small?: boolean;
  label?: boolean;
}) {
  const [profile, setProfile] = useState<User | null>(null),
    [error, setError] = useState("");
  async function open() {
    if (!user.id) return;
    try {
      const result = await api<{ user: User }>(`/api/users/${user.id}/profile`);
      setProfile(result.user);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <button
        type="button"
        className={`profile-trigger${label ? " with-label" : ""}`}
        onClick={() => void open()}
        disabled={!user.id}
        aria-label={`Открыть профиль ${user.username}`}
      >
        <Avatar user={user} small={small} />
        {label && (
          <span>
            <strong
              style={
                user.roles?.[0]?.color
                  ? { color: user.roles[0].color }
                  : undefined
              }
            >
              {user.displayName || user.username}
              <UserBadges user={user} />
            </strong>
            <small>
              {!(user as any).isBot && user.presence !== 'bot' && user.status !== 'bot' && (
                <i
                  className={`presence ${
                    user.presence || user.status || "offline"
                  }`}
                />
              )}
              {((user as any).isBot || user.presence === 'bot' || user.status === 'bot') ? "Бот · " : ""}@{user.username}
            </small>
          </span>
        )}
      </button>
      {profile && (
        <ProfileCard
          user={profile}
          communityRoles={user.roles}
          communityBaseRole={user.role}
          close={() => setProfile(null)}
        />
      )}
      {error && (
        <div className="toast" role="alert" onClick={() => setError("")}>
          {error}
        </div>
      )}
    </>
  );
}

function ProfileCard({
  user,
  close,
  communityRoles,
  communityBaseRole,
}: {
  user: User;
  close: () => void;
  communityRoles?: MemberRole[];
  communityBaseRole?: string;
}) {
  const statusLabels: Record<string, string> = {
    online: "В сети",
    idle: "Не активен",
    dnd: "Не беспокоить",
    offline: "Не в сети",
    bot: "БОТ",
  };
  return (
    <div
      className="modal-backdrop profile-card-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className="profile-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Профиль ${user.username}`}
      >
        <button className="close" onClick={close} aria-label="Закрыть">
          ×
        </button>
        {user.bannerUrl ? (
          <img
            className="profile-card-banner"
            src={user.bannerUrl}
            alt="Шапка профиля"
          />
        ) : (
          <div className="profile-card-banner fallback" />
        )}
        <div className="profile-card-body">
          <Avatar user={user} />
          <h2>
            {user.displayName || user.username}
            <UserBadges user={user} />
          </h2>
          <p className="profile-handle">@{user.username}</p>
          <div className="profile-status">
            {user.isBot || user.status === 'bot' ? (
              <span className="bot-status-tag">БОТ ПЛАТФОРМЫ</span>
            ) : (
              <>
                <i className={`presence ${user.status || "offline"}`} />
                {statusLabels[user.status || "offline"]}
              </>
            )}
          </div>
          <hr />
          <h3>Обо мне</h3>
          <p>{user.bio || (user.isBot ? "Бот для платформы VROT." : "Пользователь пока ничего о себе не рассказал.")}</p>
          {user.adminRole && user.adminRole !== "user" && (
            <span className="role-chip">
              {user.adminRole === "owner"
                ? "Основатель"
                : user.adminRole === "admin"
                  ? "Администратор"
                  : "Модератор"}
            </span>
          )}
          {communityBaseRole && (
            <div className="profile-community-roles">
              <h3>Роли в сообществе</h3>
              {communityBaseRole === "owner" && (
                <span className="role-chip">Владелец</span>
              )}
              {communityBaseRole === "admin" && (
                <span className="role-chip">Администратор</span>
              )}
              {communityRoles?.length ? (
                communityRoles.map((r) => (
                  <span
                    key={r.id}
                    className="role-chip"
                    style={{ borderColor: r.color, color: r.color }}
                  >
                    {r.name}
                  </span>
                ))
              ) : communityBaseRole === "member" ? (
                <span className="role-chip">Участник</span>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
type IconName =
  | "friends"
  | "plus"
  | "settings"
  | "phone"
  | "video"
  | "mic"
  | "screen"
  | "send"
  | "back";
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, string> = {
    friends:
      "M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20a6 6 0 0 1 12 0v1H2v-1Zm13.5 1v-1c0-2-.7-3.8-1.9-5.2A5 5 0 0 1 22 18.5V21h-6.5Z",
    plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z",
    settings:
      "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm9 3.5-2.1-1.2.1-1.2-1.7-2.9-1.2.5-1-.7-.2-1.3h-3.4l-.2 1.3-1 .7-1.2-.5-1.7 2.9.1 1.2L3 12v3l2.1 1.2-.1 1.2 1.7 2.9 1.2-.5 1 .7.2 1.3h3.4l.2-1.3 1-.7 1.2.5 1.7-2.9-.1-1.2L21 15v-3Z",
    phone:
      "m7.1 3.6 2.1 4.8-2.5 1.5a15.8 15.8 0 0 0 7.4 7.4l1.5-2.5 4.8 2.1-.8 3.2c-.2.8-.9 1.4-1.8 1.4A15.3 15.3 0 0 1 2.5 6.2c0-.9.6-1.6 1.4-1.8l3.2-.8Z",
    video:
      "M3 6.5C3 5.7 3.7 5 4.5 5h10c.8 0 1.5.7 1.5 1.5v11c0 .8-.7 1.5-1.5 1.5h-10c-.8 0-1.5-.7-1.5-1.5v-11Zm14 4 4-2v7l-4-2v-3Z",
    mic: "M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm-7-4h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.92V21h-2v-3.08A7 7 0 0 1 5 11Z",
    screen: "M3 4h18v13H3V4Zm7 15h4l1 2H9l1-2Z",
    send: "m3 3 18 9-18 9 3-8 9-1-9-1-3-8Z",
    back: "m14.5 5-7 7 7 7",
  };
  return (
    <svg
      className="svg-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d={paths[name]}
        fill={name === "back" ? "none" : "currentColor"}
        stroke={name === "back" ? "currentColor" : "none"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ImageCropperModal({
  imageSrc,
  aspect,
  isCircle,
  title,
  onSave,
  onCancel,
}: {
  imageSrc: string;
  aspect: number;
  isCircle: boolean;
  title: string;
  onSave: (croppedDataUrl: string) => void;
  onCancel: () => void;
}) {
  const [imgSize, setImgSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, initialX: 0, initialY: 0 });
  const imgRef = useRef<HTMLImageElement>(null);

  const boxW = aspect === 1 ? 260 : 340;
  const boxH = aspect === 1 ? 260 : 120;

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setImgSize({ width: img.naturalWidth, height: img.naturalHeight });
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
    img.src = imageSrc;
  }, [imageSrc]);

  const baseScale = imgSize
    ? Math.min(boxW / imgSize.width, boxH / imgSize.height)
    : 1;
  const coverScale = imgSize
    ? Math.max(boxW / imgSize.width, boxH / imgSize.height)
    : 1;
  const coverZoomRatio =
    baseScale > 0 ? Number((coverScale / baseScale).toFixed(2)) : 1;

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      initialX: offset.x,
      initialY: offset.y,
    };
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setOffset({
      x: dragStart.current.initialX + dx,
      y: dragStart.current.initialY + dy,
    });
  }

  function handleMouseUp() {
    setDragging(false);
  }

  function handleTouchStart(e: React.TouchEvent) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    setDragging(true);
    dragStart.current = {
      x: touch.clientX,
      y: touch.clientY,
      initialX: offset.x,
      initialY: offset.y,
    };
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!dragging || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - dragStart.current.x;
    const dy = touch.clientY - dragStart.current.y;
    setOffset({
      x: dragStart.current.initialX + dx,
      y: dragStart.current.initialY + dy,
    });
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    setZoom((z) =>
      Math.max(0.2, Math.min(3.5, Number((z + delta).toFixed(2)))),
    );
  }

  function handleCrop() {
    if (!imgSize) return;
    const img = imgRef.current;
    if (!img) return;

    const outW = aspect === 1 ? 256 : 900;
    const outH = aspect === 1 ? 256 : 300;
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const scaleFactor = outW / boxW;
    ctx.fillStyle = "#1e1f22";
    ctx.fillRect(0, 0, outW, outH);

    const renderW = imgSize.width * baseScale * zoom * scaleFactor;
    const renderH = imgSize.height * baseScale * zoom * scaleFactor;
    const renderX = outW / 2 + offset.x * scaleFactor - renderW / 2;
    const renderY = outH / 2 + offset.y * scaleFactor - renderH / 2;

    ctx.drawImage(img, renderX, renderY, renderW, renderH);

    const quality = aspect === 1 ? 0.88 : 0.82;
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    onSave(dataUrl);
  }

  return (
    <div
      className="modal-backdrop cropper-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <section className="modal cropper-modal" role="dialog" aria-modal="true">
        <header className="cropper-header">
          <h3>{title}</h3>
          <button className="close" onClick={onCancel} aria-label="Закрыть">
            ×
          </button>
        </header>
        <p className="cropper-tip">
          100% — всё фото целиком. Вы можете уменьшать или увеличивать его:
        </p>
        <div
          className={`crop-viewport ${isCircle ? "circle-guide" : "rect-guide"}`}
          style={{ width: boxW, height: boxH }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleMouseUp}
        >
          {imgSize && (
            <img
              ref={imgRef}
              src={imageSrc}
              alt="Обрезка"
              className="crop-image"
              draggable={false}
              style={{
                left: `${boxW / 2 + offset.x}px`,
                top: `${boxH / 2 + offset.y}px`,
                width: `${imgSize.width * baseScale * zoom}px`,
                height: `${imgSize.height * baseScale * zoom}px`,
                transform: "translate(-50%, -50%)",
              }}
            />
          )}
          <div className="crop-overlay" />
        </div>
        <div className="cropper-controls">
          <div className="cropper-slider-row">
            <label>
              <span>Масштаб:</span>
              <strong>{Math.round(zoom * 100)}%</strong>
            </label>
            <button
              type="button"
              className="cropper-zoom-btn"
              title="Уменьшить"
              onClick={() =>
                setZoom((z) => Math.max(0.2, Number((z - 0.1).toFixed(2))))
              }
            >
              −
            </button>
            <input
              type="range"
              min="0.2"
              max="3.5"
              step="0.02"
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
            />
            <button
              type="button"
              className="cropper-zoom-btn"
              title="Увеличить"
              onClick={() =>
                setZoom((z) => Math.min(3.5, Number((z + 0.1).toFixed(2))))
              }
            >
              +
            </button>
          </div>
          <div className="cropper-presets">
            <button
              type="button"
              className={`cropper-preset-btn ${Math.abs(zoom - 1) < 0.03 ? "active" : ""}`}
              onClick={() => {
                setZoom(1);
                setOffset({ x: 0, y: 0 });
              }}
            >
              100% (Всё фото)
            </button>
            {coverZoomRatio > 1.05 && (
              <button
                type="button"
                className={`cropper-preset-btn ${Math.abs(zoom - coverZoomRatio) < 0.05 ? "active" : ""}`}
                onClick={() => {
                  setZoom(coverZoomRatio);
                  setOffset({ x: 0, y: 0 });
                }}
              >
                {isCircle ? "Заполнить круг" : "Заполнить рамку"}
              </button>
            )}
            {(offset.x !== 0 || offset.y !== 0) && (
              <button
                type="button"
                className="cropper-preset-btn"
                onClick={() => setOffset({ x: 0, y: 0 })}
              >
                По центру
              </button>
            )}
          </div>
        </div>
        <div className="cropper-actions">
          <button type="button" className="button subtle" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className="button" onClick={handleCrop}>
            Обрезать и сохранить
          </button>
        </div>
      </section>
    </div>
  );
}

function FaqModal({
  initialTopic = "verification",
  close,
}: {
  initialTopic?: string;
  close: () => void;
}) {
  const [topic, setTopic] = useState(initialTopic);

  const topics = [
    { id: "verification", title: "Верификация", icon: "✓" },
    { id: "donations", title: "Значок донатера", icon: "💎" },
    { id: "security", title: "Безопасность и 152-ФЗ", icon: "🛡️" },
    { id: "features", title: "Возможности VROT", icon: "🚀" },
    { id: "rules", title: "Правила платформы", icon: "📜" },
  ];

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className="modal faq-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="faq-title"
      >
        <button className="close" onClick={close} aria-label="Закрыть">
          ×
        </button>
        <h2 id="faq-title">Справочный центр и FAQ форум VROT</h2>
        <div className="faq-container">
          <nav className="faq-sidebar" aria-label="Категории FAQ">
            {topics.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`faq-nav-btn ${topic === t.id ? "active" : ""}`}
                onClick={() => setTopic(t.id)}
              >
                <span>{t.icon}</span>
                <span>{t.title}</span>
              </button>
            ))}
          </nav>
          <div className="faq-content">
            {topic === "verification" && (
              <div>
                <h3>✓ Верификация профилей и сообществ</h3>
                <p>
                  Синяя галочка верификации подтверждает подлинность профиля или
                  канала. Она выдаётся официальной администрацией платформы
                  VROT.
                </p>
                <div className="faq-box">
                  <h4>Кто может получить верификацию?</h4>
                  <p>
                    • Известные личности, авторы контента и блогеры
                    <br />
                    • Создатели официальных и тематических сообществ
                    <br />• Разработчики платформы и партнёры проекта
                  </p>
                </div>
                <div className="faq-box">
                  <h4>Как получить галочку?</h4>
                  <p>
                    Верификация выдаётся администрацией VROT. Чтобы подтвердить
                    свой статус, свяжитесь с администратором платформы через
                    личные сообщения или официальные контакты поддержки.
                  </p>
                </div>
              </div>
            )}
            {topic === "donations" && (
              <div>
                <h3>💎 Значок донатера и поддержка проекта</h3>
                <p>
                  Значок донатера (💎) выдаётся пользователям, которые внесли
                  добровольный вклад в развитие платформы VROT, поддержку
                  серверов и создание новых возможностей.
                </p>
                <div className="faq-box">
                  <h4>Что даёт значок донатера?</h4>
                  <p>
                    • Премиальный анимированный значок 💎 рядом с именем
                    пользователя в профиле, сообщениях, списках участников и
                    личных чатах
                    <br />
                    • Интерактивная подсказка с благодарностью администрации
                    <br />• Поддержка независимой разработки без навязчивой
                    рекламы
                  </p>
                </div>
                <div className="faq-box">
                  <h4>Как поддержать проект?</h4>
                  <p>
                    Значок назначается администратором после совершения
                    добровольного пожертвования на развитие серверов. Обратитесь
                    к администратору VROT для получения значка.
                  </p>
                </div>
              </div>
            )}
            {topic === "security" && (
              <div>
                <h3>🛡️ Безопасность данных и законность</h3>
                <p>
                  VROT спроектирован с упором на максимальную конфиденциальность
                  пользователей и полное соответствие законодательству РФ
                  (152-ФЗ, 149-ФЗ).
                </p>
                <div className="faq-box">
                  <h4>Ключевые принципы безопасности:</h4>
                  <p>
                    • Все сообщения шифруются при передаче и хранении
                    (AES-256-GCM)
                    <br />
                    • Прямые P2P голосовые и видеозвонки по WebRTC без записи на
                    сервере
                    <br />
                    • Никаких сторонних трекеров, рекламных пикселей и слежки
                    <br />• Полный экспорт и удаление всех данных по запросу
                  </p>
                </div>
              </div>
            )}
            {topic === "features" && (
              <div>
                <h3>🚀 Возможности мессенджера VROT</h3>
                <p>
                  VROT сочетает мощь голосовых сообществ в стиле Discord и
                  приватность личных зашифрованных диалогов.
                </p>
                <div className="faq-box">
                  <h4>Основные функции:</h4>
                  <p>
                    • Сервера сообществ, текстовые каналы и голосовые комнаты
                    <br />
                    • Личные сообщения с голосовыми заметками и отправкой файлов
                    <br />
                    • Трансляция экрана с автоматическим распознаванием
                    мобильной или альбомной ориентации и полноэкранным режимом
                    <br />
                    • Обрезка аватарок и шапок с выбором 100% области без
                    обрезания краёв
                    <br />• Нативное Android-приложение с системными входящими
                    звонками
                  </p>
                </div>
              </div>
            )}
            {topic === "rules" && (
              <div>
                <h3>📜 Правила платформы</h3>
                <p>
                  Сообщество VROT строится на взаимном уважении. Запрещены спам,
                  мошенничество, вредоносный контент и нарушения
                  законодательства РФ.
                </p>
                <div className="faq-box">
                  <p>
                    Администрация оставляет за собой право заморозить или
                    заблокировать аккаунты, нарушающие правила платформы.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}


function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined),
    [cfg, setCfg] = useState<Config | null>(null),
    [legal, setLegal] = useState<string | null>(null),
    [faqTopic, setFaqTopic] = useState<string | null>(null);

  const openFaq = (topic?: string) => setFaqTopic(topic || "verification");

  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem("vrot_theme") || "dark";
    document.documentElement.lang = localStorage.getItem("vrot_language") || "ru";
    Promise.all([
      api<{ user: User | null }>("/api/auth/me"),
      api<Config>("/api/config"),
    ])
      .then(([m, c]) => {
        setUser(m.user);
        setCfg(c);
      })
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!cfg) return;
    const faviconHref =
      cfg.customFaviconUrl || cfg.customLogoUrl || "/icon.svg";
    let link = document.querySelector(
      "link[rel*='icon']",
    ) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = apiUrl(faviconHref);
  }, [cfg?.customFaviconUrl, cfg?.customLogoUrl]);

  if (user === undefined || !cfg)
    return (
      <div className="center">
        <div className="spinner" aria-label="Загрузка" />
      </div>
    );

  return (
    <FaqContext.Provider value={openFaq}>
      <a className="skip" href="#main">
        Перейти к содержанию
      </a>
      {cfg.announcement && (
        <div
          className="system-announcement"
          role="region"
          aria-label="Объявление"
        >
          <span>📢 {cfg.announcement}</span>
        </div>
      )}
      {user ? (
        <Messenger user={user} cfg={cfg} onLogout={() => setUser(null)} />
      ) : (
        <>
          <Welcome cfg={cfg} onLogin={setUser} openLegal={setLegal} />
          <Footer openLegal={setLegal} />
        </>
      )}
      {legal && <Legal type={legal} cfg={cfg} close={() => setLegal(null)} />}
      {faqTopic !== null && (
        <FaqModal initialTopic={faqTopic} close={() => setFaqTopic(null)} />
      )}
      <CookieNotice openPolicy={() => setLegal("cookies")} />
    </FaqContext.Provider>
  );
}

function Welcome({
  cfg,
  onLogin,
  openLegal,
}: {
  cfg: Config;
  onLogin: (u: User) => void;
  openLegal: (x: string) => void;
}) {
  const [mode, setMode] = useState<
      "login" | "register" | "reset-request" | "reset-confirm"
    >("login"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [resetEmail, setResetEmail] = useState(""),
    [notice, setNotice] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      if (mode === "reset-request") {
        const email = String(f.get("email") || "")
          .trim()
          .toLowerCase();
        const result = await api<{ message: string }>(
          "/api/auth/password-reset/request",
          {
            method: "POST",
            body: JSON.stringify({ email }),
          },
        );
        setResetEmail(email);
        setNotice(result.message);
        setMode("reset-confirm");
        return;
      }
      if (mode === "reset-confirm") {
        await api("/api/auth/password-reset/confirm", {
          method: "POST",
          body: JSON.stringify({
            email: resetEmail,
            code: f.get("code"),
            newPassword: f.get("newPassword"),
          }),
        });
        setMode("login");
        setNotice("Пароль изменён. Теперь войдите с новым паролем.");
        return;
      }
      const body =
        mode === "login"
          ? { email: f.get("email"), password: f.get("password") }
          : {
              username: f.get("username"),
              email: f.get("email"),
              password: f.get("password"),
              birthDate: f.get("birthDate"),
              legalAccepted: f.get("legalAccepted") === "on",
            };
      const r = await api<{ user: User }>(
        `/api/auth/${mode === "login" ? "login" : "register"}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      onLogin(r.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" className="welcome">
      <section className="hero">
        <div className="hero-mark" aria-hidden="true">
          <VrotLogo size={46} customUrl={cfg?.customLogoUrl} />
        </div>
        <p className="eyebrow">{cfg?.siteName || "VROT"}.FUN</p>
        <h1>
          {cfg?.siteSlogan ? (
            cfg.siteSlogan
          ) : (
            <>
              Своё место
              <br />
              для своих.
            </>
          )}
        </h1>
        <p className="lead">
          Сообщества и живые разговоры без рекламы, трекеров и продажи внимания.
        </p>
        <ul className="trust">
          <li>Шифрование данных на сервере</li>
          <li>Никаких рекламных cookies</li>
          <li>Удаление и экспорт данных</li>
        </ul>
      </section>
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="tabs">
          <button
            className={mode === "login" ? "active" : ""}
            onClick={() => {
              setMode("login");
              setError("");
              setNotice("");
            }}
          >
            Вход
          </button>
          <button
            className={mode === "register" ? "active" : ""}
            onClick={() => {
              setMode("register");
              setError("");
              setNotice("");
            }}
          >
            Регистрация
          </button>
        </div>
        <h2 id="auth-title">
          {mode === "login"
            ? "С возвращением"
            : mode === "register"
              ? "Создать аккаунт"
              : "Восстановить пароль"}
        </h2>
        {mode === "register" && cfg.registrationMode !== "open" ? (
          <div className="notice" role="status">
            <strong>Регистрация пока закрыта</strong>
            <span>
              Мы откроем её после подключения законной идентификации по номеру
              телефона. Уже созданные аккаунты могут войти.
            </span>
          </div>
        ) : (
          <form onSubmit={submit}>
            {mode === "register" && (
              <label>
                Имя пользователя
                <input
                  name="username"
                  minLength={3}
                  maxLength={32}
                  autoComplete="username"
                  required
                />
              </label>
            )}
            {mode !== "reset-confirm" && (
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  defaultValue={resetEmail}
                  required
                />
              </label>
            )}
            {(mode === "login" || mode === "register") && (
              <label>
                Пароль
                <input
                  name="password"
                  type="password"
                  minLength={mode === "register" ? 12 : 1}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  required
                />
              </label>
            )}
            {mode === "reset-confirm" && (
              <>
                <p className="reset-hint">
                  Код отправлен на <strong>{resetEmail}</strong>. Он действует
                  10 минут.
                </p>
                <label>
                  Код из письма
                  <input
                    name="code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    autoComplete="one-time-code"
                    required
                  />
                </label>
                <label>
                  Новый пароль
                  <input
                    name="newPassword"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                  />
                </label>
              </>
            )}
            {mode === "register" && (
              <>
                <label>
                  Дата рождения
                  <input name="birthDate" type="date" required />
                </label>
                <label className="check">
                  <input name="legalAccepted" type="checkbox" required />
                  <span>
                    Мне не менее {cfg.minimumAge} лет, я принимаю{" "}
                    <button
                      type="button"
                      className="link"
                      onClick={() => openLegal("terms")}
                    >
                      условия
                    </button>{" "}
                    и ознакомлен(а) с{" "}
                    <button
                      type="button"
                      className="link"
                      onClick={() => openLegal("privacy")}
                    >
                      политикой
                    </button>
                    .
                  </span>
                </label>
              </>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="success" role="status">
                {notice}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy
                ? "Подождите…"
                : mode === "login"
                  ? "Войти"
                  : mode === "register"
                    ? "Создать аккаунт"
                    : mode === "reset-request"
                      ? "Отправить код"
                      : "Изменить пароль"}
            </button>
            {mode === "login" && (
              <button
                type="button"
                className="auth-reset-link"
                onClick={() => {
                  setMode("reset-request");
                  setError("");
                  setNotice("");
                }}
              >
                Забыли пароль?
              </button>
            )}
            {mode === "reset-confirm" && (
              <button
                type="button"
                className="auth-reset-link"
                onClick={() => {
                  setMode("reset-request");
                  setError("");
                  setNotice("");
                }}
              >
                Другой email или новый код
              </button>
            )}
          </form>
        )}
        <p className="fine">
          Мы никогда не попросим пароль по почте или в чате.
        </p>
      </section>
    </main>
  );
}

function Messenger({
  user,
  cfg,
  onLogout,
}: {
  user: User;
  cfg: Config;
  onLogout: () => void;
}) {
  const [profile, setProfile] = useState<User>(user),
    [communities, setCommunities] = useState<Community[]>([]),
    [community, setCommunity] = useState<Community | null>(null),
    [channels, setChannels] = useState<Channel[]>([]),
    [channel, setChannel] = useState<Channel | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [friends, setFriends] = useState<Friend[]>([]),
    [members, setMembers] = useState<Member[]>([]),
    [communityRoles, setCommunityRoles] = useState<CommunityRole[]>([]),
    [channelOverrides, setChannelOverrides] = useState<
      { roleId: string; canSend: boolean }[]
    >([]),
    [directFriend, setDirectFriend] = useState<Friend | null>(null),
    [directMessages, setDirectMessages] = useState<Message[]>([]),
    [view, setView] = useState<"friends" | "community">("friends"),
    [error, setError] = useState(""),
    [showSettings, setShowSettings] = useState(false),
    [showAdmin, setShowAdmin] = useState(false),
    [showCommunityDialog, setShowCommunityDialog] = useState(false),
    [showInviteFriends, setShowInviteFriends] = useState(false),
    [showCommunityMenu, setShowCommunityMenu] = useState(false),
    [showCommunitySettings, setShowCommunitySettings] = useState(false),
    [editingChannel, setEditingChannel] = useState<Channel | null>(null),
    [communityInvitations, setCommunityInvitations] = useState<
      CommunityInvitation[]
    >([]),
    [showMembers, setShowMembers] = useState(false),
    [mobileChannels, setMobileChannels] = useState(false),
    [call, setCall] = useState<ActiveCall | null>(null),
    [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const socket = useMemo<Socket>(
    () => io(API_ORIGIN || undefined, { withCredentials: true }),
    [],
  );
  const refreshCommunities = () =>
    api<Community[]>("/api/communities").then(setCommunities);
  const refreshFriends = () => api<Friend[]>("/api/friends").then(setFriends);
  const refreshInvitations = () =>
    api<CommunityInvitation[]>("/api/community-invitations").then(
      setCommunityInvitations,
    );
  useEffect(() => {
    if (!incoming || call || !window.AudioContext) return;
    const context = new AudioContext();
    const ring = () => {
      if (context.state !== "running") return;
      const start = context.currentTime;
      for (const [index, freq] of [587.33, 783.99].entries()) {
        const oscillator = context.createOscillator(),
          gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = freq;
        gain.gain.setValueAtTime(0, start + index * 0.22);
        gain.gain.linearRampToValueAtTime(0.1, start + index * 0.22 + 0.025);
        gain.gain.setValueAtTime(0.1, start + index * 0.22 + 0.14);
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          start + index * 0.22 + 0.21,
        );
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start + index * 0.22);
        oscillator.stop(start + index * 0.22 + 0.22);
      }
    };
    void context
      .resume()
      .then(ring)
      .catch(() => {});
    const timer = window.setInterval(ring, 1800);
    return () => {
      window.clearInterval(timer);
      void context.close();
    };
  }, [incoming?.from.id, call]);
  useEffect(() => {
    Promise.all([
      refreshCommunities(),
      refreshFriends(),
      refreshInvitations(),
    ]).catch((e) => setError(e.message));
    subscribeToPush(false).catch(() => {});
    const params = new URLSearchParams(window.location.search);
    const dmParam = params.get("dm");
    if (dmParam) {
      if (dmParam.toLowerCase() === "botfather") {
        api<{ ok: boolean; botFather: any }>("/api/bots/botfather/open", { method: "POST" })
          .then((res) => {
            if (res.ok && res.botFather) {
              setDirectFriend(res.botFather);
              setView("friends");
              setMobileChannels(false);
            }
          })
          .catch(console.error);
      } else {
        api<{ user: any }>(`/api/users/${dmParam}/profile`)
          .then((res) => {
            if (res.user) {
              setDirectFriend(res.user);
              setView("friends");
              setMobileChannels(false);
            }
          })
          .catch(console.error);
      }
    }
    const refresh = () => refreshFriends().catch(() => {});
    const incomingCall = (x: IncomingCall) => {
      if (x.expiresAt <= Date.now()) return;
      setIncoming(x);
      if ((window as any).AndroidBridge?.onIncomingCall) {
        (window as any).AndroidBridge.onIncomingCall(
          x.from.displayName || x.from.username,
          x.from.id,
          Boolean(x.video),
        );
      }
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker.ready.then((reg) => {
            reg
              .showNotification(
                `Входящий звонок: ${x.from.displayName || x.from.username}`,
                {
                  body: x.video
                    ? "📹 Входящий видеозвонок"
                    : "📞 Входящий голосовой вызов",
                  icon: x.from.avatarUrl || "/icon.svg",
                  badge: "/icon.svg",
                  tag: `call:${x.from.id}`,
                },
              )
              .catch(() => {});
          });
        }
      }
    };
    (window as any).onAndroidAnswerCall = (callerId: string) => {
      setIncoming((inc) => {
        if (inc && inc.from.id === callerId) {
          socket.emit("call:respond", {callId: inc.callId, accept: true}, (ack: {ok:boolean}) => {
            if (ack.ok) setCall({target:{kind:"friend",id:inc.from.id},label:inc.from.username,video:inc.video,callId:inc.callId});
          });
          return null;
        }
        return inc;
      });
    };
    (window as any).onAndroidDeclineCall = (callerId: string) => {
      setIncoming((inc) => { if (inc && inc.from.id === callerId) { socket.emit("call:respond", {callId:inc.callId,accept:false}); return null; } return inc; });
    };
    const onPresenceChange = ({
      userId,
      presence,
    }: {
      userId: string;
      presence: string;
    }) => {
      setFriends((prev) =>
        prev.map((f) =>
          f.id === userId ? { ...f, presence: presence as any } : f,
        ),
      );
      setDirectFriend((df) =>
        df?.id === userId ? { ...df, presence: presence as any } : df,
      );
      setMembers((prev) =>
        prev.map((m) =>
          m.id === userId ? { ...m, presence: presence as any } : m,
        ),
      );
    };
    const onPresenceSnapshot = ({
      onlineUserIds,
    }: {
      onlineUserIds: string[];
    }) => {
      const set = new Set(onlineUserIds);
      setFriends((prev) =>
        prev.map((f) => ({
          ...f,
          presence: set.has(f.id)
            ? f.presence === "offline"
              ? "online"
              : f.presence
            : "offline",
        })),
      );
      setDirectFriend((df) =>
        df
          ? {
              ...df,
              presence: set.has(df.id)
                ? df.presence === "offline"
                  ? "online"
                  : df.presence
                : "offline",
            }
          : null,
      );
      setMembers((prev) =>
        prev.map((m) => ({
          ...m,
          presence: set.has(m.id)
            ? m.presence === "offline"
              ? "online"
              : m.presence
            : "offline",
        })),
      );
    };
    const onCallCancelled = () => {
      setIncoming(null);
    };
    const onCallEnded = ({callId,reason,callerId}:{callId:string;reason:string;callerId:string}) => {
      if (reason === "answered") return;
      setIncoming((inc) => inc?.callId === callId ? null : inc);
      setCall((active) => active?.callId === callId ? null : active);
      if (callerId && "serviceWorker" in navigator) void navigator.serviceWorker.ready.then((reg) => reg.getNotifications({tag:`call:${callerId}`})).then((items)=>items.forEach((item)=>item.close())).catch(()=>{});
      if (reason === "timeout") setError("Время ожидания ответа истекло (15 секунд)");
    };
    socket.on("friend:updated", refresh);
    socket.on("community:invitation", refreshInvitations);
    socket.on("call:incoming", incomingCall);
    socket.on("call:cancelled", onCallCancelled);
    socket.on("call:ended", onCallEnded);
    socket.on("presence:change", onPresenceChange);
    socket.on("presence:snapshot", onPresenceSnapshot);
    return () => {
      delete (window as any).onAndroidAnswerCall;
      delete (window as any).onAndroidDeclineCall;
      socket.off("friend:updated", refresh);
      socket.off("community:invitation", refreshInvitations);
      socket.off("call:incoming", incomingCall);
      socket.off("call:cancelled", onCallCancelled);
      socket.off("call:ended", onCallEnded);
      socket.off("presence:change", onPresenceChange);
      socket.off("presence:snapshot", onPresenceSnapshot);
      socket.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!community) {
      setChannels([]);
      setChannel(null);
      setMembers([]);
      setCommunityRoles([]);
      return;
    }
    Promise.all([
      api<Channel[]>(`/api/communities/${community.id}/channels`),
      api<Member[]>(`/api/communities/${community.id}/members`),
      api<CommunityRole[]>(`/api/communities/${community.id}/roles`),
    ])
      .then(([x, people, roles]) => {
        setChannels(x);
        setMembers(people);
        setCommunityRoles(roles);
        setChannel(x.find((item) => item.kind === "text") || x[0] || null);
      })
      .catch((e) => setError(e.message));
  }, [community]);
  useEffect(() => {
    if (!channel || channel.kind !== "text") {
      setMessages([]);
      return;
    }
    api<Message[]>(`/api/channels/${channel.id}/messages`)
      .then(setMessages)
      .catch((e) => setError(e.message));
    socket.emit("channel:join", channel.id);
    const add = (m: Message) =>
      setMessages((x) =>
        x.some((y) => y.id === m.id)
          ? x
          : [...x, normalizeApiUrls(m) as Message],
      );
    const del = ({ id }: { id: string }) =>
      setMessages((x) =>
        x.map((m) =>
          m.id === id
            ? { ...m, content: "", deleted_at: new Date().toISOString() }
            : m,
        ),
      );
    const react = ({
      messageId,
      reactions,
    }: {
      messageId: string;
      reactions: MessageReaction[];
    }) => {
      setMessages((x) =>
        x.map((m) => {
          if (m.id !== messageId) return m;
          const updatedReactions = reactions.map((r) => ({
            ...r,
            reacted: Boolean(r.users && r.users.includes(profile.id)),
          }));
          return { ...m, reactions: updatedReactions };
        }),
      );
    };
    socket.on("message:new", add);
    socket.on("message:deleted", del);
    socket.on("message:reaction", react);
    return () => {
      socket.off("message:new", add);
      socket.off("message:deleted", del);
      socket.off("message:reaction", react);
    };
  }, [channel?.id, profile.id]);
  useEffect(() => {
    if (channel?.kind === "text")
      api<{ roleId: string; canSend: boolean }[]>(
        `/api/channels/${channel.id}/role-permissions`,
      )
        .then(setChannelOverrides)
        .catch(() => setChannelOverrides([]));
    else setChannelOverrides([]);
  }, [channel?.id]);
  useEffect(() => {
    if (!directFriend) {
      setDirectMessages([]);
      return;
    }
    api<Message[]>(`/api/friends/${directFriend.id}/messages`)
      .then(setDirectMessages)
      .catch((e) => setError(e.message));
    const add = (m: Message) =>
      setDirectMessages((x) =>
        x.some((y) => y.id === m.id)
          ? x
          : [...x, normalizeApiUrls(m) as Message],
      );
    socket.on("dm:new", add);
    return () => {
      socket.off("dm:new", add);
    };
  }, [directFriend?.id]);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  async function handleChannelReaction(msg: Message, emoji: string) {
    try {
      await api(`/api/messages/${msg.id}/reactions`, {
        method: "POST",
        body: JSON.stringify({ emoji }),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleChannelDelete(id: string) {
    if (!confirm("Удалить это сообщение?")) return;
    try {
      await api(`/api/messages/${id}`, { method: "DELETE" });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function handleInsertFormat(before: string, after: string) {
    const input = document.getElementById("message") as HTMLInputElement | null;
    if (!input) return;
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const text = input.value;
    const selected = text.substring(start, end);
    const replacement = before + selected + after;
    input.value = text.substring(0, start) + replacement + text.substring(end);
    input.focus();
    input.setSelectionRange(
      start + before.length,
      start + before.length + selected.length,
    );
  }

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!channel) return;
    const form = e.currentTarget,
      input = form.elements.namedItem("message") as HTMLInputElement,
      content = input.value.trim();
    if (!content) return;
    const rep = replyingTo;
    input.value = "";
    setReplyingTo(null);
    try {
      await api(`/api/channels/${channel.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, replyToId: rep?.id || null, clientMessageId: crypto.randomUUID() }),
      });
    } catch (e) {
      input.value = content;
      setReplyingTo(rep);
      setError((e as Error).message);
    }
  }
  async function sendDirect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!directFriend) return;
    const form = e.currentTarget,
      input = form.elements.namedItem("message") as HTMLInputElement,
      content = input.value.trim();
    if (!content) return;
    input.value = "";
    try {
      await api(`/api/friends/${directFriend.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, clientMessageId: crypto.randomUUID() }),
      });
    } catch (e) {
      input.value = content;
      setError((e as Error).message);
    }
  }
  async function createChannel(kind: "text" | "voice") {
    if (!community) return;
    const name = prompt(
      kind === "voice"
        ? "Название голосового канала (без пробелов)"
        : "Название текстового канала (без пробелов)",
    )?.trim();
    if (!name) return;
    try {
      const c = await api<Channel>(
        `/api/communities/${community.id}/channels`,
        { method: "POST", body: JSON.stringify({ name, kind }) },
      );
      setChannels((x) => [...x, c]);
      setChannel(c);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function invite() {
    if (!community) return;
    try {
      const x = await api<{ code: string }>(
        `/api/communities/${community.id}/invites`,
        { method: "POST" },
      );
      await navigator.clipboard?.writeText(x.code).catch(() => {});
      prompt("Код приглашения (действует 7 дней). Он уже скопирован:", x.code);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function respondToInvitation(id: string, accept: boolean) {
    try {
      const result = await api<{ communityId: string }>(
        `/api/community-invitations/${id}/respond`,
        { method: "POST", body: JSON.stringify({ accept }) },
      );
      await refreshInvitations();
      if (accept) {
        const list = await api<Community[]>("/api/communities");
        setCommunities(list);
        const joined = list.find((c) => c.id === result.communityId);
        if (joined) chooseCommunity(joined);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function chooseCommunity(c: Community) {
    setCommunity(c);
    setShowCommunityMenu(false);
    setView("community");
    setMobileChannels(true);
  }
  function startFriendCall(friend: Friend, video: boolean) {
    socket.emit(
      "call:invite",
      { friendId: friend.id, video },
      (ack: { ok: boolean; error?: string; callId?: string }) => {
        if (!ack?.ok) {
          setError(ack?.error || "Не удалось начать звонок");
          return;
        }
        setCall({
          target: { kind: "friend", id: friend.id },
          label: friend.username,
          video,
          callId: ack.callId,
        });
      },
    );
  }
  const myMember = members.find((m) => m.id === profile.id);
  const myRoles = communityRoles
    .filter(
      (r) =>
        r.kind === "everyone" ||
        (community?.role === "admin" && r.kind === "admin") ||
        myMember?.roles?.some((x) => x.id === r.id),
    )
    .sort((a, b) => b.position - a.position);
  const permission = (key: keyof CommunityRole["permissions"]) =>
    community?.role === "owner" ||
    Boolean(
      myRoles.find((r) => typeof r.permissions[key] === "boolean")?.permissions[
        key
      ],
    );
  const canManage = permission("manageChannels");
  const canInvite = permission("invite");
  const canSend = permission("sendMessages");
  const canJoinVoice = permission("joinVoice");
  const channelSetting = myRoles
    .map((r) => channelOverrides.find((x) => x.roleId === r.id))
    .find(Boolean);
  const canSendInChannel =
    community?.role === "owner"
      ? true
      : channelSetting
        ? channelSetting.canSend
        : canSend;
  return (
    <main
      id="main"
      className={`app-shell ${mobileChannels ? "mobile-nav-open" : ""}`}
    >
      <nav className="rail" aria-label={tr("Сообщества","Communities")}>
        <button
          className={`home-badge ${view === "friends" ? "selected" : ""}`}
          title={tr("Личные сообщения","Direct messages")}
          onClick={() => {
            setView("friends");
            setDirectFriend(null);
            setMobileChannels(true);
          }}
        >
          <VrotLogo size={26} customUrl={cfg?.customLogoUrl} />
        </button>
        {communities.map((c) => (
          <button
            key={c.id}
            className={
              view === "community" && community?.id === c.id
                ? "community selected"
                : "community"
            }
            onClick={() => chooseCommunity(c)}
            title={c.name}
          >
            {c.avatarUrl ? (
              <img className="community-avatar" src={c.avatarUrl} alt="" />
            ) : (
              c.name.slice(0, 2).toUpperCase()
            )}
          </button>
        ))}
        <button
          className="add"
          onClick={() => setShowCommunityDialog(true)}
          aria-label={tr("Создать или присоединиться к сообществу","Create or join a community")}
        >
          <Icon name="plus" />
        </button>
      </nav>
      {mobileChannels && (
        <button
          className="mobile-scrim"
          aria-label="Закрыть меню"
          onClick={() => setMobileChannels(false)}
        />
      )}
      <aside className={`channels ${mobileChannels ? "mobile-open" : ""}`}>
        <header className="community-header">
          {view === "community" && community ? (
            <button
              className="community-menu-trigger"
              aria-expanded={showCommunityMenu}
              onClick={() => setShowCommunityMenu((v) => !v)}
            >
              <strong>{community.name}</strong>
              {community.verified && (
                <span
                  className="community-verified"
                  title="Сообщество верифицировано"
                >
                  ✓
                </span>
              )}
              <span className="menu-chevron">⌄</span>
            </button>
          ) : (
            <strong>{cfg?.siteName || "VROT"}</strong>
          )}
          <button
            className="mobile-close"
            onClick={() => setMobileChannels(false)}
            aria-label="Закрыть меню"
          >
            ×
          </button>
        </header>
        {view === "friends" ? (
          <>
            <p className="section-label">Личное</p>
            <button
              className={`channel ${directFriend ? "" : "active"}`}
              onClick={() => {
                setDirectFriend(null);
                setMobileChannels(false);
              }}
            >
                <Icon name="friends" /> {tr("Друзья","Friends")}
            </button>
            <p className="section-label">{tr("Чаты","Chats")}</p>
            <div className="friend-mini-list">
              {friends
                .filter((f) => f.status === "accepted")
                .map((f) => (
                  <button
                    key={f.id}
                    className={
                      directFriend?.id === f.id
                        ? "friend-mini active"
                        : "friend-mini"
                    }
                    onClick={() => {
                      setDirectFriend(f);
                      setView("friends");
                      setMobileChannels(false);
                    }}
                  >
                    <Avatar user={f} small />
                    <span>
                      <i className={`presence ${f.presence || "offline"}`} />
                      {f.displayName || f.username}
                    </span>
                  </button>
                ))}
              {!friends.some((f) => f.status === "accepted") && (
                <small>Добавьте друзей по имени</small>
              )}
            </div>
          </>
        ) : community ? (
          <>
            {showCommunityMenu && (
              <div className="community-menu" role="menu">
                {canInvite && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setShowInviteFriends(true);
                      setShowCommunityMenu(false);
                    }}
                  >
                    <Icon name="friends" size={18} /> Пригласить друзей
                  </button>
                )}
                {canInvite && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      void invite();
                      setShowCommunityMenu(false);
                    }}
                  >
                    <Icon name="plus" size={18} /> Создать код приглашения
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    setShowMembers(true);
                    setMobileChannels(false);
                    setShowCommunityMenu(false);
                  }}
                >
                  <Icon name="friends" size={18} /> Участники{" "}
                  <span>{members.length}</span>
                </button>
                {community.role === "owner" && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setShowCommunitySettings(true);
                      setShowCommunityMenu(false);
                    }}
                  >
                    <Icon name="settings" size={18} /> Настройки и роли
                  </button>
                )}
              </div>
            )}
            <p className="section-label">Текстовые каналы</p>
            {channels
              .filter((c) => c.kind === "text")
              .map((c) => (
                <div className="channel-row" key={c.id}>
                  <button
                    className={
                      channel?.id === c.id ? "channel active" : "channel"
                    }
                    onClick={() => {
                      setChannel(c);
                      setMobileChannels(false);
                    }}
                  >
                    {c.avatarUrl?<img className="channel-avatar" src={c.avatarUrl} alt=""/>:"#"} {c.name}
                  </button>
                  {canManage && (
                    <button
                      className="channel-edit"
                      aria-label={`Изменить канал ${c.name}`}
                      title="Настройки канала"
                      onClick={() => setEditingChannel(c)}
                    >
                      <Icon name="settings" size={15} />
                    </button>
                  )}
                </div>
              ))}
            {canManage && (
              <button
                className="channel add-channel"
                onClick={() => createChannel("text")}
              >
                <Icon name="plus" size={16} /> Текстовый канал
              </button>
            )}
            <p className="section-label">Голосовые каналы</p>
            {channels
              .filter((c) => c.kind === "voice")
              .map((c) => (
                <div className="channel-row" key={c.id}>
                  <button
                    className={
                      channel?.id === c.id ? "channel active" : "channel"
                    }
                    onClick={() => {
                      setChannel(c);
                      setMobileChannels(false);
                    }}
                  >
                    {c.avatarUrl?<img className="channel-avatar" src={c.avatarUrl} alt=""/>:<Icon name="phone" size={17}/>} {c.name}
                  </button>
                  {canManage && (
                    <button
                      className="channel-edit"
                      aria-label={`Изменить канал ${c.name}`}
                      onClick={() => setEditingChannel(c)}
                    >
                      <Icon name="settings" size={15} />
                    </button>
                  )}
                </div>
              ))}
            {canManage && (
              <button
                className="channel add-channel"
                onClick={() => createChannel("voice")}
              >
                <Icon name="plus" size={16} /> Голосовой канал
              </button>
            )}
          </>
        ) : (
          <div className="empty-small">
            Создайте сообщество или войдите по коду приглашения.
          </div>
        )}
        <div className="profile">
          <Avatar user={profile} />
          <span>{profile.displayName || profile.username}</span>
          {profile.adminRole && profile.adminRole !== "user" && (
            <button
              className="admin-button"
              onClick={() => setShowAdmin(true)}
              aria-label="Админ-панель"
              title="Админ-панель"
            >
              A
            </button>
          )}
          <button onClick={() => setShowSettings(true)} aria-label={tr("Настройки","Settings")}>
            <Icon name="settings" />
          </button>
        </div>
      </aside>
      <section
        className={`chat ${view === "community" ? "community-chat" : ""}`}
      >
        {view === "friends" ? (
          <FriendsPanel
            friends={friends}
            refresh={refreshFriends}
            call={startFriendCall}
            fail={setError}
            socket={socket}
            userId={profile.id}
            openFriend={directFriend}
            onOpenFriend={setDirectFriend}
            openChannels={() => setMobileChannels(true)}
          />
        ) : (
          <>
            <div className="conversation-pane">
              <header className="chat-header">
                <button
                  className="mobile-menu-button"
                  onClick={() => setMobileChannels(true)}
                  aria-label="Открыть каналы"
                >
                  ☰
                </button>
                <strong title={channel?.description||undefined}>
                  {channel
                    ? `${channel.kind === "voice" ? "Голосовой · " : "# "}${channel.name}`
                    : "Выберите канал"}
                </strong>
                {channel?.kind === "voice" && (
                  <div className="call-actions">
                    <button
                      disabled={!canJoinVoice}
                      onClick={() =>
                        setCall({
                          target: { kind: "channel", id: channel.id },
                          label: `# ${channel.name}`,
                          video: false,
                        })
                      }
                      title="Голосовой звонок"
                    >
                      <Icon name="phone" />
                    </button>
                    <button
                      disabled={!canJoinVoice}
                      onClick={() =>
                        setCall({
                          target: { kind: "channel", id: channel.id },
                          label: `# ${channel.name}`,
                          video: true,
                        })
                      }
                      title="Видеозвонок"
                    >
                      <Icon name="video" />
                    </button>
                  </div>
                )}
              </header>
              <div className="messages" aria-live="polite">
                {channel?.kind === "voice" ? (
                  canJoinVoice ? (
                    <VoiceLobby
                      channel={channel}
                      join={(video) =>
                        setCall({
                          target: { kind: "channel", id: channel.id },
                          label: channel.name,
                          video,
                        })
                      }
                    />
                  ) : (
                    <div className="empty">
                      <h2>Голосовой канал</h2>
                      <p>У вашей роли нет права подключаться.</p>
                    </div>
                  )
                ) : channel && messages.length > 0 ? (
                  messages.map((m) => (
                    <MessageItem
                      key={m.id}
                      message={m}
                      currentUserId={profile.id}
                      roleColor={
                        members.find((x) => x.id === m.author.id)?.roles?.[0]
                          ?.color
                      }
                      canDelete={
                        m.author.id === profile.id ||
                        Boolean(
                          community &&
                            ["owner", "admin", "moderator"].includes(
                              community.role,
                            ),
                        ) ||
                        Boolean(
                          ["admin", "owner"].includes(profile.adminRole || ""),
                        )
                      }
                      onReply={(target) => {
                        setReplyingTo(target);
                        document.getElementById("message")?.focus();
                      }}
                      onReact={handleChannelReaction}
                      onDelete={handleChannelDelete}
                      onJumpToMessage={(targetId) => {
                        const el = document.getElementById(`msg-${targetId}`);
                        if (el) {
                          el.scrollIntoView({
                            behavior: "smooth",
                            block: "center",
                          });
                          el.style.backgroundColor = "rgba(88,101,242,0.25)";
                          setTimeout(() => {
                            el.style.backgroundColor = "";
                          }, 1400);
                        }
                      }}
                    />
                  ))
                ) : channel ? (
                  <div className="empty">
                    <h2>#{channel.name}</h2>
                    <p>В этом канале пока нет сообщений. Напишите первым!</p>
                  </div>
                ) : (
                  <div className="empty">
                    <h2>Добро пожаловать в VROT</h2>
                    <p>Выберите сервер и канал, чтобы начать общение.</p>
                  </div>
                )}
              </div>
              {channel?.kind === "text" && canSendInChannel && (
                <form className="composer" onSubmit={send}>
                  {replyingTo && (
                    <div className="composer-reply-bar">
                      <div className="composer-reply-info">
                        <span>
                          Ответ <strong>@{replyingTo.author.username}</strong>:
                        </span>
                        <span className="reply-quote-snippet">
                          {replyingTo.content || "[вложение]"}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="composer-reply-cancel"
                        title="Отменить ответ"
                        onClick={() => setReplyingTo(null)}
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <FormattingBar onInsert={handleInsertFormat} />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      width: "100%",
                    }}
                  >
                    <MediaButtons
                      fail={setError}
                      onSend={async (attachmentId) => {
                        const rep = replyingTo;
                        setReplyingTo(null);
                        await api(`/api/channels/${channel.id}/messages`, {
                          method: "POST",
                          body: JSON.stringify({
                            content: "",
                            attachmentId,
                            replyToId: rep?.id || null,
                          }),
                        });
                      }}
                    />
                    <label className="sr-only" htmlFor="message">
                      Сообщение
                    </label>
                    <input
                      id="message"
                      name="message"
                      maxLength={4000}
                      placeholder={`Написать в #${channel.name}`}
                      autoComplete="off"
                    />
                    <EmojiPicker
                      onPick={(s) => {
                        const input = document.getElementById(
                          "message",
                        ) as HTMLInputElement | null;
                        if (input) {
                          input.value += s;
                          input.focus();
                        }
                      }}
                    />
                    <button aria-label="Отправить">
                      <Icon name="send" />
                    </button>
                  </div>
                </form>
              )}
            </div>
            {community && (
              <MemberSidebar
                members={members}
                open={showMembers}
                close={() => setShowMembers(false)}
              />
            )}
          </>
        )}
        {error && (
          <div className="toast" role="alert" onClick={() => setError("")}>
            {error}
          </div>
        )}
      </section>
      {showSettings && (
        <Settings
          user={profile}
          onAvatar={setProfile}
          close={() => setShowSettings(false)}
          logout={async () => {
            await api("/api/auth/logout", { method: "POST" });
            onLogout();
          }}
        />
      )}
      {showAdmin && (
        <AdminPanel
          actor={profile}
          config={cfg}
          close={() => setShowAdmin(false)}
        />
      )}{" "}
      {showCommunityDialog && (
        <CommunityDialog
          close={() => setShowCommunityDialog(false)}
          done={async (id) => {
            const list = await refreshCommunities().then(() =>
              api<Community[]>("/api/communities"),
            );
            setCommunities(list);
            const c = list.find((x) => x.id === id) || list.at(-1) || null;
            if (c) chooseCommunity(c);
            setShowCommunityDialog(false);
          }}
        />
      )}
      {showInviteFriends && community && (
        <InviteFriendsDialog
          community={community}
          friends={friends}
          members={members}
          close={() => setShowInviteFriends(false)}
          fail={setError}
        />
      )}
      {showCommunitySettings && community && (
        <CommunitySettingsDialog
          community={community}
          roles={communityRoles}
          members={members}
          close={() => setShowCommunitySettings(false)}
          onCommunitySaved={(updated) => {
            setCommunity({ ...community, ...updated });
            setCommunities((prev) =>
              prev.map((c) =>
                c.id === community.id ? { ...c, ...updated } : c,
              ),
            );
          }}
          onRolesChanged={async () => {
            const [r, m] = await Promise.all([
              api<CommunityRole[]>(`/api/communities/${community.id}/roles`),
              api<Member[]>(`/api/communities/${community.id}/members`),
            ]);
            setCommunityRoles(r);
            setMembers(m);
          }}
        />
      )}
      {editingChannel && community && (
        <ChannelSettingsDialog
          channel={editingChannel}
          roles={communityRoles}
          close={() => setEditingChannel(null)}
          onPermissionSaved={() =>
            api<{ roleId: string; canSend: boolean }[]>(
              `/api/channels/${editingChannel.id}/role-permissions`,
            ).then(setChannelOverrides)
          }
          onSaved={(updated) => {
            setChannels((prev) =>
              prev.map((c) => (c.id === updated.id ? updated : c)),
            );
            if (channel?.id === updated.id) setChannel(updated);
          }}
        />
      )}
      {communityInvitations.length > 0 && (
        <aside
          className="community-invitations"
          aria-label="Приглашения в сообщества"
        >
          <strong>Приглашения в сообщества</strong>
          {communityInvitations.map((inv) => (
            <div className="community-invitation" key={inv.id}>
              <Avatar
                user={{
                  username: inv.inviterUsername,
                  avatarUrl: inv.inviterAvatarUrl,
                }}
                small
              />
              <span>
                <b>{inv.communityName}</b>
                <small>От @{inv.inviterUsername}</small>
              </span>
              <button
                className="design-button"
                onClick={() => void respondToInvitation(inv.id, true)}
              >
                Вступить
              </button>
              <button
                className="ghost-button"
                onClick={() => void respondToInvitation(inv.id, false)}
              >
                Отклонить
              </button>
            </div>
          ))}
        </aside>
      )}
      {call && (
        <CallPanel
          socket={socket}
          call={call}
          currentUser={profile}
          close={() => { if(call.target.kind === "friend") socket.emit("call:cancel", {friendId:call.target.id,callId:call.callId}); setCall(null); }}
        />
      )}{" "}
      {incoming && !call && (
        <div
          className="incoming-call"
          role="dialog"
          aria-label={tr("Входящий звонок","Incoming call")}
        >
          <div className="incoming-call-orbit">
            <Avatar user={incoming.from} />
          </div>
          <div className="incoming-call-meta">
            <span className="incoming-call-kicker">{tr("ВХОДЯЩИЙ ЗВОНОК","INCOMING CALL")}</span>
            <strong>
              {incoming.from.displayName || incoming.from.username}
            </strong>
            <small>
              @{incoming.from.username} ·{" "}
              {incoming.video ? tr("Видеозвонок","Video call") : tr("Голосовой звонок","Voice call")}
            </small>
          </div>
          <button
            className="accept"
            onClick={() => {
              const accepted = incoming;
              socket.emit("call:respond", {callId:accepted.callId,accept:true}, (ack:{ok:boolean}) => {
                if(ack.ok) setCall({target:{kind:"friend",id:accepted.from.id},label:accepted.from.username,video:accepted.video,callId:accepted.callId});
                else setError("Вызов уже завершён");
              });
              setIncoming(null);
            }}
          >
            <Icon name="phone" /> {tr("Ответить","Answer")}
          </button>
          <button className="decline" onClick={() => {socket.emit("call:respond",{callId:incoming.callId,accept:false});setIncoming(null);}}>
            {tr("Отклонить","Decline")}
          </button>
        </div>
      )}
    </main>
  );
}

function VoiceLobby({
  channel,
  join,
}: {
  channel: Channel;
  join: (video: boolean) => void;
}) {
  return (
    <div className="voice-lobby">
      <div className="voice-orb">
        <Icon name="phone" size={42} />
      </div>
      <h2>{channel.name}</h2>
      <p>
        Постоянный голосовой канал сообщества. Подключайтесь с микрофоном или
        сразу с камерой.
      </p>
      <div>
        <button className="voice-join" onClick={() => join(false)}>
          <Icon name="phone" /> Войти голосом
        </button>
        <button className="voice-join secondary" onClick={() => join(true)}>
          <Icon name="video" /> Войти с видео
        </button>
      </div>
    </div>
  );
}
function MemberSidebar({
  members,
  open,
  close,
}: {
  members: Member[];
  open: boolean;
  close: () => void;
}) {
  const groups = [
    { key: "owner", title: "Основатели" },
    { key: "admin", title: "Администраторы" },
    { key: "member", title: "Участники" },
  ];
  return (
    <aside
      className={`member-sidebar ${open ? "open" : ""}`}
      aria-label="Участники сообщества"
    >
      <header>
        <strong>Участники · {members.length}</strong>
        <button onClick={close} aria-label="Закрыть">
          ×
        </button>
      </header>
      <div className="member-groups">
        {groups.map((group) => {
          const list = members.filter(
            (member) =>
              member.role === group.key ||
              (group.key === "member" &&
                !["owner", "admin"].includes(member.role)),
          );
          if (!list.length) return null;
          return (
            <section key={group.key}>
              <h3>
                {group.title} — {list.length}
              </h3>
              {list.map((member) => (
                <div className="member-with-role" key={member.id}>
                  <ProfileButton user={member} label />
                  <span
                    className="member-role-label"
                    style={{ color: member.roles?.[0]?.color }}
                  >
                    {member.roles?.[0]?.name ||
                      (
                        { owner: "Владелец", admin: "Администратор" } as Record<
                          string,
                          string
                        >
                      )[member.role] ||
                      "Участник"}
                  </span>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function FriendsPanel({
  friends,
  refresh,
  call,
  fail,
  socket,
  userId,
  openFriend,
  onOpenFriend,
  openChannels,
}: {
  friends: Friend[];
  refresh: () => Promise<void>;
  call: (f: Friend, v: boolean) => void;
  fail: (x: string) => void;
  socket: Socket;
  userId: string;
  openFriend: Friend | null;
  onOpenFriend: (f: Friend | null) => void;
  openChannels: () => void;
}) {
  const [results, setResults] = useState<User[]>([]),
    [busy, setBusy] = useState(false),
    [active, setActive] = useState<Friend | null>(openFriend),
    [dm, setDm] = useState<Message[]>([]);
  const [showBotMenu, setShowBotMenu] = useState(false);
  const [botCommands, setBotCommands] = useState<{ command: string; description: string }[]>([]);

  const isBot = Boolean(active?.isBot || (active as any)?.presence === 'bot' || (active as any)?.status === 'bot' || active?.username?.toLowerCase().endsWith('bot'));

  useEffect(() => {
    setShowBotMenu(false);
    if (!active || !isBot) {
      setBotCommands([]);
      return;
    }
    if (active.botCommands && active.botCommands.length > 0) {
      setBotCommands(active.botCommands);
    } else {
      api<{ ok: boolean; commands: { command: string; description: string }[] }>(`/api/bots/${active.id}/commands`)
        .then((res) => {
          if (res.ok && Array.isArray(res.commands)) {
            setBotCommands(res.commands);
          }
        })
        .catch(() => {});
    }
  }, [active?.id, isBot]);

  const accepted = friends.filter((f) => f.status === "accepted"),
    incoming = friends.filter(
      (f) => f.status === "pending" && f.direction === "incoming",
    ),
    outgoing = friends.filter(
      (f) => f.status === "pending" && f.direction === "outgoing",
    );
  useEffect(() => {
    setActive(openFriend);
  }, [openFriend?.id]);
  useEffect(() => {
    if (!active) {
      setDm([]);
      return;
    }
    let alive = true;
    api<Message[]>(`/api/friends/${active.id}/messages`)
      .then((x) => {
        if (alive) setDm(x);
      })
      .catch((e) => fail(e.message));
    const add = (m: Message) => {
      if (m.author.id !== active.id && m.author.id !== userId) return;
      setDm((x) =>
        x.some((y) => y.id === m.id)
          ? x
          : [...x, normalizeApiUrls(m) as Message],
      );
    };
    const del = ({ id }: { id: string }) => {
      setDm((x) =>
        x.map((m) =>
          m.id === id
            ? { ...m, content: "", deleted_at: new Date().toISOString() }
            : m,
        ),
      );
    };
    const react = ({
      messageId,
      reactions,
    }: {
      messageId: string;
      reactions: MessageReaction[];
    }) => {
      setDm((x) =>
        x.map((m) => {
          if (m.id !== messageId) return m;
          const updatedReactions = reactions.map((r) => ({
            ...r,
            reacted: Boolean(r.users && r.users.includes(userId)),
          }));
          return { ...m, reactions: updatedReactions };
        }),
      );
    };
    socket.on("dm:new", add);
    socket.on("dm:deleted", del);
    socket.on("dm:reaction", react);
    return () => {
      alive = false;
      socket.off("dm:new", add);
      socket.off("dm:deleted", del);
      socket.off("dm:reaction", react);
    };
  }, [active?.id, userId, socket]);

  const [dmReplyingTo, setDmReplyingTo] = useState<Message | null>(null);

  async function handleDmReaction(msg: Message, emoji: string) {
    try {
      await api(`/api/direct-messages/${msg.id}/reactions`, {
        method: "POST",
        body: JSON.stringify({ emoji }),
      });
    } catch (e) {
      fail((e as Error).message);
    }
  }

  async function handleDmDelete(id: string) {
    if (!confirm("Удалить это сообщение?")) return;
    try {
      await api(`/api/direct-messages/${id}`, { method: "DELETE" });
    } catch (e) {
      fail((e as Error).message);
    }
  }

  function handleInsertDmFormat(before: string, after: string) {
    const input = document.getElementById(
      "direct-message-input",
    ) as HTMLInputElement | null;
    if (!input) return;
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const text = input.value;
    const selected = text.substring(start, end);
    const replacement = before + selected + after;
    input.value = text.substring(0, start) + replacement + text.substring(end);
    input.focus();
    input.setSelectionRange(
      start + before.length,
      start + before.length + selected.length,
    );
  }

  function open(next: Friend | null) {
    setActive(next);
    setDmReplyingTo(null);
    onOpenFriend(next);
  }
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get("q") || "").trim();
    if (q.length < 2) return;
    setBusy(true);
    try {
      setResults(
        await api<User[]>(`/api/users/search?q=${encodeURIComponent(q)}`),
      );
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function request(u: User) {
    try {
      await api("/api/friends/requests", {
        method: "POST",
        body: JSON.stringify({ username: u.username }),
      });
      setResults([]);
      await refresh();
    } catch (e) {
      fail((e as Error).message);
    }
  }
  async function act(id: string, action: "accept" | "remove") {
    try {
      await api(`/api/friends/${id}${action === "accept" ? "/accept" : ""}`, {
        method: action === "accept" ? "POST" : "DELETE",
      });
      await refresh();
    } catch (e) {
      fail((e as Error).message);
    }
  }
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!active) return;
    const input = e.currentTarget.elements.namedItem(
        "message",
      ) as HTMLInputElement,
      content = input.value.trim();
    if (!content) return;
    const rep = dmReplyingTo;
    input.value = "";
    setDmReplyingTo(null);
    try {
      const m = await api<Message>(`/api/friends/${active.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, replyToId: rep?.id || null, clientMessageId: crypto.randomUUID() }),
      });
      setDm((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]));
    } catch (e) {
      input.value = content;
      setDmReplyingTo(rep);
      fail((e as Error).message);
    }
  }
  if (active)
    return (
      <section className="direct-chat">
        <header className="chat-header">
          <button
            className="back-button mobile-only"
            onClick={() => open(null)}
            aria-label="Назад"
          >
            <Icon name="back" />
          </button>
          <div className="direct-chat-header-user">
            <ProfileButton user={active} />
            <span className="direct-chat-name">
              <strong>{active.displayName || active.username}</strong>
              <UserBadges user={active} />
            </span>
          </div>
          {!isBot && (
            <div className="call-actions">
              <button
                className="icon-button"
                onClick={() => call(active, false)}
                title="Голосовой звонок"
              >
                <Icon name="phone" />
              </button>
              <button
                className="icon-button"
                onClick={() => call(active, true)}
                title="Видеозвонок"
              >
                <Icon name="video" />
              </button>
            </div>
          )}
        </header>
        <div className="messages">
          {dm.length ? (
            dm.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                currentUserId={userId}
                canDelete={m.author.id === userId}
                onReply={(target) => {
                  setDmReplyingTo(target);
                  document.getElementById("direct-message-input")?.focus();
                }}
                onReact={handleDmReaction}
                onDelete={handleDmDelete}
                onJumpToMessage={(targetId) => {
                  const el = document.getElementById(`msg-${targetId}`);
                  if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                    el.style.backgroundColor = "rgba(88,101,242,0.25)";
                    setTimeout(() => {
                      el.style.backgroundColor = "";
                    }, 1400);
                  }
                }}
              />
            ))
          ) : (
            <div className="empty">
              <h2>Начните общение</h2>
              <p>Сообщения доступны после принятия заявки.</p>
            </div>
          )}
        </div>
        <form className="composer direct-composer" onSubmit={send}>
          {dmReplyingTo && (
            <div className="composer-reply-bar">
              <div className="composer-reply-info">
                <span>
                  Ответ <strong>@{dmReplyingTo.author.username}</strong>:
                </span>
                <span className="reply-quote-snippet">
                  {dmReplyingTo.content || "[вложение]"}
                </span>
              </div>
              <button
                type="button"
                className="composer-reply-cancel"
                title="Отменить ответ"
                onClick={() => setDmReplyingTo(null)}
              >
                ×
              </button>
            </div>
          )}
          <FormattingBar onInsert={handleInsertDmFormat} />
          <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
            <MediaButtons
              fail={fail}
              onSend={async (attachmentId) => {
                const rep = dmReplyingTo;
                setDmReplyingTo(null);
                await api(`/api/friends/${active.id}/messages`, {
                  method: "POST",
                  body: JSON.stringify({
                    content: "",
                    attachmentId,
                    replyToId: rep?.id || null,
                  }),
                });
              }}
            />
            {isBot && (
              <div className="bot-menu-wrapper" style={{ position: "relative" }}>
                <button
                  type="button"
                  className="bot-menu-button"
                  onClick={() => setShowBotMenu((v) => !v)}
                  title="Команды бота"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="3" y1="12" x2="21" y2="12"></line>
                    <line x1="3" y1="6" x2="21" y2="6"></line>
                    <line x1="3" y1="18" x2="21" y2="18"></line>
                  </svg>
                  <span>Меню</span>
                </button>
                {showBotMenu && (
                  <div className="bot-menu-popup">
                    <div style={{ padding: "4px 8px 8px", borderBottom: "1px solid rgba(255, 255, 255, 0.08)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", color: "rgba(255, 255, 255, 0.5)", fontWeight: 700 }}>
                        Команды бота
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowBotMenu(false)}
                        style={{ background: "none", border: "none", color: "rgba(255, 255, 255, 0.5)", cursor: "pointer", fontSize: "16px", lineHeight: 1 }}
                      >
                        ×
                      </button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "6px" }}>
                      {botCommands.length > 0 ? (
                        botCommands.map((cmd) => (
                          <button
                            key={cmd.command}
                            type="button"
                            className="bot-menu-item"
                            onClick={async () => {
                              setShowBotMenu(false);
                              const input = document.getElementById("direct-message-input") as HTMLInputElement | null;
                              if (input) input.value = `/${cmd.command}`;
                              try {
                                const m = await api<Message>(`/api/friends/${active.id}/messages`, {
                                  method: "POST",
                                  body: JSON.stringify({ content: `/${cmd.command}`, clientMessageId: crypto.randomUUID() }),
                                });
                                if (input) input.value = "";
                                setDm((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]));
                              } catch (e) {
                                fail((e as Error).message);
                              }
                            }}
                          >
                            <strong>/{cmd.command}</strong>
                            <span>{cmd.description}</span>
                          </button>
                        ))
                      ) : (
                        <div style={{ padding: "12px 8px", fontSize: "12px", color: "rgba(255, 255, 255, 0.5)", textAlign: "center" }}>
                          Команды не настроены
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            <input
              id="direct-message-input"
              name="message"
              maxLength={4000}
              placeholder={`Написать ${active.username}…`}
              autoComplete="off"
            />
            <EmojiPicker
              onPick={(s) => {
                const input = document.getElementById(
                  "direct-message-input",
                ) as HTMLInputElement | null;
                if (input) {
                  input.value += s;
                  input.focus();
                }
              }}
            />
            <button aria-label="Отправить">
              <Icon name="send" />
            </button>
          </div>
        </form>
      </section>
    );
  return (
    <section className="friends-page">
      <header>
        <button
          className="mobile-menu-button"
          onClick={openChannels}
          aria-label="Открыть список чатов"
        >
          ☰
        </button>
        <div>
          <h2>Друзья</h2>
          <span>{accepted.length} в списке</span>
        </div>
      </header>
      <form className="friend-search" onSubmit={search}>
        <input
          name="q"
          minLength={2}
          maxLength={32}
          placeholder="Найти по имени пользователя"
          aria-label="Имя пользователя"
        />
        <button className="design-button" disabled={busy}>
          {busy ? "Ищу…" : "Найти"}
        </button>
      </form>
      {results.length > 0 && (
        <div className="search-results">
          {results.map((u) => (
            <article className="search-user" key={u.id}>
              <ProfileButton user={u} />
              <strong>
                {u.username}
                <UserBadges user={u} />
              </strong>
              <button className="design-button" onClick={() => request(u)}>
                Отправить заявку
              </button>
            </article>
          ))}
        </div>
      )}
      {incoming.length > 0 && (
        <FriendGroup title="Входящие заявки">
          {incoming.map((f) => (
            <FriendRow key={f.id} friend={f}>
              <button
                className="design-button accept"
                onClick={() => act(f.id, "accept")}
              >
                Принять
              </button>
              <button
                className="ghost-button"
                onClick={() => act(f.id, "remove")}
              >
                Отклонить
              </button>
            </FriendRow>
          ))}
        </FriendGroup>
      )}
      {outgoing.length > 0 && (
        <FriendGroup title="Исходящие заявки">
          {outgoing.map((f) => (
            <FriendRow key={f.id} friend={f}>
              <span className="request-status">Ожидает ответа</span>
              <button
                className="ghost-button"
                onClick={() => act(f.id, "remove")}
              >
                Отменить
              </button>
            </FriendRow>
          ))}
        </FriendGroup>
      )}
      <FriendGroup title="Все друзья">
        {accepted.length ? (
          accepted.map((f) => (
            <FriendRow key={f.id} friend={f}>
              <button className="design-button" onClick={() => open(f)}>
                Открыть чат
              </button>
              <button
                className="icon-button"
                onClick={() => call(f, false)}
                title="Позвонить"
              >
                <Icon name="phone" />
              </button>
              <button
                className="icon-button"
                onClick={() => call(f, true)}
                title="Видеозвонок"
              >
                <Icon name="video" />
              </button>
              <button
                className="ghost-button"
                onClick={() => act(f.id, "remove")}
                title="Удалить из друзей"
              >
                ×
              </button>
            </FriendRow>
          ))
        ) : (
          <p className="empty-friends">
            Здесь появятся люди, которых вы добавите. Найдите друга по точному
            имени пользователя.
          </p>
        )}
      </FriendGroup>
    </section>
  );
}
function EmojiPicker({ onPick }: { onPick: (s: string) => void }) {
  const groups: Record<string, string[]> = {
    Лица: [
      "😀",
      "😄",
      "😁",
      "😂",
      "🤣",
      "😊",
      "😍",
      "🥰",
      "😘",
      "😎",
      "🥳",
      "😭",
      "🥺",
      "😮",
      "😡",
      "🤔",
      "🫠",
      "😴",
      "🤯",
      "😇",
    ],
    Жесты: [
      "👍",
      "👎",
      "👏",
      "🙌",
      "🤝",
      "👋",
      "🙏",
      "💪",
      "👌",
      "✌️",
      "🤘",
      "🫶",
    ],
    Символы: [
      "❤️",
      "💜",
      "💙",
      "🖤",
      "🔥",
      "⭐",
      "✨",
      "💯",
      "🎉",
      "🎁",
      "💬",
      "✅",
      "❌",
      "⚡",
    ],
    Разное: [
      "🐱",
      "🐶",
      "🦊",
      "🌈",
      "☀️",
      "🌙",
      "🍕",
      "🍔",
      "☕",
      "🎮",
      "🎵",
      "🚀",
    ],
  };
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  return (
    <div className="emoji-picker-wrap">
      <button
        type="button"
        className="emoji-trigger"
        aria-label="Открыть меню эмодзи"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ☺
      </button>
      {open && (
        <div className="emoji-panel" role="dialog" aria-label="Выбор эмодзи">
          <div className="emoji-panel-head">
            <strong>Эмодзи</strong>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Закрыть меню эмодзи"
            >
              ×
            </button>
          </div>
          <input
            autoFocus
            aria-label="Поиск эмодзи"
            placeholder="Поиск по категории"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="emoji-panel-list">
            {Object.entries(groups)
              .filter(
                ([name]) =>
                  name.toLowerCase().includes(query.trim().toLowerCase()) ||
                  !query.trim(),
              )
              .map(([name, items]) => (
                <section key={name}>
                  <h4>{name}</h4>
                  <div>
                    {items.map((s, i) => (
                      <button
                        type="button"
                        key={`${s}-${i}`}
                        onClick={() => {
                          onPick(s);
                          setOpen(false);
                        }}
                        aria-label={`Эмодзи ${s}`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
function InviteFriendsDialog({
  community,
  friends,
  members,
  close,
  fail,
}: {
  community: Community;
  friends: Friend[];
  members: Member[];
  close: () => void;
  fail: (s: string) => void;
}) {
  const [sent, setSent] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState<string | null>(null);
  const available = friends.filter(
    (f) => f.status === "accepted" && !members.some((m) => m.id === f.id),
  );
  async function send(friend: Friend) {
    setBusy(friend.id);
    try {
      await api(`/api/communities/${community.id}/invite-friend`, {
        method: "POST",
        body: JSON.stringify({ friendId: friend.id }),
      });
      setSent((prev) => new Set(prev).add(friend.id));
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className="modal invite-friends-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Пригласить друзей"
      >
        <button className="close" onClick={close} aria-label="Закрыть">
          ×
        </button>
        <h2>Пригласить в {community.name}</h2>
        <p>
          Выберите друга — приглашение придёт ему в VROT и уведомлением на
          телефон, если они включены.
        </p>
        <div className="invite-friends-list">
          {available.length ? (
            available.map((f) => (
              <div key={f.id} className="invite-friend-row">
                <Avatar user={f} />
                <span>
                  {f.displayName || f.username}
                  <small>@{f.username}</small>
                </span>
                <button
                  className="design-button"
                  disabled={busy === f.id || sent.has(f.id)}
                  onClick={() => void send(f)}
                >
                  {sent.has(f.id)
                    ? "Отправлено"
                    : busy === f.id
                      ? "Отправка…"
                      : "Пригласить"}
                </button>
              </div>
            ))
          ) : (
            <p>Пока нет друзей, которых можно пригласить.</p>
          )}
        </div>
      </section>
    </div>
  );
}
function AttachmentView({ file }: { file: Attachment }) {
  if (file.mime.startsWith("image/"))
    return (
      <a href={apiUrl(file.url)} target="_blank" rel="noreferrer">
        <img className="message-image" src={apiUrl(file.url)} alt={file.name} />
      </a>
    );
  if (file.mime.startsWith("audio/")) return <VoicePlayer file={file} />;
  if (file.mime.startsWith("video/"))
    return (
      <video
        className="message-video"
        controls
        preload="metadata"
        src={apiUrl(file.url)}
      />
    );
  return (
    <a className="message-file" href={apiUrl(file.url)} download>
      {file.name} · {(file.size / 1024 / 1024).toFixed(1)} МБ
    </a>
  );
}
function VoicePlayer({ file }: { file: Attachment }) {
  const audio = useRef<HTMLAudioElement | null>(null),
    [playing, setPlaying] = useState(false),
    [current, setCurrent] = useState(0),
    [duration, setDuration] = useState(0),
    [speed, setSpeed] = useState(1);
  const format = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
      .toString()
      .padStart(2, "0")}`;
  async function toggle() {
    if (!audio.current) return;
    if (audio.current.paused) await audio.current.play();
    else audio.current.pause();
  }
  function seek(value: number) {
    if (audio.current) audio.current.currentTime = value;
    setCurrent(value);
  }
  function cycleSpeed() {
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  }
  return (
    <div className="voice-player">
      <button
        className="voice-play"
        onClick={() => void toggle()}
        aria-label={playing ? "Пауза" : "Воспроизвести"}
      >
        {playing ? (
          <svg viewBox="0 0 24 24">
            <path d="M7 5h4v14H7zm6 0h4v14h-4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24">
            <path d="m8 5 11 7-11 7V5z" />
          </svg>
        )}
      </button>
      <div className="voice-wave">
        <input
          type="range"
          min="0"
          max={duration || 0}
          step="0.05"
          value={Math.min(current, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Позиция голосового сообщения"
        />
        <span>
          {format(current)} / {format(duration)}
        </span>
      </div>
      <button className="voice-speed" onClick={cycleSpeed}>
        {speed}×
      </button>
      <audio
        ref={audio}
        src={file.url}
        preload="metadata"
        onLoadedMetadata={(e) =>
          setDuration(
            Number.isFinite(e.currentTarget.duration)
              ? e.currentTarget.duration
              : 0,
          )
        }
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}
function MediaButtons({
  onSend,
  fail,
}: {
  onSend: (attachmentId: string) => Promise<void>;
  fail: (message: string) => void;
}) {
  const [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false),
    recorder = useRef<MediaRecorder | null>(null),
    voiceStream = useRef<MediaStream | null>(null),
    chunks = useRef<Blob[]>([]);
  async function send(file: File) {
    setBusy(true);
    try {
      const uploaded = await uploadFile(file);
      await onSend(uploaded.id);
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await send(file);
  }
  async function toggleVoice() {
    if (recorder.current && recording) {
      recorder.current.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        }),
        mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
        r = new MediaRecorder(stream, { mimeType: mime });
      voiceStream.current = stream;
      chunks.current = [];
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        voiceStream.current = null;
        const file = new File(chunks.current, `voice-${Date.now()}.webm`, {
          type: "audio/webm",
        });
        void send(file);
      };
      recorder.current = r;
      r.start();
      setRecording(true);
    } catch (e) {
      fail(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Разрешите доступ к микрофону для голосового сообщения"
          : (e as Error).message,
      );
    }
  }
  useEffect(
    () => () => {
      recorder.current?.state === "recording" && recorder.current.stop();
      voiceStream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  return (
    <div className="media-buttons">
      <label className={busy ? "disabled" : ""} title="Прикрепить файл">
        <Icon name="plus" />
        <input
          type="file"
          accept="image/*,audio/*,video/*,application/pdf"
          disabled={busy}
          onChange={pick}
        />
      </label>
      <button
        type="button"
        className={recording ? "recording" : ""}
        disabled={busy}
        onClick={() => void toggleVoice()}
        title={recording ? "Остановить запись" : "Голосовое сообщение"}
        aria-label={recording ? "Остановить запись" : "Голосовое сообщение"}
      >
        {recording ? <span className="stop-square" /> : <Icon name="mic" />}
      </button>
    </div>
  );
}
function FriendGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="friend-group">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function FriendRow({
  friend,
  children,
}: {
  friend: Friend;
  children: React.ReactNode;
}) {
  return (
    <article className="friend-row">
      <ProfileButton user={friend} label />
      <div className="friend-actions">{children}</div>
    </article>
  );
}

function CommunityDialog({
  close,
  done,
}: {
  close: () => void;
  done: (id: string) => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const f = new FormData(e.currentTarget),
        c = await api<Community>("/api/communities", {
          method: "POST",
          body: JSON.stringify({
            name: f.get("name"),
            description: f.get("description"),
          }),
        });
      done(c.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function join(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const code = String(
          new FormData(e.currentTarget).get("code") || "",
        ).trim(),
        x = await api<{ communityId: string }>(
          `/api/invites/${encodeURIComponent(code)}/join`,
          { method: "POST" },
        );
      done(x.communityId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section className="modal" role="dialog" aria-modal="true">
        <button className="close" onClick={close}>
          ×
        </button>
        <h2>Сообщество</h2>
        <form onSubmit={create}>
          <label>
            Название
            <input name="name" minLength={2} maxLength={60} required />
          </label>
          <label>
            Описание
            <input name="description" maxLength={300} />
          </label>
          <button className="button" disabled={busy}>
            Создать сообщество
          </button>
        </form>
        <div className="or">
          <span>или</span>
        </div>
        <form onSubmit={join}>
          <label>
            Код приглашения
            <input name="code" required autoComplete="off" />
          </label>
          <button className="button subtle" disabled={busy}>
            Присоединиться
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
function CommunitySettingsDialog({
  community,
  roles,
  members,
  close,
  onCommunitySaved,
  onRolesChanged,
}: {
  community: Community;
  roles: CommunityRole[];
  members: Member[];
  close: () => void;
  onCommunitySaved: (c: Partial<Community>) => void;
  onRolesChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"overview" | "roles">("overview"),
    [name, setName] = useState(community.name),
    [description, setDescription] = useState(community.description || ""),
    [avatarUrl, setAvatarUrl] = useState<string | null>(
      community.avatarUrl || null,
    ),
    [selectedRole, setSelectedRole] = useState<CommunityRole | null>(null),
    [roleName, setRoleName] = useState(""),
    [color, setColor] = useState("#8b9cff"),
    [position, setPosition] = useState(50),
    [perms, setPerms] = useState({
      sendMessages: true,
      joinVoice: true,
      invite: false,
      manageChannels: false,
    }),
    [selectedMember, setSelectedMember] = useState<string>(""),
    [assigned, setAssigned] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const labels: { key: keyof typeof perms; label: string }[] = [
    { key: "sendMessages", label: "Писать сообщения" },
    { key: "joinVoice", label: "Входить в голосовые каналы" },
    { key: "invite", label: "Приглашать друзей и создавать коды" },
    { key: "manageChannels", label: "Создавать и изменять каналы" },
  ];
  function selectRole(role: CommunityRole | null) {
    setSelectedRole(role);
    setRoleName(role?.name || "");
    setColor(role?.color || "#8b9cff");
    setPosition(role?.position ?? 50);
    setPerms(
      role?.permissions || {
        sendMessages: true,
        joinVoice: true,
        invite: false,
        manageChannels: false,
      },
    );
  }
  async function saveOverview(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const avatarPath = avatarUrl
        ? new URL(avatarUrl, window.location.origin).pathname
        : null;
      const updated = await api<Community>(`/api/communities/${community.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description, avatarUrl: avatarPath }),
      });
      onCommunitySaved(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveRole(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/communities/${community.id}/roles${selectedRole ? `/${selectedRole.id}` : ""}`,
        {
          method: selectedRole ? "PATCH" : "POST",
          body: JSON.stringify({
            name: roleName,
            color,
            position,
            permissions: perms,
          }),
        },
      );
      await onRolesChanged();
      selectRole(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteRole() {
    if (!selectedRole || !confirm(`Удалить роль «${selectedRole.name}»?`))
      return;
    setBusy(true);
    try {
      await api(`/api/communities/${community.id}/roles/${selectedRole.id}`, {
        method: "DELETE",
      });
      await onRolesChanged();
      selectRole(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveAssignment() {
    if (!selectedMember) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/communities/${community.id}/members/${selectedMember}/roles`,
        { method: "PUT", body: JSON.stringify({ roleIds: assigned }) },
      );
      await onRolesChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className="modal community-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Настройки сообщества"
      >
        <button className="close" onClick={close} aria-label="Закрыть">
          ×
        </button>
        <h2>Настройки сообщества</h2>
        <div className="settings-tabs">
          <button
            className={tab === "overview" ? "active" : ""}
            onClick={() => setTab("overview")}
          >
            Обзор
          </button>
          <button
            className={tab === "roles" ? "active" : ""}
            onClick={() => setTab("roles")}
          >
            Роли и права
          </button>
        </div>
        {tab === "overview" ? (
          <form onSubmit={saveOverview} className="community-settings-form">
            <div className="community-preview">
              <span className="community-icon-preview">
                {avatarUrl ? (
                  <img src={apiUrl(avatarUrl)} alt="Аватар сообщества" />
                ) : (
                  name.slice(0, 2).toUpperCase()
                )}
              </span>
              <label className="design-button avatar-pick">
                Изменить аватар
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const a = await uploadFile(file);
                      setAvatarUrl(a.url);
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                />
              </label>
              {avatarUrl && (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setAvatarUrl(null)}
                >
                  Удалить
                </button>
              )}
            </div>
            <label>
              Название
              <input
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label>
              Описание
              <textarea
                value={description}
                maxLength={300}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
            </label>
            <p className="settings-hint">
              Галочка подтверждения выдаётся администрацией VROT, её нельзя
              включить самостоятельно.
            </p>
            <button className="design-button" disabled={busy}>
              Сохранить сообщество
            </button>
          </form>
        ) : (
          <div className="roles-layout">
            <div className="role-list">
              <button
                className={!selectedRole ? "selected" : ""}
                onClick={() => selectRole(null)}
              >
                + Новая роль
              </button>
              {roles.map((r) => (
                  <button
                    key={r.id}
                    className={selectedRole?.id === r.id ? "selected" : ""}
                    onClick={() => selectRole(r)}
                  >
                    <i style={{ background: r.color }} />
                    {r.name}
                  </button>
              ))}
            </div>
            <div className="role-editor">
              <form onSubmit={saveRole}>
                <h3>
                  {selectedRole
                    ? `Редактирование: ${selectedRole.name}`
                    : "Новая роль"}
                </h3>
                <label>
                  Название
                  <input
                    value={roleName}
                    maxLength={40}
                    onChange={(e) => setRoleName(e.target.value)}
                    required
                  />
                </label>
                <div className="role-fields">
                  <label>
                    Цвет
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                    />
                  </label>
                  <label>
                    Приоритет (выше — важнее)
                    <input
                      type="number"
                      value={position}
                      min={selectedRole?.kind === "everyone" ? 0 : 1}
                      max={999}
                      disabled={selectedRole?.kind === "everyone"}
                      onChange={(e) => setPosition(Number(e.target.value))}
                    />
                  </label>
                </div>
                <p className="settings-hint">
                  Если у участника несколько ролей, цвет и права берутся у роли
                  с наибольшим приоритетом.
                </p>
                {labels.map((item) => (
                  <label className="role-check" key={item.key}>
                    <input
                      type="checkbox"
                      checked={perms[item.key]}
                      onChange={(e) =>
                        setPerms((p) => ({
                          ...p,
                          [item.key]: e.target.checked,
                        }))
                      }
                    />
                    {item.label}
                  </label>
                ))}
                <div className="settings-actions">
                  <button className="design-button" disabled={busy}>
                    Сохранить роль
                  </button>
                  {selectedRole?.kind === "custom" && (
                    <button
                      type="button"
                      className="danger-link"
                      onClick={() => void deleteRole()}
                    >
                      Удалить роль
                    </button>
                  )}
                </div>
              </form>
              <hr />
              <h3>Назначить роли</h3>
              <select
                value={selectedMember}
                onChange={(e) => {
                  setSelectedMember(e.target.value);
                  setAssigned(
                    members
                      .find((m) => m.id === e.target.value)
                      ?.roles?.map((r) => r.id) || [],
                  );
                }}
              >
                <option value="">Выберите участника</option>
                {members
                  .filter((m) => m.role === "member")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName || m.username}
                    </option>
                  ))}
              </select>
              {selectedMember && (
                <>
                  <div className="assignment-list">
                    {roles
                      .filter((r) => r.kind === "custom")
                      .map((r) => (
                        <label className="role-check" key={r.id}>
                          <input
                            type="checkbox"
                            checked={assigned.includes(r.id)}
                            onChange={(e) =>
                              setAssigned((prev) =>
                                e.target.checked
                                  ? [...prev, r.id]
                                  : prev.filter((id) => id !== r.id),
                              )
                            }
                          />
                          <i style={{ background: r.color }} />
                          {r.name}
                        </label>
                      ))}
                  </div>
                  <button
                    className="design-button"
                    disabled={busy}
                    onClick={() => void saveAssignment()}
                  >
                    Сохранить роли участника
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
function ChannelSettingsDialog({
  channel,
  roles,
  close,
  onSaved,
  onPermissionSaved,
}: {
  channel: Channel;
  roles: CommunityRole[];
  close: () => void;
  onSaved: (c: Channel) => void;
  onPermissionSaved: () => Promise<unknown>;
}) {
  const [name, setName] = useState(channel.name),
    [description, setDescription] = useState(channel.description || ""),
    [avatarUrl,setAvatarUrl]=useState<string|null>(channel.avatarUrl||null),
    [overrides, setOverrides] = useState<
      { roleId: string; canSend: boolean }[]
    >([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    api<{ roleId: string; canSend: boolean }[]>(
      `/api/channels/${channel.id}/role-permissions`,
    )
      .then(setOverrides)
      .catch((e) => setError(e.message));
  }, [channel.id]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const updated = await api<Channel>(`/api/channels/${channel.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description, avatarUrl:avatarUrl?new URL(avatarUrl,window.location.origin).pathname:null }),
      });
      onSaved(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function setPermission(roleId: string, value: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/channels/${channel.id}/role-permissions`, {
        method: "PUT",
        body: JSON.stringify({
          roleId,
          canSend: value === "inherit" ? null : value === "allow",
        }),
      });
      setOverrides(await api(`/api/channels/${channel.id}/role-permissions`));
      await onPermissionSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className="modal channel-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Настройки канала"
      >
        <button className="close" onClick={close} aria-label="Закрыть">
          ×
        </button>
        <h2>Канал #{channel.name}</h2>
        <form onSubmit={save}>
          <div className="community-preview"><span className="community-icon-preview channel-icon-preview">{avatarUrl?<img src={apiUrl(avatarUrl)} alt="Аватар канала"/>:"#"}</span><label className="design-button avatar-pick">Изменить аватар<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;try{const a=await uploadFile(file);setAvatarUrl(a.url)}catch(err){setError((err as Error).message)}}}/></label>{avatarUrl&&<button type="button" className="ghost-button" onClick={()=>setAvatarUrl(null)}>Удалить</button>}</div>
          <label>
            Название
            <input
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label>
            Описание
            <textarea
              value={description}
              maxLength={300}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <button className="design-button" disabled={busy}>
            Сохранить канал
          </button>
        </form>
        {channel.kind === "text" && (
          <>
            <hr />
            <h3>Кто может писать</h3>
            <p className="settings-hint">
              Настройка канала важнее общих прав роли. Приоритет ролей задаётся
              в настройках сообщества.
            </p>
            {roles.map((r) => (
              <label key={r.id} className="channel-permission-row">
                <span>
                  <i style={{ background: r.color }} />
                  {r.name}
                </span>
                <select
                  disabled={busy}
                  value={
                    overrides.find((x) => x.roleId === r.id)?.canSend === true
                      ? "allow"
                      : overrides.find((x) => x.roleId === r.id)?.canSend ===
                          false
                        ? "deny"
                        : "inherit"
                  }
                  onChange={(e) => void setPermission(r.id, e.target.value)}
                >
                  <option value="inherit">Как в роли</option>
                  <option value="allow">Разрешить</option>
                  <option value="deny">Запретить</option>
                </select>
              </label>
            ))}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
function MembersDialog({
  community,
  close,
  left,
}: {
  community: Community;
  close: () => void;
  left: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    api<Member[]>(`/api/communities/${community.id}/members`)
      .then(setMembers)
      .catch((e) => setError(e.message));
  }, [community.id]);
  async function leave() {
    if (!confirm("Покинуть это сообщество?")) return;
    try {
      await api(`/api/communities/${community.id}/members/me`, {
        method: "DELETE",
      });
      left();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section className="modal" role="dialog" aria-modal="true">
        <button className="close" onClick={close}>
          ×
        </button>
        <h2>Участники · {members.length}</h2>
        <div className="member-list">
          {members.map((m) => (
            <article key={m.id}>
              <Avatar user={m} />
              <strong>{m.username}</strong>
              <small>
                {m.role === "owner"
                  ? "Владелец"
                  : m.role === "admin"
                    ? "Администратор"
                    : "Участник"}
              </small>
            </article>
          ))}
        </div>
        {community.role !== "owner" && (
          <button className="danger" onClick={leave}>
            Покинуть сообщество
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}

function AdminPanel({
  actor,
  config: initialConfig,
  close,
}: {
  actor: User;
  config?: Config;
  close: () => void;
}) {
  const [tab, setTab] = useState<
    "users" | "communities" | "branding" | "settings" | "stats"
  >("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [adminCommunities, setAdminCommunities] = useState<
    { id: string; name: string; verified: boolean }[]
  >([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const [cfg, setCfg] = useState<Config>(
    initialConfig || {
      registrationMode: "closed",
      minimumAge: 18,
      siteName: "VROT",
      siteSlogan: "Своё место для своих.",
      announcement: "",
      customLogoUrl: null,
      operator: { name: "", inn: "", email: "", address: "" },
    },
  );
  const [siteName, setSiteName] = useState(cfg.siteName || "VROT");
  const [siteSlogan, setSiteSlogan] = useState(cfg.siteSlogan || "");
  const [announcement, setAnnouncement] = useState(cfg.announcement || "");
  const [regMode, setRegMode] = useState(cfg.registrationMode || "closed");
  const [minAge, setMinAge] = useState(cfg.minimumAge || 18);
  const [opName, setOpName] = useState(cfg.operator?.name || "");
  const [opInn, setOpInn] = useState(cfg.operator?.inn || "");
  const [opEmail, setOpEmail] = useState(cfg.operator?.email || "");
  const [opAddress, setOpAddress] = useState(cfg.operator?.address || "");
  const [customLogoUrl, setCustomLogoUrl] = useState<string | null>(
    cfg.customLogoUrl || null,
  );
  const [customFaviconUrl, setCustomFaviconUrl] = useState<string | null>(
    cfg.customFaviconUrl || null,
  );

  const [stats, setStats] = useState<{
    usersCount: number;
    messagesCount: number;
    communitiesCount: number;
    onlineCount: number;
    recentEvents: Array<{
      id: string;
      action: string;
      actor_username: string;
      created_at: string;
      target_id?: string;
    }>;
  } | null>(null);

  async function loadSettings() {
    try {
      const data = await api<{ config: Config }>("/api/admin/settings");
      setCfg(data.config);
      setSiteName(data.config.siteName || "VROT");
      setSiteSlogan(data.config.siteSlogan || "");
      setAnnouncement(data.config.announcement || "");
      setRegMode(data.config.registrationMode || "closed");
      setMinAge(data.config.minimumAge || 18);
      setOpName(data.config.operator?.name || "");
      setOpInn(data.config.operator?.inn || "");
      setOpEmail(data.config.operator?.email || "");
      setOpAddress(data.config.operator?.address || "");
      setCustomLogoUrl(data.config.customLogoUrl || null);
      setCustomFaviconUrl(data.config.customFaviconUrl || null);
    } catch (e) {
      console.warn("Failed to load settings:", e);
    }
  }

  async function loadStats() {
    try {
      const data = await api<{
        usersCount: number;
        messagesCount: number;
        communitiesCount: number;
        onlineCount: number;
        recentEvents: any[];
      }>("/api/admin/stats");
      setStats(data);
    } catch (e) {
      console.warn("Failed to load stats:", e);
    }
  }

  async function loadUsers(q = "") {
    try {
      const result = await api<AdminUser[]>(
        `/api/admin/users?q=${encodeURIComponent(q)}`,
      );
      setUsers(result);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function loadAdminCommunities() {
    try {
      setAdminCommunities(await api("/api/admin/communities"));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void loadUsers();
    void loadAdminCommunities();
    void loadSettings();
    void loadStats();
  }, []);

  async function act(user: AdminUser, action: string, value?: string) {
    if (
      ["ban", "freeze"].includes(action) &&
      !confirm(
        `${action === "ban" ? "Заблокировать" : "Заморозить"} ${user.username}?`,
      )
    )
      return;
    setBusy(user.id + action);
    try {
      const reason =
        action === "ban"
          ? prompt(
              "Причина блокировки (видна пользователю):",
              "Нарушение правил",
            ) || "Нарушение правил"
          : undefined;
      const body =
        action === "role" ? { action, role: value } : { action, reason };
      await api(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await loadUsers(query);
      void loadStats();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setBusy("logo");
      setError("");
      const r = await fetch(apiUrl("/api/admin/logo"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": file.type || "image/svg+xml" },
        body: file,
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Ошибка загрузки логотипа");
      }
      const data = await r.json();
      setCustomLogoUrl(apiUrl(data.logoUrl));
      setMsg("Логотип успешно обновлён!");
      setTimeout(() => setMsg(""), 3500);
      void loadSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function handleFaviconUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setBusy("favicon");
      setError("");
      const r = await fetch(apiUrl("/api/admin/favicon"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": file.type || "image/x-icon" },
        body: file,
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Ошибка загрузки favicon");
      }
      const data = await r.json();
      setCustomFaviconUrl(apiUrl(data.faviconUrl));
      setMsg("Favicon успешно обновлён!");
      setTimeout(() => setMsg(""), 3500);
      void loadSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function setPresetFavicon(url: string | null) {
    try {
      setBusy("preset-fav");
      setError("");
      await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ customFaviconUrl: url }),
      });
      setCustomFaviconUrl(url);
      setMsg(url ? "Выбран пресет favicon!" : "Favicon сброшен на стандартный");
      setTimeout(() => setMsg(""), 3500);
      void loadSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function setPresetLogo(url: string | null) {
    try {
      setBusy("preset");
      setError("");
      await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ customLogoUrl: url }),
      });
      setCustomLogoUrl(url);
      setMsg(
        url ? "Выбран пресет логотипа!" : "Логотип сброшен на стандартный SVG",
      );
      setTimeout(() => setMsg(""), 3500);
      void loadSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function saveBranding(e: FormEvent) {
    e.preventDefault();
    try {
      setBusy("branding");
      setError("");
      await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          siteName,
          siteSlogan,
        }),
      });
      setMsg("Брендинг успешно сохранён!");
      setTimeout(() => setMsg(""), 3500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function savePlatformSettings(e: FormEvent) {
    e.preventDefault();
    try {
      setBusy("settings");
      setError("");
      await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          registrationMode: regMode,
          minimumAge: Number(minAge),
          announcement,
          operatorName: opName,
          operatorInn: opInn,
          operatorEmail: opEmail,
          operatorAddress: opAddress,
        }),
      });
      setMsg("Параметры платформы сохранены!");
      setTimeout(() => setMsg(""), 3500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className="modal admin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
      >
        <button className="close" onClick={close} aria-label="Закрыть">
          ×
        </button>
        <h2 id="admin-title">Админ-панель VROT</h2>

        <div className="admin-tabs">
          <button
            type="button"
            className={`admin-tab-btn ${tab === "users" ? "active" : ""}`}
            onClick={() => setTab("users")}
          >
            👥 Пользователи
          </button>
          <button
            type="button"
            className={`admin-tab-btn ${tab === "branding" ? "active" : ""}`}
            onClick={() => setTab("branding")}
          >
            🎨 Логотип и брендинг
          </button>
          <button
            type="button"
            className={`admin-tab-btn ${tab === "communities" ? "active" : ""}`}
            onClick={() => {
              setTab("communities");
              void loadAdminCommunities();
            }}
          >
            Сообщества
          </button>
          <button
            type="button"
            className={`admin-tab-btn ${tab === "settings" ? "active" : ""}`}
            onClick={() => setTab("settings")}
          >
            ⚙️ Параметры платформы
          </button>
          <button
            type="button"
            className={`admin-tab-btn ${tab === "stats" ? "active" : ""}`}
            onClick={() => {
              setTab("stats");
              void loadStats();
            }}
          >
            📊 Статистика
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        {msg && (
          <div className="notice" style={{ marginBottom: 12 }}>
            {msg}
          </div>
        )}

        <div className="admin-tab-content">
          {tab === "communities" && (
            <div className="admin-community-list">
              <h3>Подтверждение сообществ</h3>
              <p className="settings-hint">
                Галочка VROT выдаётся администрацией платформы, а не владельцем
                сообщества.
              </p>
              {adminCommunities.map((c) => (
                <article key={c.id}>
                  <span>
                    {c.name}
                    {c.verified && (
                      <span className="community-verified" title="Подтверждено">
                        ✓
                      </span>
                    )}
                  </span>
                  <button
                    className="design-button"
                    disabled={busy === c.id}
                    onClick={async () => {
                      setBusy(c.id);
                      try {
                        await api(
                          `/api/admin/communities/${c.id}/verification`,
                          {
                            method: "PATCH",
                            body: JSON.stringify({ verified: !c.verified }),
                          },
                        );
                        await loadAdminCommunities();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy("");
                      }
                    }}
                  >
                    {c.verified ? "Снять галочку" : "Подтвердить"}
                  </button>
                </article>
              ))}
            </div>
          )}
          {tab === "users" && (
            <div>
              <form
                className="admin-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadUsers(query);
                }}
              >
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Имя, @username или email"
                />
                <button className="button">Найти</button>
              </form>
              <div className="admin-users">
                {users.map((u) => (
                  <article
                    key={u.id}
                    className={
                      u.banned ? "is-banned" : u.frozen ? "is-frozen" : ""
                    }
                  >
                    <Avatar user={u} />
                    <div className="admin-user-meta">
                      <strong>
                        {u.displayName || u.username}
                        <UserBadges user={u} />
                      </strong>
                      <small>
                        @{u.username} · {u.email}
                      </small>
                      <small>
                        {u.adminRole}
                        {u.banned
                          ? ` · бан: ${u.banReason || "без причины"}`
                          : u.frozen
                            ? " · заморожен"
                            : ""}
                      </small>
                    </div>
                    <div className="admin-actions">
                      <button
                        disabled={!!busy || u.id === actor.id}
                        onClick={() => act(u, u.frozen ? "unfreeze" : "freeze")}
                      >
                        {u.frozen ? "Разморозить" : "Заморозить"}
                      </button>
                      <button
                        disabled={!!busy || u.id === actor.id}
                        className="danger"
                        onClick={() => act(u, u.banned ? "unban" : "ban")}
                      >
                        {u.banned ? "Разбанить" : "Бан"}
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          act(u, u.verified ? "unverify" : "verify")
                        }
                      >
                        {u.verified ? "Снять галочку" : "Верифицировать"}
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          act(u, u.donator ? "undonator" : "donator")
                        }
                        style={
                          u.donator
                            ? { borderColor: "#ec4899", color: "#ec4899" }
                            : {}
                        }
                      >
                        {u.donator ? "Снять донатера" : "💎 Выдать донатера"}
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          act(u, u.mrbeastBadge ? "unmrbeast" : "mrbeast")
                        }
                      >
                        {u.mrbeastBadge
                          ? "Снять фан-бейдж"
                          : "Выдать фан-бейдж MrBeast"}
                      </button>
                      {actor.adminRole === "owner" && u.id !== actor.id && (
                        <select
                          value={u.adminRole || "user"}
                          disabled={!!busy}
                          onChange={(e) => act(u, "role", e.target.value)}
                        >
                          <option value="user">Пользователь</option>
                          <option value="moderator">Модератор</option>
                          <option value="admin">Администратор</option>
                        </select>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          {tab === "branding" && (
            <div>
              <div className="admin-branding-box">
                <h3 style={{ margin: "0 0 10px" }}>Управление логотипом</h3>
                <p
                  style={{ color: "#949ba4", fontSize: 13, margin: "0 0 12px" }}
                >
                  Логотип отображается в шапке, на главной странице, на иконке
                  приложения и в PWA.
                </p>
                <div className="admin-logo-preview-row">
                  <div className="admin-logo-preview">
                    <VrotLogo size={64} customUrl={customLogoUrl} />
                  </div>
                  <div>
                    <label
                      className="button"
                      style={{
                        display: "inline-block",
                        cursor: "pointer",
                        width: "auto",
                      }}
                    >
                      📁 Загрузить новый логотип (SVG / PNG)
                      <input
                        type="file"
                        accept=".svg,.png,.webp,.jpg,.jpeg"
                        style={{ display: "none" }}
                        onChange={handleLogoUpload}
                        disabled={busy === "logo"}
                      />
                    </label>
                    <p
                      style={{
                        fontSize: 12,
                        color: "#949ba4",
                        margin: "6px 0 0",
                      }}
                    >
                      Текущий источник:{" "}
                      {customLogoUrl
                        ? customLogoUrl
                        : "Официальный векторный SVG"}
                    </p>
                  </div>
                </div>

                <div style={{ marginTop: 14 }}>
                  <strong style={{ fontSize: 13, color: "#dbdee1" }}>
                    Быстрые официальные пресеты:
                  </strong>
                  <div className="admin-logo-presets">
                    <button
                      type="button"
                      className="admin-preset-btn"
                      onClick={() => setPresetLogo("/logo.svg")}
                    >
                      Официальный SVG (/logo.svg)
                    </button>
                    <button
                      type="button"
                      className="admin-preset-btn"
                      onClick={() => setPresetLogo("/logo-white.png")}
                    >
                      Белый логотип 2000px (/logo-white.png)
                    </button>
                    <button
                      type="button"
                      className="admin-preset-btn"
                      onClick={() => setPresetLogo("/logo-black.png")}
                    >
                      Чёрный логотип 2000px (/logo-black.png)
                    </button>
                    <button
                      type="button"
                      className="admin-preset-btn"
                      onClick={() => setPresetLogo("/logo-bg.png")}
                    >
                      С фоном (/logo-bg.png)
                    </button>
                    <button
                      type="button"
                      className="admin-preset-btn"
                      onClick={() => setPresetLogo(null)}
                      style={{ color: "#f87171" }}
                    >
                      Сброс на встроенный SVG
                    </button>
                  </div>
                </div>
              </div>

              <div className="admin-branding-box">
                <h3 style={{ margin: "0 0 10px" }}>
                  Управление Favicon (иконка во вкладке браузера)
                </h3>
                <p
                  style={{ color: "#949ba4", fontSize: 13, margin: "0 0 12px" }}
                >
                  Favicon отображается на вкладке браузера, в закладках и на
                  рабочем столе пользователей.
                </p>
                <div className="admin-logo-preview-row">
                  <div
                    className="admin-logo-preview"
                    style={{
                      width: 44,
                      height: 44,
                      minWidth: 44,
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    <img
                      src={customFaviconUrl || customLogoUrl || "/icon.svg"}
                      alt="Favicon"
                      style={{ width: 32, height: 32, objectFit: "contain" }}
                    />
                  </div>
                  <div>
                    <label
                      className="button"
                      style={{
                        display: "inline-block",
                        cursor: "pointer",
                        width: "auto",
                      }}
                    >
                      📁 Загрузить новый Favicon (.ico / .svg / .png)
                      <input
                        type="file"
                        accept=".ico,.svg,.png,.webp"
                        style={{ display: "none" }}
                        onChange={handleFaviconUpload}
                        disabled={busy === "favicon"}
                      />
                    </label>
                    <p
                      style={{
                        fontSize: 12,
                        color: "#949ba4",
                        margin: "6px 0 0",
                      }}
                    >
                      Текущий favicon:{" "}
                      {customFaviconUrl
                        ? customFaviconUrl
                        : "По умолчанию (/icon.svg)"}
                    </p>
                  </div>
                </div>

                <div style={{ marginTop: 14 }}>
                  <strong style={{ fontSize: 13, color: "#dbdee1" }}>
                    Быстрые варианты favicon:
                  </strong>
                  <div className="admin-logo-presets">
                    <button
                      type="button"
                      className="admin-preset-btn"
                      onClick={() => setPresetFavicon("/icon.svg")}
                    >
                      Стандартный SVG (/icon.svg)
                    </button>
                    <button
                      type="button"
                      className="admin-preset-btn"
                      onClick={() => setPresetFavicon("/logo.svg")}
                    >
                      Официальный вектор (/logo.svg)
                    </button>
                    <button
                      type="button"
                      className="admin-preset-btn"
                      onClick={() => setPresetFavicon("/logo-white.png")}
                    >
                      Белая иконка (/logo-white.png)
                    </button>
                    <button
                      type="button"
                      className="admin-preset-btn"
                      onClick={() => setPresetFavicon(null)}
                      style={{ color: "#f87171" }}
                    >
                      Сброс на авто-выбор
                    </button>
                  </div>
                </div>
              </div>

              <form onSubmit={saveBranding} className="admin-branding-box">
                <h3 style={{ margin: "0 0 10px" }}>Название и слоган</h3>
                <label>
                  Название платформы:
                  <input
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                    placeholder="VROT"
                    required
                  />
                </label>
                <label>
                  Слоган / описание:
                  <input
                    value={siteSlogan}
                    onChange={(e) => setSiteSlogan(e.target.value)}
                    placeholder="Своё место для своих."
                  />
                </label>
                <button
                  className="primary button"
                  style={{ marginTop: 12 }}
                  disabled={busy === "branding"}
                >
                  Сохранить брендинг
                </button>
              </form>
            </div>
          )}

          {tab === "settings" && (
            <form
              onSubmit={savePlatformSettings}
              className="admin-branding-box"
            >
              <h3 style={{ margin: "0 0 10px" }}>Параметры платформы</h3>
              <label>
                Режим регистрации:
                <select
                  value={regMode}
                  onChange={(e) => setRegMode(e.target.value)}
                  style={{
                    background: "#090d13",
                    border: "1px solid #354052",
                    color: "#fff",
                    borderRadius: 10,
                    padding: 12,
                  }}
                >
                  <option value="open">Открытая регистрация</option>
                  <option value="closed">
                    Закрытая (только по кодам / приглашениям)
                  </option>
                </select>
              </label>

              <label>
                Минимальный возраст пользователей:
                <input
                  type="number"
                  min="12"
                  max="100"
                  value={minAge}
                  onChange={(e) => setMinAge(Number(e.target.value))}
                />
              </label>

              <label>
                Системное объявление (баннер поверх всего приложения):
                <input
                  value={announcement}
                  onChange={(e) => setAnnouncement(e.target.value)}
                  placeholder="Оставьте пустым, если объявлений нет"
                />
              </label>

              <hr
                style={{
                  border: 0,
                  borderTop: "1px solid #35363c",
                  margin: "18px 0",
                }}
              />
              <h4 style={{ margin: "0 0 8px" }}>
                Реквизиты оператора (152-ФЗ / самозанятый / ИП)
              </h4>
              <p style={{ color: "#949ba4", fontSize: 12, margin: "0 0 10px" }}>
                Отображаются в политике конфиденциальности и соглашениях.
              </p>

              <label>
                ФИО оператора / Наименование:
                <input
                  value={opName}
                  onChange={(e) => setOpName(e.target.value)}
                  placeholder="Самозанятый Иванов И.И."
                />
              </label>

              <label>
                ИНН:
                <input
                  value={opInn}
                  onChange={(e) => setOpInn(e.target.value)}
                  placeholder="12-значный ИНН"
                />
              </label>

              <label>
                Email поддержки / оператора:
                <input
                  type="email"
                  value={opEmail}
                  onChange={(e) => setOpEmail(e.target.value)}
                  placeholder="support@vrot.fun"
                />
              </label>

              <label>
                Адрес оператора:
                <input
                  value={opAddress}
                  onChange={(e) => setOpAddress(e.target.value)}
                  placeholder="г. Москва / РФ"
                />
              </label>

              <button
                className="primary button"
                style={{ marginTop: 14 }}
                disabled={busy === "settings"}
              >
                Сохранить настройки платформы
              </button>
            </form>
          )}

          {tab === "stats" && (
            <div>
              <div className="admin-stats-grid">
                <div className="stat-card">
                  <div className="stat-number">{stats?.usersCount ?? "…"}</div>
                  <div className="stat-label">Пользователей</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number" style={{ color: "#23a559" }}>
                    {stats?.onlineCount ?? "…"}
                  </div>
                  <div className="stat-label">Онлайн сейчас</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">
                    {stats?.messagesCount ?? "…"}
                  </div>
                  <div className="stat-label">Сообщений</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">
                    {stats?.communitiesCount ?? "…"}
                  </div>
                  <div className="stat-label">Сообществ</div>
                </div>
              </div>

              <div className="admin-branding-box">
                <h4 style={{ margin: "0 0 8px" }}>
                  Журнал аудита действий администрации
                </h4>
                {stats?.recentEvents && stats.recentEvents.length > 0 ? (
                  <table className="audit-table">
                    <thead>
                      <tr>
                        <th>Время</th>
                        <th>Действие</th>
                        <th>Администратор</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recentEvents.map((evt) => (
                        <tr key={evt.id}>
                          <td>
                            {new Date(evt.created_at).toLocaleString("ru-RU")}
                          </td>
                          <td>
                            <code>{evt.action}</code>
                          </td>
                          <td>@{evt.actor_username || "система"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p style={{ color: "#949ba4", fontSize: 13 }}>
                    Действий пока не зафиксировано
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function CallPanel({
  socket,
  call,
  currentUser,
  close,
}: {
  socket: Socket;
  call: ActiveCall;
  currentUser: User;
  close: () => void;
}) {
  const [local, setLocal] = useState<MediaStream | null>(null),
    [remotes, setRemotes] = useState<
      Map<string, { user: User; stream: MediaStream }>
    >(new Map()),
    [status, setStatus] = useState("Подключение…"),
    [muted, setMuted] = useState(false),
    [cameraOff, setCameraOff] = useState(!call.video),
    [sharing, setSharing] = useState(false),
    [minimized, setMinimized] = useState(false),
    [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set()),
    [error, setError] = useState("");
  const peers = useRef(new Map<string, RTCPeerConnection>()),
    peerWatchdogs = useRef(new Map<string, number>()),
    remoteStreams = useRef(new Map<string, MediaStream>()),
    pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>()),
    signalChains = useRef(new Map<string, Promise<void>>()),
    baseStream = useRef<MediaStream | null>(null),
    screenTrack = useRef<MediaStreamTrack | null>(null);
  useEffect(() => {
    let disposed = false,
      stream: MediaStream | null = null;
    const target = call.target;
    const removePeer = ({ socketId }: { socketId: string }) => {
      window.clearTimeout(peerWatchdogs.current.get(socketId));
      peerWatchdogs.current.delete(socketId);
      peers.current.get(socketId)?.close();
      peers.current.delete(socketId);
      remoteStreams.current.delete(socketId);
      pendingCandidates.current.delete(socketId);
      setRemotes((x) => {
        const n = new Map(x);
        n.delete(socketId);
        return n;
      });
    };
    const run = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error(
            "Браузер не поддерживает доступ к микрофону и камере",
          );
        const ice = await api<{ iceServers: RTCIceServer[] }>("/api/calls/ice");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: call.video
            ? {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30, max: 30 },
              }
            : false,
        });
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        baseStream.current = stream;
        setLocal(stream);
        const makePeer = async (id: string, user: User, initiator: boolean) => {
          let pc = peers.current.get(id);
          if (pc) return pc;
          pc = new RTCPeerConnection({
            iceServers: ice.iceServers,
          });
          peers.current.set(id, pc);
          peerWatchdogs.current.set(
            id,
            window.setTimeout(() => {
              if (pc?.connectionState !== "connected") {
                setStatus("Не удалось установить связь");
                setError(
                  "Медиа не подключилось за 30 секунд. Завершите звонок и попробуйте ещё раз.",
                );
              }
            }, 30_000),
          );
          pendingCandidates.current.set(id, []);
          stream!
            .getAudioTracks()
            .forEach((track) => pc!.addTrack(track, stream!));
          if (initiator) {
            const videoSender = pc.addTransceiver("video", {
              direction: "sendrecv",
            }).sender;
            const currentVideo =
              screenTrack.current || stream!.getVideoTracks()[0];
            if (currentVideo) await videoSender.replaceTrack(currentVideo);
          }
          pc.onicecandidate = (e) => {
            if (e.candidate)
              socket.emit("call:signal", {
                target,
                to: id,
                candidate: e.candidate,
              });
          };
          pc.ontrack = (e) => {
            let remote = remoteStreams.current.get(id);
            if (!remote) {
              remote = new MediaStream();
              remoteStreams.current.set(id, remote);
            }
            if (!remote.getTracks().some((track) => track.id === e.track.id))
              remote.addTrack(e.track);
            e.track.onmute = () => setRemotes((x) => new Map(x));
            e.track.onunmute = () => setRemotes((x) => new Map(x));
            setRemotes((x) => new Map(x).set(id, { user, stream: remote }));
            setStatus("Устанавливаем связь…");
          };
          pc.onconnectionstatechange = () => {
            if (pc!.connectionState === "connected") {
              window.clearTimeout(peerWatchdogs.current.get(id));
              peerWatchdogs.current.delete(id);
              setError("");
              setStatus("В звонке");
            }
            if (pc!.connectionState === "disconnected")
              setStatus("Восстанавливаем связь…");
            if (pc!.connectionState === "failed") {
              setStatus("Ошибка соединения");
              setError(
                "Не удалось установить звонок. Проверьте сеть и начните его заново.",
              );
            }
            if (["failed", "closed"].includes(pc!.connectionState))
              removePeer({ socketId: id });
          };
          if (initiator) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("call:signal", {
              target,
              to: id,
              description: pc.localDescription,
            });
          }
          return pc;
        };
        const flushCandidates = async (id: string, pc: RTCPeerConnection) => {
          const queued = pendingCandidates.current.get(id) || [];
          pendingCandidates.current.set(id, []);
          for (const candidate of queued) await pc.addIceCandidate(candidate);
        };
        const onSignal = async (data: {
          from: string;
          user: User;
          description?: RTCSessionDescriptionInit;
          candidate?: RTCIceCandidateInit;
        }) => {
          const previous =
            signalChains.current.get(data.from) || Promise.resolve();
          const next = previous.then(async () => {
            const pc = await makePeer(data.from, data.user, false);
            if (data.description) {
              await pc.setRemoteDescription(data.description);
              await flushCandidates(data.from, pc);
              if (data.description.type === "offer") {
                const video = pc
                  .getTransceivers()
                  .find((t) => t.receiver.track.kind === "video");
                if (video) {
                  video.direction = "sendrecv";
                  await video.sender.replaceTrack(
                    screenTrack.current || stream!.getVideoTracks()[0] || null,
                  );
                }
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit("call:signal", {
                  target,
                  to: data.from,
                  description: pc.localDescription,
                });
              }
            }
            if (data.candidate) {
              if (pc.remoteDescription)
                await pc.addIceCandidate(data.candidate);
              else
                pendingCandidates.current.get(data.from)?.push(data.candidate);
            }
          });
          signalChains.current.set(data.from, next);
          try {
            await next;
          } catch (e) {
            setError((e as Error).message);
            setStatus("Ошибка соединения");
          } finally {
            if (signalChains.current.get(data.from) === next)
              signalChains.current.delete(data.from);
          }
        };
        const onPeerJoined = () => setStatus("Подключаем участника…");
        socket.on("call:signal", onSignal);
        socket.on("call:peer-joined", onPeerJoined);
        socket.on("call:peer-left", removePeer);
        socket.emit(
          "call:join",
          target,
          async (ack: {
            ok: boolean;
            error?: string;
            peers?: Array<{ socketId: string; user: User }>;
          }) => {
            if (!ack?.ok) {
              setStatus("Ошибка подключения");
              setError(ack?.error || "Не удалось войти в звонок");
              return;
            }
            setStatus(
              ack.peers?.length ? "Подключаем участника…" : "Ожидание друга…",
            );
            for (const p of ack.peers || [])
              await makePeer(p.socketId, p.user, true);
          },
        );
        return () => {
          socket.off("call:signal", onSignal);
          socket.off("call:peer-joined", onPeerJoined);
          socket.off("call:peer-left", removePeer);
        };
      } catch (e) {
        setStatus("Нет доступа к устройствам");
        const name = e instanceof DOMException ? e.name : "";
        setError(
          name === "NotAllowedError"
            ? "Доступ к микрофону или камере запрещён. Разреши его для cz.vrot.fun в настройках браузера и нажми «Завершить», затем начни звонок снова."
            : name === "NotFoundError"
              ? "Камера или микрофон не найдены."
              : name === "NotReadableError"
                ? "Камера или микрофон заняты другой программой."
                : (e as Error).message,
        );
      }
    };
    let detach: (() => void) | undefined;
    run().then((x) => {
      detach = x;
    });
    return () => {
      disposed = true;
      detach?.();
      socket.emit("call:leave");
      peers.current.forEach((pc) => pc.close());
      peers.current.clear();
      peerWatchdogs.current.forEach((timer) => window.clearTimeout(timer));
      peerWatchdogs.current.clear();
      remoteStreams.current.clear();
      pendingCandidates.current.clear();
      signalChains.current.clear();
      screenTrack.current?.stop();
      screenTrack.current = null;
      baseStream.current = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [call.target.kind, call.target.id, call.video]);
  useEffect(() => {
    if (!window.AudioContext) return;
    const inputs: Array<[string, MediaStream]> = [];
    if (local?.getAudioTracks().length && !muted) inputs.push(["self", local]);
    for (const [id, remote] of remotes)
      if (remote.stream.getAudioTracks().length)
        inputs.push([id, remote.stream]);
    if (!inputs.length) {
      setSpeakingIds(new Set());
      return;
    }
    const context = new AudioContext();
    const meters: Array<{
      id: string;
      source: MediaStreamAudioSourceNode;
      analyser: AnalyserNode;
      samples: Uint8Array<ArrayBuffer>;
    }> = [];
    for (const [id, stream] of inputs) {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      source.connect(analyser);
      meters.push({
        id,
        source,
        analyser,
        samples: new Uint8Array(analyser.fftSize),
      });
    }
    void context.resume().catch(() => {});
    const lastVoice = new Map<string, number>();
    let previous = "";
    const timer = window.setInterval(() => {
      const now = performance.now();
      const next = new Set<string>();
      for (const meter of meters) {
        meter.analyser.getByteTimeDomainData(meter.samples);
        let energy = 0;
        for (const sample of meter.samples) {
          const value = (sample - 128) / 128;
          energy += value * value;
        }
        if (Math.sqrt(energy / meter.samples.length) > 0.025)
          lastVoice.set(meter.id, now);
        if (now - (lastVoice.get(meter.id) || 0) < 420) next.add(meter.id);
      }
      const signature = [...next].sort().join("|");
      if (signature !== previous) {
        previous = signature;
        setSpeakingIds(next);
      }
    }, 120);
    return () => {
      window.clearInterval(timer);
      for (const meter of meters) {
        meter.source.disconnect();
        meter.analyser.disconnect();
      }
      void context.close();
    };
  }, [local, remotes, muted]);
  function toggleMute() {
    local?.getAudioTracks().forEach((t) => (t.enabled = muted));
    setMuted(!muted);
  }
  function toggleCamera() {
    local?.getVideoTracks().forEach((t) => (t.enabled = cameraOff));
    setCameraOff(!cameraOff);
  }
  async function stopSharing() {
    const original = baseStream.current?.getVideoTracks()[0] || null;
    for (const pc of peers.current.values()) {
      const sender = pc
        .getTransceivers()
        .find((t) => t.receiver.track.kind === "video")?.sender;
      if (sender) await sender.replaceTrack(original);
    }
    screenTrack.current?.stop();
    screenTrack.current = null;
    if (baseStream.current) setLocal(baseStream.current);
    setSharing(false);
  }
  async function toggleSharing() {
    if (sharing) {
      await stopSharing();
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        }),
        track = display.getVideoTracks()[0];
      track.contentHint = "detail";
      screenTrack.current = track;
      track.onended = () => {
        void stopSharing();
      };
      for (const pc of peers.current.values()) {
        const sender = pc
          .getTransceivers()
          .find((t) => t.receiver.track.kind === "video")?.sender;
        if (!sender) continue;
        await sender.replaceTrack(track);
        const params = sender.getParameters();
        if (params.encodings?.length) {
          params.encodings[0].maxBitrate = 4_000_000;
          params.encodings[0].scaleResolutionDownBy = 1;
          void sender.setParameters(params).catch(() => {});
        }
      }
      setLocal(
        new MediaStream([
          ...(baseStream.current?.getAudioTracks() || []),
          track,
        ]),
      );
      setSharing(true);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotAllowedError"))
        setError((e as Error).message);
    }
  }
  return (
    <div
      className={`call-overlay${minimized ? " is-minimized" : ""}`}
      role={minimized ? "region" : "dialog"}
      aria-modal={minimized ? undefined : true}
      aria-label={`Звонок ${call.label}`}
    >
      <header>
        <div className="call-heading">
          <span className="call-live-label">
            <i /> ЗВОНОК VROT
          </span>
          <strong>{call.label}</strong>
          <span>
            {status} · {remotes.size + 1} участник(а)
          </span>
        </div>
        <div className="call-header-actions">
          <button
            type="button"
            className="call-window-button"
            onClick={() => setMinimized((value) => !value)}
            aria-label={
              minimized ? "Развернуть звонок" : "Свернуть звонок и открыть чаты"
            }
            title={
              minimized ? "Развернуть звонок" : "К чатам, не завершая звонок"
            }
          >
            {minimized ? "Развернуть" : "К чатам"}
          </button>
          <button className="hangup" onClick={close} title="Завершить звонок">
            Завершить
          </button>
        </div>
      </header>
      {minimized && (
        <div className="call-mini-peers" aria-label="Участники звонка">
          <div
            className={`call-mini-peer${speakingIds.has("self") ? " is-speaking" : ""}`}
            title="Вы"
          >
            <Avatar user={currentUser} />
            <span>Вы</span>
          </div>
          {[...remotes.entries()].map(([id, remote]) => (
            <div
              key={id}
              className={`call-mini-peer${speakingIds.has(id) ? " is-speaking" : ""}`}
              title={remote.user.displayName || remote.user.username}
            >
              <Avatar user={remote.user} />
              <span>{remote.user.displayName || remote.user.username}</span>
            </div>
          ))}
        </div>
      )}
      <div
        className={`video-grid${remotes.size >= 2 ? " is-group" : ""}${!call.video ? " is-audio-call" : ""}`}
        aria-hidden={minimized}
      >
        {local && (
          <VideoTile
            stream={local}
            name={sharing ? "Ваш экран" : "Вы"}
            user={currentUser}
            speaking={speakingIds.has("self")}
            muted
            mirror={!sharing}
            audioOnly={local.getVideoTracks().length === 0}
          />
        )}{" "}
        {[...remotes.entries()].map(([id, x]) => (
          <VideoTile
            key={id}
            stream={x.stream}
            name={x.user.displayName || x.user.username}
            user={x.user}
            speaking={speakingIds.has(id)}
            audioOnly={
              !x.stream
                .getVideoTracks()
                .some((t) => t.readyState === "live" && !t.muted)
            }
          />
        ))}
      </div>
      {error && (
        <div className="call-error">
          <p>{error}</p>
          <button className="ghost-button" onClick={close}>
            Завершить звонок
          </button>
        </div>
      )}
      <div className="call-controls">
        <button
          className={muted ? "off" : ""}
          onClick={toggleMute}
          title={muted ? "Включить микрофон" : "Выключить микрофон"}
          aria-label={muted ? "Включить микрофон" : "Выключить микрофон"}
        >
          <Icon name="mic" />{" "}
          <span>{muted ? "Включить микрофон" : "Микрофон"}</span>
        </button>
        {call.video && (
          <button
            className={cameraOff ? "off" : ""}
            onClick={toggleCamera}
            title={cameraOff ? "Включить камеру" : "Выключить камеру"}
            aria-label={cameraOff ? "Включить камеру" : "Выключить камеру"}
          >
            <Icon name="video" />{" "}
            <span>{cameraOff ? "Включить камеру" : "Камера"}</span>
          </button>
        )}
        <button
          className={sharing ? "off" : ""}
          onClick={() => void toggleSharing()}
          title={sharing ? "Остановить демонстрацию экрана" : "Показать экран"}
          aria-label={
            sharing ? "Остановить демонстрацию экрана" : "Показать экран"
          }
        >
          <Icon name="screen" />{" "}
          <span>{sharing ? "Остановить экран" : "Показать экран"}</span>
        </button>
        <button className="hangup" onClick={close} title="Положить трубку">
          Положить трубку
        </button>
      </div>
    </div>
  );
}
function VideoTile({
  stream,
  name,
  user,
  speaking,
  muted = false,
  mirror = false,
  audioOnly = false,
}: {
  stream: MediaStream;
  name: string;
  user: { username: string; avatarUrl?: string | null };
  speaking: boolean;
  muted?: boolean;
  mirror?: boolean;
  audioOnly?: boolean;
}) {
  const tileRef = useRef<HTMLElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPortrait, setIsPortrait] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = stream;
    const start = () => {
      if (muted || !stream.getAudioTracks().length) return;
      void audio
        .play()
        .then(() => setAudioBlocked(false))
        .catch(() => setAudioBlocked(true));
    };
    start();
    stream.addEventListener("addtrack", start);
    return () => stream.removeEventListener("addtrack", start);
  }, [stream, muted, audioOnly]);

  const audioElement = (
    <audio
      ref={audioRef}
      autoPlay
      muted={muted}
      aria-label={`Аудио: ${name}`}
    />
  );
  const unlockAudio = audioBlocked && !muted && (
    <button
      type="button"
      className="audio-unlock"
      onClick={() =>
        void audioRef.current?.play().then(() => setAudioBlocked(false))
      }
    >
      Включить звук
    </button>
  );

  function toggleFullscreen() {
    if (!tileRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    } else {
      tileRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    }
  }

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  if (audioOnly)
    return (
      <figure
        className={`video-tile audio-tile${speaking ? " is-speaking" : ""}`}
        ref={tileRef}
      >
        <div className="audio-avatar" aria-hidden="true">
          <Avatar user={user} />
        </div>
        {audioElement}
        {unlockAudio}
        {speaking && (
          <span className="speaker-indicator">
            <i /> Говорит
          </span>
        )}
        <figcaption>{name}</figcaption>
      </figure>
    );

  return (
    <figure
      className={`video-tile${isPortrait ? " is-portrait" : ""}${speaking ? " is-speaking" : ""}`}
      ref={tileRef}
    >
      <video
        ref={(el) => {
          if (el && el.srcObject !== stream) {
            el.srcObject = stream;
            void el.play().catch(() => {});
          }
        }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoHeight > v.videoWidth) {
            setIsPortrait(true);
          } else {
            setIsPortrait(false);
          }
          void v.play().catch(() => {});
        }}
        autoPlay
        playsInline
        muted
        className={mirror ? "mirror" : ""}
      />
      {audioElement}
      {unlockAudio}
      {speaking && (
        <span className="speaker-indicator">
          <i /> Говорит
        </span>
      )}
      <button
        type="button"
        className="video-fullscreen-btn"
        onClick={toggleFullscreen}
        title={
          isFullscreen ? "Выйти из полноэкранного режима" : "На весь экран"
        }
        aria-label="На весь экран"
      >
        {isFullscreen ? "🗗" : "⛶"}
      </button>
      <figcaption>
        <Avatar user={user} small />
        {name}
      </figcaption>
    </figure>
  );
}

function Settings({
  close,
  logout,
  user,
  onAvatar,
}: {
  close: () => void;
  logout: () => void;
  user: User;
  onAvatar: (u: User) => void;
}) {
  const [danger, setDanger] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem("vrot_theme") || "dark");
  const [language, setLanguage] = useState(localStorage.getItem("vrot_language") || "ru");

  const [avatarAction, setAvatarAction] = useState(false);
  const [bannerAction, setBannerAction] = useState(false);
  const [notifState, setNotifState] = useState<string>(
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "default",
  );
  const [cropTarget, setCropTarget] = useState<{
    src: string;
    kind: "avatar" | "banner";
    aspect: number;
    isCircle: boolean;
    title: string;
  } | null>(null);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  async function handleEnablePush() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setError("Ваш браузер не поддерживает системные уведомления");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const ok = await subscribeToPush(true);
      if (typeof Notification !== "undefined") {
        setNotifState(Notification.permission);
      }
      if (ok) {
        setNotice("Системные уведомления успешно разрешены и включены!");
      } else if (Notification.permission === "denied") {
        setError(
          "Уведомления заблокированы в браузере. Разрешите их в настройках сайта.",
        );
      } else {
        setError("Разрешение на показ уведомлений не было предоставлено");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleTestNotification() {
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      setError("Сначала включите уведомления кнопкой выше");
      return;
    }
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification("VROT: Проверка связи", {
          body: "Системные уведомления работают! Сообщения будут приходить прямо на ваш экран.",
          icon: "/icon.svg",
          badge: "/icon.svg",
          vibrate: [200, 100, 200],
          tag: "vrot-test",
        } as any);
      } else {
        new Notification("VROT: Проверка связи", {
          body: "Системные уведомления работают! Сообщения будут приходить прямо на ваш экран.",
          icon: "/icon.svg",
        });
      }
      setNotice("Тестовое уведомление отправлено в систему!");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function updateImage(kind: "avatar" | "banner", value: string | null) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ user: User }>(`/api/profile/${kind}`, {
        method: "PUT",
        body: JSON.stringify({
          [kind === "avatar" ? "avatarUrl" : "bannerUrl"]: value,
        }),
      });
      onAvatar(r.user);
      setNotice(
        value
          ? kind === "avatar"
            ? "Аватар обновлён"
            : "Шапка обновлена"
          : kind === "avatar"
            ? "Аватар удалён"
            : "Шапка удалена",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleFileChosen(
    e: React.ChangeEvent<HTMLInputElement>,
    kind: "avatar" | "banner",
  ) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("Поддерживаются только форматы PNG, JPEG и WebP");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("Не удалось прочитать выбранный файл");
    reader.onload = () => {
      setCropTarget({
        src: String(reader.result),
        kind,
        aspect: kind === "avatar" ? 1 : 3,
        isCircle: kind === "avatar",
        title:
          kind === "avatar"
            ? "Настройка и обрезка аватара"
            : "Настройка и обрезка шапки профиля",
      });
    };
    reader.readAsDataURL(file);
  }

  async function saveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<{ user: User }>("/api/profile", {
        method: "PUT",
        body: JSON.stringify({
          username: f.get("username"),
          displayName: f.get("displayName"),
          bio: f.get("bio"),
          status: f.get("status"),
        }),
      });
      onAvatar(r.user);
      setNotice("Настройки сохранены");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function password(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const f = new FormData(e.currentTarget);
    try {
      await api("/api/profile/password", {
        method: "PUT",
        body: JSON.stringify({
          currentPassword: f.get("currentPassword"),
          newPassword: f.get("newPassword"),
        }),
      });
      e.currentTarget.reset();
      setNotice("Пароль изменён");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!confirm("Удалить аккаунт без возможности восстановления?")) return;
    try {
      await api("/api/account", {
        method: "DELETE",
        body: JSON.stringify({ password: f.get("password") }),
      });
      location.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <button className="close" onClick={close} aria-label="Закрыть">
          ×
        </button>
        <h2 id="settings-title">Мой профиль</h2>
        <div className="appearance-settings">
          <h3>{tr("Внешний вид и язык", "Appearance and language")}</h3>
          <label>{tr("Тема", "Theme")}
            <select value={theme} onChange={(event) => {const value=event.target.value;setTheme(value);localStorage.setItem("vrot_theme",value);document.documentElement.dataset.theme=value;}}>
              <option value="dark">{tr("Тёмная", "Dark")}</option><option value="light">{tr("Светлая", "Light")}</option>
            </select>
          </label>
          <label>{tr("Язык интерфейса", "Interface language")}
            <select value={language} onChange={(event) => {const value=event.target.value;setLanguage(value);localStorage.setItem("vrot_language",value);document.documentElement.lang=value;window.location.reload();}}>
              <option value="ru">Русский</option><option value="en">English</option>
            </select>
          </label>
        </div>

        {/* Скрытые инпуты для загрузки файлов */}
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={(e) => handleFileChosen(e, "avatar")}
        />
        <input
          ref={bannerInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={(e) => handleFileChosen(e, "banner")}
        />

        <div className="profile-preview">
          {user.bannerUrl ? (
            <div
              className="profile-banner-clickable"
              onClick={() => setBannerAction(true)}
              title="Нажмите, чтобы изменить или удалить шапку"
            >
              <img
                className="profile-banner"
                src={user.bannerUrl}
                alt="Шапка профиля"
              />
              <span className="banner-hover-tag">
                Изменить или удалить шапку
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="profile-banner fallback add-banner-btn"
              onClick={() => bannerInputRef.current?.click()}
              title="Добавить шапку профиля"
            >
              + Добавить шапку
            </button>
          )}

          {user.avatarUrl ? (
            <div
              className="profile-avatar-clickable"
              onClick={() => setAvatarAction(true)}
              title="Нажмите, чтобы изменить или удалить аватар"
            >
              <Avatar user={user} />
              <span className="avatar-hover-icon">✎</span>
            </div>
          ) : (
            <button
              type="button"
              className="profile-avatar-clickable empty-avatar-btn"
              onClick={() => avatarInputRef.current?.click()}
              title="Добавить аватар"
            >
              <span className="avatar-plus-symbol">+</span>
            </button>
          )}

          <div>
            <strong>
              {user.displayName || user.username}
              <UserBadges user={user} />
            </strong>
            <small>@{user.username}</small>
            <p>{user.bio || "Добавьте описание профиля"}</p>
          </div>
        </div>

        {/* Всплывающее меню для шапки при клике */}
        {bannerAction && (
          <div
            className="action-menu-backdrop"
            onClick={() => setBannerAction(false)}
          >
            <div
              className="action-menu-sheet"
              onClick={(e) => e.stopPropagation()}
            >
              <h4>Шапка профиля</h4>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setBannerAction(false);
                  bannerInputRef.current?.click();
                }}
              >
                🖼️ Загрузить новую шапку
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => {
                  setBannerAction(false);
                  updateImage("banner", null);
                }}
              >
                🗑️ Удалить шапку
              </button>
              <button
                type="button"
                className="button subtle"
                onClick={() => setBannerAction(false)}
              >
                Отмена
              </button>
            </div>
          </div>
        )}

        {/* Всплывающее меню для аватара при клике */}
        {avatarAction && (
          <div
            className="action-menu-backdrop"
            onClick={() => setAvatarAction(false)}
          >
            <div
              className="action-menu-sheet"
              onClick={(e) => e.stopPropagation()}
            >
              <h4>Аватар профиля</h4>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setAvatarAction(false);
                  avatarInputRef.current?.click();
                }}
              >
                🖼️ Загрузить новый аватар
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => {
                  setAvatarAction(false);
                  updateImage("avatar", null);
                }}
              >
                🗑️ Удалить аватар
              </button>
              <button
                type="button"
                className="button subtle"
                onClick={() => setAvatarAction(false)}
              >
                Отмена
              </button>
            </div>
          </div>
        )}

        {/* Модальное окно обрезки изображений */}
        {cropTarget && (
          <ImageCropperModal
            imageSrc={cropTarget.src}
            aspect={cropTarget.aspect}
            isCircle={cropTarget.isCircle}
            title={cropTarget.title}
            onCancel={() => setCropTarget(null)}
            onSave={(croppedBase64) => {
              const kind = cropTarget.kind;
              setCropTarget(null);
              void updateImage(kind, croppedBase64);
            }}
          />
        )}

        <form className="settings-form" onSubmit={saveProfile}>
          <label>
            Имя пользователя
            <input
              name="username"
              defaultValue={user.username}
              minLength={3}
              maxLength={32}
              required
            />
          </label>
          <label>
            Отображаемое имя
            <input
              name="displayName"
              defaultValue={user.displayName || user.username}
              maxLength={64}
              required
            />
          </label>
          <label>
            Описание
            <textarea
              name="bio"
              defaultValue={user.bio || ""}
              maxLength={300}
              rows={3}
            />
          </label>
          <label>
            Статус
            <select name="status" defaultValue={user.status || "online"}>
              <option value="online">В сети</option>
              <option value="idle">Не активен</option>
              <option value="dnd">Не беспокоить</option>
              <option value="offline">Невидимый</option>
            </select>
          </label>
          <button className="button" disabled={busy}>
            Сохранить профиль
          </button>
        </form>
        {notice && <p className="success">{notice}</p>}
        {error && <p className="error">{error}</p>}

        <hr />
        <h3>Уведомления на телефон и ПК</h3>
        <div className="push-settings-box">
          <p>
            Включите уведомления, чтобы получать сообщения от друзей и вызовы в
            систему Windows или на телефон даже при свёрнутом браузере.
          </p>
          <div className="push-status-row">
            <span>Статус в системе: </span>
            {notifState === "granted" ? (
              <strong className="status-granted">✅ Разрешено</strong>
            ) : notifState === "denied" ? (
              <strong className="status-denied">
                ⚠️ Заблокировано в браузере
              </strong>
            ) : (
              <strong className="status-default">⏳ Не включено</strong>
            )}
          </div>
          {notifState === "granted" ? (
            <div className="push-btn-row">
              <button
                type="button"
                className="button push-test-btn"
                disabled={busy}
                onClick={handleTestNotification}
              >
                🔔 Отправить тестовое уведомление
              </button>
            </div>
          ) : notifState === "denied" ? (
            <p className="push-denied-tip">
              Уведомления для <strong>cz.vrot.fun</strong> были заблокированы в
              браузере. Чтобы включить: нажмите на иконку замочка/настроек слева
              от адресной строки и переключите «Уведомления» в «Разрешить»,
              затем обновите страницу.
            </p>
          ) : (
            <button
              type="button"
              className="button push-enable-btn"
              disabled={busy}
              onClick={handleEnablePush}
            >
              🔔 Включить уведомления
            </button>
          )}

          <hr className="subtle-hr" />
          <div className="android-apk-box">
            <h4>📱 Мобильное приложение Android</h4>
            <p>
              Полное APK-приложение VROT для Android с системными входящими
              звонками (на весь экран) и уведомлениями.
            </p>
            <a
              href="/download/vrot.apk"
              className="button secondary apk-download-btn"
              download="vrot.apk"
            >
              📥 Скачать VROT для Android (.apk)
            </a>
          </div>
        </div>

        <hr />
        <h3>Пароль</h3>
        <form className="settings-form two" onSubmit={password}>
          <label>
            Текущий пароль
            <input name="currentPassword" type="password" required />
          </label>
          <label>
            Новый пароль
            <input name="newPassword" type="password" minLength={12} required />
          </label>
          <button className="button" disabled={busy}>
            Изменить пароль
          </button>
        </form>

        <hr />
        <h3>Управление аккаунтом</h3>
        <div className="account-actions-group">
          <a
            className="button secondary"
            href={apiUrl("/api/account/export")}
            download
          >
            📥 Скачать мои данные
          </a>
          <button type="button" className="button secondary" onClick={logout}>
            🚪 Выйти
          </button>
          <button
            type="button"
            className="button danger"
            onClick={() => setDanger(!danger)}
          >
            🗑️ Удалить аккаунт
          </button>
        </div>
        {danger && (
          <form className="danger-zone-form" onSubmit={remove}>
            <p className="danger-text">
              Все ваши сообщения, друзья и файлы будут удалены навсегда. Для
              подтверждения введите пароль:
            </p>
            <label>
              Пароль для подтверждения
              <input name="password" type="password" required />
            </label>
            <button className="button danger">Удалить аккаунт навсегда</button>
          </form>
        )}
      </section>
    </div>
  );
}

function CookieNotice({ openPolicy }: { openPolicy: () => void }) {
  const [open, setOpen] = useState(
    () => localStorage.getItem("vrot_cookie_notice") !== "seen",
  );
  if (!open) return null;
  return (
    <aside className="cookie" aria-label="Уведомление о cookies">
      <div>
        <strong>Только необходимые cookies</strong>
        <p>
          Мы используем один защищённый cookie для входа. Аналитики, рекламы и
          сторонних трекеров нет.
        </p>
      </div>
      <button className="link" onClick={openPolicy}>
        Подробнее
      </button>
      <button
        onClick={() => {
          localStorage.setItem("vrot_cookie_notice", "seen");
          setOpen(false);
        }}
      >
        Понятно
      </button>
    </aside>
  );
}
function Footer({ openLegal }: { openLegal: (x: string) => void }) {
  const openFaq = useFaq();
  return (
    <footer className="footer">
      <span>© {new Date().getFullYear()} VROT.fun</span>
      {[
        ["privacy", "Конфиденциальность"],
        ["terms", "Условия"],
        ["cookies", "Cookies"],
        ["refund", "Возвраты"],
      ].map(([x, t]) => (
        <button key={x} onClick={() => openLegal(x)}>
          {t}
        </button>
      ))}
      <button onClick={() => openFaq("verification")}>FAQ и справка</button>
    </footer>
  );
}

const legalText: {
  [k: string]: { title: string; body: (c: Config) => React.ReactNode };
} = {
  privacy: {
    title: "Политика обработки персональных данных",
    body: (c) => (
      <>
        <p>Редакция от 3 октября 2026 года. Оператор: {operator(c)}.</p>
        <h3>Что и зачем обрабатывается</h3>
        <p>
          Для создания аккаунта: имя пользователя, email, дата рождения и хеш
          пароля; для работы сервиса: сообщения, членство в сообществах,
          технические журналы безопасности, IP в виде необратимого хеша и данные
          сессии. Цели — исполнение договора, безопасность, поддержка и
          исполнение обязанностей по закону. Рекламные профили не создаются.
        </p>
        <h3>Основания и сроки</h3>
        <p>
          Основания: заключение и исполнение пользовательского договора,
          согласие там, где оно требуется, и обязанности оператора по закону.
          Данные аккаунта хранятся до удаления аккаунта; журналы безопасности —
          до 12 месяцев; сведения и сообщения, которые закон требует хранить от
          организатора распространения информации, — в установленные законом
          сроки.
        </p>
        <h3>Хранение и получатели</h3>
        <p>
          Первичная запись и хранение данных граждан РФ выполняются на сервере в
          Российской Федерации. Передача возможна хостинг-провайдеру как
          обработчику и государственным органам только на законном основании.
          Трансграничная передача и рекламные системы не используются.
        </p>
        <h3>Ваши права</h3>
        <p>
          В настройках доступны экспорт и удаление. Запрос на уточнение,
          ограничение обработки, отзыв согласия или сведения об обработке
          направляется по адресу {c.operator.email || "[нужен email оператора]"}
          . Отзыв согласия не отменяет обработку на иных законных основаниях.
        </p>
        <p>
          Меры защиты: TLS, Argon2id для паролей, шифрование сообщений
          AES‑256‑GCM, разграничение доступа, журналы аудита, резервное
          копирование и обновления безопасности.
        </p>
      </>
    ),
  },
  terms: {
    title: "Условия использования",
    body: (c) => (
      <>
        <p>
          Редакция от 3 октября 2026 года. Эти условия являются договором между
          пользователем и {operator(c)}.
        </p>
        <h3>Сервис</h3>
        <p>
          Vrot.fun предоставляет аккаунт, сообщества, каналы и обмен
          сообщениями. Регистрация означает принятие условий и подтверждение
          возраста не менее {c.minimumAge} лет.
        </p>
        <h3>Запрещено</h3>
        <p>
          Нельзя публиковать незаконный контент, угрозы, травлю, материалы
          сексуального насилия над детьми, вредоносный код, спам, нарушать права
          третьих лиц, обходить защиту или выдавать себя за другого человека.
          Пользователь отвечает за размещаемые материалы и наличие необходимых
          прав.
        </p>
        <h3>Модерация и прекращение</h3>
        <p>
          Мы вправе ограничить контент или аккаунт при нарушении условий или
          законном требовании. Пользователь может удалить аккаунт в настройках.
          Существенные изменения условий публикуются заранее.
        </p>
        <h3>Ответственность</h3>
        <p>
          Сервис предоставляется с разумной заботливостью, но непрерывность не
          гарантируется. Ограничения ответственности применяются только в
          пределах, разрешённых обязательным законодательством о защите прав
          потребителей.
        </p>
      </>
    ),
  },
  cookies: {
    title: "Политика cookies",
    body: (c) => (
      <>
        <p>
          Vrot.fun не использует рекламные, аналитические или сторонние cookies.
        </p>
        <p>
          <strong>vrot_session</strong> — строго необходимый защищённый HttpOnly
          cookie входа, срок до 30 дней. Без него авторизованная часть сервиса
          не работает. Запись <strong>vrot_cookie_notice</strong> хранится
          только в localStorage браузера и помнит закрытие уведомления.
        </p>
        <p>
          Удалить cookie можно через выход из аккаунта или настройки браузера.
          Для необходимых cookies отдельное согласие не запрашивается.
        </p>
      </>
    ),
  },
  refund: {
    title: "Политика оплаты и возвратов",
    body: () => (
      <>
        <p>
          На текущем этапе Vrot.fun бесплатен, не принимает платежи и не
          содержит платных функций, подписок, скрытых комиссий или
          автоматических списаний.
        </p>
        <p>
          До запуска любой платной функции здесь будут заранее опубликованы
          цена, порядок оплаты, отказа и возврата. Оплата не будет подключена
          без явного действия пользователя.
        </p>
      </>
    ),
  },
};
function operator(c: Config) {
  return c.operator.name
    ? `${c.operator.name}${c.operator.inn ? `, ИНН ${c.operator.inn}` : ""}${c.operator.address ? `, ${c.operator.address}` : ""}`
    : "[реквизиты оператора должны быть заполнены до публичного запуска]";
}
function Legal({
  type,
  cfg,
  close,
}: {
  type: string;
  cfg: Config;
  close: () => void;
}) {
  const x = legalText[type] || legalText.privacy;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <article
        className="modal legal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-title"
      >
        <button className="close" onClick={close} aria-label="Закрыть">
          ×
        </button>
        <h2 id="legal-title">{x.title}</h2>
        {x.body(cfg)}
      </article>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
