import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, timingSafeEqual, randomUUID, scrypt as scryptCallback, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { INITIAL_GIFTS, INITIAL_MEMORIES, INITIAL_GUESTS, INITIAL_SUPPLIERS } from './seed-data.js';
import { sendRsvpConfirmation } from './evolution.js';
import { normalizeBrazilianPhone, normalizeGuestName } from './guest-match.js';
import { asaasCheckoutUrl, asaasRequest, decryptSecret, encryptSecret, hashWebhookToken, secureTokenMatches } from './asaas.js';
import { isStorageConfigured, ensureBucket, putImage, getImage, deleteImage, closeStorage } from './storage.js';

const root = dirname(fileURLToPath(import.meta.url));
const scrypt = promisify(scryptCallback);
const app = Fastify({ logger: { redact: ['req.headers.cookie', 'req.headers.authorization'] }, trustProxy: process.env.TRUST_PROXY === 'true', bodyLimit: 16_384, requestTimeout: 15_000 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, application_name: 'suzy-junior-wedding' });
const live = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'suzy-junior-realtime' });

await app.register(cookie, { secret: process.env.SESSION_SECRET || 'development-only-secret-change-this-now' });
await app.register(helmet, { global: true, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com', 'https://use.typekit.net'], fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://use.typekit.net'], imgSrc: ["'self'", 'data:'], scriptSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: null } } });
await app.register(rateLimit, { global: true, max: 180, timeWindow: '1 minute' });
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 8, parts: 10 } });
await app.register(fastifyStatic, { root: join(root, '../public'), prefix: '/', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, immutable: false, wildcard: false });

app.addHook('onRequest', async (request, reply) => {
  if (!['GET', 'HEAD'].includes(request.method)) return;
  const pathname = new URL(request.url, 'http://local').pathname;
  if (pathname.startsWith('/api/') || pathname.startsWith('/media/') || pathname.startsWith('/images/') || /\.(?:css|js|ico|png|jpe?g|webp|svg|woff2?)$/i.test(pathname)) return;
  if (pathname === '/') return reply.code(200).header('cache-control', 'no-store').sendFile('not-found.html');
  const match = pathname.match(/^\/casamento\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (match) {
    const found = await pool.query('SELECT 1 FROM weddings WHERE slug=$1', [match[1]]);
    if (found.rowCount) return;
  }
  return reply.code(404).header('cache-control', 'no-store').sendFile('not-found.html');
});

async function requireAdmin(request, reply) {
  reply.header('cache-control', 'no-store');
  const session = request.unsignCookie(request.cookies.admin_session || '');
  if (!session.valid || !session.value?.startsWith('admin:')) return reply.code(401).send({ error: 'Acesso administrativo necessário.' });
  const userId = session.value.slice(6);
  if (userId.startsWith('legacy:')) {
    if (userId.slice(7) !== request.weddingId) return reply.code(401).send({ error: 'Acesso administrativo necessário.' });
  } else if (userId === 'legacy') {
    const legacyTenant = await request.db.query('SELECT 1 FROM legacy_admin_tenants WHERE singleton=true AND wedding_id=$1', [request.weddingId]);
    if (!legacyTenant.rowCount) return reply.code(401).send({ error: 'Acesso administrativo necessário.' });
  } else {
    const user = await request.db.query('SELECT id FROM admin_users WHERE id=$1', [userId]);
    if (!user.rowCount) return reply.code(401).send({ error: 'Acesso administrativo necessário.' });
  }
  request.adminUserId = userId;
}
const passwordHash = async password => {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(hash).toString('hex')}`;
};
const passwordMatches = async (password, encoded) => {
  const [salt, expectedHex] = String(encoded).split(':');
  if (!salt || !/^[a-f0-9]{128}$/i.test(expectedHex || '')) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
};
function sameOrigin(request, reply, done) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return done();
  const origin = request.headers.origin;
  const expectedOrigin = process.env.NODE_ENV === 'production' && process.env.APP_URL
    ? new URL(process.env.APP_URL).origin
    : `${request.protocol}://${request.headers.host}`;
  if (origin && origin !== expectedOrigin) return reply.code(403).send({ error: 'Origem inválida.' });
  if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Origem inválida.' });
  done();
}
app.addHook('preHandler', sameOrigin);
app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/') || request.url.startsWith('/api/health') || request.url.startsWith('/api/admin/register') || request.url.startsWith('/api/events') || request.url.startsWith('/api/webhooks/asaas/')) return;
  const requestedSlug = request.headers['x-wedding-slug'] || new URL(request.url, 'http://local').searchParams.get('wedding');
  if (request.url.startsWith('/api/admin/login') && !requestedSlug) { request.globalAdminLogin = true; return; }
  if (!requestedSlug) return reply.code(400).send({error:'URL incompleta: informe o slug do casamento, por exemplo /casamento/nome-do-casal.'});
  if (typeof requestedSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedSlug)) return reply.code(400).send({error:'Slug de casamento inválido.'});
  const found = await pool.query('SELECT id,title FROM weddings WHERE slug=$1', [requestedSlug]);
  if (!found.rowCount) return reply.code(404).send({error:'Casamento não encontrado.'});
  request.weddingSlug = requestedSlug; request.weddingId = found.rows[0].id; request.weddingTitle=found.rows[0].title; request.db = await pool.connect();
  try { await request.db.query('BEGIN'); await request.db.query("SELECT set_config('app.wedding_id',$1,true)", [request.weddingId]); }
  catch(error) { request.db.release(); request.db=null; throw error; }
});
app.addHook('onError', async request => { if(request.db&&!request.dbReleased){await request.db.query('ROLLBACK').catch(()=>{});request.db.release();request.dbReleased=true;} });
app.addHook('onSend', async (request, reply, payload) => {
  const pathname = new URL(request.raw.url || '/', 'http://local').pathname;
  if (/\.(?:html|js|css)$/i.test(pathname) || pathname === '/' || pathname.startsWith('/casamento/')) reply.header('cache-control', 'no-cache, must-revalidate');
  if(request.db&&!request.dbReleased){await request.db.query('COMMIT');request.db.release();request.dbReleased=true;}
  return payload;
});
const text = (value, max = 120) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const phone = value => typeof value === 'string' && /^[+()\d .-]{8,24}$/.test(value);
const money = value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 10000000;
const paymentsWebhookBase = request => process.env.PAYMENTS_WEBHOOK_BASE_URL || (process.env.NODE_ENV==='production'&&process.env.APP_URL?process.env.APP_URL:`${request.protocol}://${request.headers.host}`);
const isoDate = value => typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(new Date(`${value}T12:00:00-03:00`).valueOf())&&new Date(`${value}T12:00:00-03:00`).toISOString().slice(0,10)===value;
const publicGuestFields = 'id, name, companions, created_at';
const publicMemoryFields = 'id, sender_name, gift_title, gift_amount, message, created_at';
const date = value => new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Fortaleza' });
const seedDate = value => { const [day, month, year] = value.replace('.', '').split(' '); const months = { Jan:0, Fev:1, Mar:2, Abr:3, Mai:4, Jun:5, Jul:6, Ago:7, Set:8, Out:9, Nov:10, Dez:11 }; return new Date(Date.UTC(Number(year), months[month], Number(day), 15)).toISOString(); };
const guestOut = row => ({ id: row.id, name: row.name, companions: row.companions, confirmedAt: date(row.created_at) });
const memoryOut = row => ({ id: row.id, senderName: row.sender_name, giftTitle: row.gift_title, giftAmount: Number(row.gift_amount), message: row.message, createdAt: date(row.created_at) });
const giftOut = row => ({ id:row.id,title:row.title,category:row.category,price:Number(row.price),description:row.description,imageUrl:row.image_url||'',isGifted:row.is_gifted,giftedBy:row.gifted_by||'' });
function imageFormat(buffer){
  if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return {ext:'jpg',type:'image/jpeg'};
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {ext:'png',type:'image/png'};
  if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return {ext:'webp',type:'image/webp'};
  return null;
}

