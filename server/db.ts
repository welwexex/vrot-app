import pg from 'pg';
import {randomUUID} from 'node:crypto';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20, idleTimeoutMillis: 30_000 });

export async function migrate(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY, username varchar(32) NOT NULL, username_key varchar(32) UNIQUE NOT NULL,
      email varchar(254) UNIQUE NOT NULL, phone varchar(32), phone_verified_at timestamptz,
      password_hash text NOT NULL, birth_date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz, marketing_consent_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash char(64) UNIQUE NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      ip_hash char(64), user_agent varchar(300)
    );
    CREATE TABLE IF NOT EXISTS communities (
      id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), name varchar(60) NOT NULL,
      description varchar(300) NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS community_members (
      community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, role varchar(16) NOT NULL DEFAULT 'member',
      joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(community_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS channels (
      id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      name varchar(40) NOT NULL, position integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(community_id,name)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      author_id uuid REFERENCES users(id) ON DELETE SET NULL, content_enc text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), edited_at timestamptz, deleted_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS messages_channel_time ON messages(channel_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS invites (
      code varchar(32) PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, max_uses integer NOT NULL DEFAULT 25,
      uses integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS community_invitations (
      id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      inviter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invitee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status varchar(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
      created_at timestamptz NOT NULL DEFAULT now(), responded_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS community_invitations_pending ON community_invitations(community_id,invitee_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS friendships (
      requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status varchar(16) NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(requester_id,addressee_id), CHECK(requester_id <> addressee_id)
    );
    CREATE INDEX IF NOT EXISTS friendships_addressee_status ON friendships(addressee_id,status);
    CREATE INDEX IF NOT EXISTS friendships_requester_status ON friendships(requester_id,status);
    CREATE TABLE IF NOT EXISTS direct_messages (
      id uuid PRIMARY KEY, sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, content_enc text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
      CHECK(sender_id <> recipient_id)
    );
    CREATE INDEX IF NOT EXISTS direct_messages_pair_time ON direct_messages(sender_id,recipient_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS attachments (
      id uuid PRIMARY KEY, uploader_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mime varchar(100) NOT NULL, original_name varchar(255) NOT NULL, storage_name varchar(80) UNIQUE NOT NULL,
      size integer NOT NULL CHECK(size>0 AND size<=20971520), created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id bigserial PRIMARY KEY, actor_id uuid, event_type varchar(80) NOT NULL, subject_id text,
      details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh text NOT NULL, auth text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      last_success_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS android_devices (
      token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS android_devices_user ON android_devices(user_id);
    CREATE TABLE IF NOT EXISTS ios_devices (
      token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind varchar(8) NOT NULL CHECK (kind IN ('apns','voip')),
      created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ios_devices_user ON ios_devices(user_id);
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code_hash char(64) NOT NULL,
      expires_at timestamptz NOT NULL,
      attempts smallint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name varchar(64)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio varchar(300)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'online'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_role varchar(24) NOT NULL DEFAULT 'user'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS frozen_at timestamptz`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at timestamptz`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason varchar(300)`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS kind varchar(16) NOT NULL DEFAULT 'text'`);
  await pool.query(`ALTER TABLE communities ADD COLUMN IF NOT EXISTS avatar_url text`);
  await pool.query(`ALTER TABLE communities ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS description varchar(300) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS avatar_url text`);
  await pool.query(`CREATE TABLE IF NOT EXISTS community_roles (
    id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name varchar(40) NOT NULL, color varchar(7) NOT NULL DEFAULT '#b5bac1', position integer NOT NULL DEFAULT 0,
    kind varchar(16) NOT NULL DEFAULT 'custom' CHECK(kind IN ('everyone','admin','custom')),
    permissions jsonb NOT NULL DEFAULT '{}', UNIQUE(community_id,name), UNIQUE(community_id,kind,name)
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS community_roles_base ON community_roles(community_id,kind) WHERE kind IN ('everyone','admin')`);
  await pool.query(`CREATE TABLE IF NOT EXISTS community_member_roles (
    community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES community_roles(id) ON DELETE CASCADE,
    PRIMARY KEY(community_id,user_id,role_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS channel_role_permissions (
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES community_roles(id) ON DELETE CASCADE,
    can_send boolean NOT NULL, PRIMARY KEY(channel_id,role_id)
  )`);
  const missingRoles=await pool.query(`SELECT c.id FROM communities c WHERE NOT EXISTS(SELECT 1 FROM community_roles r WHERE r.community_id=c.id AND r.kind='everyone')`);
  for(const c of missingRoles.rows){
    await pool.query(`INSERT INTO community_roles(id,community_id,name,color,position,kind,permissions) VALUES($1,$2,'Участники','#b5bac1',0,'everyone',$3) ON CONFLICT DO NOTHING`,[randomUUID(),c.id,JSON.stringify({sendMessages:true,joinVoice:true,invite:true,manageChannels:false})]);
    await pool.query(`INSERT INTO community_roles(id,community_id,name,color,position,kind,permissions) VALUES($1,$2,'Администратор','#e893a9',100,'admin',$3) ON CONFLICT DO NOTHING`,[randomUUID(),c.id,JSON.stringify({sendMessages:true,joinVoice:true,invite:true,manageChannels:true})]);
  }
  await pool.query(`INSERT INTO community_member_roles(community_id,user_id,role_id) SELECT cm.community_id,cm.user_id,r.id FROM community_members cm JOIN community_roles r ON r.community_id=cm.community_id AND r.kind='admin' WHERE cm.role='admin' ON CONFLICT DO NOTHING`);
  await pool.query(`ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_kind_check`);
  await pool.query(`ALTER TABLE channels ADD CONSTRAINT channels_kind_check CHECK(kind IN ('text','voice'))`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS donator boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mrbeast_badge boolean NOT NULL DEFAULT false`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key varchar(64) PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES direct_messages(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS client_message_id uuid`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id uuid`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS direct_message_client_unique ON direct_messages(sender_id,client_message_id) WHERE client_message_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS channel_message_client_unique ON messages(author_id,client_message_id) WHERE client_message_id IS NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      id bigserial PRIMARY KEY,
      message_id uuid NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji varchar(16) NOT NULL,
      is_dm boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(message_id, user_id, emoji)
    )
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_owner_id uuid REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_token varchar(128) UNIQUE`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_markup jsonb`);
  await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS reply_markup jsonb`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_updates (
      id bigserial PRIMARY KEY,
      bot_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      update_data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bot_updates_bot_idx ON bot_updates(bot_id, id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_webhooks (
      bot_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      url text NOT NULL,
      secret_token varchar(128),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Ensure BotFather exists
  const bf = await pool.query(`SELECT id FROM users WHERE username_key='botfather'`);
  if (!bf.rowCount) {
    const bfId = randomUUID();
    const dummyHash = '$argon2id$v=19$m=65536,t=3,p=1$fake$fake';
    await pool.query(`
      INSERT INTO users (id, username, username_key, email, password_hash, birth_date, display_name, bio, is_bot, verified, status)
      VALUES ($1, 'BotFather', 'botfather', 'botfather@vrot.fun', $2, '2000-01-01', 'BotFather', 'Официальный отец ботов VROT. Создание и управление ботами.', true, true, 'bot')
      ON CONFLICT (username_key) DO NOTHING
    `, [bfId, dummyHash]);
  }

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_commands JSONB DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_settings JSONB DEFAULT '{"allowMessages":"everyone","allowCalls":"everyone","showBio":"everyone","showBanner":"everyone","showAvatar":"everyone"}'::jsonb`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_wallpaper text DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS customization JSONB DEFAULT '{"accentColor":"#5865f2","messageStyle":"bubble"}'::jsonb`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_blocks (
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    blocked_id uuid REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, blocked_id)
  )`);
  await pool.query(`
    UPDATE users SET bot_commands = '[
      {"command": "start", "description": "Главное меню BotFather"},
      {"command": "newbot", "description": "Создать нового бота"},
      {"command": "mybots", "description": "Мои боты и управление токенами"},
      {"command": "setcommands", "description": "Настроить меню команд бота"},
      {"command": "token", "description": "Сгенерировать новый API токен"},
      {"command": "help", "description": "Справка и документация"}
    ]'::jsonb WHERE username_key = 'botfather' AND (bot_commands IS NULL OR bot_commands = '[]'::jsonb)
  `);

  // Email verification & Security migrations
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token_hash char(64)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires_at timestamptz`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes text[] DEFAULT '{}'`);

  // Passkey credentials
  await pool.query(`
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key text NOT NULL,
      counter bigint NOT NULL DEFAULT 0,
      device_name varchar(100) NOT NULL DEFAULT 'Устройство',
      transports text[] DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS passkey_user_idx ON passkey_credentials(user_id)`);

  // Auth Challenges for WebAuthn & 2FA Temp Tokens
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_challenges (
      id uuid PRIMARY KEY,
      challenge text NOT NULL,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      challenge_type varchar(32) NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS auth_challenges_exp_idx ON auth_challenges(expires_at)`);

  // Sessions extensions
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now()`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address varchar(45)`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_name varchar(120)`);

  // V AI memory table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS v_ai_memory (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      compact_summary text NOT NULL DEFAULT '',
      last_interaction_at timestamptz NOT NULL DEFAULT now(),
      turns_count int NOT NULL DEFAULT 0
    )
  `);

  // Setup V AI Bot profile & commands
  await pool.query(`
    UPDATE users SET
      display_name = 'V AI',
      bio = 'Персональный ИИ-ассистент VROT 2.1. Умеет общаться на любые темы, анализировать фото и безопасно искать в ваших переписках без слэш-команд.',
      verified = true,
      status = 'bot',
      bot_commands = '[
        {"command": "start", "description": "Познакомиться с V AI"},
        {"command": "clear", "description": "Сбросить память диалога"},
        {"command": "help", "description": "Справка и возможности"}
      ]'::jsonb
    WHERE username_key = 'vai_bot' OR id = '571e0139-02bf-498f-acab-87582cfcb7b0'
  `);

  // Migrations for VROT 2.1
  await pool.query(`
    CREATE TABLE IF NOT EXISTS archived_chats (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      peer_id uuid NOT NULL,
      is_channel boolean NOT NULL DEFAULT false,
      archived_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, peer_id)
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS quick_reaction varchar(16) NOT NULL DEFAULT '❤️';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_code_hash char(64);
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_type varchar(32) NOT NULL DEFAULT 'Web Browser';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_name varchar(100) NOT NULL DEFAULT 'Браузер';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS app_version varchar(32) NOT NULL DEFAULT '1.0.0';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address varchar(64) DEFAULT NULL;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_active_at timestamptz NOT NULL DEFAULT now();
  `);
}

export async function audit(actorId:string|null,eventType:string,subjectId?:string,details:Record<string,unknown>={}){
  await pool.query('INSERT INTO audit_events(actor_id,event_type,subject_id,details) VALUES($1,$2,$3,$4)',[actorId,eventType,subjectId??null,JSON.stringify(details)]);
}
