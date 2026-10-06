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
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { INITIAL_GIFTS, INITIAL_MEMORIES, INITIAL_GUESTS, INITIAL_SUPPLIERS } from './seed-data.js';
import { sendRsvpConfirmation } from './evolution.js';
import { isStorageConfigured, ensureBucket, putImage, getImage, deleteImage, closeStorage } from './storage.js';

const root = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: { redact: ['req.headers.cookie', 'req.headers.authorization'] }, trustProxy: process.env.TRUST_PROXY === 'true', bodyLimit: 16_384, requestTimeout: 15_000 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, application_name: 'suzy-junior-wedding' });
const live = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'suzy-junior-realtime' });

await app.register(cookie, { secret: process.env.SESSION_SECRET || 'development-only-secret-change-this-now' });
await app.register(helmet, { global: true, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], scriptSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: null } } });
await app.register(rateLimit, { global: true, max: 180, timeWindow: '1 minute' });
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 8, parts: 10 } });
await app.register(fastifyStatic, { root: join(root, '../public'), prefix: '/', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, immutable: false, wildcard: false });

async function requireAdmin(request, reply) {
  reply.header('cache-control', 'no-store');
  const session = request.unsignCookie(request.cookies.admin_session || '');
  if (!session.valid || session.value !== 'admin') return reply.code(401).send({ error: 'Acesso administrativo necessário.' });
}
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
const text = (value, max = 120) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const phone = value => typeof value === 'string' && /^[+()\d .-]{8,24}$/.test(value);
const money = value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 10000000;
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
  await pool.query(await readFile(join(root, 'schema.sql'), 'utf8'));
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('suzy-junior-wedding-seed'))");
    const existing = await db.query('SELECT count(*)::int AS count FROM gifts');
    if (existing.rows[0].count) { await db.query('COMMIT'); return; }
    for (const g of INITIAL_GIFTS) await db.query('INSERT INTO gifts(id,title,category,price,description) VALUES($1,$2,$3,$4,$5)', [g.id,g.title,g.category,g.price,g.description]);
    for (const m of INITIAL_MEMORIES) await db.query('INSERT INTO memories(sender_name,whatsapp,gift_title,gift_amount,message,is_visible,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [m.senderName,m.whatsapp,m.giftTitle,m.giftAmount,m.message,m.isVisible,seedDate(m.createdAt)]);
    for (const g of INITIAL_GUESTS) await db.query('INSERT INTO guests(name,whatsapp,companions,is_visible,created_at) VALUES($1,$2,$3,$4,$5)', [g.name,g.whatsapp,g.companions,g.isVisible,seedDate(g.confirmedAt)]);
    for (const s of INITIAL_SUPPLIERS) await db.query('INSERT INTO suppliers(id,name,role,contact,cost,paid_amount,status,is_visible) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [s.id,s.name,s.role,s.contact,s.cost,s.paidAmount,s.status,s.isVisible]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

app.get('/api/health', async (_req, reply) => {
  try { await pool.query('SELECT 1'); return { status: 'ok', database: 'connected' }; }
  catch { return reply.code(503).send({ status: 'unavailable' }); }
});
app.get('/api/site', async () => {
  const [gifts, memories, guests, venues] = await Promise.all([
    pool.query('SELECT * FROM gifts ORDER BY id'),
    pool.query(`SELECT ${publicMemoryFields} FROM memories WHERE is_visible ORDER BY created_at DESC LIMIT 100`),
    pool.query(`SELECT ${publicGuestFields} FROM guests WHERE is_visible ORDER BY created_at DESC LIMIT 250`),
    pool.query("SELECT key,value FROM site_settings WHERE key IN ('venue_ceremony','venue_reception','story_content','event_schedule') ORDER BY key")
  ]);
  const settings=Object.fromEntries(venues.rows.map(r=>[r.key,r.value]));
  return { gifts: gifts.rows.map(giftOut), memories: memories.rows.map(memoryOut), guests: guests.rows.map(guestOut), venues: ['venue_ceremony','venue_reception'].map(k=>settings[k]).filter(Boolean), story:settings.story_content||null, event:settings.event_schedule||null };
});
app.get('/media/*', async (req, reply) => {
  const key=req.params['*'];
  if(!/^(?:venues\/(?:ceremony|reception)|gifts)\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test(key)) return reply.code(404).send({error:'Imagem não encontrada.'});
  try {
    const image=await getImage(key);
    reply.header('content-type',image.ContentType||'application/octet-stream').header('cache-control',image.CacheControl||'public, max-age=31536000, immutable').header('x-content-type-options','nosniff');
    return reply.send(image.Body);
  } catch(error) { if(error.name==='NoSuchKey'||error.$metadata?.httpStatusCode===404)return reply.code(404).send({error:'Imagem não encontrada.'});throw error; }
});
app.post('/api/rsvp', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const { name, whatsapp, companions = 0 } = req.body || {};
  if (!text(name, 120) || !phone(whatsapp) || !Number.isInteger(companions) || companions < 0 || companions > 4) return reply.code(400).send({ error: 'Confira nome, WhatsApp e quantidade de acompanhantes.' });
  const schedule=await pool.query("SELECT value->>'rsvpDeadline' AS deadline FROM site_settings WHERE key='event_schedule'");
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Fortaleza',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(schedule.rows[0]?.deadline&&today>schedule.rows[0].deadline)return reply.code(409).send({error:'O prazo para confirmar presença foi encerrado.'});
  const result = await pool.query('INSERT INTO guests(name,whatsapp,companions) VALUES($1,$2,$3) RETURNING id,name,companions,created_at', [name.trim(),whatsapp.trim(),companions]);
  let notificationSent = false;
  try { notificationSent = await sendRsvpConfirmation({ name: name.trim(), whatsapp: whatsapp.trim(), companions }); }
  catch (error) { req.log.warn({ err: error }, 'RSVP salvo; não foi possível enviar a confirmação por WhatsApp.'); }
  return reply.code(201).send({ guest: guestOut(result.rows[0]), notificationSent });
});
app.post('/api/memories', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const { senderName, whatsapp, message = '', giftId } = req.body || {};
  if (!text(senderName, 120) || !phone(whatsapp) || typeof message !== 'string' || message.length > 1000 || !text(giftId, 40)) return reply.code(400).send({ error: 'Confira seus dados e a mensagem (até 1.000 caracteres).' });
  const db=await pool.connect();let result;
  try{
    await db.query('BEGIN');
    const gift=await db.query('SELECT id,title,price,is_gifted FROM gifts WHERE id=$1 FOR UPDATE',[giftId]);
    if(!gift.rowCount){await db.query('ROLLBACK');return reply.code(404).send({error:'Presente não encontrado.'})}
    if(gift.rows[0].is_gifted){await db.query('ROLLBACK');return reply.code(409).send({error:'Este presente já foi confirmado por outra pessoa. Escolha outro item.'})}
    await db.query('UPDATE gifts SET is_gifted=true,gifted_by=$2 WHERE id=$1',[giftId,senderName.trim()]);
    if(message.trim()){
      const confirmed=await db.query('SELECT 1 FROM guests WHERE lower(name)=lower($1) LIMIT 1',[senderName.trim()]);
      if(!confirmed.rowCount){await db.query('ROLLBACK');return reply.code(400).send({error:'Confirme a presença antes de enviar uma dedicatória. A dedicatória é opcional.'})}
      result=await db.query('INSERT INTO memories(gift_id,sender_name,whatsapp,gift_title,gift_amount,message) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,sender_name,gift_title,gift_amount,message,created_at',[giftId,senderName.trim(),whatsapp.trim(),gift.rows[0].title,gift.rows[0].price,message.trim()]);
    }
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{db.release()}
  return reply.code(201).send({ memory:result?memoryOut(result.rows[0]):null });
});
app.post('/api/admin/memories', { preHandler: requireAdmin }, async (req,reply)=>{
  const {senderName,message='',writtenAt}=req.body||{};
  if(!text(senderName,120)||typeof message!=='string'||message.length>1000||!isoDate(writtenAt))return reply.code(400).send({error:'Confira o convidado, a frase (até 1.000 caracteres) e a data.'});
  const guest=await pool.query('SELECT id FROM guests WHERE lower(name)=lower($1) LIMIT 1',[senderName.trim()]);
  if(!guest.rowCount)return reply.code(400).send({error:'A dedicatória só pode ser associada a alguém com presença confirmada.'});
  const createdAt=new Date(`${writtenAt}T12:00:00-03:00`);
  const result=await pool.query("INSERT INTO memories(sender_name,whatsapp,gift_title,gift_amount,message,created_at) VALUES($1,'','Dedicatória',0,$2,$3) RETURNING id,sender_name,gift_title,gift_amount,message,created_at",[senderName.trim(),message.trim(),createdAt]);
  return reply.code(201).send({memory:memoryOut(result.rows[0])});
});
app.post('/api/admin/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const expected = process.env.ADMIN_PASSWORD;
  const supplied = req.body?.password;
  const expectedHash = createHash('sha256').update(expected || '').digest();
  const suppliedHash = createHash('sha256').update(typeof supplied === 'string' && supplied.length <= 200 ? supplied : '').digest();
  if (!expected || !timingSafeEqual(expectedHash, suppliedHash)) return reply.code(401).send({ error: 'Senha inválida.' });
  reply.setCookie('admin_session', 'admin', { signed: true, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 60 * 60 * 8 });
  return { ok: true };
});
app.post('/api/admin/logout', { preHandler: requireAdmin }, async (_req, reply) => { reply.clearCookie('admin_session', { path: '/' }); return { ok: true }; });
app.get('/api/admin/data', { preHandler: requireAdmin }, async () => {
  const [memories, guests, suppliers, gifts, settings] = await Promise.all([pool.query('SELECT * FROM memories ORDER BY created_at DESC'), pool.query('SELECT * FROM guests ORDER BY created_at DESC'), pool.query('SELECT * FROM suppliers ORDER BY name'),pool.query('SELECT * FROM gifts ORDER BY category,title'),pool.query("SELECT key,value FROM site_settings WHERE key IN ('venue_ceremony','venue_reception','story_content','event_schedule') ORDER BY key")]);
  const values=Object.fromEntries(settings.rows.map(r=>[r.key,r.value]));
  return { memories: memories.rows.map(r => ({ ...memoryOut(r), whatsapp:r.whatsapp, isVisible:r.is_visible })), guests: guests.rows.map(r => ({ ...guestOut(r), whatsapp:r.whatsapp, isVisible:r.is_visible })), suppliers: suppliers.rows.map(r => ({ id:r.id,name:r.name,role:r.role,contact:r.contact,cost:Number(r.cost),paidAmount:Number(r.paid_amount),status:r.status,isVisible:r.is_visible })), gifts:gifts.rows.map(giftOut), venues: ['venue_ceremony','venue_reception'].map(k=>values[k]).filter(Boolean), story:values.story_content||null, event:values.event_schedule||null };
});
app.patch('/api/admin/event-schedule', { preHandler: requireAdmin }, async (req,reply)=>{
  const {eventDate,eventTime,rsvpDeadline}=req.body||{};
  if(!isoDate(eventDate)||!isoDate(rsvpDeadline)||typeof eventTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(eventTime))return reply.code(400).send({error:'Informe uma data válida para o evento, horário e prazo do RSVP.'});
  const event={eventDate,eventTime,rsvpDeadline};
  await pool.query("UPDATE site_settings SET value=$1::jsonb,updated_at=now() WHERE key='event_schedule'",[JSON.stringify(event)]);
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
  const id=randomUUID(),key=`gifts/${id}.${format.ext}`;await putImage(key,imageBuffer,format.type);
  try{await pool.query('INSERT INTO gifts(id,title,category,price,description,image_url,image_key) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,title.trim(),category.trim(),Number(price),description.trim(),`/media/${key}`,key])}
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
  const setters=entries.map(([key],i)=>`${key}=$${i+1}`),result=await pool.query(`UPDATE gifts SET ${setters.join(',')} WHERE id=$${entries.length+1} RETURNING id`,[...entries.map(([,value])=>value),req.params.giftId]);
  return result.rowCount?{ok:true}:reply.code(404).send({error:'Presente não encontrado.'});
});
app.delete('/api/admin/gifts/:giftId', { preHandler: requireAdmin }, async (req,reply)=>{
  const db=await pool.connect();let imageKey;
  try{
    await db.query('BEGIN');const gift=await db.query('SELECT image_key,is_gifted FROM gifts WHERE id=$1 FOR UPDATE',[req.params.giftId]);
    if(!gift.rowCount){await db.query('ROLLBACK');return reply.code(404).send({error:'Presente não encontrado.'})}
    if(gift.rows[0].is_gifted){await db.query('ROLLBACK');return reply.code(409).send({error:'Este presente já foi confirmado e não pode ser removido da lista.'})}
    imageKey=gift.rows[0].image_key;await db.query('DELETE FROM gifts WHERE id=$1',[req.params.giftId]);await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{db.release()}
  if(imageKey)await deleteImage(imageKey).catch(error=>req.log.warn({err:error},'A imagem do presente permaneceu no armazenamento.'));
  return {ok:true};
});
app.post('/api/admin/gifts/:giftId/image', { preHandler: requireAdmin, bodyLimit: 5 * 1024 * 1024 + 64 * 1024 }, async (req,reply)=>{
  if(!isStorageConfigured())return reply.code(503).send({error:'Armazenamento de imagens não configurado.'});
  const part=await req.file();if(!part)return reply.code(400).send({error:'Selecione uma imagem JPG, PNG ou WebP.'});
  const buffer=await part.toBuffer(),format=imageFormat(buffer);if(!format)return reply.code(400).send({error:'O arquivo não parece ser uma imagem JPG, PNG ou WebP válida.'});
  const current=await pool.query('SELECT image_key FROM gifts WHERE id=$1',[req.params.giftId]);if(!current.rowCount)return reply.code(404).send({error:'Presente não encontrado.'});
  const key=`gifts/${randomUUID()}.${format.ext}`;await putImage(key,buffer,format.type);
  try{await pool.query('UPDATE gifts SET image_key=$2,image_url=$3 WHERE id=$1',[req.params.giftId,key,`/media/${key}`])}catch(error){await deleteImage(key).catch(()=>{});throw error}
  if(current.rows[0].image_key)await deleteImage(current.rows[0].image_key).catch(error=>req.log.warn({err:error},'A imagem anterior do presente permaneceu no armazenamento.'));
  return {ok:true,imageUrl:`/media/${key}`};
});
app.patch('/api/admin/story', { preHandler: requireAdmin }, async (req,reply)=>{
  const b=req.body||{};
  const validFacts=Array.isArray(b.facts)&&b.facts.length>=1&&b.facts.length<=12&&b.facts.every(v=>text(v,120));
  if(!text(b.eyebrow,100)||!text(b.title,100)||!text(b.body,3000)||!validFacts||!text(b.question,180)||!text(b.answer,180))return reply.code(400).send({error:'Confira os textos e informe de 1 a 12 fatos, um por linha.'});
  const story={eyebrow:b.eyebrow.trim(),title:b.title.trim(),body:b.body.trim(),facts:b.facts.map(v=>v.trim()),question:b.question.trim(),answer:b.answer.trim()};
  await pool.query("UPDATE site_settings SET value=$1::jsonb,updated_at=now() WHERE key='story_content'",[JSON.stringify(story)]);
  return {ok:true,story};
});
app.patch('/api/admin/venues/:venueId', { preHandler: requireAdmin }, async (req,reply)=>{
  const id=req.params.venueId, b=req.body||{};
  if(!['ceremony','reception'].includes(id)) return reply.code(404).send({error:'Local não encontrado.'});
  const spec={title:['title',v=>text(v,100)],eyebrow:['eyebrow',v=>text(v,100)],name:['name',v=>text(v,160)],address:['address',v=>text(v,240)],mapsUrl:['maps_url',v=>{if(typeof v!=='string'||v.length>500)return false;try{const u=new URL(v);return u.protocol==='https:'&&(['google.com','www.google.com','maps.google.com','maps.app.goo.gl'].includes(u.hostname))}catch{return false}}],imageAlt:['image_alt',v=>text(v,180)]};
  const entries=Object.entries(b).filter(([k])=>spec[k]);
  if(!entries.length||entries.some(([k,v])=>!spec[k][1](v))) return reply.code(400).send({error:'Confira título, nome, endereço e link HTTPS do Google Maps.'});
  const current=await pool.query('SELECT value FROM site_settings WHERE key=$1',[`venue_${id}`]);
  if(!current.rowCount)return reply.code(404).send({error:'Local não encontrado.'});
  const venue={...current.rows[0].value};for(const [key,value] of entries)venue[key]=value.trim();
  await pool.query('UPDATE site_settings SET value=$2::jsonb,updated_at=now() WHERE key=$1',[`venue_${id}`,JSON.stringify(venue)]);
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
  const current=await pool.query('SELECT value FROM site_settings WHERE key=$1',[`venue_${id}`]);
  if(!current.rowCount)return reply.code(404).send({error:'Local não encontrado.'});
  const key=`venues/${id}/${randomUUID()}.${ext}`;
  await putImage(key,buffer,type);
  const previous=current.rows[0].value.imageKey;
  try{await pool.query("UPDATE site_settings SET value=value||jsonb_build_object('imageKey',$2::text,'imageUrl',$3::text),updated_at=now() WHERE key=$1",[`venue_${id}`,key,`/media/${key}`])}
  catch(error){await deleteImage(key).catch(()=>{});throw error}
  if(previous&&/^venues\/(ceremony|reception)\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test(previous))await deleteImage(previous).catch(error=>req.log.warn({err:error},'Imagem anterior permaneceu no armazenamento.'));
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
  const result=await pool.query(`UPDATE ${spec.table} SET ${setters.join(',')} WHERE id=$${entries.length+1} RETURNING id`, [...entries.map(([key,value])=>value),id]);
  return result.rowCount ? {ok:true} : reply.code(404).send({error:'Registro não encontrado.'});
});
app.delete('/api/admin/:kind/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const tables={memories:'memories',guests:'guests',suppliers:'suppliers'}; const table=tables[req.params.kind];
  if(!table) return reply.code(404).send({error:'Registro não encontrado.'});
  const result=await pool.query(`DELETE FROM ${table} WHERE id=$1`,[req.params.id]);
  return result.rowCount ? {ok:true} : reply.code(404).send({error:'Registro não encontrado.'});
});
app.post('/api/admin/suppliers', { preHandler: requireAdmin }, async (req,reply)=>{
  const {name,role,cost=0,contact=''}=req.body||{};
  if(!text(name,120)||!text(role,180)||!money(cost)||typeof contact!=='string'||contact.length>80) return reply.code(400).send({error:'Dados inválidos.'});
  const result=await pool.query("INSERT INTO suppliers(name,role,cost,contact) VALUES($1,$2,$3,$4) RETURNING id",[name.trim(),role.trim(),cost,contact.trim()]);
  return reply.code(201).send({id:result.rows[0].id});
});
app.get('/api/events', async (req, reply) => {
  reply.hijack();
  const res=reply.raw; res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'}); res.write('event: ready\ndata: {}\n\n');
  const send=()=>{ if(!res.destroyed) res.write(`event: update\ndata: ${JSON.stringify({at:Date.now()})}\n\n`); };
  const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keep-alive\n\n');},25_000); live.on('notification',send);
  req.raw.on('close',()=>{clearInterval(heartbeat);live.off('notification',send);});
});
app.setNotFoundHandler((req,reply)=> req.url.startsWith('/api/') ? reply.code(404).send({error:'Rota não encontrada.'}) : reply.sendFile('index.html'));
app.setErrorHandler((error,req,reply)=>{ req.log.error(error); const code=error.statusCode||(['23514','22P02'].includes(error.code)?400:500); reply.code(code).send({error:code<500?(error.statusCode?error.message:'Dados inválidos.'):'Erro interno.'}); });

async function start() {
  if (!process.env.DATABASE_URL || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 14 || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('Configure DATABASE_URL, ADMIN_PASSWORD (mínimo de 14 caracteres) e SESSION_SECRET (mínimo de 32 caracteres).');
  if (process.env.APP_URL) { const appUrl = new URL(process.env.APP_URL); if (!['http:', 'https:'].includes(appUrl.protocol)) throw new Error('APP_URL deve usar http ou https.'); }
  await seed(); if(isStorageConfigured())await ensureBucket(); await live.connect(); await live.query('LISTEN wedding_changes');
  await app.listen({host:process.env.HOST||'127.0.0.1',port:Number(process.env.PORT)||3000});
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();await live.end().catch(()=>{});await pool.end();await closeStorage();process.exit(0);});
start().catch(async error=>{app.log.error(error);await app.close();await live.end().catch(()=>{});await pool.end();await closeStorage();process.exit(1);});