async function seed() {
  const migration = await pool.connect();
  try { await migration.query('BEGIN'); await migration.query(await readFile(join(root, 'schema.sql'), 'utf8')); await migration.query('COMMIT'); }
  catch(error) { await migration.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { migration.release(); }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('suzy-junior-wedding-seed'))");
    const wedding=await db.query('SELECT wedding_id AS id FROM legacy_admin_tenants WHERE singleton=true');
    if(!wedding.rowCount)throw new Error('O casamento base do sistema não foi inicializado.');
    await db.query("SELECT set_config('app.wedding_id',$1,true)",[wedding.rows[0].id]);
    const existing = await db.query('SELECT count(*)::int AS count FROM gifts');
    if (existing.rows[0].count) { await db.query('COMMIT'); return; }
    for (const g of INITIAL_GIFTS) await db.query('INSERT INTO gifts(id,title,category,price,description,wedding_id) VALUES($1,$2,$3,$4,$5,$6)', [g.id,g.title,g.category,g.price,g.description,wedding.rows[0].id]);
    for (const m of INITIAL_MEMORIES) await db.query('INSERT INTO memories(sender_name,whatsapp,gift_title,gift_amount,message,is_visible,created_at,wedding_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [m.senderName,m.whatsapp,m.giftTitle,m.giftAmount,m.message,m.isVisible,seedDate(m.createdAt),wedding.rows[0].id]);
    for (const g of INITIAL_GUESTS) await db.query('INSERT INTO guests(name,whatsapp,companions,is_visible,created_at,wedding_id) VALUES($1,$2,$3,$4,$5,$6)', [g.name,g.whatsapp,g.companions,g.isVisible,seedDate(g.confirmedAt),wedding.rows[0].id]);
    for (const s of INITIAL_SUPPLIERS) await db.query('INSERT INTO suppliers(id,name,role,contact,cost,paid_amount,status,is_visible,wedding_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [s.id,s.name,s.role,s.contact,s.cost,s.paidAmount,s.status,s.isVisible,wedding.rows[0].id]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

app.get('/api/health', async (_req, reply) => {
  try { await pool.query('SELECT 1'); return { status: 'ok', database: 'connected' }; }
  catch { return reply.code(503).send({ status: 'unavailable' }); }
});
app.get('/api/site', async (req) => {
  const [gifts, memories, guests, venues, paymentIntegration] = await Promise.all([
    req.db.query('SELECT * FROM gifts ORDER BY id'),
    req.db.query(`SELECT ${publicMemoryFields} FROM memories WHERE is_visible ORDER BY created_at DESC LIMIT 100`),
    req.db.query(`SELECT ${publicGuestFields} FROM guests WHERE is_visible ORDER BY created_at DESC LIMIT 250`),
    req.db.query("SELECT key,value FROM site_settings WHERE key IN ('venue_ceremony','venue_reception','story_content','event_schedule','design_theme') ORDER BY key")
    ,req.db.query('SELECT is_active FROM payment_integrations WHERE wedding_id=$1',[req.weddingId])
  ]);
  const settings=Object.fromEntries(venues.rows.map(r=>[r.key,r.value]));
  const activePayments=Boolean(paymentIntegration.rows[0]?.is_active);
  const pending=activePayments?await req.db.query("SELECT DISTINCT gift_id FROM gift_payments WHERE wedding_id=$1 AND status IN ('CREATING','PENDING') AND expires_at>now()",[req.weddingId]):{rows:[]};
  const reserved=new Set(pending.rows.map(row=>row.gift_id));
  return { wedding:{slug:req.weddingSlug,title:req.weddingTitle}, gifts: gifts.rows.map(row=>({...giftOut(row),isReserved:reserved.has(row.id)})), memories: memories.rows.map(memoryOut), guests: guests.rows.map(guestOut), venues: ['venue_ceremony','venue_reception'].map(k=>settings[k]).filter(Boolean), story:settings.story_content||null, event:settings.event_schedule||null, design:settings.design_theme||null, paymentsEnabled:activePayments };
});
app.get('/api/theme.css', async(req,reply)=>{
  const result=await req.db.query("SELECT value FROM site_settings WHERE key='design_theme'");
  const design=result.rows[0]?.value||{},colors=design.colors||{},fonts=design.fonts||{};
  const pickColor=(key,fallback)=>validColor(colors[key])?colors[key]:fallback;
  const heading=themeFonts.heading.has(fonts.heading)?fonts.heading:'Cinzel',body=themeFonts.body.has(fonts.body)?fonts.body:'Montserrat';
  const hero=validHeroImage(design.heroImage)?design.heroImage:'/images/hero_wedding_hall_1791245517448.jpg';
  const css=`:root{--bg:${pickColor('background','#0a0d14')};--panel:${pickColor('panel','#101520')};--text:${pickColor('text','#ebebeb')};--gold:${pickColor('accent','#c0a062')};--button-bg:${pickColor('button','#c0a062')};--button-hover:${pickColor('buttonHover','#d4b475')};--button-fg:${pickColor('buttonText','#0a0d14')};--serif:"${heading}",Georgia,serif;--display:"${heading}",Georgia,serif;--sans:"${body}",sans-serif;--hero-image:url("${hero}")}`;
  return reply.type('text/css; charset=utf-8').header('cache-control','private, max-age=30').send(css);
});
app.get('/media/*', async (req, reply) => {
  const key=req.params['*'];
  if(!/^(?:venues\/(?:ceremony|reception)|gifts)\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test(key)&&!/^weddings\/[a-f0-9-]{36}\/(?:(?:venues\/(?:ceremony|reception)\/)|(?:gifts|hero)\/)[a-f0-9-]{36}\.(jpg|png|webp)$/.test(key)) return reply.code(404).send({error:'Imagem não encontrada.'});
  try {
    const image=await getImage(key);
    reply.header('content-type',image.ContentType||'application/octet-stream').header('cache-control',image.CacheControl||'public, max-age=31536000, immutable').header('x-content-type-options','nosniff');
    return reply.send(image.Body);
  } catch(error) { if(error.name==='NoSuchKey'||error.$metadata?.httpStatusCode===404)return reply.code(404).send({error:'Imagem não encontrada.'});throw error; }
});
app.post('/api/rsvp', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const { name, whatsapp, companions = 0 } = req.body || {};
  if (!text(name, 120) || !phone(whatsapp) || !Number.isInteger(companions) || companions < 0 || companions > 4) return reply.code(400).send({ error: 'Confira nome, WhatsApp e quantidade de acompanhantes.' });
  const schedule=await req.db.query("SELECT value->>'rsvpDeadline' AS deadline FROM site_settings WHERE key='event_schedule'");
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Fortaleza',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(schedule.rows[0]?.deadline&&today>schedule.rows[0].deadline)return reply.code(409).send({error:'O prazo para confirmar presença foi encerrado.'});
  const result = await req.db.query('INSERT INTO guests(name,whatsapp,companions,wedding_id) VALUES($1,$2,$3,$4) RETURNING id,name,companions,created_at', [name.trim(),whatsapp.trim(),companions,req.weddingId]);
  let notificationSent = false;
  try { notificationSent = await sendRsvpConfirmation({ name: name.trim(), whatsapp: whatsapp.trim(), companions }); }
  catch (error) { req.log.warn({ err: error }, 'RSVP salvo; não foi possível enviar a confirmação por WhatsApp.'); }
  return reply.code(201).send({ guest: guestOut(result.rows[0]), notificationSent });
});
app.post('/api/memories/dedication', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const { guestId, message, writtenAt } = req.body || {};
  if (typeof guestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guestId) || !text(message, 1000) || !isoDate(writtenAt)) {
    return reply.code(400).send({ error: 'Informe uma frase para a Penseira e a data em que foi escrita.' });
  }
  const guest = await req.db.query('SELECT name FROM guests WHERE id=$1 AND wedding_id=$2', [guestId, req.weddingId]);
  if (!guest.rowCount) return reply.code(404).send({ error: 'Não encontramos a confirmação de presença associada. Confirme sua presença antes de enviar a dedicatória.' });
  const createdAt = new Date(`${writtenAt}T12:00:00-03:00`);
  const result = await req.db.query("INSERT INTO memories(sender_name,whatsapp,gift_title,gift_amount,message,created_at,wedding_id) VALUES($1,'','Dedicatória',0,$2,$3,$4) RETURNING id,sender_name,gift_title,gift_amount,message,created_at", [guest.rows[0].name, message.trim(), createdAt, req.weddingId]);
  return reply.code(201).send({ memory: memoryOut(result.rows[0]) });
});
app.post('/api/memories', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const { senderName, whatsapp, message = '', giftId } = req.body || {};
  if (!text(senderName, 120) || !phone(whatsapp) || typeof message !== 'string' || message.length > 1000 || !text(giftId, 40)) return reply.code(400).send({ error: 'Confira seus dados e a mensagem (até 1.000 caracteres).' });
  const paymentConfig=await req.db.query('SELECT is_active FROM payment_integrations WHERE wedding_id=$1',[req.weddingId]);
  if(paymentConfig.rows[0]?.is_active)return reply.code(409).send({error:'Este casamento recebe presentes pelo checkout seguro. Escolha o presente e use o botão de pagamento.'});
  const db=req.db;let result;
  try{
    const gift=await db.query('SELECT id,title,price,is_gifted FROM gifts WHERE id=$1 FOR UPDATE',[giftId]);
    if(!gift.rowCount)return reply.code(404).send({error:'Presente não encontrado.'})
    if(gift.rows[0].is_gifted)return reply.code(409).send({error:'Este presente já foi confirmado por outra pessoa. Escolha outro item.'})
    if(message.trim()){
      const confirmed=await db.query('SELECT 1 FROM guests WHERE lower(name)=lower($1) LIMIT 1',[senderName.trim()]);
      if(!confirmed.rowCount)return reply.code(400).send({error:'Confirme a presença antes de enviar uma dedicatória. A dedicatória é opcional.'})
    }
    await db.query('UPDATE gifts SET is_gifted=true,gifted_by=$2 WHERE id=$1',[giftId,senderName.trim()]);
    if(message.trim()){
      result=await db.query('INSERT INTO memories(gift_id,sender_name,whatsapp,gift_title,gift_amount,message,wedding_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,sender_name,gift_title,gift_amount,message,created_at',[giftId,senderName.trim(),whatsapp.trim(),gift.rows[0].title,gift.rows[0].price,message.trim(),req.weddingId]);
    }
  }catch(error){throw error}
  return reply.code(201).send({ memory:result?memoryOut(result.rows[0]):null });
});
app.post('/api/admin/memories', { preHandler: requireAdmin }, async (req,reply)=>{
  const {senderName,message='',writtenAt}=req.body||{};
  if(!text(senderName,120)||typeof message!=='string'||message.length>1000||!isoDate(writtenAt))return reply.code(400).send({error:'Confira o convidado, a frase (até 1.000 caracteres) e a data.'});
  const guest=await req.db.query('SELECT id FROM guests WHERE lower(name)=lower($1) LIMIT 1',[senderName.trim()]);
  if(!guest.rowCount)return reply.code(400).send({error:'A dedicatória só pode ser associada a alguém com presença confirmada.'});
  const createdAt=new Date(`${writtenAt}T12:00:00-03:00`);
  const result=await req.db.query("INSERT INTO memories(sender_name,whatsapp,gift_title,gift_amount,message,created_at,wedding_id) VALUES($1,'','Dedicatória',0,$2,$3,$4) RETURNING id,sender_name,gift_title,gift_amount,message,created_at",[senderName.trim(),message.trim(),createdAt,req.weddingId]);
  return reply.code(201).send({memory:memoryOut(result.rows[0])});
});
app.post('/api/admin/register', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const { title, slug, username, email, password } = req.body || {};
  if (!text(title, 180) || typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80 || !text(username, 40) || !/^[a-zA-Z0-9._-]{3,40}$/.test(username.trim()) || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254 || typeof password !== 'string' || password.length < 12 || password.length > 200) {
    return reply.code(400).send({ error: 'Informe o nome do casamento, slug (letras minúsculas e hífens), usuário, e-mail e senha com pelo menos 12 caracteres.' });
  }
  const hashed = await passwordHash(password), db = await pool.connect();
  try {
    await db.query('BEGIN');
    const base = await db.query('SELECT wedding_id AS id FROM legacy_admin_tenants WHERE singleton=true');
    await db.query("SELECT set_config('app.wedding_id',$1,true)", [base.rows[0].id]);
    const defaults = await db.query("SELECT key,value FROM site_settings WHERE wedding_id=$1", [base.rows[0].id]);
    const wedding = await db.query('INSERT INTO weddings(slug,title) VALUES($1,$2) ON CONFLICT(slug) DO NOTHING RETURNING id', [slug,title.trim()]);
    if (!wedding.rowCount) { await db.query('ROLLBACK'); return reply.code(409).send({error:'Este slug já está em uso. Escolha outro.'}); }
    const weddingId = wedding.rows[0].id;
    await db.query("SELECT set_config('app.wedding_id',$1,true)", [weddingId]);
    const user = await db.query('INSERT INTO admin_users(wedding_id,username,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [weddingId,username.trim(),email.trim().toLowerCase(),hashed]);
    const eventDate = new Date(); eventDate.setFullYear(eventDate.getFullYear()+1);
    const rsvpDeadline = new Date(eventDate); rsvpDeadline.setDate(rsvpDeadline.getDate()-30);
    const iso = value => value.toISOString().slice(0,10);
    for (const row of defaults.rows) {
      let value = row.value;
      if (row.key==='story_content') value={...value,eyebrow:'NOSSA HISTÓRIA',title:'Nossa História',body:'Compartilhe aqui a história de vocês.',facts:['O primeiro encontro','Uma data especial','Um sonho em comum'],question:'E o próximo capítulo?',answer:'Começa agora!' };
      if (row.key==='venue_ceremony') value={...value,eyebrow:'CERIMÔNIA',title:'Cerimônia',name:'Local da cerimônia',address:'Endereço a definir',mapsUrl:'https://www.google.com/maps/search/?api=1&query=local+da+cerimonia',imageUrl:'',imageAlt:'Local da cerimônia'};
      if (row.key==='venue_reception') value={...value,eyebrow:'RECEPÇÃO',title:'Recepção',name:'Local da recepção',address:'Endereço a definir',mapsUrl:'https://www.google.com/maps/search/?api=1&query=local+da+recepcao',imageUrl:'',imageAlt:'Local da recepção'};
      if (row.key==='event_schedule') value={eventDate:iso(eventDate),eventTime:'16:00',rsvpDeadline:iso(rsvpDeadline)};
      await db.query('INSERT INTO site_settings(wedding_id,key,value) VALUES($1,$2,$3::jsonb)',[weddingId,row.key,JSON.stringify(value)]);
    }
    await db.query('COMMIT');
    reply.setCookie('admin_session', `admin:${user.rows[0].id}`, { signed: true, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 60 * 60 * 8 });
    return reply.code(201).send({ok:true,wedding:{slug,title:title.trim()}});
  } catch(error) { await db.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { db.release(); }
});
app.post('/api/admin/login', { config: { rateLimit: { max: 8, timeWindow: '15 minutes', keyGenerator: request => createHash('sha256').update(`${request.ip}:${String(request.body?.email || request.body?.identifier || '').trim().toLowerCase()}`).digest('hex') } } }, async (req, reply) => {
  const { identifier: suppliedIdentifier, email, password } = req.body || {};
  const identifier = email || suppliedIdentifier;
  if (typeof identifier !== 'string' || identifier.length > 254 || typeof password !== 'string' || password.length > 200) return reply.code(401).send({ error: 'Usuário/e-mail ou senha inválidos.' });
  if (req.globalAdminLogin) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.trim())) return reply.code(401).send({ error: 'Usuário/e-mail ou senha inválidos.' });
    const tenants = await pool.query('SELECT id,slug,title FROM weddings ORDER BY created_at');
    const matches = [];
    const legacyMatches = [];
    for (const tenant of tenants.rows) {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query("SELECT set_config('app.wedding_id',$1,true)", [tenant.id]);
        const result = await db.query('SELECT id,password_hash FROM admin_users WHERE wedding_id=$1 AND lower(email)=lower($2)', [tenant.id,identifier.trim()]);
        if (result.rowCount && await passwordMatches(password,result.rows[0].password_hash)) matches.push({id:result.rows[0].id,slug:tenant.slug,title:tenant.title});
        const legacy = await db.query('SELECT 1 FROM legacy_admin_tenants WHERE singleton=true AND wedding_id=$1', [tenant.id]);
        const expected = process.env.ADMIN_PASSWORD;
        const expectedHash = createHash('sha256').update(expected || '').digest();
        const suppliedHash = createHash('sha256').update(password).digest();
        const configuredEmail = process.env.ADMIN_EMAIL;
        if (legacy.rowCount && expected && timingSafeEqual(expectedHash,suppliedHash) && (!configuredEmail || configuredEmail.trim().toLowerCase()===identifier.trim().toLowerCase())) legacyMatches.push({id:tenant.id,slug:tenant.slug,title:tenant.title});
        await db.query('COMMIT');
      } catch(error) { await db.query('ROLLBACK').catch(()=>{}); throw error; }
      finally { db.release(); }
    }
    if (!matches.length && !legacyMatches.length) return reply.code(401).send({ error: 'E-mail ou senha inválidos.' });
    if (matches.length > 1) return reply.code(409).send({ error: 'Este e-mail acessa mais de um casamento. Escolha qual painel deseja abrir.', weddings: matches.map(({slug,title})=>({slug,title})) });
    if (legacyMatches.length === 1 && !matches.length) {
      const match=legacyMatches[0];
      reply.setCookie('admin_session', `admin:legacy:${match.id}`, { signed: true, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 60 * 60 * 8 });
      return { ok:true, wedding:{slug:match.slug,title:match.title} };
    }
    if (legacyMatches.length > 1) return reply.code(409).send({ error: 'Este acesso corresponde a mais de um casamento. Informe a URL completa do site e tente novamente.' });
    const match=matches[0];
    reply.setCookie('admin_session', `admin:${match.id}`, { signed: true, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 60 * 60 * 8 });
    return { ok:true, wedding:{slug:match.slug,title:match.title} };
  }
  const result = await req.db.query('SELECT id,password_hash FROM admin_users WHERE lower(username)=lower($1) OR lower(email)=lower($1) LIMIT 1', [identifier.trim()]);
  if (result.rowCount && await passwordMatches(password, result.rows[0].password_hash)) {
    reply.setCookie('admin_session', `admin:${result.rows[0].id}`, { signed: true, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 60 * 60 * 8 });
    return { ok: true, wedding:{slug:req.weddingSlug,title:req.weddingTitle} };
  }
  // Permite migrar sem interrupção: a senha administrativa atual segue aceitando login no campo de usuário/e-mail.
  const expected = process.env.ADMIN_PASSWORD;
  const supplied = password;
  const expectedHash = createHash('sha256').update(expected || '').digest();
  const suppliedHash = createHash('sha256').update(typeof supplied === 'string' && supplied.length <= 200 ? supplied : '').digest();
  const legacyTenant = await req.db.query('SELECT wedding_id FROM legacy_admin_tenants WHERE singleton=true');
  if (!expected || !legacyTenant.rowCount || legacyTenant.rows[0].wedding_id !== req.weddingId || !timingSafeEqual(expectedHash, suppliedHash)) return reply.code(401).send({ error: 'Usuário/e-mail ou senha inválidos.' });
  reply.setCookie('admin_session', `admin:legacy:${req.weddingId}`, { signed: true, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 60 * 60 * 8 });
  return { ok: true, wedding:{slug:req.weddingSlug,title:req.weddingTitle} };
});
app.post('/api/admin/logout', { preHandler: requireAdmin }, async (req, reply) => { reply.clearCookie('admin_session', { path: '/' }); return { ok: true }; });
app.get('/api/admin/payments', { preHandler: requireAdmin }, async req=>{
  const [integration,payments]=await Promise.all([
    req.db.query('SELECT environment,is_active,last_tested_at FROM payment_integrations WHERE wedding_id=$1',[req.weddingId]),
    req.db.query('SELECT id,gift_id,sender_name,gift_title,amount,status,checkout_url,created_at,updated_at FROM gift_payments WHERE wedding_id=$1 ORDER BY created_at DESC LIMIT 100',[req.weddingId])
  ]);
  const configured=integration.rowCount>0, row=integration.rows[0];
  const appUrl=paymentsWebhookBase(req);
  return {configured,environment:row?.environment||'sandbox',isActive:Boolean(row?.is_active),lastTestedAt:row?.last_tested_at||null,webhookUrl:`${appUrl.replace(/\/$/,'')}/api/webhooks/asaas/${req.weddingId}`,payments:payments.rows.map(p=>({id:p.id,giftTitle:p.gift_title,senderName:p.sender_name,amount:Number(p.amount),status:p.status,checkoutUrl:p.checkout_url,createdAt:p.created_at,updatedAt:p.updated_at}))};
});
app.put('/api/admin/payments/config', { preHandler: requireAdmin }, async(req,reply)=>{
  const {environment='sandbox',apiKey,rotateWebhookToken=false}=req.body||{};
  if(!['sandbox','production'].includes(environment)||typeof rotateWebhookToken!=='boolean'||(apiKey!==undefined&&(!text(apiKey,300)||apiKey.trim().length<20)))return reply.code(400).send({error:'Informe um ambiente válido e uma chave API do Asaas.'});
  if(apiKey&&!/^[a-f0-9]{64}$/i.test(process.env.PAYMENTS_ENCRYPTION_KEY||''))return reply.code(503).send({error:'O servidor ainda não tem PAYMENTS_ENCRYPTION_KEY configurada (64 caracteres hexadecimais).'});
  const old=await req.db.query('SELECT environment,api_key_cipher,webhook_token_cipher FROM payment_integrations WHERE wedding_id=$1',[req.weddingId]);
  if(!old.rowCount&&!apiKey)return reply.code(400).send({error:'Cole a chave API do Asaas para configurar este casamento.'});
  if(old.rowCount&&old.rows[0].environment!==environment&&!apiKey)return reply.code(400).send({error:'Ao trocar o ambiente, informe a chave API correspondente.'});
  const cipher=apiKey?encryptSecret(apiKey.trim()):old.rows[0].api_key_cipher;
  let token=old.rowCount&&!rotateWebhookToken?decryptSecret(old.rows[0].webhook_token_cipher):null;
  if(!token)token=randomBytes(32).toString('base64url');
  await req.db.query(`INSERT INTO payment_integrations(wedding_id,environment,api_key_cipher,webhook_token_hash,webhook_token_cipher,is_active,last_tested_at,updated_at)
    VALUES($1,$2,$3,$4,$5,false,NULL,now()) ON CONFLICT(wedding_id) DO UPDATE SET environment=EXCLUDED.environment,api_key_cipher=EXCLUDED.api_key_cipher,webhook_token_hash=EXCLUDED.webhook_token_hash,webhook_token_cipher=EXCLUDED.webhook_token_cipher,is_active=false,last_tested_at=NULL,updated_at=now()`,
    [req.weddingId,environment,cipher,hashWebhookToken(token).toString('hex'),encryptSecret(token)]);
  return {ok:true,configured:true,environment,webhookUrl:`${paymentsWebhookBase(req).replace(/\/$/,'')}/api/webhooks/asaas/${req.weddingId}`,webhookToken:token};
});
app.post('/api/admin/payments/test', { preHandler: requireAdmin }, async(req,reply)=>{
  const result=await req.db.query('SELECT environment,api_key_cipher FROM payment_integrations WHERE wedding_id=$1',[req.weddingId]);
  if(!result.rowCount)return reply.code(409).send({error:'Configure primeiro a conta Asaas deste casamento.'});
  try{
    const account=await asaasRequest(result.rows[0].environment,decryptSecret(result.rows[0].api_key_cipher),'/myAccount');
    await req.db.query('UPDATE payment_integrations SET is_active=false,last_tested_at=now(),updated_at=now() WHERE wedding_id=$1',[req.weddingId]);
    return {ok:true,account:{name:account.name||account.company||'Conta validada',email:account.email||''}};
  }catch(error){
    req.log.warn({err:error,weddingId:req.weddingId},'Falha ao validar a conta Asaas');
    const detail=error.name==='TimeoutError'?'Tempo limite ao conectar com o Asaas.':error.cause?.code?`Falha de rede ao conectar com o Asaas (${error.cause.code}).`:error.message;
    return reply.code(502).send({error:String(detail||'Não foi possível validar a conta Asaas.').slice(0,350)});
  }
});
app.patch('/api/admin/payments/activation', { preHandler: requireAdmin }, async(req,reply)=>{
  const {enabled,webhookConfigured}=req.body||{};
  if(typeof enabled!=='boolean'||(enabled&&webhookConfigured!==true))return reply.code(400).send({error:'Confirme que o Webhook foi cadastrado e testado no Asaas antes de habilitar os pagamentos.'});
  const result=await req.db.query('SELECT last_tested_at FROM payment_integrations WHERE wedding_id=$1',[req.weddingId]);
  if(!result.rowCount||!result.rows[0].last_tested_at)return reply.code(409).send({error:'Teste primeiro a conexão com a conta Asaas.'});
  await req.db.query('UPDATE payment_integrations SET is_active=$2,updated_at=now() WHERE wedding_id=$1',[req.weddingId,enabled]);
  return {ok:true,isActive:enabled};
});
app.post('/api/payments/checkout', { config:{rateLimit:{max:5,timeWindow:'15 minutes'}} }, async(req,reply)=>{
  const {giftId,senderName,whatsapp,email='',dedication=''}=req.body||{};
  if(!text(giftId,40)||!text(senderName,120)||!phone(whatsapp)||typeof email!=='string'||email.length>254||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))||typeof dedication!=='string'||dedication.length>1000)return reply.code(400).send({error:'Confira o presente, nome, WhatsApp e e-mail informado.'});
  const config=await req.db.query('SELECT environment,api_key_cipher,is_active FROM payment_integrations WHERE wedding_id=$1',[req.weddingId]);
  if(!config.rowCount||!config.rows[0].is_active)return reply.code(503).send({error:'O pagamento online ainda não está configurado para este casamento.'});
  const giftResult=await req.db.query('SELECT id,title,price,is_gifted FROM gifts WHERE id=$1 FOR UPDATE',[giftId]);
  if(!giftResult.rowCount)return reply.code(404).send({error:'Presente não encontrado.'});
  const gift=giftResult.rows[0];
  if(gift.is_gifted)return reply.code(409).send({error:'Este presente já foi pago. Escolha outro item.'});
  if(Number(gift.price)<=0)return reply.code(400).send({error:'Este presente ainda não tem um valor para pagamento.'});
  await req.db.query("UPDATE gift_payments SET status='EXPIRED',updated_at=now() WHERE wedding_id=$1 AND gift_id=$2 AND status IN ('CREATING','PENDING') AND expires_at<=now()",[req.weddingId,giftId]);
  const active=await req.db.query("SELECT id FROM gift_payments WHERE wedding_id=$1 AND gift_id=$2 AND status IN ('CREATING','PENDING') LIMIT 1",[req.weddingId,giftId]);
  if(active.rowCount)return reply.code(409).send({error:'Este presente já está reservado em um checkout em andamento. Tente novamente quando a reserva expirar.'});
  const normalizedPhone=normalizeBrazilianPhone(whatsapp);
  const registeredGuests=await req.db.query('SELECT id,name,whatsapp FROM guests WHERE wedding_id=$1',[req.weddingId]);
  const guest=registeredGuests.rows.find(row=>normalizeBrazilianPhone(row.whatsapp)===normalizedPhone&&normalizeGuestName(row.name)===normalizeGuestName(senderName));
  if(!guest)return reply.code(403).send({error:'Não encontramos uma confirmação com esse WhatsApp e nome. Use os mesmos dados informados no RSVP; acentos, espaços e pontuação no nome não precisam ser idênticos.'});
  const inserted=await req.db.query(`INSERT INTO gift_payments(wedding_id,gift_id,gift_title,guest_id,sender_name,whatsapp,dedication,amount,status,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CREATING',now()+interval '65 minutes') RETURNING id`,[req.weddingId,giftId,gift.title,guest.id,senderName.trim(),whatsapp.trim(),dedication.trim(),gift.price]);
  const paymentId=inserted.rows[0].id;
  const baseUrl=process.env.NODE_ENV==='production'&&process.env.APP_URL?process.env.APP_URL.replace(/\/$/,''):`${req.protocol}://${req.headers.host}`;
  const callback=`${baseUrl}/casamento/${encodeURIComponent(req.weddingSlug)}?pagamento=`;
  const payload={billingTypes:['PIX','CREDIT_CARD'],chargeTypes:['DETACHED'],minutesToExpire:60,externalReference:paymentId,callback:{successUrl:`${callback}sucesso#presentes`,cancelUrl:`${callback}cancelado#presentes`,expiredUrl:`${callback}expirado#presentes`},items:[{externalReference:gift.id,name:gift.title,description:`Presente de casamento para ${req.weddingTitle}`,quantity:1,value:Number(gift.price)}],customerData:{name:senderName.trim(),phone:normalizedPhone,...(email.trim()?{email:email.trim()}:{} )}};
  try{
    const apiKey=decryptSecret(config.rows[0].api_key_cipher),checkout=await asaasRequest(config.rows[0].environment,apiKey,'/checkouts',{method:'POST',body:payload});
    const checkoutUrl=asaasCheckoutUrl(config.rows[0].environment,checkout);
    await req.db.query("UPDATE gift_payments SET status='PENDING',checkout_id=$1,checkout_url=$2,updated_at=now() WHERE id=$3",[checkout.id,checkoutUrl,paymentId]);
    return reply.code(201).send({paymentId,checkoutUrl,expiresAt:new Date(Date.now()+60*60*1000).toISOString()});
  }catch(error){await req.db.query("UPDATE gift_payments SET status='FAILED',updated_at=now() WHERE id=$1",[paymentId]);req.log.warn({err:error,weddingId:req.weddingId,paymentId},'Não foi possível criar checkout no Asaas');return reply.code(502).send({error:error.message.slice(0,350)});}
});
app.post('/api/webhooks/asaas/:weddingId', { config:{rateLimit:{max:120,timeWindow:'1 minute'}} }, async(req,reply)=>{
  const {weddingId}=req.params, payload=req.body||{}, eventId=payload.id,eventType=payload.event,checkout=payload.checkout;
  if(!/^[0-9a-f-]{36}$/i.test(weddingId)||!text(eventId,255)||!text(eventType,100))return reply.code(400).send({error:'Evento inválido.'});
  const tenant=await pool.query('SELECT id FROM weddings WHERE id=$1',[weddingId]);
  if(!tenant.rowCount)return reply.code(404).send({error:'Casamento não encontrado.'});
  const db=await pool.connect();
  try{
    await db.query('BEGIN');await db.query("SELECT set_config('app.wedding_id',$1,true)",[weddingId]);
    const integration=await db.query('SELECT webhook_token_hash FROM payment_integrations WHERE wedding_id=$1',[weddingId]);
    if(!integration.rowCount||!secureTokenMatches(req.headers['asaas-access-token'],integration.rows[0].webhook_token_hash)){await db.query('ROLLBACK');return reply.code(401).send({error:'Token de webhook inválido.'});}
    const received=await db.query('INSERT INTO asaas_webhook_events(wedding_id,event_id,event_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',[weddingId,eventId,eventType]);
    if(!received.rowCount){await db.query('COMMIT');return {ok:true,duplicate:true};}
    const settleGift=async payment=>{
      const gift=await db.query('SELECT is_gifted FROM gifts WHERE id=$1 FOR UPDATE',[payment.gift_id]);
      if(gift.rows[0]?.is_gifted){await db.query("UPDATE gift_payments SET status='PAID_DUPLICATE',updated_at=now() WHERE id=$1",[payment.id]);return}
      await db.query("UPDATE gift_payments SET status='PAID',updated_at=now() WHERE id=$1",[payment.id]);
      await db.query('UPDATE gifts SET is_gifted=true,gifted_by=$2 WHERE id=$1',[payment.gift_id,payment.sender_name]);
      if(payment.dedication.trim())await db.query('INSERT INTO memories(gift_id,sender_name,whatsapp,gift_title,gift_amount,message,wedding_id) SELECT $1,$2,$3,g.title,g.price,$4,$5 FROM gifts g WHERE g.id=$1 ON CONFLICT DO NOTHING',[payment.gift_id,payment.sender_name,payment.whatsapp,payment.dedication,weddingId]);
    };
    if(['CHECKOUT_PAID','CHECKOUT_CANCELED','CHECKOUT_EXPIRED'].includes(eventType)&&text(checkout?.id,80)){
      const paymentResult=await db.query("SELECT id,gift_id,sender_name,dedication,status FROM gift_payments WHERE wedding_id=$1 AND checkout_id=$2 FOR UPDATE",[weddingId,checkout.id]);
      if(paymentResult.rowCount){
        const payment=paymentResult.rows[0];
        if(eventType==='CHECKOUT_PAID'&&!['PAID','PAID_DUPLICATE','REFUND_PENDING','PARTIAL_REFUND','REFUNDED','CHARGEBACK'].includes(payment.status)){
          const fullPayment=await db.query('SELECT id,gift_id,sender_name,whatsapp,dedication FROM gift_payments WHERE id=$1',[payment.id]);
          await settleGift(fullPayment.rows[0]);
        }else if(eventType==='CHECKOUT_CANCELED')await db.query("UPDATE gift_payments SET status='CANCELED',updated_at=now() WHERE id=$1 AND status IN ('CREATING','PENDING')",[payment.id]);
        else if(eventType==='CHECKOUT_EXPIRED')await db.query("UPDATE gift_payments SET status='EXPIRED',updated_at=now() WHERE id=$1 AND status IN ('CREATING','PENDING')",[payment.id]);
      }
    }
    const paymentId=payload.payment?.externalReference;
    if(/^[0-9a-f-]{36}$/i.test(paymentId||'')){
      const local=await db.query('SELECT id,gift_id,sender_name,whatsapp,dedication,status FROM gift_payments WHERE wedding_id=$1 AND id=$2 FOR UPDATE',[weddingId,paymentId]);
      if(local.rowCount){
        const payment=local.rows[0];
        if(eventType==='PAYMENT_RECEIVED'&&['CREATING','PENDING','EXPIRED','CANCELED'].includes(payment.status))await settleGift(payment);
        else if(eventType==='PAYMENT_RECEIVED'&&payment.status==='CHARGEBACK')await db.query("UPDATE gift_payments SET status='PAID',updated_at=now() WHERE id=$1",[payment.id]);
        const mapped={PAYMENT_REFUND_IN_PROGRESS:'REFUND_PENDING',PAYMENT_PARTIALLY_REFUNDED:'PARTIAL_REFUND',PAYMENT_REFUNDED:'REFUNDED',PAYMENT_REFUND_DENIED:'PAID',PAYMENT_CHARGEBACK_REQUESTED:'CHARGEBACK',PAYMENT_CHARGEBACK_DISPUTE:'CHARGEBACK',PAYMENT_AWAITING_CHARGEBACK_REVERSAL:'CHARGEBACK'}[eventType];
        if(mapped){
          await db.query('UPDATE gift_payments SET status=$2,updated_at=now() WHERE id=$1',[payment.id,mapped]);
          if(mapped==='REFUNDED')await db.query("UPDATE gifts SET is_gifted=false,gifted_by=NULL WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM gift_payments WHERE gift_id=$1 AND wedding_id=$2 AND id<>$3 AND status IN ('PAID','PAID_DUPLICATE','CHARGEBACK'))",[payment.gift_id,weddingId,payment.id]);
        }
      }
    }
    await db.query('COMMIT');return {ok:true};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
});
app.get('/api/admin/data', { preHandler: requireAdmin }, async (req) => {
  const [memories, guests, suppliers, gifts, settings] = await Promise.all([req.db.query('SELECT * FROM memories ORDER BY created_at DESC'), req.db.query('SELECT * FROM guests ORDER BY created_at DESC'), req.db.query('SELECT * FROM suppliers ORDER BY name'),req.db.query('SELECT * FROM gifts ORDER BY category,title'),req.db.query("SELECT key,value FROM site_settings WHERE key IN ('venue_ceremony','venue_reception','story_content','event_schedule','design_theme') ORDER BY key")]);
  const values=Object.fromEntries(settings.rows.map(r=>[r.key,r.value]));
  return { wedding:{slug:req.weddingSlug,title:req.weddingTitle}, memories: memories.rows.map(r => ({ ...memoryOut(r), whatsapp:r.whatsapp, isVisible:r.is_visible })), guests: guests.rows.map(r => ({ ...guestOut(r), whatsapp:r.whatsapp, isVisible:r.is_visible })), suppliers: suppliers.rows.map(r => ({ id:r.id,name:r.name,role:r.role,contact:r.contact,cost:Number(r.cost),paidAmount:Number(r.paid_amount),status:r.status,isVisible:r.is_visible })), gifts:gifts.rows.map(giftOut), venues: ['venue_ceremony','venue_reception'].map(k=>values[k]).filter(Boolean), story:values.story_content||null, event:values.event_schedule||null, design:values.design_theme||null };
});
app.patch('/api/admin/slug', { preHandler: requireAdmin }, async (req, reply) => {
  const { slug } = req.body || {};
  if (typeof slug !== 'string' || slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return reply.code(400).send({ error: 'Use um slug com letras minúsculas, números e hífens, sem espaços.' });
  try {
    const result = await req.db.query('UPDATE weddings SET slug=$1 WHERE id=$2 RETURNING slug', [slug, req.weddingId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'Casamento não encontrado.' });
    return { ok:true, slug:result.rows[0].slug, url:`/casamento/${result.rows[0].slug}` };
  } catch (error) {
    if (error.code === '23505') return reply.code(409).send({ error: 'Este endereço já está sendo usado por outro casamento. Escolha outro slug.' });
    throw error;
  }
});
const themePresets = new Set(['dourado-classico','azul-mar-profundo','verde-esperanca','vermelho-apaixonado','lavanda-serena','personalizado']);
const themeFonts = { heading:new Set(['Cinzel','Playfair Display','Cormorant Garamond','Georgia']), body:new Set(['Montserrat','Lora','Arial','Georgia']) };
const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
function validHeroImage(value) {
  return typeof value === 'string' && (/^\/images\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(value)||/^\/media\/weddings\/[a-f0-9-]{36}\/hero\/[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(value));
}
app.patch('/api/admin/design', { preHandler: requireAdmin }, async (req,reply)=>{
  const {preset,colors,fonts,heroImage,heroImageKey=''}=req.body||{};
  if(!themePresets.has(preset)||!colors||!['background','panel','text','accent','button','buttonHover','buttonText'].every(key=>validColor(colors[key]))||!fonts||!themeFonts.heading.has(fonts.heading)||!themeFonts.body.has(fonts.body)||!validHeroImage(heroImage)||typeof heroImageKey!=='string'||(heroImageKey&&!/^weddings\/[a-f0-9-]{36}\/hero\/[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(heroImageKey)))return reply.code(400).send({error:'Confira as cores, fontes e imagem de capa informadas.'});
  const design={preset,colors:Object.fromEntries(['background','panel','text','accent','button','buttonHover','buttonText'].map(key=>[key,colors[key].toLowerCase()])),fonts,heroImage,heroImageKey};
  await req.db.query("INSERT INTO site_settings(wedding_id,key,value) VALUES($1,'design_theme',$2::jsonb) ON CONFLICT(wedding_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[req.weddingId,JSON.stringify(design)]);
  return {ok:true,design};
});
app.post('/api/admin/design/hero', { preHandler: requireAdmin, bodyLimit: 5 * 1024 * 1024 + 64 * 1024 }, async(req,reply)=>{
  let imageBuffer;
  for await(const part of req.parts())if(part.type==='file'&&part.fieldname==='image')imageBuffer=await part.toBuffer();
  const format=imageBuffer&&imageFormat(imageBuffer);
  if(!format)return reply.code(400).send({error:'Envie uma imagem JPG, PNG ou WebP válida.'});
  if(!isStorageConfigured())return reply.code(503).send({error:'Armazenamento de imagens não configurado.'});
  const id=randomUUID(),key=`weddings/${req.weddingId}/hero/${id}.${format.ext}`;
  await putImage(key,imageBuffer,format.type);
  const current=await req.db.query("SELECT value FROM site_settings WHERE key='design_theme'");
  const design=current.rows[0]?.value||{};
  design.heroImage=`/media/${key}`;design.heroImageKey=key;
  await req.db.query("INSERT INTO site_settings(wedding_id,key,value) VALUES($1,'design_theme',$2::jsonb) ON CONFLICT(wedding_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[req.weddingId,JSON.stringify(design)]);
  return {ok:true,design};
});
app.patch('/api/admin/event-schedule', { preHandler: requireAdmin }, async (req,reply)=>{
  const {eventDate,eventTime,rsvpDeadline}=req.body||{};
  if(!isoDate(eventDate)||!isoDate(rsvpDeadline)||typeof eventTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(eventTime))return reply.code(400).send({error:'Informe uma data válida para o evento, horário e prazo do RSVP.'});
  const event={eventDate,eventTime,rsvpDeadline};
  await req.db.query("UPDATE site_settings SET value=$1::jsonb,updated_at=now() WHERE key='event_schedule'",[JSON.stringify(event)]);
  return {ok:true,event};
});
app.post('/api/admin/gifts', { preHandler: requireAdmin, bodyLimit: 5 * 1024 * 1024 + 64 * 1024 }, async (req,reply)=>{
  const fields={};let imageBuffer;
  for await(const part of req.parts()){
    if(part.type==='file'){if(part.fieldname==='image')imageBuffer=await part.toBuffer();else await part.toBuffer()}
    else fields[part.fieldname]=part.value;
  }
  const {title,category,description,price}=fields,format=imageBuffer&&imageFormat(imageBuffer);
  if(!text(title,180)||!text(category,80)||!text(description,1000)||!money(Number(price))||!format)return reply.code(400).send({error:'Informe nome, categoria, descrição, valor e uma foto JPG, PNG ou WebP válida.'});
  if(!isStorageConfigured())return reply.code(503).send({error:'Armazenamento de imagens não configurado.'});
  const id=randomUUID(),key=`weddings/${req.weddingId}/gifts/${id}.${format.ext}`;await putImage(key,imageBuffer,format.type);
  try{await req.db.query('INSERT INTO gifts(id,title,category,price,description,image_url,image_key,wedding_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,title.trim(),category.trim(),Number(price),description.trim(),`/media/${key}`,key,req.weddingId])}
  catch(error){await deleteImage(key).catch(()=>{});throw error}
  return reply.code(201).send({id,imageUrl:`/media/${key}`});
});
app.patch('/api/admin/gifts/:giftId', { preHandler: requireAdmin }, async (req,reply)=>{
  const {title,category,description,price}=req.body||{},entries=[];
  if(title!==undefined){if(!text(title,180))return reply.code(400).send({error:'Nome inválido.'});entries.push(['title',title.trim()])}
  if(category!==undefined){if(!text(category,80))return reply.code(400).send({error:'Categoria inválida.'});entries.push(['category',category.trim()])}
  if(description!==undefined){if(!text(description,1000))return reply.code(400).send({error:'Descrição inválida.'});entries.push(['description',description.trim()])}
  if(price!==undefined){if(!money(price))return reply.code(400).send({error:'Valor inválido.'});entries.push(['price',Number(price)])}
  if(!entries.length)return reply.code(400).send({error:'Informe ao menos um campo para atualizar.'});
  const locked=await req.db.query('SELECT id FROM gifts WHERE id=$1 FOR UPDATE',[req.params.giftId]);if(!locked.rowCount)return reply.code(404).send({error:'Presente não encontrado.'});
  if(entries.some(([key])=>['title','price'].includes(key))){const pending=await req.db.query("SELECT 1 FROM gift_payments WHERE wedding_id=$1 AND gift_id=$2 AND status IN ('CREATING','PENDING') LIMIT 1",[req.weddingId,req.params.giftId]);if(pending.rowCount)return reply.code(409).send({error:'Nome e valor não podem mudar enquanto há um checkout em andamento para este presente.'})}
  const setters=entries.map(([key],i)=>`${key}=$${i+1}`),result=await req.db.query(`UPDATE gifts SET ${setters.join(',')} WHERE id=$${entries.length+1} RETURNING id`,[...entries.map(([,value])=>value),req.params.giftId]);
  return result.rowCount?{ok:true}:reply.code(404).send({error:'Presente não encontrado.'});
});
app.delete('/api/admin/gifts/:giftId', { preHandler: requireAdmin }, async (req,reply)=>{
  const db=req.db;let imageKey;
  try{
    const gift=await db.query('SELECT image_key,is_gifted,(SELECT count(*)::int FROM gift_payments p WHERE p.wedding_id=$2 AND p.gift_id=gifts.id) AS payment_count FROM gifts WHERE id=$1 FOR UPDATE',[req.params.giftId,req.weddingId]);
    if(!gift.rowCount)return reply.code(404).send({error:'Presente não encontrado.'})
    if(gift.rows[0].is_gifted)return reply.code(409).send({error:'Este presente já foi confirmado e não pode ser removido da lista.'})
    if(gift.rows[0].payment_count)return reply.code(409).send({error:'Este presente tem histórico de checkout e não pode ser removido. Mantenha-o na lista para preservar a auditoria dos pagamentos.'})
    imageKey=gift.rows[0].image_key;await db.query('DELETE FROM gifts WHERE id=$1',[req.params.giftId]);
  }catch(error){throw error}
  if(imageKey)await deleteImage(imageKey).catch(error=>req.log.warn({err:error},'A imagem do presente permaneceu no armazenamento.'));
  return {ok:true};
});
app.post('/api/admin/gifts/:giftId/image', { preHandler: requireAdmin, bodyLimit: 5 * 1024 * 1024 + 64 * 1024 }, async (req,reply)=>{
  if(!isStorageConfigured())return reply.code(503).send({error:'Armazenamento de imagens não configurado.'});
  const part=await req.file();if(!part)return reply.code(400).send({error:'Selecione uma imagem JPG, PNG ou WebP.'});
  const buffer=await part.toBuffer(),format=imageFormat(buffer);if(!format)return reply.code(400).send({error:'O arquivo não parece ser uma imagem JPG, PNG ou WebP válida.'});
  const current=await req.db.query('SELECT image_key FROM gifts WHERE id=$1',[req.params.giftId]);if(!current.rowCount)return reply.code(404).send({error:'Presente não encontrado.'});
  const key=`weddings/${req.weddingId}/gifts/${randomUUID()}.${format.ext}`;await putImage(key,buffer,format.type);
  try{await req.db.query('UPDATE gifts SET image_key=$2,image_url=$3 WHERE id=$1',[req.params.giftId,key,`/media/${key}`])}catch(error){await deleteImage(key).catch(()=>{});throw error}
  if(current.rows[0].image_key)await deleteImage(current.rows[0].image_key).catch(error=>req.log.warn({err:error},'A imagem anterior do presente permaneceu no armazenamento.'));
  return {ok:true,imageUrl:`/media/${key}`};
});
app.patch('/api/admin/story', { preHandler: requireAdmin }, async (req,reply)=>{
  const b=req.body||{};
  const validFacts=Array.isArray(b.facts)&&b.facts.length>=1&&b.facts.length<=12&&b.facts.every(v=>text(v,120));
  if(!text(b.eyebrow,100)||!text(b.title,100)||!text(b.body,3000)||!validFacts||!text(b.question,180)||!text(b.answer,180))return reply.code(400).send({error:'Confira os textos e informe de 1 a 12 fatos, um por linha.'});
  const story={eyebrow:b.eyebrow.trim(),title:b.title.trim(),body:b.body.trim(),facts:b.facts.map(v=>v.trim()),question:b.question.trim(),answer:b.answer.trim()};
  await req.db.query("UPDATE site_settings SET value=$1::jsonb,updated_at=now() WHERE key='story_content'",[JSON.stringify(story)]);
  return {ok:true,story};
});
app.patch('/api/admin/venues/:venueId', { preHandler: requireAdmin }, async (req,reply)=>{
  const id=req.params.venueId, b=req.body||{};
  if(!['ceremony','reception'].includes(id)) return reply.code(404).send({error:'Local não encontrado.'});
  const spec={title:['title',v=>text(v,100)],eyebrow:['eyebrow',v=>text(v,100)],name:['name',v=>text(v,160)],address:['address',v=>text(v,240)],mapsUrl:['maps_url',v=>{if(typeof v!=='string'||v.length>500)return false;try{const u=new URL(v);return u.protocol==='https:'&&(['google.com','www.google.com','maps.google.com','maps.app.goo.gl'].includes(u.hostname))}catch{return false}}],imageAlt:['image_alt',v=>text(v,180)]};
  const entries=Object.entries(b).filter(([k])=>spec[k]);
  if(!entries.length||entries.some(([k,v])=>!spec[k][1](v))) return reply.code(400).send({error:'Confira título, nome, endereço e link HTTPS do Google Maps.'});
  const current=await req.db.query('SELECT value FROM site_settings WHERE key=$1',[`venue_${id}`]);
  if(!current.rowCount)return reply.code(404).send({error:'Local não encontrado.'});
  const venue={...current.rows[0].value};for(const [key,value] of entries)venue[key]=value.trim();
  await req.db.query('UPDATE site_settings SET value=$2::jsonb,updated_at=now() WHERE key=$1',[`venue_${id}`,JSON.stringify(venue)]);
  return {ok:true,venue};
});
app.post('/api/admin/venues/:venueId/image', { preHandler: requireAdmin, bodyLimit: 5 * 1024 * 1024 + 64 * 1024 }, async (req,reply)=>{
  const id=req.params.venueId;
  if(!['ceremony','reception'].includes(id))return reply.code(404).send({error:'Local não encontrado.'});
  if(!isStorageConfigured())return reply.code(503).send({error:'Armazenamento de imagens não configurado.'});
  const part=await req.file();if(!part)return reply.code(400).send({error:'Selecione uma imagem JPG, PNG ou WebP.'});
  const buffer=await part.toBuffer();let ext,type;
  if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff){ext='jpg';type='image/jpeg'}
  else if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){ext='png';type='image/png'}
  else if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP'){ext='webp';type='image/webp'}
  else return reply.code(400).send({error:'O arquivo não parece ser uma imagem JPG, PNG ou WebP válida.'});
  const current=await req.db.query('SELECT value FROM site_settings WHERE key=$1',[`venue_${id}`]);
  if(!current.rowCount)return reply.code(404).send({error:'Local não encontrado.'});
  const key=`weddings/${req.weddingId}/venues/${id}/${randomUUID()}.${ext}`;
  await putImage(key,buffer,type);
  const previous=current.rows[0].value.imageKey;
  try{await req.db.query("UPDATE site_settings SET value=value||jsonb_build_object('imageKey',$2::text,'imageUrl',$3::text),updated_at=now() WHERE key=$1",[`venue_${id}`,key,`/media/${key}`])}
  catch(error){await deleteImage(key).catch(()=>{});throw error}
  if(previous&&/^(?:venues\/(ceremony|reception)|weddings\/[a-f0-9-]{36}\/venues\/(ceremony|reception))\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test(previous))await deleteImage(previous).catch(error=>req.log.warn({err:error},'Imagem anterior permaneceu no armazenamento.'));
  return {ok:true,imageUrl:`/media/${key}`};
});
app.patch('/api/admin/:kind/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const { kind, id } = req.params, b = req.body || {};
  if (!['memories','guests','suppliers'].includes(kind)) return reply.code(404).send({ error:'Registro não encontrado.' });
  const specs = {
    memories: { table:'memories', fields:{ senderName:['sender_name', v=>text(v,120)], message:['message', v=>typeof v==='string'&&v.length<=1000], isVisible:['is_visible',v=>typeof v==='boolean'] } },
    guests: { table:'guests', fields:{ name:['name',v=>text(v,120)], companions:['companions',v=>Number.isInteger(v)&&v>=0&&v<=4], isVisible:['is_visible',v=>typeof v==='boolean'] } },
    suppliers: { table:'suppliers', fields:{ name:['name',v=>text(v,120)], role:['role',v=>text(v,180)], contact:['contact',v=>typeof v==='string'&&v.length<=80], cost:['cost',money], paidAmount:['paid_amount',money], status:['status',v=>['Contratado','Em Negociação','Quitado'].includes(v)], isVisible:['is_visible',v=>typeof v==='boolean'] } }
  };
  const spec=specs[kind]; const entries=Object.entries(b).filter(([key])=>spec.fields[key]);
  if (!entries.length || entries.some(([key,value])=>!spec.fields[key][1](value))) return reply.code(400).send({ error:'Dados inválidos.' });
  const setters=entries.map(([key],i)=>`${spec.fields[key][0]}=$${i+1}`);
  const result=await req.db.query(`UPDATE ${spec.table} SET ${setters.join(',')} WHERE id=$${entries.length+1} RETURNING id`, [...entries.map(([key,value])=>value),id]);
  return result.rowCount ? {ok:true} : reply.code(404).send({error:'Registro não encontrado.'});
});
app.delete('/api/admin/:kind/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const tables={memories:'memories',guests:'guests',suppliers:'suppliers'}; const table=tables[req.params.kind];
  if(!table) return reply.code(404).send({error:'Registro não encontrado.'});
  if(req.params.kind==='guests'){const payments=await req.db.query('SELECT 1 FROM gift_payments WHERE wedding_id=$1 AND guest_id=$2 LIMIT 1',[req.weddingId,req.params.id]);if(payments.rowCount)return reply.code(409).send({error:'Este convidado possui histórico de pagamento e não pode ser removido.'})}
  const result=await req.db.query(`DELETE FROM ${table} WHERE id=$1`,[req.params.id]);
  return result.rowCount ? {ok:true} : reply.code(404).send({error:'Registro não encontrado.'});
});
app.post('/api/admin/suppliers', { preHandler: requireAdmin }, async (req,reply)=>{
  const {name,role,cost=0,contact=''}=req.body||{};
  if(!text(name,120)||!text(role,180)||!money(cost)||typeof contact!=='string'||contact.length>80) return reply.code(400).send({error:'Dados inválidos.'});
  const result=await req.db.query("INSERT INTO suppliers(name,role,cost,contact,wedding_id) VALUES($1,$2,$3,$4,$5) RETURNING id",[name.trim(),role.trim(),cost,contact.trim(),req.weddingId]);
  return reply.code(201).send({id:result.rows[0].id});
});
app.get('/api/events', async (req, reply) => {
  const slug=req.query?.wedding;
  if(!slug)return reply.code(400).send({error:'URL incompleta: informe o slug do casamento.'});
  const result=await pool.query('SELECT id FROM weddings WHERE slug=$1',[slug]);
  if(!result.rowCount)return reply.code(404).send({error:'Casamento não encontrado.'});
  const weddingId=result.rows[0].id;
  reply.hijack();
  const res=reply.raw; res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'}); res.write('event: ready\ndata: {}\n\n');
  const send=msg=>{let payload;try{payload=JSON.parse(msg.payload)}catch{return}if(payload.weddingId===weddingId&&!res.destroyed)res.write(`event: update\ndata: ${JSON.stringify({at:Date.now()})}\n\n`)};
  const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keep-alive\n\n');},25_000); live.on('notification',send);
  res.on('close',()=>{clearInterval(heartbeat);live.off('notification',send);});
});
app.setNotFoundHandler((req,reply)=> req.url.startsWith('/api/') ? reply.code(404).send({error:'Rota não encontrada.'}) : reply.sendFile('index.html'));
app.setErrorHandler((error,req,reply)=>{ req.log.error(error); const code=error.statusCode||(['23514','22P02'].includes(error.code)?400:500); reply.code(code).send({error:code<500?(error.statusCode?error.message:'Dados inválidos.'):'Erro interno.'}); });

async function start() {
  if (!process.env.DATABASE_URL || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 14 || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('Configure DATABASE_URL, ADMIN_PASSWORD (mínimo de 14 caracteres) e SESSION_SECRET (mínimo de 32 caracteres).');
  if (process.env.APP_URL) { const appUrl = new URL(process.env.APP_URL); if (!['http:', 'https:'].includes(appUrl.protocol)) throw new Error('APP_URL deve usar http ou https.'); }
  await seed(); if(isStorageConfigured())await ensureBucket(); await live.connect(); await live.query('LISTEN wedding_changes');
  await app.listen({host:process.env.HOST||'127.0.0.1',port:Number(process.env.PORT)||3000});
}
let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;await app.close().catch(()=>{});await live.end().catch(()=>{});await pool.end().catch(()=>{});await closeStorage().catch(()=>{});}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await shutdown();process.exit(0);});
start().catch(async error=>{app.log.error(error);await shutdown();process.exit(1);});
