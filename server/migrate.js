import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
const client = await pool.connect();
try { await client.query('BEGIN'); await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); await client.query('COMMIT'); console.log('Banco atualizado.'); }
catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
finally { client.release(); await pool.end(); }
