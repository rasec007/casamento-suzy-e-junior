CREATE TABLE IF NOT EXISTS weddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(80) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title varchar(180) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS legacy_admin_tenants (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE
);
INSERT INTO weddings(slug,title) SELECT 'suzy-e-junior','Suzy & Junior' WHERE NOT EXISTS (SELECT 1 FROM legacy_admin_tenants) AND NOT EXISTS (SELECT 1 FROM weddings WHERE slug='suzy-e-junior') ON CONFLICT(slug) DO NOTHING;
INSERT INTO legacy_admin_tenants(singleton,wedding_id) SELECT true,id FROM weddings WHERE slug='suzy-e-junior' ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS gifts (
  id text PRIMARY KEY, title text NOT NULL, category text NOT NULL,
  price numeric(10,2) NOT NULL CHECK (price >= 0), description text NOT NULL
);
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS image_url text NOT NULL DEFAULT '';
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS image_key text;
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS is_gifted boolean NOT NULL DEFAULT false;
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS gifted_by varchar(120);
CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_name varchar(120) NOT NULL,
  whatsapp varchar(24) NOT NULL, gift_title varchar(180) NOT NULL,
  gift_amount numeric(10,2) NOT NULL CHECK (gift_amount >= 0), message varchar(1000) NOT NULL DEFAULT '',
  is_visible boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS gift_id text REFERENCES gifts(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS memories_one_gift_reservation_idx ON memories(gift_id) WHERE gift_id IS NOT NULL;
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
CREATE TABLE IF NOT EXISTS site_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  username varchar(40) NOT NULL,
  email varchar(254) NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(wedding_id, username), UNIQUE(wedding_id, email)
);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS wedding_id uuid REFERENCES weddings(id) ON DELETE CASCADE;
UPDATE admin_users SET wedding_id=(SELECT id FROM weddings WHERE slug='suzy-e-junior') WHERE wedding_id IS NULL;
ALTER TABLE admin_users ALTER COLUMN wedding_id SET NOT NULL;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='admin_users'::regclass AND contype='u' AND conname IN ('admin_users_username_key','admin_users_email_key') LOOP
    EXECUTE format('ALTER TABLE admin_users DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_wedding_username_idx ON admin_users(wedding_id,lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_wedding_email_idx ON admin_users(wedding_id,lower(email));
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['gifts','memories','guests','suppliers','site_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS wedding_id uuid REFERENCES weddings(id) ON DELETE CASCADE', tbl);
    EXECUTE format('UPDATE %I SET wedding_id=(SELECT id FROM weddings WHERE slug=''suzy-e-junior'') WHERE wedding_id IS NULL', tbl);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN wedding_id SET NOT NULL', tbl);
  END LOOP;
END $$;
ALTER TABLE site_settings DROP CONSTRAINT IF EXISTS site_settings_pkey;
ALTER TABLE site_settings ADD CONSTRAINT site_settings_pkey PRIMARY KEY (wedding_id,key);
SELECT set_config('app.wedding_id',(SELECT wedding_id::text FROM legacy_admin_tenants WHERE singleton=true),true);
INSERT INTO site_settings(wedding_id,key,value) SELECT w.id,v.key,v.value::jsonb FROM weddings w CROSS JOIN (VALUES
('venue_ceremony', '{"id":"ceremony","title":"Cerimônia Religiosa","eyebrow":"SACRAMENTO MATRIMONIAL • 10H00","name":"Paróquia N. Sra. da Glória","address":"Av. Oliveira Paiva, 905 — Cidade dos Funcionários, Fortaleza / CE","mapsUrl":"https://www.google.com/maps/search/?api=1&query=Paroquia+Nossa+Senhora+da+Gloria+Fortaleza","imageUrl":"/images/venue_ceremony_church_1791245531975.jpg","imageAlt":"Interior da Paróquia Nossa Senhora da Glória"}'),
('venue_reception', '{"id":"reception","title":"Recepção aos Convidados","eyebrow":"BRINDE & BANQUETE • 12H00","name":"Asttore Forneria","address":"Rua Ana Bilhar, 987 — Meireles / Varjota, Fortaleza / CE","mapsUrl":"https://www.google.com/maps/search/?api=1&query=Asttore+Forneria+Fortaleza","imageUrl":"/images/venue_reception_forneria_1791245541370.jpg","imageAlt":"Salão da recepção na Asttore Forneria"}'),
('story_content', '{"eyebrow":"01. DO JARDIM DE INFÂNCIA AO ALTAR","title":"Nossa História","body":"Nossa história não começou há dez anos, mas sim quando tínhamos apenas 5 anos de idade, no Jardim de Infância da Escola Centro Acadêmico. O tempo cuidou de guardar nosso reencontro até que estivéssemos prontos para caminhar lado a lado. Já são 10 anos juntos, 1 filho de 7 anos, 1 cachorro, 1 gato, 2 peixes, 2 periquitos, 2 empréstimos, 1 terreno e infinitos sonhos. No dia 18/03/2027, daremos o passo mais bonito da nossa caminhada.","facts":["10 anos juntos","1 filho de 7 anos","1 cachorro & 1 gato","2 peixes & 2 periquitos","2 empréstimos & 1 terreno"],"question":"Depois de todo esse tempo?","answer":"Sempre!"}'),
('event_schedule', '{"eventDate":"2027-03-18","eventTime":"10:00","rsvpDeadline":"2027-02-18"}'),
('design_theme', '{"preset":"dourado-classico","colors":{"background":"#0a0d14","panel":"#101520","text":"#ebebeb","accent":"#c0a062","button":"#c0a062","buttonHover":"#d4b475","buttonText":"#0a0d14"},"fonts":{"heading":"Cinzel","body":"Montserrat"},"heroImage":"/images/hero_wedding_hall_1791245517448.jpg","heroImageKey":""}')
) AS v(key,value) WHERE w.slug='suzy-e-junior' ON CONFLICT(wedding_id,key) DO NOTHING;
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['gifts','memories','guests','suppliers','site_settings','admin_users'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS wedding_isolation ON %I', tbl);
    EXECUTE format('CREATE POLICY wedding_isolation ON %I USING (wedding_id::text=current_setting(''app.wedding_id'',true)) WITH CHECK (wedding_id::text=current_setting(''app.wedding_id'',true))', tbl);
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS gifts_tenant_order_idx ON gifts (wedding_id,id);
CREATE INDEX IF NOT EXISTS memories_tenant_created_idx ON memories (wedding_id,created_at DESC);
CREATE INDEX IF NOT EXISTS guests_tenant_created_idx ON guests (wedding_id,created_at DESC);
CREATE INDEX IF NOT EXISTS suppliers_tenant_name_idx ON suppliers (wedding_id,name);
CREATE INDEX IF NOT EXISTS guests_visible_created_idx ON guests (wedding_id,created_at DESC) WHERE is_visible;
CREATE INDEX IF NOT EXISTS memories_visible_created_idx ON memories (wedding_id,created_at DESC) WHERE is_visible;
CREATE OR REPLACE FUNCTION notify_wedding_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid;
BEGIN IF TG_OP='DELETE' THEN tenant:=OLD.wedding_id; ELSE tenant:=NEW.wedding_id; END IF;
  PERFORM pg_notify('wedding_changes', json_build_object('weddingId',tenant,'table',TG_TABLE_NAME,'operation',TG_OP)::text); RETURN NULL; END $$;
DROP TRIGGER IF EXISTS guests_notify ON guests;
CREATE TRIGGER guests_notify AFTER INSERT OR UPDATE OR DELETE ON guests FOR EACH ROW EXECUTE FUNCTION notify_wedding_change();
DROP TRIGGER IF EXISTS memories_notify ON memories;
CREATE TRIGGER memories_notify AFTER INSERT OR UPDATE OR DELETE ON memories FOR EACH ROW EXECUTE FUNCTION notify_wedding_change();
DROP TRIGGER IF EXISTS suppliers_notify ON suppliers;
CREATE TRIGGER suppliers_notify AFTER INSERT OR UPDATE OR DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION notify_wedding_change();
DROP TRIGGER IF EXISTS site_settings_notify ON site_settings;
CREATE TRIGGER site_settings_notify AFTER INSERT OR UPDATE OR DELETE ON site_settings FOR EACH ROW EXECUTE FUNCTION notify_wedding_change();
DROP TRIGGER IF EXISTS gifts_notify ON gifts;
CREATE TRIGGER gifts_notify AFTER INSERT OR UPDATE OR DELETE ON gifts FOR EACH ROW EXECUTE FUNCTION notify_wedding_change();
