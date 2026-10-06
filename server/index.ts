import 'dotenv/config';
import path from 'node:path';
import express,{NextFunction,Request,Response} from 'express';
import http from 'node:http';
import http2 from 'node:http2';
import {createHmac,randomInt,sign,timingSafeEqual} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import fs from 'node:fs';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import argon2 from 'argon2';
import {Server} from 'socket.io';
import webpush from 'web-push';
import nodemailer from 'nodemailer';
import {cert,getApps,initializeApp} from 'firebase-admin/app';
import {getMessaging} from 'firebase-admin/messaging';
import {z} from 'zod';
import {audit,migrate,pool} from './db.js';
import {decrypt,encrypt,randomToken,sha256,uuid} from './crypto.js';

declare global { namespace Express { interface Request { user?:{id:string,username:string,email:string,avatar_url?:string|null,display_name?:string|null,bio?:string|null,banner_url?:string|null,status?:string,verified?:boolean,donator?:boolean,mrbeast_badge?:boolean,admin_role?:string,frozen_at?:string|null,banned_at?:string|null,ban_reason?:string|null} } } }
const app=express(); const server=http.createServer(app); const origin=process.env.PUBLIC_ORIGIN||'http://localhost:5173';
const allowedOrigins=[origin,...(process.env.ADDITIONAL_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean)];
const io=new Server(server,{cors:{origin:allowedOrigins,credentials:true},maxHttpBufferSize:1_000_000});
app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",'https://api.vrot.fun'],styleSrc:["'self'",'https://api.vrot.fun'],imgSrc:["'self'","data:",'https://api.vrot.fun'],mediaSrc:["'self'",'https://api.vrot.fun'],connectSrc:["'self'",'wss:','https://api.vrot.fun'],fontSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"]}}}));
app.use(express.json({limit:'768kb'})); app.use(cookieParser());
app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
app.use('/api/uploads',(req,res,next)=>{res.setHeader('Cross-Origin-Resource-Policy','same-site');next();});
app.use((req,res,next)=>{const requestOrigin=req.get('origin');if(requestOrigin&&allowedOrigins.includes(requestOrigin)){res.setHeader('Access-Control-Allow-Origin',requestOrigin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-File-Name');res.vary('Origin');if(req.method==='OPTIONS')return res.status(204).end();}next();});
app.use('/api/auth',rateLimit({windowMs:15*60_000,limit:20,standardHeaders:'draft-7',legacyHeaders:false}));
app.use((req,res,next)=>{ if(['POST','PUT','PATCH','DELETE'].includes(req.method)){const o=req.get('origin');if(o&&!allowedOrigins.includes(o))return res.status(403).json({error:'Недопустимый источник запроса'});} next(); });

const wrap=(fn:(req:Request,res:Response,next:NextFunction)=>Promise<unknown>)=>(req:Request,res:Response,next:NextFunction)=>fn(req,res,next).catch(next);
async function sessionUser(token?:string){
  if(!token)return null; const q=await pool.query(`SELECT u.id,u.username,u.email,u.avatar_url,u.display_name,u.bio,u.banner_url,u.status,u.verified,u.donator,u.mrbeast_badge,u.admin_role,u.frozen_at,u.banned_at,u.ban_reason FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.deleted_at IS NULL`,[sha256(token)]); return q.rows[0]||null;
}
const auth=wrap(async(req,res,next)=>{const user=await sessionUser(req.cookies.vrot_session);if(!user)return res.status(401).json({error:'Нужен вход'});if(user.banned_at)return res.status(403).json({error:user.ban_reason?`Аккаунт заблокирован: ${user.ban_reason}`:'Аккаунт заблокирован'});if(user.frozen_at&&['POST','PUT','PATCH','DELETE'].includes(req.method)&&req.path!=='/auth/logout')return res.status(423).json({error:'Аккаунт заморожен: доступен только просмотр данных на момент заморозки'});req.user=user;next();});
const publicUser=(r:any)=>({id:r.id,username:r.username,displayName:r.display_name||r.username,avatarUrl:r.avatar_url||null,bannerUrl:r.banner_url||null,bio:r.bio||'',status:r.status||'online',verified:Boolean(r.verified),donator:Boolean(r.donator),mrbeastBadge:Boolean(r.mrbeast_badge),adminRole:r.admin_role||'user',frozen:Boolean(r.frozen_at)});
const adminRoles=['moderator','admin','owner'];
const requireAdmin=(req:Request,res:Response,next:NextFunction)=>adminRoles.includes(req.user?.admin_role||'')?next():res.status(403).json({error:'Нужны права администратора'});

let systemSettings: Record<string, string> = {};
async function loadSystemSettings() {
  try {
    const q = await pool.query('SELECT key, value FROM system_settings');
    systemSettings = Object.fromEntries(q.rows.map(r => [r.key, r.value]));
  } catch (e) {
    console.error('Failed to load system settings:', e);
  }
}
function config(){
  return {
    registrationMode: systemSettings.registration_mode || process.env.REGISTRATION_MODE || 'closed',
    minimumAge: Number(systemSettings.minimum_age || process.env.MINIMUM_AGE || 18),
    customLogoUrl: systemSettings.custom_logo_url || null,
    customFaviconUrl: systemSettings.custom_favicon_url || null,
    siteName: systemSettings.site_name || 'VROT',
    siteSlogan: systemSettings.site_slogan || 'Своё место для своих.',
    announcement: systemSettings.announcement || '',
    operator: {
      name: systemSettings.operator_name || process.env.OPERATOR_NAME || '',
      inn: systemSettings.operator_inn || process.env.OPERATOR_INN || '',
      email: systemSettings.operator_email || process.env.OPERATOR_EMAIL || '',
      address: systemSettings.operator_address || process.env.OPERATOR_ADDRESS || ''
    }
  };
}

let vapidPublicKey=process.env.VAPID_PUBLIC_KEY||'',vapidPrivateKey=process.env.VAPID_PRIVATE_KEY||'';
async function initPushKeys(){
  if(!vapidPublicKey||!vapidPrivateKey){
    const q=await pool.query("SELECT key,value FROM system_settings WHERE key IN ('vapid_public_key','vapid_private_key')");
    const saved=Object.fromEntries(q.rows.map(r=>[r.key,r.value]));
    vapidPublicKey=saved.vapid_public_key||'';vapidPrivateKey=saved.vapid_private_key||'';
    if(!vapidPublicKey||!vapidPrivateKey){
      const generated=webpush.generateVAPIDKeys();vapidPublicKey=generated.publicKey;vapidPrivateKey=generated.privateKey;
      await pool.query("INSERT INTO system_settings(key,value) VALUES('vapid_public_key',$1),('vapid_private_key',$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[vapidPublicKey,vapidPrivateKey]);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:admin@cz.vrot.fun',vapidPublicKey,vapidPrivateKey);
}
const onlineUsers=new Map<string,number>();
function computePresence(userId:string,customStatus?:string){const isOnline=(onlineUsers.get(userId)||0)>0;if(!isOnline)return 'offline';return customStatus&&customStatus!=='offline'?customStatus:'online';}
const firebaseAccountPath=process.env.FIREBASE_SERVICE_ACCOUNT_PATH||'';
if(firebaseAccountPath&&fs.existsSync(firebaseAccountPath)){try{initializeApp({credential:cert(JSON.parse(fs.readFileSync(firebaseAccountPath,'utf8')))});}catch(e){console.error('Firebase initialization failed',e instanceof Error?e.message:e);}}
type PushPayload={title:string;body:string;url?:string;tag?:string;kind?:'message'|'channel'|'call'|'invite';friendId?:string;channelId?:string;video?:boolean;callId?:string;expiresAt?:number};
const apnsKeyPath=process.env.APNS_KEY_PATH||'';
function apnsAuthorization(){
  if(!process.env.APNS_KEY_ID||!process.env.APNS_TEAM_ID)return null;
  const key=apnsKeyPath&&fs.existsSync(apnsKeyPath)?fs.readFileSync(apnsKeyPath):process.env.APNS_KEY_BASE64?Buffer.from(process.env.APNS_KEY_BASE64,'base64'):null;
  if(!key)return null;
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const header=encode({alg:'ES256',kid:process.env.APNS_KEY_ID}),body=encode({iss:process.env.APNS_TEAM_ID,iat:Math.floor(Date.now()/1000)});
  return `${header}.${body}.${sign('sha256',Buffer.from(`${header}.${body}`),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
}
async function sendApplePush(userId:string,kind:'apns'|'voip',payload:Record<string,unknown>){
  const token=apnsAuthorization();if(!token)return;
  const devices=await pool.query('SELECT token FROM ios_devices WHERE user_id=$1 AND kind=$2',[userId,kind]);
  const host=process.env.APNS_ENV==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com';
  const topic=`${process.env.APNS_BUNDLE_ID||'fun.vrot.ios'}${kind==='voip'?'.voip':''}`;
  await Promise.all(devices.rows.map(async row=>{
    const client=http2.connect(host);
    client.on('error',error=>console.error('APNs HTTP/2 connection failed',error.message));
    try{
      const result=await new Promise<{status:number;body:string}>((resolve,reject)=>{
        const request=client.request({':method':'POST',':path':`/3/device/${row.token}`,authorization:`bearer ${token}`,'apns-topic':topic,'apns-push-type':kind==='voip'?'voip':'alert','apns-priority':'10','apns-expiration':'0'});
        let status=0,body='';request.on('response',headers=>{status=Number(headers[':status']||0);});request.setEncoding('utf8');request.on('data',chunk=>{body+=chunk;});request.on('end',()=>resolve({status,body}));request.on('error',reject);request.end(JSON.stringify(payload));
      });
      if(result.status===410||result.status===400&&result.body.includes('BadDeviceToken'))await pool.query('DELETE FROM ios_devices WHERE token=$1',[row.token]);
      else if(result.status!==200)console.error('APNs rejected notification',result.status,result.body);
    }catch(error){console.error('APNs delivery failed',error instanceof Error?error.message:error);}finally{client.close();}
  }));
}
async function sendPush(userId:string,payload:PushPayload){
  if(vapidPublicKey&&vapidPrivateKey){
  const q=await pool.query('SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=$1',[userId]);
  await Promise.all(q.rows.map(async row=>{
    try{
      await webpush.sendNotification({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}},JSON.stringify(payload),{TTL:86400,urgency:'high'});
      await pool.query('UPDATE push_subscriptions SET last_success_at=now() WHERE endpoint=$1',[row.endpoint]);
    }catch(e:any){
      if(e?.statusCode===404||e?.statusCode===410)await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1',[row.endpoint]);
      else console.error('push delivery failed',e?.statusCode||e?.message||e);
    }
  }));
  }
  if(payload.kind==='call'){
    void sendApplePush(userId,'apns',{aps:{alert:{title:payload.title,body:payload.body},sound:'default','content-available':1},kind:'call',friendId:payload.friendId||'',callId:payload.callId||'',video:Boolean(payload.video),expiresAt:payload.expiresAt}).catch(console.error);
  } else {
    void sendApplePush(userId,'apns',{aps:{alert:{title:payload.title,body:payload.body},sound:'default'},kind:payload.kind||'message',friendId:payload.friendId||'',channelId:payload.channelId||''}).catch(console.error);
  }
  if(!getApps().length)return;
  const devices=await pool.query('SELECT token FROM android_devices WHERE user_id=$1',[userId]);
  for(let i=0;i<devices.rows.length;i+=500){
    const tokens=devices.rows.slice(i,i+500).map(row=>String(row.token));
    try{
      const result=await getMessaging().sendEachForMulticast({tokens,data:{type:payload.kind||'message',title:payload.title,body:payload.body,url:payload.url||'/',tag:payload.tag||'',friendId:payload.friendId||'',channelId:payload.channelId||'',video:String(Boolean(payload.video)),callId:payload.callId||''},android:{priority:payload.kind==='call'?'high':'normal',ttl:payload.kind==='call'?30_000:86_400_000}});
      for(let n=0;n<result.responses.length;n++){const error=result.responses[n].error;if(error&&['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(error.code))await pool.query('DELETE FROM android_devices WHERE token=$1',[tokens[n]]);}
    }catch(e){console.error('Android push delivery failed',e instanceof Error?e.message:e);}
  }
}

app.get('/api/config',(_req,res)=>res.json(config()));
app.get('/api/health',async(_req,res)=>{await pool.query('SELECT 1');res.json({ok:true});});
app.get('/api/auth/me',wrap(async(req,res)=>{const user=await sessionUser(req.cookies.vrot_session);res.json({user:user?publicUser(user):null});}));

const registerSchema=z.object({username:z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_.-]+$/u),email:z.string().email().max(254).transform(v=>v.toLowerCase()),password:z.string().min(12).max(128),birthDate:z.string().date(),legalAccepted:z.literal(true)});
app.post('/api/auth/register',wrap(async(req,res)=>{
  const cfg=config(); if(cfg.registrationMode!=='open')return res.status(503).json({error:'Публичная регистрация откроется после завершения обязательной идентификации пользователей'});
  const d=registerSchema.parse(req.body),birth=new Date(`${d.birthDate}T00:00:00Z`),age=Math.floor((Date.now()-birth.getTime())/31557600000);
  if(age<cfg.minimumAge)return res.status(400).json({error:`Регистрация доступна с ${cfg.minimumAge} лет`});
  const id=uuid(),hash=await argon2.hash(d.password,{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1});
  try{await pool.query('INSERT INTO users(id,username,username_key,email,password_hash,birth_date) VALUES($1,$2,$3,$4,$5,$6)',[id,d.username,d.username.toLocaleLowerCase('ru'),d.email,hash,d.birthDate]);}
  catch(e:any){if(e.code==='23505')return res.status(409).json({error:'Имя или email уже заняты'});throw e;}
  await audit(id,'account.registered',id); await issueSession(req,res,id); res.status(201).json({user:{id,username:d.username}});
}));
const loginSchema=z.object({email:z.string().trim().min(1).max(254).transform(v=>v.toLowerCase()),password:z.string().min(1).max(128)});
app.post('/api/auth/login',wrap(async(req,res)=>{const d=loginSchema.parse(req.body);const q=await pool.query('SELECT * FROM users WHERE (email=$1 OR username_key=$2) AND deleted_at IS NULL',[d.email,d.email.toLocaleLowerCase('ru')]);const u=q.rows[0];if(!u||!await argon2.verify(u.password_hash,d.password)){await new Promise(r=>setTimeout(r,350));return res.status(401).json({error:'Неверный логин (email / имя) или пароль'});}if(u.banned_at)return res.status(403).json({error:u.ban_reason?`Аккаунт заблокирован: ${u.ban_reason}`:'Аккаунт заблокирован'});await issueSession(req,res,u.id);await audit(u.id,'account.login',u.id);res.json({user:publicUser(u)});}));
app.post('/api/auth/logout',auth,wrap(async(req,res)=>{await pool.query('DELETE FROM sessions WHERE token_hash=$1',[sha256(req.cookies.vrot_session)]);res.clearCookie('vrot_session');res.status(204).end();}));
const resetEmailSchema=z.object({email:z.string().email().max(254).transform(v=>v.toLowerCase())});
const resetConfirmSchema=resetEmailSchema.extend({code:z.string().regex(/^\d{6}$/),newPassword:z.string().min(12).max(128)});
const smtpHost=process.env.SMTP_HOST||'';
const mailer=smtpHost?nodemailer.createTransport({host:smtpHost,port:Number(process.env.SMTP_PORT||25),secure:process.env.SMTP_SECURE==='true',ignoreTLS:smtpHost==='host.docker.internal',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD||''}:undefined,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000}):null;
async function sendResetEmail(to:string,code:string){
  const relayUrl=process.env.MAIL_RELAY_URL;
  if(relayUrl){
    const secret=process.env.TURN_SECRET;
    if(!secret)throw new Error('Mail relay secret is missing');
    const body=JSON.stringify({to,code}),timestamp=String(Date.now());
    const key=createHmac('sha256',secret).update('vrot-mail-relay-v1').digest();
    const signature=createHmac('sha256',key).update(`${timestamp}.${body}`).digest('hex');
    const response=await fetch(relayUrl,{method:'POST',headers:{'content-type':'application/json','x-vrot-time':timestamp,'x-vrot-signature':signature},body,signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Mail relay returned ${response.status}`);
    return;
  }
  if(!mailer)throw new Error('Mail transport is not configured');
  await mailer.sendMail({from:process.env.SMTP_FROM||'VROT <noreply@cz.vrot.fun>',to,subject:'Код восстановления VROT',text:`Код восстановления: ${code}\n\nОн действует 10 минут. Если вы не запрашивали восстановление, просто проигнорируйте письмо.`,html:`<p>Ваш код восстановления VROT:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">${code}</p><p>Код действует 10 минут. Если вы не запрашивали восстановление, проигнорируйте письмо.</p>`});
}
const resetCodeHash=(userId:string,code:string)=>createHmac('sha256',process.env.DATA_ENCRYPTION_KEY||'').update(`${userId}:${code}`).digest('hex');
app.post('/api/auth/password-reset/request',rateLimit({windowMs:15*60_000,limit:5}),wrap(async(req,res)=>{
  const {email}=resetEmailSchema.parse(req.body);
  if(!mailer&&!process.env.MAIL_RELAY_URL)return res.status(503).json({error:'Отправка писем пока недоступна'});
  const user=(await pool.query('SELECT id,email FROM users WHERE email=$1 AND deleted_at IS NULL AND banned_at IS NULL',[email])).rows[0];
  if(user){
    const prior=(await pool.query('SELECT created_at FROM password_reset_codes WHERE user_id=$1',[user.id])).rows[0];
    if(!prior||Date.now()-new Date(prior.created_at).getTime()>90_000){
      const code=String(randomInt(0,1_000_000)).padStart(6,'0');
      await pool.query(`INSERT INTO password_reset_codes(user_id,code_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT(user_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,created_at=now()`,[user.id,resetCodeHash(user.id,code)]);
      try{
        await sendResetEmail(user.email,code);
        await audit(user.id,'account.password_reset_requested',user.id);
      }catch(e){await pool.query('DELETE FROM password_reset_codes WHERE user_id=$1',[user.id]);console.error('password reset email failed',e);return res.status(503).json({error:'Письмо сейчас не отправилось. Попробуйте позже'});}
    }
  }
  res.json({ok:true,message:'Если адрес зарегистрирован, код придёт на почту в течение нескольких минут.'});
}));
app.post('/api/auth/password-reset/confirm',rateLimit({windowMs:15*60_000,limit:15}),wrap(async(req,res)=>{
  const d=resetConfirmSchema.parse(req.body),client=await pool.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query(`SELECT u.id,r.code_hash,r.attempts,r.expires_at FROM users u JOIN password_reset_codes r ON r.user_id=u.id WHERE u.email=$1 AND u.deleted_at IS NULL AND u.banned_at IS NULL FOR UPDATE OF r`,[d.email]);
    const row=q.rows[0];
    if(!row||new Date(row.expires_at).getTime()<Date.now()||row.attempts>=5){await client.query('COMMIT');return res.status(400).json({error:'Код недействителен или истёк'});}
    const actual=Buffer.from(resetCodeHash(row.id,d.code),'hex'),expected=Buffer.from(row.code_hash,'hex');
    if(!timingSafeEqual(actual,expected)){
      await client.query('UPDATE password_reset_codes SET attempts=attempts+1 WHERE user_id=$1',[row.id]);
      await client.query('COMMIT');
      return res.status(400).json({error:'Код недействителен или истёк'});
    }
    const hash=await argon2.hash(d.newPassword,{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1});
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,row.id]);
    await client.query('DELETE FROM sessions WHERE user_id=$1',[row.id]);
    await client.query('DELETE FROM push_subscriptions WHERE user_id=$1',[row.id]);
    await client.query('DELETE FROM ios_devices WHERE user_id=$1',[row.id]);
    await client.query('DELETE FROM android_devices WHERE user_id=$1',[row.id]);
    await client.query('DELETE FROM password_reset_codes WHERE user_id=$1',[row.id]);
    await client.query('COMMIT');
    await audit(row.id,'account.password_reset_completed',row.id);
    res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.get('/api/push/public-key',auth,(_req,res)=>vapidPublicKey?res.json({publicKey:vapidPublicKey}):res.status(503).json({error:'Push-уведомления ещё не настроены'}));
const pushSchema=z.object({endpoint:z.string().url().max(2048),keys:z.object({p256dh:z.string().min(20).max(512),auth:z.string().min(8).max(256)})});
app.post('/api/push/subscriptions',auth,wrap(async(req,res)=>{const d=pushSchema.parse(req.body);await pool.query(`INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,created_at=now()`,[d.endpoint,req.user!.id,d.keys.p256dh,d.keys.auth]);await audit(req.user!.id,'push.subscribed',req.user!.id);res.status(201).json({ok:true});}));
app.post('/api/push/test',auth,wrap(async(req,res)=>{await sendPush(req.user!.id,{title:'Vrot.fun',body:'Тестовое уведомление успешно доставлено!',url:'/',tag:'test'});res.json({ok:true});}));
app.delete('/api/push/subscriptions',auth,wrap(async(req,res)=>{const d=z.object({endpoint:z.string().url().max(2048)}).parse(req.body);await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2',[d.endpoint,req.user!.id]);res.status(204).end();}));
const androidTokenSchema=z.object({token:z.string().min(20).max(4096)});
app.post('/api/android/devices',auth,rateLimit({windowMs:60_000,limit:10}),wrap(async(req,res)=>{const {token}=androidTokenSchema.parse(req.body);await pool.query('INSERT INTO android_devices(token,user_id) VALUES($1,$2) ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id,last_seen_at=now()',[token,req.user!.id]);res.status(201).json({ok:true,pushConfigured:getApps().length>0});}));
app.delete('/api/android/devices',auth,wrap(async(req,res)=>{const {token}=androidTokenSchema.parse(req.body);await pool.query('DELETE FROM android_devices WHERE token=$1 AND user_id=$2',[token,req.user!.id]);res.status(204).end();}));
const iosTokenSchema=z.object({token:z.string().regex(/^[a-fA-F0-9]{64,256}$/),kind:z.enum(['apns','voip'])});
app.post('/api/ios/devices',auth,rateLimit({windowMs:60_000,limit:10}),wrap(async(req,res)=>{const d=iosTokenSchema.parse(req.body);await pool.query('INSERT INTO ios_devices(token,user_id,kind) VALUES($1,$2,$3) ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id,kind=EXCLUDED.kind,last_seen_at=now()',[d.token,req.user!.id,d.kind]);res.status(201).json({ok:true,pushConfigured:Boolean(apnsAuthorization())});}));
app.delete('/api/ios/devices',auth,wrap(async(req,res)=>{const d=iosTokenSchema.parse(req.body);await pool.query('DELETE FROM ios_devices WHERE token=$1 AND user_id=$2',[d.token,req.user!.id]);res.status(204).end();}));
const avatarSchema=z.object({avatarUrl:z.union([z.null(),z.string().max(220_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/,'Недопустимый формат аватарки')])});
app.put('/api/profile/avatar',auth,wrap(async(req,res)=>{const d=avatarSchema.parse(req.body);await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2',[d.avatarUrl,req.user!.id]);const user=(await pool.query('SELECT * FROM users WHERE id=$1',[req.user!.id])).rows[0];res.json({user:publicUser(user)});}));
const bannerSchema=z.object({bannerUrl:z.union([z.null(),z.string().max(420_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/,'Недопустимый формат шапки')])});
app.put('/api/profile/banner',auth,wrap(async(req,res)=>{const d=bannerSchema.parse(req.body);await pool.query('UPDATE users SET banner_url=$1 WHERE id=$2',[d.bannerUrl,req.user!.id]);const user=(await pool.query('SELECT * FROM users WHERE id=$1',[req.user!.id])).rows[0];res.json({user:publicUser(user)});}));
const profileSchema=z.object({username:z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_.-]+$/u),displayName:z.string().trim().min(1).max(64),bio:z.string().trim().max(300),status:z.enum(['online','idle','dnd','offline'])});
app.put('/api/profile',auth,wrap(async(req,res)=>{const d=profileSchema.parse(req.body);try{const q=await pool.query('UPDATE users SET username=$1,username_key=$2,display_name=$3,bio=$4,status=$5 WHERE id=$6 RETURNING *',[d.username,d.username.toLocaleLowerCase('ru'),d.displayName,d.bio,d.status,req.user!.id]);res.json({user:publicUser(q.rows[0])});}catch(e:any){if(e.code==='23505')return res.status(409).json({error:'Это имя пользователя уже занято'});throw e;}}));
const passwordSchema=z.object({currentPassword:z.string().min(1).max(128),newPassword:z.string().min(12).max(128)});
app.put('/api/profile/password',auth,rateLimit({windowMs:15*60_000,limit:8}),wrap(async(req,res)=>{const d=passwordSchema.parse(req.body),q=await pool.query('SELECT password_hash FROM users WHERE id=$1',[req.user!.id]);if(!q.rows[0]||!await argon2.verify(q.rows[0].password_hash,d.currentPassword))return res.status(403).json({error:'Текущий пароль неверен'});const hash=await argon2.hash(d.newPassword,{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1});await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,req.user!.id]);await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[req.user!.id,sha256(req.cookies.vrot_session)]);await audit(req.user!.id,'account.password_changed',req.user!.id);res.status(204).end();}));
async function issueSession(req:Request,res:Response,userId:string){const token=randomToken(),id=uuid();await pool.query(`INSERT INTO sessions(id,user_id,token_hash,expires_at,ip_hash,user_agent) VALUES($1,$2,$3,now()+interval '30 days',$4,$5)`,[id,userId,sha256(token),sha256(String(req.ip)),String(req.get('user-agent')||'').slice(0,300)]);res.cookie('vrot_session',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:30*86400_000});}

app.get('/api/communities',auth,wrap(async(req,res)=>{const q=await pool.query(`SELECT c.id,c.name,c.description,c.avatar_url "avatarUrl",c.verified,cm.role FROM communities c JOIN community_members cm ON cm.community_id=c.id WHERE cm.user_id=$1 ORDER BY c.created_at`,[req.user!.id]);res.json(q.rows);}));
app.post('/api/communities',auth,wrap(async(req,res)=>{const d=z.object({name:z.string().trim().min(2).max(60),description:z.string().trim().max(300).default('')}).parse(req.body),client=await pool.connect(),id=uuid();try{await client.query('BEGIN');await client.query('INSERT INTO communities(id,owner_id,name,description) VALUES($1,$2,$3,$4)',[id,req.user!.id,d.name,d.description]);await client.query("INSERT INTO community_members(community_id,user_id,role) VALUES($1,$2,'owner')",[id,req.user!.id]);await client.query(`INSERT INTO community_roles(id,community_id,name,color,kind,permissions) VALUES($1,$2,'Участники','#b5bac1','everyone',$3),($4,$2,'Администратор','#e893a9','admin',$5)`,[uuid(),id,JSON.stringify({sendMessages:true,joinVoice:true,invite:true,manageChannels:false}),uuid(),JSON.stringify({sendMessages:true,joinVoice:true,invite:true,manageChannels:true})]);const channelId=uuid();await client.query('INSERT INTO channels(id,community_id,name) VALUES($1,$2,$3)',[channelId,id,'общий']);await client.query('COMMIT');await audit(req.user!.id,'community.created',id);res.status(201).json({id,name:d.name,description:d.description,role:'owner',channelId});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}));
app.get('/api/communities/:id/channels',auth,wrap(async(req,res)=>{const communityId=String(req.params.id);if(!await isMember(req.user!.id,communityId))return res.status(403).json({error:'Нет доступа'});const q=await pool.query('SELECT id,name,description,avatar_url "avatarUrl",kind,position FROM channels WHERE community_id=$1 ORDER BY CASE kind WHEN \'text\' THEN 0 ELSE 1 END,position,name',[communityId]);res.json(q.rows);}));
app.post('/api/communities/:id/channels',auth,wrap(async(req,res)=>{const communityId=String(req.params.id);if(!await canCommunity(req.user!.id,communityId,'manageChannels'))return res.status(403).json({error:'Недостаточно прав'});const d=z.object({name:z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}_-]+$/u),kind:z.enum(['text','voice']).default('text')}).parse(req.body),id=uuid();await pool.query('INSERT INTO channels(id,community_id,name,kind) VALUES($1,$2,$3,$4)',[id,communityId,d.name.toLocaleLowerCase('ru'),d.kind]);res.status(201).json({id,name:d.name,description:'',avatarUrl:null,kind:d.kind});}));
const communityEditSchema=z.object({name:z.string().trim().min(2).max(60),description:z.string().trim().max(300),avatarUrl:z.string().regex(/^\/api\/uploads\/[0-9a-f-]{36}$/).nullable()});
app.patch('/api/communities/:id',auth,wrap(async(req,res)=>{const id=String(req.params.id);if(await memberRole(req.user!.id,id)!=='owner')return res.status(403).json({error:'Оформление меняет только владелец'});const d=communityEditSchema.parse(req.body);if(d.avatarUrl){const fileId=d.avatarUrl.split('/').pop();const a=await pool.query(`SELECT 1 FROM attachments WHERE id=$1 AND uploader_id=$2 AND mime LIKE 'image/%'`,[fileId,req.user!.id]);if(!a.rowCount)return res.status(400).json({error:'Выберите своё загруженное изображение'});}const q=await pool.query('UPDATE communities SET name=$1,description=$2,avatar_url=$3 WHERE id=$4 RETURNING id,name,description,avatar_url "avatarUrl",verified',[d.name,d.description,d.avatarUrl,id]);await audit(req.user!.id,'community.updated',id);res.json(q.rows[0]);}));
const channelEditSchema=z.object({name:z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}_-]+$/u),description:z.string().trim().max(300),avatarUrl:z.string().regex(/^\/api\/uploads\/[0-9a-f-]{36}$/).nullable()});
app.patch('/api/channels/:id',auth,wrap(async(req,res)=>{const id=String(req.params.id),c=(await pool.query('SELECT community_id FROM channels WHERE id=$1',[id])).rows[0];if(!c)return res.status(404).json({error:'Канал не найден'});if(!await canCommunity(req.user!.id,c.community_id,'manageChannels'))return res.status(403).json({error:'Недостаточно прав'});const d=channelEditSchema.parse(req.body);if(d.avatarUrl){const fileId=d.avatarUrl.split('/').pop();const a=await pool.query(`SELECT 1 FROM attachments WHERE id=$1 AND uploader_id=$2 AND mime LIKE 'image/%'`,[fileId,req.user!.id]);if(!a.rowCount)return res.status(400).json({error:'Выберите своё загруженное изображение'});}const q=await pool.query('UPDATE channels SET name=$1,description=$2,avatar_url=$3 WHERE id=$4 RETURNING id,name,description,avatar_url "avatarUrl",kind',[d.name.toLocaleLowerCase('ru'),d.description,d.avatarUrl,id]);await audit(req.user!.id,'channel.updated',id);res.json(q.rows[0]);}));
const rolePermissionsSchema=z.object({sendMessages:z.boolean(),joinVoice:z.boolean(),invite:z.boolean(),manageChannels:z.boolean()});
const roleEditSchema=z.object({name:z.string().trim().min(2).max(40),color:z.string().regex(/^#[0-9a-fA-F]{6}$/),position:z.number().int().min(0).max(999),permissions:rolePermissionsSchema});
app.get('/api/communities/:id/roles',auth,wrap(async(req,res)=>{const id=String(req.params.id);if(!await isMember(req.user!.id,id))return res.status(403).json({error:'Нет доступа'});const q=await pool.query('SELECT id,name,color,position,kind,permissions FROM community_roles WHERE community_id=$1 ORDER BY position DESC,name',[id]);res.json(q.rows);}));
app.post('/api/communities/:id/roles',auth,wrap(async(req,res)=>{const id=String(req.params.id);if(await memberRole(req.user!.id,id)!=='owner')return res.status(403).json({error:'Роли меняет только владелец'});const d=roleEditSchema.parse(req.body),roleId=uuid();const q=await pool.query('INSERT INTO community_roles(id,community_id,name,color,position,permissions) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,color,position,kind,permissions',[roleId,id,d.name,d.color,d.position,JSON.stringify(d.permissions)]);res.status(201).json(q.rows[0]);}));
app.patch('/api/communities/:id/roles/:roleId',auth,wrap(async(req,res)=>{const id=String(req.params.id);if(await memberRole(req.user!.id,id)!=='owner')return res.status(403).json({error:'Роли меняет только владелец'});const d=roleEditSchema.parse(req.body),q=await pool.query('UPDATE community_roles SET name=$1,color=$2,position=CASE WHEN kind=\'everyone\' THEN 0 ELSE $3 END,permissions=$4 WHERE id=$5 AND community_id=$6 RETURNING id,name,color,position,kind,permissions',[d.name,d.color,d.position,JSON.stringify(d.permissions),req.params.roleId,id]);if(!q.rows[0])return res.status(404).json({error:'Роль не найдена'});res.json(q.rows[0]);}));
app.delete('/api/communities/:id/roles/:roleId',auth,wrap(async(req,res)=>{const id=String(req.params.id);if(await memberRole(req.user!.id,id)!=='owner')return res.status(403).json({error:'Роли меняет только владелец'});const q=await pool.query("DELETE FROM community_roles WHERE id=$1 AND community_id=$2 AND kind='custom' RETURNING id",[req.params.roleId,id]);if(!q.rows[0])return res.status(404).json({error:'Роль не найдена'});res.status(204).end();}));
app.put('/api/communities/:id/members/:userId/roles',auth,wrap(async(req,res)=>{const id=String(req.params.id),target=String(req.params.userId);if(await memberRole(req.user!.id,id)!=='owner')return res.status(403).json({error:'Роли назначает только владелец'});const roleIds=z.array(z.string().uuid()).max(12).parse(req.body?.roleIds);if(await memberRole(target,id)!=='member')return res.status(403).json({error:'Роль владельца или администратора нельзя изменить здесь'});const q=await pool.query("SELECT id FROM community_roles WHERE community_id=$1 AND kind='custom' AND id=ANY($2::uuid[])",[id,roleIds]);if(q.rowCount!==new Set(roleIds).size)return res.status(400).json({error:'Некорректная роль'});const client=await pool.connect();try{await client.query('BEGIN');await client.query('DELETE FROM community_member_roles WHERE community_id=$1 AND user_id=$2',[id,target]);for(const roleId of roleIds)await client.query('INSERT INTO community_member_roles(community_id,user_id,role_id) VALUES($1,$2,$3)',[id,target,roleId]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}await audit(req.user!.id,'community.roles_assigned',id,{userId:target});res.json({roleIds});}));
app.put('/api/channels/:id/role-permissions',auth,wrap(async(req,res)=>{const id=String(req.params.id),c=(await pool.query('SELECT community_id FROM channels WHERE id=$1',[id])).rows[0];if(!c)return res.status(404).json({error:'Канал не найден'});if(!await canCommunity(req.user!.id,c.community_id,'manageChannels'))return res.status(403).json({error:'Недостаточно прав'});const d=z.object({roleId:z.string().uuid(),canSend:z.boolean().nullable()}).parse(req.body);const role=(await pool.query('SELECT 1 FROM community_roles WHERE id=$1 AND community_id=$2',[d.roleId,c.community_id])).rowCount;if(!role)return res.status(400).json({error:'Роль не найдена'});if(d.canSend===null)await pool.query('DELETE FROM channel_role_permissions WHERE channel_id=$1 AND role_id=$2',[id,d.roleId]);else await pool.query('INSERT INTO channel_role_permissions(channel_id,role_id,can_send) VALUES($1,$2,$3) ON CONFLICT(channel_id,role_id) DO UPDATE SET can_send=EXCLUDED.can_send',[id,d.roleId,d.canSend]);res.json({ok:true});}));
app.get('/api/channels/:id/role-permissions',auth,wrap(async(req,res)=>{const c=(await pool.query('SELECT community_id FROM channels WHERE id=$1',[req.params.id])).rows[0];if(!c||!await isMember(req.user!.id,c.community_id))return res.status(403).json({error:'Нет доступа'});const q=await pool.query('SELECT role_id "roleId",can_send "canSend" FROM channel_role_permissions WHERE channel_id=$1',[req.params.id]);res.json(q.rows);}));
app.post('/api/communities/:id/invites',auth,wrap(async(req,res)=>{const communityId=String(req.params.id);if(!await canCommunity(req.user!.id,communityId,'invite'))return res.status(403).json({error:'Недостаточно прав'});const code=randomToken(12);await pool.query("INSERT INTO invites(code,community_id,created_by,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",[code,communityId,req.user!.id]);res.status(201).json({code,expiresIn:604800});}));
app.post('/api/communities/:id/invite-friend',auth,rateLimit({windowMs:60_000,limit:30}),wrap(async(req,res)=>{
  const communityId=String(req.params.id),{friendId}=z.object({friendId:z.string().uuid()}).parse(req.body);
  if(!await canCommunity(req.user!.id,communityId,'invite'))return res.status(403).json({error:'Нет права приглашать в сообщество'});
  if(!await areFriends(req.user!.id,friendId))return res.status(403).json({error:'Приглашать можно только друзей'});
  if(await isMember(friendId,communityId))return res.status(409).json({error:'Друг уже в сообществе'});
  const community=(await pool.query('SELECT name FROM communities WHERE id=$1',[communityId])).rows[0];
  if(!community)return res.status(404).json({error:'Сообщество не найдено'});
  const id=uuid();
  try{await pool.query('INSERT INTO community_invitations(id,community_id,inviter_id,invitee_id) VALUES($1,$2,$3,$4)',[id,communityId,req.user!.id,friendId]);}
  catch(e:any){if(e.code==='23505')return res.status(409).json({error:'Приглашение уже отправлено'});throw e;}
  await audit(req.user!.id,'community.friend_invited',communityId,{inviteeId:friendId});
  io.to(`user:${friendId}`).emit('community:invitation');
  void sendPush(friendId,{kind:'invite',title:'Приглашение в сообщество',body:`${req.user!.display_name||req.user!.username} приглашает вас в «${community.name}»`,url:'/',tag:`community-invite:${id}`});
  res.status(201).json({id});
}));
app.get('/api/community-invitations',auth,wrap(async(req,res)=>{
  const q=await pool.query("SELECT ci.id,ci.community_id,ci.created_at,c.name community_name,u.username inviter_username,u.avatar_url inviter_avatar_url FROM community_invitations ci JOIN communities c ON c.id=ci.community_id JOIN users u ON u.id=ci.inviter_id WHERE ci.invitee_id=$1 AND ci.status='pending' ORDER BY ci.created_at DESC LIMIT 50",[req.user!.id]);
  res.json(q.rows.map(r=>({id:r.id,communityId:r.community_id,communityName:r.community_name,inviterUsername:r.inviter_username,inviterAvatarUrl:r.inviter_avatar_url,createdAt:r.created_at})));
}));
app.post('/api/community-invitations/:id/respond',auth,wrap(async(req,res)=>{
  const {accept}=z.object({accept:z.boolean()}).parse(req.body),client=await pool.connect();
  try{await client.query('BEGIN');const q=await client.query("UPDATE community_invitations SET status=$1,responded_at=now() WHERE id=$2 AND invitee_id=$3 AND status='pending' RETURNING community_id,inviter_id",[accept?'accepted':'declined',req.params.id,req.user!.id]);if(!q.rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'Приглашение не найдено'});}if(accept)await client.query('INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[q.rows[0].community_id,req.user!.id]);await client.query('COMMIT');await audit(req.user!.id,accept?'community.invitation_accepted':'community.invitation_declined',q.rows[0].community_id);io.to(`user:${q.rows[0].inviter_id}`).emit('community:invitation');res.json({communityId:q.rows[0].community_id,accepted:accept});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.post('/api/invites/:code/join',auth,wrap(async(req,res)=>{const q=await pool.query('UPDATE invites SET uses=uses+1 WHERE code=$1 AND expires_at>now() AND uses<max_uses RETURNING community_id',[req.params.code]);if(!q.rows[0])return res.status(404).json({error:'Приглашение недействительно'});await pool.query('INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[q.rows[0].community_id,req.user!.id]);res.json({communityId:q.rows[0].community_id});}));

app.get('/api/communities/:id/members',auth,wrap(async(req,res)=>{const communityId=String(req.params.id);if(!await isMember(req.user!.id,communityId))return res.status(403).json({error:'Нет доступа'});const q=await pool.query(`SELECT u.id,u.username,u.display_name,u.avatar_url,u.status presence,u.verified,u.donator,u.mrbeast_badge,cm.role,cm.joined_at,COALESCE((SELECT json_agg(json_build_object('id',r.id,'name',r.name,'color',r.color,'position',r.position) ORDER BY r.position DESC) FROM community_roles r WHERE r.community_id=cm.community_id AND ((r.kind='admin' AND cm.role='admin') OR EXISTS(SELECT 1 FROM community_member_roles mr WHERE mr.community_id=cm.community_id AND mr.user_id=cm.user_id AND mr.role_id=r.id))),'[]'::json) roles FROM community_members cm JOIN users u ON u.id=cm.user_id WHERE cm.community_id=$1 AND u.deleted_at IS NULL ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.username_key`,[communityId]);res.json(q.rows.map(r=>({...r,displayName:r.display_name||r.username,avatarUrl:r.avatar_url||null,mrbeastBadge:Boolean(r.mrbeast_badge),presence:computePresence(r.id,r.presence)}))); }));
app.delete('/api/communities/:id/members/me',auth,wrap(async(req,res)=>{const communityId=String(req.params.id),role=await memberRole(req.user!.id,communityId);if(!role)return res.status(404).json({error:'Вы не состоите в сообществе'});if(role==='owner')return res.status(409).json({error:'Владелец не может покинуть сообщество'});await pool.query('DELETE FROM community_members WHERE community_id=$1 AND user_id=$2',[communityId,req.user!.id]);await audit(req.user!.id,'community.left',communityId);res.status(204).end();}));

app.get('/api/users/search',auth,wrap(async(req,res)=>{const qText=String(req.query.q||'').trim().toLocaleLowerCase('ru');if(qText.length<2)return res.json([]);const q=await pool.query(`SELECT id,username,display_name,avatar_url,status,verified,donator,mrbeast_badge FROM users WHERE deleted_at IS NULL AND banned_at IS NULL AND id<>$1 AND username_key LIKE $2 ORDER BY CASE WHEN username_key=$3 THEN 0 ELSE 1 END,username_key LIMIT 12`,[req.user!.id,`${qText}%`,qText]);res.json(q.rows.map(r=>({...publicUser(r),status:computePresence(r.id,r.status)})));}));
app.get('/api/users/:id/profile',auth,wrap(async(req,res)=>{const q=await pool.query('SELECT id,username,display_name,avatar_url,banner_url,bio,status,verified,donator,mrbeast_badge,admin_role,frozen_at FROM users WHERE id=$1 AND deleted_at IS NULL AND banned_at IS NULL',[req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Профиль не найден'});res.json({user:{...publicUser(q.rows[0]),status:computePresence(q.rows[0].id,q.rows[0].status)}});}));
app.get('/api/friends',auth,wrap(async(req,res)=>{const q=await pool.query(`SELECT f.status,f.created_at,CASE WHEN f.requester_id=$1 THEN 'outgoing' ELSE 'incoming' END direction,u.id,u.username,u.display_name,u.avatar_url,u.status presence,u.verified,u.donator,u.mrbeast_badge FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END WHERE (f.requester_id=$1 OR f.addressee_id=$1) AND u.deleted_at IS NULL ORDER BY CASE f.status WHEN 'pending' THEN 0 ELSE 1 END,u.username_key`,[req.user!.id]);res.json(q.rows.map(r=>({...r,displayName:r.display_name||r.username,avatarUrl:r.avatar_url||null,mrbeastBadge:Boolean(r.mrbeast_badge),presence:computePresence(r.id,r.presence)})));}));
app.post('/api/friends/requests',auth,rateLimit({windowMs:60_000,limit:20}),wrap(async(req,res)=>{const d=z.object({username:z.string().trim().min(3).max(32)}).parse(req.body),target=(await pool.query('SELECT id,username FROM users WHERE username_key=$1 AND deleted_at IS NULL',[d.username.toLocaleLowerCase('ru')])).rows[0];if(!target||target.id===req.user!.id)return res.status(404).json({error:'Пользователь не найден'});const existing=(await pool.query('SELECT status FROM friendships WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)',[req.user!.id,target.id])).rows[0];if(existing)return res.status(409).json({error:existing.status==='accepted'?'Вы уже друзья':'Заявка уже существует'});await pool.query('INSERT INTO friendships(requester_id,addressee_id) VALUES($1,$2)',[req.user!.id,target.id]);await audit(req.user!.id,'friend.requested',target.id);io.to(`user:${target.id}`).emit('friend:updated');res.status(201).json({id:target.id,username:target.username,status:'pending',direction:'outgoing'});}));
app.post('/api/friends/:id/accept',auth,wrap(async(req,res)=>{const q=await pool.query("UPDATE friendships SET status='accepted' WHERE requester_id=$1 AND addressee_id=$2 AND status='pending' RETURNING requester_id",[req.params.id,req.user!.id]);if(!q.rows[0])return res.status(404).json({error:'Заявка не найдена'});await audit(req.user!.id,'friend.accepted',String(req.params.id));io.to(`user:${req.params.id}`).emit('friend:updated');res.status(204).end();}));
app.delete('/api/friends/:id',auth,wrap(async(req,res)=>{const q=await pool.query('DELETE FROM friendships WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1) RETURNING status',[req.user!.id,req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Связь не найдена'});await audit(req.user!.id,'friend.removed',String(req.params.id));io.to(`user:${req.params.id}`).emit('friend:updated');res.status(204).end();}));

async function areFriends(a:string,b:string){return Boolean((await pool.query("SELECT 1 FROM friendships WHERE status='accepted' AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))",[a,b])).rowCount);}
const messageSchema=z.object({content:z.string().trim().max(4000).default(''),attachmentId:z.string().uuid().nullable().optional(),replyToId:z.string().uuid().nullable().optional(),clientMessageId:z.string().uuid().optional()}).refine(d=>Boolean(d.content||d.attachmentId),{message:'Сообщение пустое'});
async function ownAttachment(userId:string,id?:string|null){if(!id)return true;return Boolean((await pool.query('SELECT 1 FROM attachments WHERE id=$1 AND uploader_id=$2',[id,userId])).rowCount);}

async function fetchReactions(messageIds:string[],isDm:boolean):Promise<Map<string,Map<string,string[]>>>{
  const map=new Map<string,Map<string,string[]>>();
  if(messageIds.length===0)return map;
  const q=await pool.query('SELECT message_id,user_id,emoji FROM message_reactions WHERE message_id=ANY($1) AND is_dm=$2',[messageIds,isDm]);
  for(const r of q.rows){
    if(!map.has(r.message_id))map.set(r.message_id,new Map());
    const m=map.get(r.message_id)!;
    if(!m.has(r.emoji))m.set(r.emoji,[]);
    m.get(r.emoji)!.push(r.user_id);
  }
  return map;
}

app.get('/api/friends/:id/messages',auth,wrap(async(req,res)=>{
  const friendId=String(req.params.id);
  if(!await areFriends(req.user!.id,friendId))return res.status(403).json({error:'Общение доступно только друзьям'});
  const q=await pool.query(`SELECT m.id,m.content_enc,m.created_at,m.deleted_at,m.reply_to_id,u.id author_id,u.username,u.avatar_url,u.verified author_verified,u.donator author_donator,u.mrbeast_badge author_mrbeast_badge,a.id attachment_id,a.mime attachment_mime,a.original_name attachment_name,a.size attachment_size,rm.id reply_id,rm.content_enc reply_content_enc,rm.deleted_at reply_deleted_at,ru.username reply_author_username FROM direct_messages m JOIN users u ON u.id=m.sender_id LEFT JOIN attachments a ON a.id=m.attachment_id LEFT JOIN direct_messages rm ON rm.id=m.reply_to_id LEFT JOIN users ru ON ru.id=rm.sender_id WHERE ((m.sender_id=$1 AND m.recipient_id=$2) OR (m.sender_id=$2 AND m.recipient_id=$1)) AND m.created_at<=COALESCE($3::timestamptz,'infinity'::timestamptz) ORDER BY m.created_at DESC LIMIT 100`,[req.user!.id,friendId,req.user!.frozen_at||null]);
  const rows=q.rows.reverse();
  const reactionsMap=await fetchReactions(rows.map(r=>r.id),true);
  res.json(rows.map(r=>messageDto(r,reactionsMap.get(r.id),req.user!.id)));
}));

app.post('/api/friends/:id/messages',auth,rateLimit({windowMs:10_000,limit:30}),wrap(async(req,res)=>{
  const friendId=String(req.params.id);
  if(!await areFriends(req.user!.id,friendId))return res.status(403).json({error:'Общение доступно только друзьям'});
  const d=messageSchema.parse(req.body);
  if(!await ownAttachment(req.user!.id,d.attachmentId))return res.status(403).json({error:'Файл недоступен'});
  const id=uuid();
  let replyInfo:any=null;
  if(d.replyToId){
    const rq=await pool.query('SELECT rm.id,rm.content_enc,rm.deleted_at,ru.username reply_author_username FROM direct_messages rm JOIN users ru ON ru.id=rm.sender_id WHERE rm.id=$1',[d.replyToId]);
    if(rq.rows[0]){
      let c='';try{c=rq.rows[0].deleted_at?'':decrypt(rq.rows[0].content_enc);}catch{}
      replyInfo={id:rq.rows[0].id,authorUsername:rq.rows[0].reply_author_username,content:c,deleted:Boolean(rq.rows[0].deleted_at)};
    }
  }
  const q=await pool.query('INSERT INTO direct_messages(id,sender_id,recipient_id,content_enc,attachment_id,reply_to_id,client_message_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (sender_id,client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING RETURNING created_at',[id,req.user!.id,friendId,encrypt(d.content),d.attachmentId||null,d.replyToId||null,d.clientMessageId||null]);
  if(!q.rowCount){const old=await pool.query('SELECT id,recipient_id FROM direct_messages WHERE sender_id=$1 AND client_message_id=$2',[req.user!.id,d.clientMessageId]);if(old.rows[0]?.recipient_id!==friendId)return res.status(409).json({error:'Идентификатор сообщения уже использован'});return res.status(200).json({...await storedMessageDto(old.rows[0].id,true,req.user!.id),recipientId:friendId});}
  const attachment=d.attachmentId?(await pool.query('SELECT id attachment_id,mime attachment_mime,original_name attachment_name,size attachment_size FROM attachments WHERE id=$1',[d.attachmentId])).rows[0]:{};
  const msg={...messageDto({id,content_enc:encrypt(d.content),created_at:q.rows[0].created_at,deleted_at:null,reply_to_id:d.replyToId||null,author_id:req.user!.id,username:req.user!.username,avatar_url:req.user!.avatar_url,author_verified:req.user!.verified,author_donator:req.user!.donator,author_mrbeast_badge:req.user!.mrbeast_badge,...attachment},undefined,req.user!.id,replyInfo),recipientId:friendId};
  io.to(`user:${friendId}`).emit('dm:new',msg);
  io.to(`user:${req.user!.id}`).emit('dm:new',msg);
  void sendPush(friendId,{kind:'message',friendId:req.user!.id,title:req.user!.display_name||req.user!.username,body:d.content||(d.attachmentId?'📷 Отправил(а) вложение':'Новое сообщение'),url:`/?dm=${req.user!.id}`,tag:`dm:${req.user!.id}`});
  res.status(201).json(msg);
}));

app.delete('/api/direct-messages/:id',auth,wrap(async(req,res)=>{
  const q=await pool.query(`UPDATE direct_messages SET content_enc=$1,deleted_at=now() WHERE id=$2 AND sender_id=$3 AND deleted_at IS NULL RETURNING sender_id,recipient_id`,[encrypt(''),req.params.id,req.user!.id]);
  if(!q.rows[0])return res.status(404).json({error:'Сообщение не найдено'});
  io.to(`user:${q.rows[0].sender_id}`).emit('dm:deleted',{id:req.params.id});
  io.to(`user:${q.rows[0].recipient_id}`).emit('dm:deleted',{id:req.params.id});
  res.status(204).end();
}));

app.post('/api/direct-messages/:id/reactions',auth,rateLimit({windowMs:10_000,limit:40}),wrap(async(req,res)=>{
  const emoji=z.string().min(1).max(16).parse(req.body.emoji);
  const msgQ=await pool.query('SELECT id,sender_id,recipient_id FROM direct_messages WHERE id=$1',[req.params.id]);
  const msg=msgQ.rows[0];
  if(!msg||(msg.sender_id!==req.user!.id&&msg.recipient_id!==req.user!.id))return res.status(404).json({error:'Сообщение не найдено'});
  const ex=await pool.query('DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3 RETURNING id',[msg.id,req.user!.id,emoji]);
  if(ex.rowCount===0){
    await pool.query('INSERT INTO message_reactions(message_id,user_id,emoji,is_dm) VALUES($1,$2,$3,true)',[msg.id,req.user!.id,emoji]);
  }
  const reactionsMap=await fetchReactions([msg.id],true);
  const rawMap=reactionsMap.get(msg.id)||new Map();
  const reactions=Array.from(rawMap.entries()).map(([em,uids])=>({emoji:em,count:uids.length,users:uids}));
  io.to(`user:${msg.sender_id}`).emit('dm:reaction',{messageId:msg.id,reactions});
  io.to(`user:${msg.recipient_id}`).emit('dm:reaction',{messageId:msg.id,reactions});
  res.json({ok:true,reactions});
}));

app.get('/api/calls/ice',auth,wrap(async(req,res)=>{const secret=process.env.TURN_SECRET,host=process.env.TURN_HOST||'cz.vrot.fun';const iceServers:Array<{urls:string[];username?:string;credential?:string}>=[{urls:[`stun:${host}:3478`]}];if(secret){const username=`${Math.floor(Date.now()/1000)+3600}:${req.user!.id}`,credential=createHmac('sha1',secret).update(username).digest('base64');iceServers.push({urls:[`turn:${host}:3478?transport=udp`,`turn:${host}:3478?transport=tcp`],username,credential});}res.json({iceServers,ttl:3600});}));

const uploadTypes=new Set(['image/jpeg','image/png','image/webp','image/gif','audio/webm','audio/ogg','audio/mpeg','audio/mp4','video/webm','video/mp4','application/pdf']);
app.post('/api/uploads',auth,rateLimit({windowMs:60_000,limit:20}),express.raw({type:()=>true,limit:'20mb'}),wrap(async(req,res)=>{const mime=String(req.get('content-type')||'').split(';')[0].toLowerCase();if(!uploadTypes.has(mime))return res.status(415).json({error:'Этот тип файла не поддерживается'});const body=req.body as Buffer;if(!Buffer.isBuffer(body)||body.length===0)return res.status(400).json({error:'Пустой файл'});let name='file';try{name=decodeURIComponent(String(req.get('x-file-name')||'file')).replace(/[\r\n]/g,' ').slice(0,255)||'file'}catch{}const id=uuid(),storageName=randomToken(24);await writeFile(path.join('/app/uploads',storageName),body,{flag:'wx'});await pool.query('INSERT INTO attachments(id,uploader_id,mime,original_name,storage_name,size) VALUES($1,$2,$3,$4,$5,$6)',[id,req.user!.id,mime,name,storageName,body.length]);res.status(201).json({id,mime,name,size:body.length,url:`/api/uploads/${id}`});}));
app.get('/api/uploads/:id',auth,wrap(async(req,res)=>{const q=await pool.query(`SELECT a.* FROM attachments a WHERE a.id=$1 AND (a.uploader_id=$2 OR EXISTS(SELECT 1 FROM communities c JOIN community_members cm ON cm.community_id=c.id WHERE c.avatar_url='/api/uploads/'||a.id AND cm.user_id=$2) OR EXISTS(SELECT 1 FROM channels c JOIN community_members cm ON cm.community_id=c.community_id WHERE c.avatar_url='/api/uploads/'||a.id AND cm.user_id=$2) OR EXISTS(SELECT 1 FROM messages m JOIN channels c ON c.id=m.channel_id JOIN community_members cm ON cm.community_id=c.community_id WHERE m.attachment_id=a.id AND cm.user_id=$2) OR EXISTS(SELECT 1 FROM direct_messages d WHERE d.attachment_id=a.id AND (d.sender_id=$2 OR d.recipient_id=$2)))`,[req.params.id,req.user!.id]);const file=q.rows[0];if(!file)return res.status(404).json({error:'Файл не найден'});res.type(file.mime);res.setHeader('Content-Disposition',file.mime.startsWith('image/')||file.mime.startsWith('audio/')||file.mime.startsWith('video/')?'inline':`attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);res.sendFile(path.join('/app/uploads',file.storage_name));}));

app.get('/api/channels/:id/messages',auth,wrap(async(req,res)=>{
  const channelId=String(req.params.id);
  if(!await canReadChannel(req.user!.id,channelId))return res.status(403).json({error:'Нет доступа'});
  const q=await pool.query(`SELECT m.id,m.content_enc,m.created_at,m.edited_at,m.deleted_at,m.reply_to_id,u.id author_id,u.username,u.avatar_url,u.verified author_verified,u.donator author_donator,u.mrbeast_badge author_mrbeast_badge,a.id attachment_id,a.mime attachment_mime,a.original_name attachment_name,a.size attachment_size,rm.id reply_id,rm.content_enc reply_content_enc,rm.deleted_at reply_deleted_at,ru.username reply_author_username FROM messages m LEFT JOIN users u ON u.id=m.author_id LEFT JOIN attachments a ON a.id=m.attachment_id LEFT JOIN messages rm ON rm.id=m.reply_to_id LEFT JOIN users ru ON ru.id=rm.author_id WHERE m.channel_id=$1 AND m.created_at<=COALESCE($2::timestamptz,'infinity'::timestamptz) ORDER BY m.created_at DESC LIMIT 100`,[channelId,req.user!.frozen_at||null]);
  const rows=q.rows.reverse();
  const reactionsMap=await fetchReactions(rows.map(r=>r.id),false);
  res.json(rows.map(r=>messageDto(r,reactionsMap.get(r.id),req.user!.id)));
}));

app.post('/api/channels/:id/messages',auth,rateLimit({windowMs:10_000,limit:20}),wrap(async(req,res)=>{
  const channelId=String(req.params.id);
  if(!await canSendChannel(req.user!.id,channelId))return res.status(403).json({error:'Эта роль не может писать в канал'});
  const d=messageSchema.parse(req.body);
  if(!await ownAttachment(req.user!.id,d.attachmentId))return res.status(403).json({error:'Файл недоступен'});
  const id=uuid();
  let replyInfo:any=null;
  if(d.replyToId){
    const rq=await pool.query('SELECT rm.id,rm.content_enc,rm.deleted_at,ru.username reply_author_username FROM messages rm LEFT JOIN users ru ON ru.id=rm.author_id WHERE rm.id=$1 AND rm.channel_id=$2',[d.replyToId,channelId]);
    if(!rq.rows[0])return res.status(400).json({error:'Ответ возможен только на сообщение из этого канала'});
    if(rq.rows[0]){
      let c='';try{c=rq.rows[0].deleted_at?'':decrypt(rq.rows[0].content_enc);}catch{}
      replyInfo={id:rq.rows[0].id,authorUsername:rq.rows[0].reply_author_username||'Пользователь',content:c,deleted:Boolean(rq.rows[0].deleted_at)};
    }
  }
  const q=await pool.query('INSERT INTO messages(id,channel_id,author_id,content_enc,attachment_id,reply_to_id,client_message_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (author_id,client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING RETURNING created_at',[id,channelId,req.user!.id,encrypt(d.content),d.attachmentId||null,d.replyToId||null,d.clientMessageId||null]);
  if(!q.rowCount){const old=await pool.query('SELECT id,channel_id FROM messages WHERE author_id=$1 AND client_message_id=$2',[req.user!.id,d.clientMessageId]);if(old.rows[0]?.channel_id!==channelId)return res.status(409).json({error:'Идентификатор сообщения уже использован'});return res.status(200).json(await storedMessageDto(old.rows[0].id,false,req.user!.id));}
  const attachment=d.attachmentId?(await pool.query('SELECT id attachment_id,mime attachment_mime,original_name attachment_name,size attachment_size FROM attachments WHERE id=$1',[d.attachmentId])).rows[0]:{};
  const msg={...messageDto({id,content_enc:encrypt(d.content),created_at:q.rows[0].created_at,deleted_at:null,reply_to_id:d.replyToId||null,author_id:req.user!.id,username:req.user!.username,avatar_url:req.user!.avatar_url,author_verified:req.user!.verified,author_donator:req.user!.donator,author_mrbeast_badge:req.user!.mrbeast_badge,...attachment},undefined,req.user!.id,replyInfo),channelId};
  io.to(`channel:${channelId}`).emit('message:new',msg);
  void pool.query(`SELECT cm.user_id FROM community_members cm JOIN channels c ON c.community_id=cm.community_id WHERE c.id=$1 AND cm.user_id<>$2`,[channelId,req.user!.id]).then(res=>{for(const r of res.rows){void sendPush(r.user_id,{kind:'channel',channelId,title:req.user!.display_name||req.user!.username,body:d.content||(d.attachmentId?'📷 Отправил(а) вложение':'Новое сообщение'),url:`/?channel=${channelId}`,tag:`channel:${channelId}`});}}).catch(()=>{});
  res.status(201).json(msg);
}));

app.delete('/api/messages/:id',auth,wrap(async(req,res)=>{
  const msgQ=await pool.query(`SELECT m.id,m.channel_id,m.author_id,c.community_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=$1 AND m.deleted_at IS NULL`,[req.params.id]);
  const msg=msgQ.rows[0];
  if(!msg)return res.status(404).json({error:'Сообщение не найдено'});
  const isAuthor=msg.author_id===req.user!.id;
  const cRole=await memberRole(req.user!.id,msg.community_id);
  const isCommAdmin=Boolean(cRole&&['owner','admin','moderator'].includes(cRole));
  const isSysAdmin=['admin','owner'].includes(req.user!.admin_role||'');
  if(!isAuthor&&!isCommAdmin&&!isSysAdmin)return res.status(403).json({error:'Недостаточно прав для удаления'});
  await pool.query(`UPDATE messages SET content_enc=$1,deleted_at=now() WHERE id=$2`,[encrypt(''),msg.id]);
  io.to(`channel:${msg.channel_id}`).emit('message:deleted',{id:msg.id});
  res.status(204).end();
}));

app.post('/api/messages/:id/reactions',auth,rateLimit({windowMs:10_000,limit:40}),wrap(async(req,res)=>{
  const emoji=z.string().min(1).max(16).parse(req.body.emoji);
  const msgQ=await pool.query('SELECT m.id,m.channel_id FROM messages m WHERE m.id=$1',[req.params.id]);
  const msg=msgQ.rows[0];
  if(!msg||!await canReadChannel(req.user!.id,msg.channel_id))return res.status(404).json({error:'Сообщение не найдено'});
  if(!await canSendChannel(req.user!.id,msg.channel_id))return res.status(403).json({error:'Эта роль не может реагировать в канале'});
  const ex=await pool.query('DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3 RETURNING id',[msg.id,req.user!.id,emoji]);
  if(ex.rowCount===0){
    await pool.query('INSERT INTO message_reactions(message_id,user_id,emoji,is_dm) VALUES($1,$2,$3,false)',[msg.id,req.user!.id,emoji]);
  }
  const reactionsMap=await fetchReactions([msg.id],false);
  const rawMap=reactionsMap.get(msg.id)||new Map();
  const reactions=Array.from(rawMap.entries()).map(([em,uids])=>({emoji:em,count:uids.length,users:uids}));
  io.to(`channel:${msg.channel_id}`).emit('message:reaction',{messageId:msg.id,reactions});
  res.json({ok:true,reactions});
}));

app.get('/api/account/export',auth,wrap(async(req,res)=>{const u=(await pool.query('SELECT id,username,email,phone,birth_date,created_at FROM users WHERE id=$1',[req.user!.id])).rows[0];const m=await pool.query('SELECT id,channel_id,content_enc,created_at,edited_at,deleted_at FROM messages WHERE author_id=$1 ORDER BY created_at',[req.user!.id]);await audit(req.user!.id,'account.exported',req.user!.id);res.setHeader('Content-Disposition','attachment; filename="vrot-data.json"');res.json({account:u,messages:m.rows.map((x:any)=>({...x,content:x.deleted_at?'':decrypt(x.content_enc),content_enc:undefined}))});}));
app.delete('/api/account',auth,wrap(async(req,res)=>{const d=z.object({password:z.string().min(1)}).parse(req.body),q=await pool.query('SELECT password_hash FROM users WHERE id=$1',[req.user!.id]);if(!q.rows[0]||!await argon2.verify(q.rows[0].password_hash,d.password))return res.status(403).json({error:'Неверный пароль'});await audit(req.user!.id,'account.deleted',req.user!.id);await pool.query(`UPDATE users SET deleted_at=now(),username='Удалённый пользователь',username_key='deleted-'||id,email=id||'@deleted.invalid',phone=NULL,password_hash='deleted' WHERE id=$1`,[req.user!.id]);await pool.query('DELETE FROM sessions WHERE user_id=$1',[req.user!.id]);await pool.query('DELETE FROM ios_devices WHERE user_id=$1',[req.user!.id]);await pool.query('DELETE FROM android_devices WHERE user_id=$1',[req.user!.id]);await pool.query('DELETE FROM push_subscriptions WHERE user_id=$1',[req.user!.id]);res.clearCookie('vrot_session');res.status(204).end();}));

app.get('/api/admin/users',auth,requireAdmin,wrap(async(req,res)=>{const search=String(req.query.q||'').trim().toLocaleLowerCase('ru');const q=await pool.query(`SELECT id,username,display_name,email,avatar_url,status,verified,donator,mrbeast_badge,admin_role,frozen_at,banned_at,ban_reason,created_at FROM users WHERE deleted_at IS NULL AND ($1='' OR username_key LIKE $2 OR lower(email) LIKE $2) ORDER BY created_at DESC LIMIT 100`,[search,`%${search}%`]);res.json(q.rows.map(r=>({...publicUser(r),email:r.email,createdAt:r.created_at,banned:Boolean(r.banned_at),banReason:r.ban_reason||''})));}));
app.get('/api/admin/communities',auth,requireAdmin,wrap(async(_req,res)=>{const q=await pool.query('SELECT id,name,verified,created_at FROM communities ORDER BY created_at DESC LIMIT 200');res.json(q.rows);}));
app.patch('/api/admin/communities/:id/verification',auth,requireAdmin,wrap(async(req,res)=>{const {verified}=z.object({verified:z.boolean()}).parse(req.body);const q=await pool.query('UPDATE communities SET verified=$1 WHERE id=$2 RETURNING id,name,verified',[verified,req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Сообщество не найдено'});await audit(req.user!.id,verified?'community.verified':'community.unverified',String(req.params.id));res.json(q.rows[0]);}));
const adminActionSchema=z.discriminatedUnion('action',[
  z.object({action:z.enum(['freeze','unfreeze','ban','unban','verify','unverify','donator','undonator','mrbeast','unmrbeast']),reason:z.string().trim().max(300).optional()}),
  z.object({action:z.literal('role'),role:z.enum(['user','moderator','admin','owner'])})
]);
app.patch('/api/admin/users/:id',auth,requireAdmin,wrap(async(req,res)=>{const targetId=String(req.params.id),d=adminActionSchema.parse(req.body),target=(await pool.query('SELECT id,username,admin_role FROM users WHERE id=$1 AND deleted_at IS NULL',[targetId])).rows[0];if(!target)return res.status(404).json({error:'Пользователь не найден'});if(target.id===req.user!.id&&['freeze','ban'].includes(d.action))return res.status(409).json({error:'Нельзя ограничить собственный аккаунт'});const rank:Record<string,number>={user:0,moderator:1,admin:2,owner:3},actorRank=rank[req.user!.admin_role||'user']||0,targetRank=rank[target.admin_role]||0;if(actorRank<=targetRank&&req.user!.id!==target.id)return res.status(403).json({error:'Нельзя управлять пользователем с равной или более высокой ролью'});if(d.action==='role'){if(req.user!.admin_role!=='owner')return res.status(403).json({error:'Роли назначает только основатель'});if(d.role==='owner'&&req.user!.id!==target.id)return res.status(409).json({error:'Передача роли основателя отключена для защиты проекта'});await pool.query('UPDATE users SET admin_role=$1 WHERE id=$2',[d.role,targetId]);}else if(d.action==='freeze')await pool.query('UPDATE users SET frozen_at=now() WHERE id=$1',[targetId]);else if(d.action==='unfreeze')await pool.query('UPDATE users SET frozen_at=NULL WHERE id=$1',[targetId]);else if(d.action==='ban'){await pool.query('UPDATE users SET banned_at=now(),ban_reason=$2 WHERE id=$1',[targetId,d.reason||null]);await pool.query('DELETE FROM sessions WHERE user_id=$1',[targetId]);}else if(d.action==='unban')await pool.query('UPDATE users SET banned_at=NULL,ban_reason=NULL WHERE id=$1',[targetId]);else if(d.action==='verify')await pool.query('UPDATE users SET verified=true WHERE id=$1',[targetId]);else if(d.action==='unverify')await pool.query('UPDATE users SET verified=false WHERE id=$1',[targetId]);else if(d.action==='donator')await pool.query('UPDATE users SET donator=true WHERE id=$1',[targetId]);else if(d.action==='undonator')await pool.query('UPDATE users SET donator=false WHERE id=$1',[targetId]);else if(d.action==='mrbeast')await pool.query('UPDATE users SET mrbeast_badge=true WHERE id=$1',[targetId]);else if(d.action==='unmrbeast')await pool.query('UPDATE users SET mrbeast_badge=false WHERE id=$1',[targetId]);await audit(req.user!.id,`admin.${d.action}`,targetId,'reason' in d&&d.reason?{reason:d.reason}:{});io.to(`user:${targetId}`).emit('account:changed',{action:d.action});const updated=(await pool.query('SELECT * FROM users WHERE id=$1',[targetId])).rows[0];res.json({user:{...publicUser(updated),email:updated.email,banned:Boolean(updated.banned_at),banReason:updated.ban_reason||''}});}));

app.get('/api/admin/settings',auth,requireAdmin,wrap(async(_req,res)=>{res.json({config:config(),raw:systemSettings});}));
const settingsSchema=z.object({customLogoUrl:z.string().max(300_000).nullable().optional(),customFaviconUrl:z.string().max(300_000).nullable().optional(),registrationMode:z.enum(['open','closed']).optional(),minimumAge:z.number().int().min(12).max(100).optional(),siteName:z.string().trim().min(1).max(64).optional(),siteSlogan:z.string().trim().max(128).optional(),announcement:z.string().trim().max(500).optional(),operatorName:z.string().trim().max(128).optional(),operatorInn:z.string().trim().max(32).optional(),operatorEmail:z.string().trim().max(128).optional(),operatorAddress:z.string().trim().max(256).optional()});
app.patch('/api/admin/settings',auth,requireAdmin,wrap(async(req,res)=>{const d=settingsSchema.parse(req.body);const mapping:Record<string,string|undefined|null>={custom_logo_url:d.customLogoUrl,custom_favicon_url:d.customFaviconUrl,registration_mode:d.registrationMode,minimum_age:d.minimumAge!==undefined?String(d.minimumAge):undefined,site_name:d.siteName,site_slogan:d.siteSlogan,announcement:d.announcement,operator_name:d.operatorName,operator_inn:d.operatorInn,operator_email:d.operatorEmail,operator_address:d.operatorAddress};for(const[k,v]of Object.entries(mapping)){if(v===null){await pool.query('DELETE FROM system_settings WHERE key=$1',[k]);delete systemSettings[k];}else if(v!==undefined){await pool.query('INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',[k,v]);systemSettings[k]=v;}}await audit(req.user!.id,'admin.settings_updated',req.user!.id,{keys:Object.keys(d)});const newCfg=config();io.emit('config:updated',newCfg);res.json({ok:true,config:newCfg});}));
app.post('/api/admin/logo',auth,requireAdmin,rateLimit({windowMs:60_000,limit:20}),express.raw({type:()=>true,limit:'10mb'}),wrap(async(req,res)=>{const mime=String(req.get('content-type')||'').split(';')[0].toLowerCase();const allowed=new Set(['image/svg+xml','image/png','image/webp','image/jpeg']);if(!allowed.has(mime))return res.status(415).json({error:'Формат должен быть SVG, PNG или WebP'});const body=req.body as Buffer;if(!Buffer.isBuffer(body)||body.length===0)return res.status(400).json({error:'Файл пуст'});const ext=mime==='image/svg+xml'?'svg':mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';const id=uuid(),storageName=`logo-${randomToken(16)}.${ext}`;const uploadDir=fs.existsSync('/app/uploads')?'/app/uploads':'uploads';await writeFile(path.join(uploadDir,storageName),body,{flag:'w'});await pool.query('INSERT INTO attachments(id,uploader_id,mime,original_name,storage_name,size) VALUES($1,$2,$3,$4,$5,$6)',[id,req.user!.id,mime,`logo.${ext}`,storageName,body.length]);const logoUrl=`/api/uploads/${id}`;await pool.query('INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',['custom_logo_url',logoUrl]);systemSettings.custom_logo_url=logoUrl;await audit(req.user!.id,'admin.logo_uploaded',id);const newCfg=config();io.emit('config:updated',newCfg);res.json({ok:true,logoUrl,config:newCfg});}));

app.post('/api/admin/favicon',auth,requireAdmin,rateLimit({windowMs:60_000,limit:20}),express.raw({type:()=>true,limit:'5mb'}),wrap(async(req,res)=>{const mime=String(req.get('content-type')||'').split(';')[0].toLowerCase();const allowed=new Set(['image/x-icon','image/vnd.microsoft.icon','image/svg+xml','image/png','image/webp','image/jpeg']);if(!allowed.has(mime))return res.status(415).json({error:'Формат должен быть ICO, SVG или PNG'});const body=req.body as Buffer;if(!Buffer.isBuffer(body)||body.length===0)return res.status(400).json({error:'Файл пуст'});const ext=mime.includes('icon')?'ico':mime==='image/svg+xml'?'svg':mime==='image/png'?'png':'webp';const id=uuid(),storageName=`favicon-${randomToken(16)}.${ext}`;const uploadDir=fs.existsSync('/app/uploads')?'/app/uploads':'uploads';await writeFile(path.join(uploadDir,storageName),body,{flag:'w'});await pool.query('INSERT INTO attachments(id,uploader_id,mime,original_name,storage_name,size) VALUES($1,$2,$3,$4,$5,$6)',[id,req.user!.id,mime,`favicon.${ext}`,storageName,body.length]);const faviconUrl=`/api/uploads/${id}`;await pool.query('INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',['custom_favicon_url',faviconUrl]);systemSettings.custom_favicon_url=faviconUrl;await audit(req.user!.id,'admin.favicon_uploaded',id);const newCfg=config();io.emit('config:updated',newCfg);res.json({ok:true,faviconUrl,config:newCfg});}));

app.get('/api/admin/stats',auth,requireAdmin,wrap(async(_req,res)=>{const usersCount=Number((await pool.query('SELECT count(*) FROM users WHERE deleted_at IS NULL')).rows[0]?.count||0);const messagesCount=Number((await pool.query('SELECT count(*) FROM messages WHERE deleted_at IS NULL')).rows[0]?.count||0)+Number((await pool.query('SELECT count(*) FROM direct_messages WHERE deleted_at IS NULL')).rows[0]?.count||0);const communitiesCount=Number((await pool.query('SELECT count(*) FROM communities')).rows[0]?.count||0);const recentEvents=(await pool.query('SELECT a.*,u.username actor_username FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 25')).rows;res.json({usersCount,messagesCount,communitiesCount,onlineCount:onlineUsers.size,recentEvents});}));

async function memberRole(userId:string,communityId:string){return (await pool.query('SELECT role FROM community_members WHERE user_id=$1 AND community_id=$2',[userId,communityId])).rows[0]?.role as string|undefined;}
async function isMember(userId:string,communityId:string){return Boolean(await memberRole(userId,communityId));}
type CommunityPermission='sendMessages'|'joinVoice'|'invite'|'manageChannels';
async function effectiveRoles(userId:string,communityId:string){
  const q=await pool.query(`SELECT r.id,r.name,r.color,r.position,r.kind,r.permissions FROM community_roles r JOIN community_members cm ON cm.community_id=r.community_id AND cm.user_id=$1 WHERE r.community_id=$2 AND (r.kind='everyone' OR (r.kind='admin' AND cm.role='admin') OR EXISTS(SELECT 1 FROM community_member_roles mr WHERE mr.community_id=$2 AND mr.user_id=$1 AND mr.role_id=r.id)) ORDER BY r.position DESC,r.name`,[userId,communityId]);
  return q.rows;
}
async function canCommunity(userId:string,communityId:string,permission:CommunityPermission){const base=await memberRole(userId,communityId);if(!base)return false;if(base==='owner')return true;const roles=await effectiveRoles(userId,communityId);return Boolean(roles.find(r=>typeof r.permissions?.[permission]==='boolean')?.permissions?.[permission]);}
async function canSendChannel(userId:string,channelId:string){const c=(await pool.query('SELECT community_id,kind FROM channels WHERE id=$1',[channelId])).rows[0];if(!c||c.kind!=='text')return false;if(await memberRole(userId,c.community_id)==='owner')return true;const roles=await effectiveRoles(userId,c.community_id);const overrides=await pool.query('SELECT role_id,can_send FROM channel_role_permissions WHERE channel_id=$1',[channelId]);for(const role of roles){const setting=overrides.rows.find(x=>x.role_id===role.id);if(setting)return Boolean(setting.can_send);}return Boolean(roles.find(r=>typeof r.permissions?.sendMessages==='boolean')?.permissions?.sendMessages);}
async function canJoinVoice(userId:string,channelId:string){const c=(await pool.query('SELECT community_id,kind FROM channels WHERE id=$1',[channelId])).rows[0];return Boolean(c?.kind==='voice'&&await canCommunity(userId,c.community_id,'joinVoice'));}
async function canReadChannel(userId:string,channelId:string){return Boolean((await pool.query('SELECT 1 FROM channels c JOIN community_members cm ON cm.community_id=c.community_id WHERE c.id=$1 AND cm.user_id=$2',[channelId,userId])).rowCount);}
function messageDto(r:any,reactionsByEmoji?:Map<string,string[]>,currentUserId?:string,replyInfo?:any){
  let content='';
  try{content=r.deleted_at?'':decrypt(r.content_enc);}catch{content='[сообщение недоступно]';}
  const reactions:Array<{emoji:string;count:number;users:string[];reacted:boolean}>=[];
  if(reactionsByEmoji){
    for(const[emoji,uids]of reactionsByEmoji.entries()){
      reactions.push({
        emoji,
        count:uids.length,
        users:uids,
        reacted:Boolean(currentUserId&&uids.includes(currentUserId))
      });
    }
  }
  let replyTo=replyInfo||null;
  if(!replyTo&&r.reply_to_id){
    let rc='';
    try{rc=r.reply_deleted_at?'':decrypt(r.reply_content_enc);}catch{}
    replyTo={
      id:r.reply_to_id,
      authorUsername:r.reply_author_username||'Пользователь',
      content:rc,
      deleted:Boolean(r.reply_deleted_at)
    };
  }
  return{
    id:r.id,
    content,
    created_at:r.created_at,
    edited_at:r.edited_at,
    deleted_at:r.deleted_at,
    replyTo,
    reactions,
    attachment:r.attachment_id?{id:r.attachment_id,mime:r.attachment_mime,name:r.attachment_name,size:r.attachment_size,url:`/api/uploads/${r.attachment_id}`}:null,
    author:r.author_id?{id:r.author_id,username:r.username,avatarUrl:r.avatar_url||null,verified:Boolean(r.author_verified??r.verified),donator:Boolean(r.author_donator??r.donator),mrbeastBadge:Boolean(r.author_mrbeast_badge??r.mrbeast_badge)}:{id:null,username:'Удалённый пользователь',avatarUrl:null,verified:false,donator:false,mrbeastBadge:false}
  };
}

async function storedMessageDto(id:string,isDm:boolean,userId:string){
  const table=isDm?'direct_messages':'messages';
  const authorColumn=isDm?'sender_id':'author_id';
  const editedColumn=isDm?'NULL::timestamptz edited_at':'m.edited_at';
  const query=`SELECT m.id,m.content_enc,m.created_at,${editedColumn},m.deleted_at,m.reply_to_id,u.id author_id,u.username,u.avatar_url,u.verified author_verified,u.donator author_donator,u.mrbeast_badge author_mrbeast_badge,a.id attachment_id,a.mime attachment_mime,a.original_name attachment_name,a.size attachment_size,rm.content_enc reply_content_enc,rm.deleted_at reply_deleted_at,ru.username reply_author_username FROM ${table} m LEFT JOIN users u ON u.id=m.${authorColumn} LEFT JOIN attachments a ON a.id=m.attachment_id LEFT JOIN ${table} rm ON rm.id=m.reply_to_id LEFT JOIN users ru ON ru.id=rm.${authorColumn} WHERE m.id=$1`;
  const result=await pool.query(query,[id]);
  return messageDto(result.rows[0],undefined,userId);
}

io.use(async(socket,next)=>{try{const cookie=socket.handshake.headers.cookie||'',token=decodeURIComponent(cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('vrot_session='))?.slice(13)||'');const user=await sessionUser(token);if(!user||user.banned_at)return next(new Error('unauthorized'));if(user.frozen_at)return next(new Error('account_frozen'));socket.data.user=user;next();}catch(e){next(e as Error);}});
type CallTarget={kind:'channel'|'friend';id:string};
async function callRoom(userId:string,target:CallTarget){if(!target||!['channel','friend'].includes(target.kind)||typeof target.id!=='string')return null;if(target.kind==='channel')return await canJoinVoice(userId,target.id)?`call:channel:${target.id}`:null;const accepted=Boolean((await pool.query("SELECT 1 FROM friendships WHERE status='accepted' AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))",[userId,target.id])).rowCount);return accepted?`call:friend:${[userId,target.id].sort().join(':')}`:null;}
async function leaveCalls(socket:any){for(const room of socket.rooms as Set<string>){if(room.startsWith('call:')){socket.to(room).emit('call:peer-left',{socketId:socket.id});await socket.leave(room);}}}
const pendingCalls=new Map<string,{callerId:string;calleeId:string;timer:ReturnType<typeof setTimeout>}>();
function finishPendingCall(callId:string,reason:'timeout'|'declined'|'cancelled'|'answered'){
  const pending=pendingCalls.get(callId);if(!pending)return false;
  clearTimeout(pending.timer);pendingCalls.delete(callId);
  io.to(`user:${pending.callerId}`).to(`user:${pending.calleeId}`).emit(reason==='answered'?'call:answered':'call:ended',{callId,reason,callerId:pending.callerId,calleeId:pending.calleeId});
  if(reason==='answered') io.to(`user:${pending.callerId}`).to(`user:${pending.calleeId}`).emit('call:ended',{callId,reason:'answered',callerId:pending.callerId,calleeId:pending.calleeId});
  return true;
}
io.on('connection',socket=>{
  const uid=socket.data.user.id;
  socket.join(`user:${uid}`);
  const prevCount=onlineUsers.get(uid)||0;
  onlineUsers.set(uid,prevCount+1);
  if(prevCount===0){
    io.emit('presence:change',{userId:uid,presence:computePresence(uid,socket.data.user.status)});
  }
  socket.emit('presence:snapshot',{onlineUserIds:[...onlineUsers.keys()]});
  socket.on('channel:join',async(channelId:string,ack)=>{if(typeof channelId==='string'&&await canReadChannel(socket.data.user.id,channelId)){await socket.join(`channel:${channelId}`);ack?.({ok:true});}else ack?.({ok:false});});
  socket.on('call:join',async(target:CallTarget,ack)=>{
    const room=await callRoom(socket.data.user.id,target);
    if(!room)return ack?.({ok:false,error:'Нет доступа к звонку'});
    if(target?.kind==='friend'&&target.id){
      for(const [id,p] of pendingCalls){
        if((p.callerId===uid&&p.calleeId===target.id)||(p.callerId===target.id&&p.calleeId===uid)){
          finishPendingCall(id,'answered');
        }
      }
    }
    await leaveCalls(socket);
    const peerIds=[...(io.sockets.adapter.rooms.get(room)||[])];
    const peers=peerIds.map(id=>{const s=io.sockets.sockets.get(id);return s?{socketId:id,user:publicUser(s.data.user)}:null;}).filter(Boolean);
    await socket.join(room);
    socket.to(room).emit('call:peer-joined',{socketId:socket.id,user:publicUser(socket.data.user)});
    ack?.({ok:true,room,peers});
  });
  socket.on('call:signal',async(data:{target:CallTarget;to:string;description?:unknown;candidate?:unknown})=>{
    const room=await callRoom(socket.data.user.id,data?.target);
    if(!room||!socket.rooms.has(room)||!io.sockets.adapter.rooms.get(room)?.has(data.to))return;
    if(data?.target?.kind==='friend'&&data.target.id){
      for(const [id,p] of pendingCalls){
        if((p.callerId===uid&&p.calleeId===data.target.id)||(p.callerId===data.target.id&&p.calleeId===uid)){
          finishPendingCall(id,'answered');
        }
      }
    }
    io.to(data.to).emit('call:signal',{from:socket.id,user:publicUser(socket.data.user),description:data.description,candidate:data.candidate});
  });
  socket.on('call:leave',async()=>leaveCalls(socket));
  socket.on('call:invite',async(data:{friendId:string;video:boolean},ack)=>{const room=await callRoom(socket.data.user.id,{kind:'friend',id:data?.friendId});if(!room)return ack?.({ok:false,error:'Пользователь не в друзьях'});const callId=uuid(),expiresAt=Date.now()+15000;const timer=setTimeout(()=>finishPendingCall(callId,'timeout'),15000);pendingCalls.set(callId,{callerId:uid,calleeId:data.friendId,timer});io.to(`user:${data.friendId}`).emit('call:incoming',{from:publicUser(socket.data.user),video:Boolean(data.video),callId,expiresAt});void sendPush(data.friendId,{kind:'call',friendId:socket.data.user.id,video:Boolean(data.video),callId,expiresAt,title:`Входящий вызов: ${socket.data.user.display_name||socket.data.user.username}`,body:data.video?'📹 Входящий видеозвонок':'📞 Входящий голосовой звонок',url:`/?call=${socket.data.user.id}`,tag:`call:${socket.data.user.id}`});if(process.env.IOS_VOIP_ENABLED==='true')void sendApplePush(data.friendId,'voip',{callId,friendId:uid,callerName:socket.data.user.display_name||socket.data.user.username,video:Boolean(data.video),expiresAt}).catch(console.error);ack?.({ok:true,callId,expiresAt});});
  socket.on('call:respond',(data:{callId:string;accept:boolean},ack)=>{const pending=pendingCalls.get(data?.callId);if(!pending||pending.calleeId!==uid)return ack?.({ok:false,error:'Вызов завершён'});finishPendingCall(data.callId,data.accept?'answered':'declined');ack?.({ok:true});});
  socket.on('call:cancel',async(data:{friendId:string;callId?:string})=>{for(const [id,p] of pendingCalls)if(p.callerId===uid&&p.calleeId===data?.friendId&&(!data.callId||data.callId===id))finishPendingCall(id,'cancelled');if(data?.friendId){io.to(`user:${data.friendId}`).emit('call:cancelled',{from:publicUser(socket.data.user),callId:data.callId});io.to(`user:${data.friendId}`).emit('call:peer-left',{socketId:socket.id});}});
  socket.on('disconnecting',()=>{for(const room of socket.rooms)if(room.startsWith('call:'))socket.to(room).emit('call:peer-left',{socketId:socket.id});});
  socket.on('disconnect',()=>{
    const rem=(onlineUsers.get(uid)||1)-1;
    if(rem<=0){
      onlineUsers.delete(uid);
      io.emit('presence:change',{userId:uid,presence:'offline'});
    }else{
      onlineUsers.set(uid,rem);
    }
  });
});

app.get('/download/vrot.apk',(_req,res)=>{
  const p1=path.resolve('/app/uploads','vrot.apk'),p2=path.resolve('uploads','vrot.apk');
  const target=fs.existsSync(p1)?p1:fs.existsSync(p2)?p2:null;
  if(target){
    res.setHeader('Content-Type','application/vnd.android.package-archive');
    res.setHeader('Content-Disposition','attachment; filename="vrot.apk"');
    return res.sendFile(target);
  }
  res.status(404).send('APK файл пока формируется на сервере. Пожалуйста, подождите минуту и повторите попытку.');
});

app.get('/download/vrot.ipa',(_req,res)=>{
  const p1=path.resolve('/app/uploads','vrot.ipa'),p2=path.resolve('uploads','vrot.ipa');
  const target=fs.existsSync(p1)?p1:fs.existsSync(p2)?p2:null;
  if(target){
    res.setHeader('Content-Type','application/octet-stream');
    res.setHeader('Content-Disposition','attachment; filename="vrot.ipa"');
    return res.sendFile(target);
  }
  res.status(404).send('IPA файл пока формируется на сервере. Пожалуйста, подождите минуту и повторите попытку.');
});

const web=path.resolve('dist');app.use('/api/web',(req,res,next)=>{res.setHeader('Cross-Origin-Resource-Policy','cross-origin');next();},express.static(web,{maxAge:process.env.NODE_ENV==='production'?'1h':0,index:false,immutable:false}));app.use(express.static(web,{maxAge:process.env.NODE_ENV==='production'?'1h':0,index:false,immutable:false}));app.get('*',(req,res,next)=>{if(req.path.startsWith('/api/')||req.path.startsWith('/socket.io'))return next();res.setHeader('Cache-Control','no-store, max-age=0');res.sendFile(path.join(web,'index.html'));});
app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{if(err instanceof z.ZodError)return res.status(400).json({error:'Проверьте введённые данные',fields:err.flatten().fieldErrors});console.error(err);res.status(500).json({error:'Внутренняя ошибка'});});

await migrate();await loadSystemSettings();await initPushKeys();const port=Number(process.env.PORT||3000);server.listen(port,'0.0.0.0',()=>console.log(`Vrot.fun listening on ${port}`));
