import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
try { await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); console.log('Banco atualizado.'); }
finally { await pool.end(); }
