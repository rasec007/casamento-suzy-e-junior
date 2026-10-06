CREATE TABLE IF NOT EXISTS gifts (
  id text PRIMARY KEY, title text NOT NULL, category text NOT NULL,
  price numeric(10,2) NOT NULL CHECK (price >= 0), description text NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_name varchar(120) NOT NULL,
  whatsapp varchar(24) NOT NULL, gift_title varchar(180) NOT NULL,
  gift_amount numeric(10,2) NOT NULL CHECK (gift_amount >= 0), message varchar(1000) NOT NULL DEFAULT '',
  is_visible boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(120) NOT NULL,
  whatsapp varchar(24) NOT NULL, companions smallint NOT NULL DEFAULT 0 CHECK (companions BETWEEN 0 AND 4),
  is_visible boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS suppliers (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, name varchar(120) NOT NULL,
  role varchar(180) NOT NULL, contact varchar(80) NOT NULL DEFAULT '',
  cost numeric(10,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  paid_amount numeric(10,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0 AND paid_amount <= cost),
  status varchar(30) NOT NULL DEFAULT 'Em Negociação' CHECK (status IN ('Contratado','Em Negociação','Quitado')),
  is_visible boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS guests_visible_created_idx ON guests (created_at DESC) WHERE is_visible;
CREATE INDEX IF NOT EXISTS memories_visible_created_idx ON memories (created_at DESC) WHERE is_visible;
CREATE OR REPLACE FUNCTION notify_wedding_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_notify('wedding_changes', json_build_object('table', TG_TABLE_NAME, 'operation', TG_OP)::text); RETURN NULL; END $$;
DROP TRIGGER IF EXISTS guests_notify ON guests;
CREATE TRIGGER guests_notify AFTER INSERT OR UPDATE OR DELETE ON guests FOR EACH ROW EXECUTE FUNCTION notify_wedding_change();
DROP TRIGGER IF EXISTS memories_notify ON memories;
CREATE TRIGGER memories_notify AFTER INSERT OR UPDATE OR DELETE ON memories FOR EACH ROW EXECUTE FUNCTION notify_wedding_change();
DROP TRIGGER IF EXISTS suppliers_notify ON suppliers;
CREATE TRIGGER suppliers_notify AFTER INSERT OR UPDATE OR DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION notify_wedding_change();
