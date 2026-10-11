-- Additive schema. Existing boxes remain on the compatibility path. An owner
-- can opt an EMPTY box into ciphertext-only storage; there is no downgrade.
CREATE TABLE IF NOT EXISTS encrypted_box_state (
  box_id VARCHAR(26) PRIMARY KEY REFERENCES connect_vaults(id) ON DELETE CASCADE,
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 9007199254740991),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE encrypted_box_state ADD COLUMN IF NOT EXISTS state_revision BIGINT NOT NULL DEFAULT 1
  CHECK (state_revision BETWEEN 1 AND 9007199254740991);
CREATE TABLE IF NOT EXISTS encrypted_items (
  box_id VARCHAR(26) NOT NULL REFERENCES encrypted_box_state(box_id) ON DELETE CASCADE,
  item_id VARCHAR(26) NOT NULL CHECK (item_id ~ '^[a-z0-9]{26}$'),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 9007199254740991),
  envelope JSONB NOT NULL CHECK (
    jsonb_typeof(envelope)='object' AND jsonb_typeof(envelope->'context')='object'
    AND envelope->>'format'='1'
    AND envelope->'context'->>'passwordBoxId'=box_id
    AND envelope->'context'->>'itemId'=item_id
    AND envelope->'context'->>'itemVersion'=revision::text
    AND envelope->'context'->>'keyEpoch'=key_epoch::text
    AND octet_length(envelope::text) <= 1500000
  ),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (box_id,item_id),
  FOREIGN KEY (box_id) REFERENCES connect_vaults(id) ON DELETE CASCADE
);

-- Deleted IDs stay reserved. Only public CAS metadata is retained, never an
-- envelope, nonce, ciphertext, plaintext or key. Both parent deletions cascade.
CREATE TABLE IF NOT EXISTS encrypted_item_tombstones (
  box_id VARCHAR(26) NOT NULL CHECK (box_id ~ '^[a-z0-9]{26}$')
    REFERENCES encrypted_box_state(box_id) ON DELETE CASCADE,
  item_id VARCHAR(26) NOT NULL CHECK (item_id ~ '^[a-z0-9]{26}$'),
  last_live_version BIGINT NOT NULL CHECK (last_live_version BETWEEN 1 AND 9007199254740991),
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (box_id,item_id),
  FOREIGN KEY (box_id) REFERENCES connect_vaults(id) ON DELETE CASCADE
);

-- Opaque, client-wrapped box key for ONE owner. Private to that account even in
-- a shared box. The server holds no password, raw key or KDF parameters.
CREATE TABLE IF NOT EXISTS encrypted_owner_keys (
  box_id VARCHAR(26) NOT NULL REFERENCES encrypted_box_state(box_id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 9007199254740991),
  bundle JSONB NOT NULL CHECK (
    jsonb_typeof(bundle)='object' AND jsonb_typeof(bundle->'wrapped')='object'
    AND bundle->>'format'='1' AND bundle->'wrapped'->>'format'='1'
    AND bundle->'wrapped'->'context'->>'passwordBoxId'=box_id
    AND bundle->'wrapped'->'context'->>'ownerAccountId'=owner_id::text
    AND bundle->'wrapped'->'context'->>'keyEpoch'=key_epoch::text
    AND octet_length(bundle::text) <= 2048
  ),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (box_id,owner_id)
);

-- Serialize all old writes with activation, including writes through the old
-- importer, form editor and store adapters. A middleware-only check races.
CREATE OR REPLACE FUNCTION passshare_plaintext_boundary() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    PERFORM id FROM connect_vaults WHERE id IN (OLD.vault_id,NEW.vault_id) ORDER BY id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=OLD.vault_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0055',MESSAGE='PS055: Ciphertext storage required';
    END IF;
  ELSE
    PERFORM id FROM connect_vaults WHERE id=NEW.vault_id FOR UPDATE;
  END IF;
  IF EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=NEW.vault_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0055',MESSAGE='PS055: Ciphertext storage required';
  END IF;
  RETURN NEW;
END $$;

-- Account identity storage is independent of boxes. Only public descriptors
-- and client-encrypted seeds live here; no server Core/AEAD/key dependency.
CREATE OR REPLACE FUNCTION passshare_identity_base64(value JSONB, bytes INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  decoded BYTEA;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR bytes NOT IN (16,24,32,48)
      OR length(value #>> '{}') <> 4*((bytes+2)/3) THEN RETURN FALSE; END IF;
  decoded:=decode(value #>> '{}','base64');
  RETURN octet_length(decoded)=bytes AND encode(decoded,'base64')=(value #>> '{}');
EXCEPTION WHEN data_exception THEN RETURN FALSE;
END $$;

CREATE TABLE IF NOT EXISTS encrypted_account_identities (
  account_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  identity JSONB NOT NULL CHECK ((
    jsonb_typeof(identity)='object'
    AND identity ?& ARRAY['accountId','identityVersion','publicKey','keyId']
    AND identity-ARRAY['accountId','identityVersion','publicKey','keyId']='{}'::jsonb
    AND jsonb_typeof(identity->'accountId')='string'
    AND jsonb_typeof(identity->'identityVersion')='number'
    AND jsonb_typeof(identity->'keyId')='string'
    AND identity->>'accountId'=account_id::text
    AND identity->>'identityVersion'='1'
    AND identity->>'keyId' ~ '^[0-9a-f]{64}$'
    AND CASE WHEN passshare_identity_base64(identity->'publicKey',32) THEN
      identity->>'keyId'=encode(sha256(decode(identity->>'publicKey','base64')),'hex')
      AND get_byte(decode(identity->>'publicKey','base64'),31)<128
      AND NOT (get_byte(decode(identity->>'publicKey','base64'),31)=127
        AND substring(encode(decode(identity->>'publicKey','base64'),'hex') FROM 3 FOR 60)=repeat('ff',30)
        AND get_byte(decode(identity->>'publicKey','base64'),0)>=237)
      ELSE FALSE END
    AND octet_length(identity::text)<=512
  ) IS TRUE),
  bundle JSONB NOT NULL CHECK ((
    jsonb_typeof(bundle)='object' AND bundle->>'format'='1'
    AND jsonb_typeof(bundle->'format')='number'
    AND bundle ?& ARRAY['format','salt','wrapped']
    AND bundle-ARRAY['format','salt','wrapped']='{}'::jsonb
    AND passshare_identity_base64(bundle->'salt',16)
    AND jsonb_typeof(bundle->'wrapped')='object'
    AND bundle->'wrapped' ?& ARRAY['format','context','nonce','ciphertext']
    AND (bundle->'wrapped')-ARRAY['format','context','nonce','ciphertext']='{}'::jsonb
    AND jsonb_typeof(bundle->'wrapped'->'format')='number'
    AND bundle->'wrapped'->>'format'='1'
    AND passshare_identity_base64(bundle->'wrapped'->'nonce',24)
    AND passshare_identity_base64(bundle->'wrapped'->'ciphertext',48)
    AND jsonb_typeof(bundle->'wrapped'->'context')='object'
    AND bundle->'wrapped'->'context' ?& ARRAY['accountId','identityVersion']
    AND (bundle->'wrapped'->'context')-ARRAY['accountId','identityVersion']='{}'::jsonb
    AND jsonb_typeof(bundle->'wrapped'->'context'->'accountId')='string'
    AND jsonb_typeof(bundle->'wrapped'->'context'->'identityVersion')='number'
    AND bundle->'wrapped'->'context'->>'accountId'=account_id::text
    AND bundle->'wrapped'->'context'->>'identityVersion'='1'
    AND octet_length(bundle::text)<=2048
  ) IS TRUE),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION passshare_account_identity_operation(
  actor UUID, session_id UUID, operation TEXT, previous BIGINT,
  descriptor JSONB, body JSONB, verified_snapshot TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  current_hash TEXT;
  current_identity encrypted_account_identities%ROWTYPE;
BEGIN
  -- Self operations never acquire box locks. Serialize bootstrap and CAS on
  -- the existing account row, including the absent-identity case. Account
  -- password operations also lock user before session; no new lock namespace.
  IF operation='put' THEN
    SELECT password_hash INTO current_hash FROM users WHERE id=actor FOR UPDATE;
  ELSE
    SELECT password_hash INTO current_hash FROM users WHERE id=actor FOR SHARE;
  END IF;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN
    RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
  END IF;
  SELECT * INTO current_identity FROM encrypted_account_identities WHERE account_id=actor;
  IF operation='get' THEN
    IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS012','Account identity not found'); END IF;
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('bundleVersion',current_identity.revision,'identity',current_identity.identity,'bundle',current_identity.bundle));
  END IF;
  IF operation<>'put' OR previous IS NULL OR previous<0 OR previous>=9007199254740991
      OR descriptor IS NULL OR body IS NULL THEN
    RETURN passshare_encrypted_error(400,'PS051','Invalid account identity request');
  END IF;
  IF descriptor->>'accountId' IS DISTINCT FROM actor::text
      OR body->'wrapped'->'context'->>'accountId' IS DISTINCT FROM actor::text THEN
    RETURN passshare_encrypted_error(400,'PS051','Invalid account identity context');
  END IF;
  IF descriptor->>'identityVersion' IS DISTINCT FROM '1'
      OR body->'wrapped'->'context'->>'identityVersion' IS DISTINCT FROM '1'
      OR (current_identity.account_id IS NOT NULL AND current_identity.identity IS DISTINCT FROM descriptor) THEN
    RETURN passshare_encrypted_error(409,'PS015','Account identity rotation is unsupported');
  END IF;
  IF previous>0 AND (verified_snapshot IS NULL OR verified_snapshot IS DISTINCT FROM encode(sha256(convert_to(current_hash,'UTF8')),'hex')) THEN
    RETURN passshare_encrypted_error(401,'PS026','Reauthentication required to replace account identity bundle');
  END IF;
  IF previous=0 AND current_identity.revision=1 AND current_identity.identity=descriptor AND current_identity.bundle=body THEN
    -- Exact revision-1 replay: no UPDATE, timestamp or xmin change.
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('bundleVersion',1,'identity',current_identity.identity,'bundle',current_identity.bundle));
  END IF;
  IF COALESCE(current_identity.revision,0)<>previous THEN
    RETURN passshare_encrypted_error(409,'PS015','Account identity bundle changed since it was read');
  END IF;
  IF current_identity.account_id IS NULL THEN
    INSERT INTO encrypted_account_identities(account_id,revision,identity,bundle) VALUES(actor,1,descriptor,body);
  ELSE
    -- Public identity is immutable. Only the same private seed's wrapper may
    -- be replaced; that binding can only be verified by the client's Core.
    UPDATE encrypted_account_identities SET revision=previous+1,bundle=body,updated_at=NOW() WHERE account_id=actor;
  END IF;
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('bundleVersion',previous+1,'identity',descriptor,'bundle',body));
END $$;

CREATE OR REPLACE FUNCTION passshare_member_identity(
  actor UUID, session_id UUID, box VARCHAR, target UUID
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  descriptor JSONB;
BEGIN
  -- Same order as transfer/retirement: box parent, ordered users, session,
  -- ordered memberships. Never insert a box FK after taking a user lock here.
  PERFORM id FROM connect_vaults WHERE id=box FOR UPDATE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Password box not found'); END IF;
  PERFORM id FROM users WHERE id IN (actor,target) ORDER BY id FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=actor) THEN
    RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
  END IF;
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  PERFORM user_id FROM vault_memberships WHERE vault_id=box AND user_id IN (actor,target) ORDER BY user_id FOR SHARE;
  -- Pin liveness AFTER every potentially waiting lock, even for this read.
  IF NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN
    RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=target)
      OR NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=actor AND passshare_membership_active(role,confirmed_at))
      OR NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=target AND passshare_membership_active(role,confirmed_at)) THEN
    RETURN passshare_encrypted_error(403,'PS016','Confirmed password box membership required');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=box) THEN
    RETURN passshare_encrypted_error(409,'PS055','Encrypted storage is not enabled');
  END IF;
  SELECT identity INTO descriptor FROM encrypted_account_identities WHERE account_id=target;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS012','Account identity not found'); END IF;
  -- No private bundle, salt, ciphertext, revision, email or other account data.
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('identity',descriptor));
END $$;

-- Enable and persist the initial owner bundle in ONE transaction. A committed
-- reply may be lost: only an exact replay of the original revision-1 bundle is
-- idempotent. A different key never replaces an existing bundle here.
CREATE OR REPLACE FUNCTION passshare_encrypted_setup(
  actor UUID, session_id UUID, box VARCHAR, body JSONB
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  membership_role TEXT;
  active_epoch BIGINT;
  current_key encrypted_owner_keys%ROWTYPE;
BEGIN
  PERFORM id FROM connect_vaults WHERE id=box FOR UPDATE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Password box not found'); END IF;
  PERFORM id FROM users WHERE id=actor FOR SHARE;
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  SELECT role INTO membership_role FROM vault_memberships
    WHERE user_id=actor AND vault_id=box AND passshare_membership_active(role,confirmed_at) FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(403,'PS016','Access denied to password box'); END IF;
  IF membership_role<>'owner' THEN RETURN passshare_encrypted_error(403,'PS032','Password box owner access required'); END IF;
  SELECT key_epoch INTO active_epoch FROM encrypted_box_state WHERE box_id=box;
  IF active_epoch IS NOT NULL AND active_epoch<>1 THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
  SELECT * INTO current_key FROM encrypted_owner_keys WHERE box_id=box AND owner_id=actor FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  IF current_key.owner_id IS NOT NULL THEN
    IF active_epoch=1 AND current_key.revision=1 AND current_key.key_epoch=1 AND current_key.bundle=body THEN
      RETURN jsonb_build_object('status',200,'body',jsonb_build_object('mode','encrypted','keyEpoch',1,'bundleVersion',1,'bundle',current_key.bundle));
    END IF;
    RETURN passshare_encrypted_error(409,'PS015','Initial owner key bundle differs');
  END IF;
  -- An old owner's bundle or any encrypted content must not be orphaned by a
  -- fresh key. Only an empty legacy activation without any bundle can recover.
  IF EXISTS(SELECT 1 FROM encrypted_owner_keys WHERE box_id=box)
      OR EXISTS(SELECT 1 FROM encrypted_items WHERE box_id=box)
      OR EXISTS(SELECT 1 FROM encrypted_item_tombstones WHERE box_id=box) THEN
    RETURN passshare_encrypted_error(409,'PS015','Existing encrypted content requires its original key');
  END IF;
  IF EXISTS(SELECT 1 FROM connect_items WHERE vault_id=box) THEN
    RETURN passshare_encrypted_error(409,'PS055','Existing plaintext requires client migration');
  END IF;
  IF (SELECT state_revision FROM encrypted_box_state WHERE box_id=box)>=9007199254740991 THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
  IF active_epoch IS NULL THEN
    INSERT INTO encrypted_box_state(box_id,key_epoch) VALUES(box,1);
  END IF;
  INSERT INTO encrypted_owner_keys(box_id,owner_id,revision,key_epoch,bundle) VALUES(box,actor,1,1,body);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('mode','encrypted','keyEpoch',1,'bundleVersion',1,'bundle',body));
END $$;
DROP TRIGGER IF EXISTS passshare_plaintext_boundary ON connect_items;
CREATE TRIGGER passshare_plaintext_boundary BEFORE INSERT OR UPDATE ON connect_items
FOR EACH ROW EXECUTE FUNCTION passshare_plaintext_boundary();

CREATE OR REPLACE FUNCTION passshare_encrypted_error(status INTEGER,code TEXT,message TEXT)
RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
  SELECT jsonb_build_object('status',status,'code',code,'message',code || ': ' || message)
$$;

-- A post-write exception rolls the entire function subtransaction back if a
-- token, failure-record or cascade wait outlives the locked session's deadline.
CREATE OR REPLACE FUNCTION passshare_require_live_session(actor UUID, session_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE='P0024',MESSAGE='PS024: Session is invalid or expired';
  END IF;
END $$;
-- This function runs as one transaction. Public header decisions belong to
-- Rust; live authorization, CAS and epoch decisions belong to locked DB state.
CREATE OR REPLACE FUNCTION passshare_encrypted_operation(
  actor UUID, session_id UUID, box VARCHAR, operation TEXT, item VARCHAR,
  previous BIGINT, body JSONB, epoch BIGINT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  membership_role TEXT;
  active_epoch BIGINT;
  current_item encrypted_items%ROWTYPE;
  tombstone encrypted_item_tombstones%ROWTYPE;
  result JSONB;
BEGIN
  PERFORM id FROM connect_vaults WHERE id=box FOR UPDATE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Password box not found'); END IF;
  -- Recheck AND lock live session and membership. Revocation/role removal must
  -- complete either before this operation or after its committed result.
  PERFORM id FROM users WHERE id=actor FOR SHARE;
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  SELECT role INTO membership_role FROM vault_memberships
    WHERE user_id=actor AND vault_id=box AND passshare_membership_active(role,confirmed_at) FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(403,'PS016','Access denied to password box'); END IF;
  SELECT key_epoch INTO active_epoch FROM encrypted_box_state WHERE box_id=box FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  IF operation='state' THEN
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object(
      'mode',CASE WHEN active_epoch IS NULL THEN 'compatibility' ELSE 'encrypted' END,'keyEpoch',active_epoch));
  END IF;
  IF operation='enable' THEN
    IF membership_role<>'owner' THEN RETURN passshare_encrypted_error(403,'PS032','Password box owner access required'); END IF;
    IF epoch IS DISTINCT FROM 1 THEN RETURN passshare_encrypted_error(400,'PS051','Invalid initial key epoch'); END IF;
    IF active_epoch IS NOT NULL THEN
      IF active_epoch<>epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
    ELSE
      IF EXISTS(SELECT 1 FROM connect_items WHERE vault_id=box) THEN
        RETURN passshare_encrypted_error(409,'PS055','Existing plaintext requires client migration');
      END IF;
      INSERT INTO encrypted_box_state(box_id,key_epoch) VALUES(box,epoch);
    END IF;
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('mode','encrypted','keyEpoch',epoch));
  END IF;
  IF active_epoch IS NULL THEN RETURN passshare_encrypted_error(409,'PS055','Encrypted storage is not enabled'); END IF;
  IF membership_role<>'owner' AND NOT EXISTS(SELECT 1 FROM encrypted_key_grants WHERE box_id=box AND recipient_id=actor AND key_epoch=active_epoch) THEN RETURN passshare_encrypted_error(403,'PS016','Current shared key required'); END IF;
  IF operation='list' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('itemId',item_id,'itemVersion',revision,'keyEpoch',key_epoch) ORDER BY item_id),'[]'::jsonb)
      INTO result FROM (SELECT item_id,revision,key_epoch FROM encrypted_items WHERE box_id=box AND (item IS NULL OR item_id>item) ORDER BY item_id LIMIT 100) AS page;
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('items',result,'nextCursor',CASE WHEN jsonb_array_length(result)=100 THEN result->99->>'itemId' ELSE NULL END));
  END IF;
  SELECT * INTO current_item FROM encrypted_items WHERE box_id=box AND item_id=item;
  IF operation='get' THEN
    IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS012','Item not found'); END IF;
    RETURN jsonb_build_object('status',200,'body',current_item.envelope);
  END IF;
  IF operation='delete' THEN
    IF box IS NULL OR box !~ '^[a-z0-9]{26}$' OR item IS NULL OR item !~ '^[a-z0-9]{26}$'
        OR previous IS NULL OR previous NOT BETWEEN 1 AND 9007199254740991
        OR epoch IS NULL OR epoch NOT BETWEEN 1 AND 9007199254740991 OR body IS NOT NULL THEN
      RETURN passshare_encrypted_error(400,'PS051','Invalid encrypted storage request');
    END IF;
    IF membership_role NOT IN ('owner','member') THEN RETURN passshare_encrypted_error(403,'PS032','Write access required'); END IF;
    IF epoch IS DISTINCT FROM active_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
    IF current_item.item_id IS NOT NULL THEN
      IF current_item.key_epoch<>active_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
      IF current_item.revision<>previous THEN RETURN passshare_encrypted_error(409,'PS015','Item changed since it was read'); END IF;
      IF (SELECT state_revision FROM encrypted_box_state WHERE box_id=box)>9007199254740990-(SELECT count(*) FROM encrypted_attachments WHERE box_id=box AND item_id=item) THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
      DELETE FROM encrypted_items WHERE box_id=box AND item_id=item;
      -- If insertion fails, the preceding deletion is rolled back as well.
      INSERT INTO encrypted_item_tombstones(box_id,item_id,last_live_version,key_epoch)
        VALUES(box,item,current_item.revision,current_item.key_epoch);
      RETURN jsonb_build_object('status',204);
    END IF;
    SELECT * INTO tombstone FROM encrypted_item_tombstones WHERE box_id=box AND item_id=item;
    IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Item not found'); END IF;
    IF tombstone.key_epoch<>active_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
    IF tombstone.last_live_version<>previous THEN RETURN passshare_encrypted_error(409,'PS015','Item changed since it was read'); END IF;
    RETURN jsonb_build_object('status',204);
  END IF;
  IF operation<>'put' OR previous IS NULL OR previous<0 OR previous>=9007199254740991 OR body IS NULL THEN
    RETURN passshare_encrypted_error(400,'PS051','Invalid encrypted storage request');
  END IF;
  IF membership_role NOT IN ('owner','member') THEN RETURN passshare_encrypted_error(403,'PS032','Write access required'); END IF;
  IF epoch IS DISTINCT FROM active_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
  IF EXISTS(SELECT 1 FROM encrypted_item_tombstones WHERE box_id=box AND item_id=item) THEN
    RETURN passshare_encrypted_error(409,'PS015','Deleted item ID cannot be reused');
  END IF;
  -- A committed PUT may lose its HTTP reply. Accept only the exact stored
  -- public envelope at the immediately following revision, without a write.
  IF current_item.revision=previous+1 AND current_item.key_epoch=epoch AND current_item.envelope=body THEN
    RETURN jsonb_build_object('status',200,'body',current_item.envelope);
  END IF;
  IF COALESCE(current_item.revision,0)<>previous THEN RETURN passshare_encrypted_error(409,'PS015','Item changed since it was read'); END IF;
  IF (SELECT state_revision FROM encrypted_box_state WHERE box_id=box)>=9007199254740991 THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
  INSERT INTO encrypted_items(box_id,item_id,revision,key_epoch,envelope)
    VALUES(box,item,previous+1,epoch,body)
    ON CONFLICT(box_id,item_id) DO UPDATE SET revision=EXCLUDED.revision,key_epoch=EXCLUDED.key_epoch,envelope=EXCLUDED.envelope,updated_at=NOW();
  RETURN jsonb_build_object('status',200,'body',body);
END $$;

-- Owner key bundle: same box-first lock order as the item operation, with the
-- live session and CURRENT confirmed owner rechecked under that lock. No
-- delete, rotation or migration exists here.
DROP FUNCTION IF EXISTS passshare_owner_key_operation(UUID,UUID,VARCHAR,TEXT,BIGINT,JSONB,BIGINT);
CREATE OR REPLACE FUNCTION passshare_owner_key_operation(
  actor UUID, session_id UUID, box VARCHAR, operation TEXT,
  previous BIGINT, body JSONB, epoch BIGINT, verified_snapshot TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  membership_role TEXT;
  active_epoch BIGINT;
  current_key encrypted_owner_keys%ROWTYPE;
  current_hash TEXT;
BEGIN
  PERFORM id FROM connect_vaults WHERE id=box FOR UPDATE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Password box not found'); END IF;
  -- Reauthentication is bound to the current credential snapshot, matching
  -- ownership transfer's box-before-user order. No encryption password enters SQL.
  SELECT password_hash INTO current_hash FROM users WHERE id=actor FOR SHARE;
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  SELECT role INTO membership_role FROM vault_memberships
    WHERE user_id=actor AND vault_id=box AND passshare_membership_active(role,confirmed_at) FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(403,'PS016','Access denied to password box'); END IF;
  IF membership_role<>'owner' THEN RETURN passshare_encrypted_error(403,'PS032','Password box owner access required'); END IF;
  SELECT key_epoch INTO active_epoch FROM encrypted_box_state WHERE box_id=box FOR UPDATE;
  IF active_epoch IS NULL THEN RETURN passshare_encrypted_error(409,'PS055','Encrypted storage is not enabled'); END IF;
  SELECT * INTO current_key FROM encrypted_owner_keys WHERE box_id=box AND owner_id=actor FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  SELECT password_hash INTO current_hash FROM users WHERE id=actor;
  IF operation='get' THEN
    IF current_key.owner_id IS NULL THEN RETURN passshare_encrypted_error(404,'PS012','Owner key bundle not found'); END IF;
    IF current_key.key_epoch<>active_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('bundleVersion',current_key.revision,'bundle',current_key.bundle));
  END IF;
  IF operation<>'put' OR previous IS NULL OR previous<0 OR previous>=9007199254740991 OR body IS NULL THEN
    RETURN passshare_encrypted_error(400,'PS051','Invalid owner key bundle request');
  END IF;
  IF epoch IS DISTINCT FROM active_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
  IF previous>0 AND (verified_snapshot IS NULL OR verified_snapshot IS DISTINCT FROM encode(sha256(convert_to(current_hash,'UTF8')),'hex')) THEN
    RETURN passshare_encrypted_error(401,'PS026','Reauthentication required to replace owner key bundle');
  END IF;
  IF COALESCE(current_key.revision,0)<>previous THEN RETURN passshare_encrypted_error(409,'PS015','Owner key bundle changed since it was read'); END IF;
  IF (SELECT state_revision FROM encrypted_box_state WHERE box_id=box)>=9007199254740991 THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
  INSERT INTO encrypted_owner_keys(box_id,owner_id,revision,key_epoch,bundle)
    VALUES(box,actor,previous+1,epoch,body)
    ON CONFLICT(box_id,owner_id) DO UPDATE SET revision=EXCLUDED.revision,key_epoch=EXCLUDED.key_epoch,bundle=EXCLUDED.bundle,updated_at=NOW();
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('bundleVersion',previous+1,'bundle',body));
END $$;

-- Public validators are also used by stored-row constraints. NULL never passes.
CREATE OR REPLACE FUNCTION passshare_exact_object(v JSONB, fields TEXT[])
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT (jsonb_typeof(v)='object' AND v ?& fields AND v-fields='{}'::jsonb) IS TRUE
$$;
CREATE OR REPLACE FUNCTION passshare_safe_number(v JSONB, minimum BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN (jsonb_typeof(v)='number' AND (v#>>'{}') ~ '^[0-9]+$'
    AND (v#>>'{}')::numeric BETWEEN minimum AND 9007199254740991) IS TRUE;
EXCEPTION WHEN data_exception THEN RETURN FALSE;
END $$;
CREATE OR REPLACE FUNCTION passshare_ciphertext(v JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE b BYTEA; t TEXT;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN FALSE; END IF;
  t:=v#>>'{}';
  IF length(t)>1398124 THEN RETURN FALSE; END IF;
  b:=decode(t,'base64');
  RETURN octet_length(b) BETWEEN 16 AND 1048592
    AND replace(encode(b,'base64'),chr(10),'')=t;
EXCEPTION WHEN data_exception THEN RETURN FALSE;
END $$;
CREATE OR REPLACE FUNCTION passshare_item_shape(v JSONB, box VARCHAR, item VARCHAR, rev BIGINT, epoch BIGINT)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT (box ~ '^[a-z0-9]{26}$' AND item ~ '^[a-z0-9]{26}$'
    AND passshare_exact_object(v,ARRAY['format','context','nonce','ciphertext'])
    AND jsonb_typeof(v->'format')='number' AND v->>'format'='1'
    AND passshare_exact_object(v->'context',ARRAY['passwordBoxId','itemId','itemVersion','keyEpoch'])
    AND jsonb_typeof(v->'context'->'passwordBoxId')='string' AND v->'context'->>'passwordBoxId'=box
    AND jsonb_typeof(v->'context'->'itemId')='string' AND v->'context'->>'itemId'=item
    AND passshare_safe_number(v->'context'->'itemVersion',1) AND v->'context'->>'itemVersion'=rev::text
    AND passshare_safe_number(v->'context'->'keyEpoch',1) AND v->'context'->>'keyEpoch'=epoch::text
    AND passshare_identity_base64(v->'nonce',24) AND passshare_ciphertext(v->'ciphertext')
    AND octet_length(v::text)<=1500000) IS TRUE
$$;
CREATE OR REPLACE FUNCTION passshare_owner_shape(v JSONB, box VARCHAR, owner UUID, epoch BIGINT)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT (box ~ '^[a-z0-9]{26}$' AND owner<>'00000000-0000-0000-0000-000000000000'::uuid
    AND passshare_exact_object(v,ARRAY['format','salt','wrapped'])
    AND jsonb_typeof(v->'format')='number' AND v->>'format'='1'
    AND passshare_identity_base64(v->'salt',16)
    AND passshare_exact_object(v->'wrapped',ARRAY['format','context','nonce','ciphertext'])
    AND jsonb_typeof(v->'wrapped'->'format')='number' AND v->'wrapped'->>'format'='1'
    AND passshare_exact_object(v->'wrapped'->'context',ARRAY['passwordBoxId','ownerAccountId','keyEpoch'])
    AND jsonb_typeof(v->'wrapped'->'context'->'passwordBoxId')='string'
    AND v->'wrapped'->'context'->>'passwordBoxId'=box
    AND jsonb_typeof(v->'wrapped'->'context'->'ownerAccountId')='string'
    AND v->'wrapped'->'context'->>'ownerAccountId'=owner::text
    AND passshare_safe_number(v->'wrapped'->'context'->'keyEpoch',1)
    AND v->'wrapped'->'context'->>'keyEpoch'=epoch::text
    AND passshare_identity_base64(v->'wrapped'->'nonce',24)
    AND passshare_identity_base64(v->'wrapped'->'ciphertext',48) AND octet_length(v::text)<=2048) IS TRUE
$$;
CREATE OR REPLACE FUNCTION passshare_grant_shape(v JSONB, box VARCHAR, sender UUID, recipient UUID, epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c JSONB:=v->'context'; p BYTEA;
BEGIN
  IF NOT (box ~ '^[a-z0-9]{26}$' AND sender<>'00000000-0000-0000-0000-000000000000'::uuid
    AND recipient<>'00000000-0000-0000-0000-000000000000'::uuid
    AND passshare_exact_object(v,ARRAY['format','suite','context','enc','ciphertext'])
    AND jsonb_typeof(v->'format')='number' AND v->>'format'='1'
    AND v->>'suite'='hpke-auth/0x0020/0x0001/0x0003'
    AND passshare_exact_object(c,ARRAY['passwordBoxId','senderAccountId','recipientAccountId','keyEpoch','senderIdentityVersion','recipientIdentityVersion','senderKeyId','recipientKeyId'])
    AND jsonb_typeof(c->'passwordBoxId')='string' AND c->>'passwordBoxId'=box
    AND jsonb_typeof(c->'senderAccountId')='string' AND c->>'senderAccountId'=sender::text
    AND jsonb_typeof(c->'recipientAccountId')='string' AND c->>'recipientAccountId'=recipient::text AND sender<>recipient
    AND passshare_safe_number(c->'keyEpoch',1) AND c->>'keyEpoch'=epoch::text
    AND passshare_safe_number(c->'senderIdentityVersion',1) AND passshare_safe_number(c->'recipientIdentityVersion',1)
    AND jsonb_typeof(c->'senderKeyId')='string' AND c->>'senderKeyId' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(c->'recipientKeyId')='string' AND c->>'recipientKeyId' ~ '^[0-9a-f]{64}$'
    AND passshare_identity_base64(v->'enc',32) AND passshare_identity_base64(v->'ciphertext',48)
    AND octet_length(v::text)<=2048) IS TRUE THEN RETURN FALSE; END IF;
  p:=decode(v->>'enc','base64');
  RETURN get_byte(p,31)<128 AND NOT (get_byte(p,31)=127
    AND substring(encode(p,'hex') FROM 3 FOR 60)=repeat('ff',30) AND get_byte(p,0)>=237);
END $$;

-- Add and validate strict constraints without rewriting existing valid rows.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='encrypted_items'::regclass AND conname='encrypted_items_strict_shape') THEN
    ALTER TABLE encrypted_items ADD CONSTRAINT encrypted_items_strict_shape
      CHECK (passshare_item_shape(envelope,box_id,item_id,revision,key_epoch) IS TRUE) NOT VALID;
  END IF;
  ALTER TABLE encrypted_items VALIDATE CONSTRAINT encrypted_items_strict_shape;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='encrypted_owner_keys'::regclass AND conname='encrypted_owner_strict_shape') THEN
    ALTER TABLE encrypted_owner_keys ADD CONSTRAINT encrypted_owner_strict_shape
      CHECK (passshare_owner_shape(bundle,box_id,owner_id,key_epoch) IS TRUE) NOT VALID;
  END IF;
  ALTER TABLE encrypted_owner_keys VALIDATE CONSTRAINT encrypted_owner_strict_shape;
END $$;

CREATE TABLE IF NOT EXISTS encrypted_key_grants (
  box_id VARCHAR(26) NOT NULL REFERENCES encrypted_box_state(box_id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES encrypted_account_identities(account_id),
  recipient_id UUID NOT NULL REFERENCES encrypted_account_identities(account_id),
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 9007199254740991),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision=1),
  created_state_revision BIGINT NOT NULL CHECK (created_state_revision BETWEEN 1 AND 9007199254740991),
  envelope JSONB NOT NULL CHECK (passshare_grant_shape(envelope,box_id,sender_id,recipient_id,key_epoch) IS TRUE),
  PRIMARY KEY(box_id,recipient_id),
  FOREIGN KEY(sender_id,box_id) REFERENCES vault_memberships(user_id,vault_id) ON DELETE CASCADE,
  FOREIGN KEY(recipient_id,box_id) REFERENCES vault_memberships(user_id,vault_id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION passshare_rotation_shape(v JSONB, box VARCHAR, owner UUID)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE removed TEXT:=v->>'removeAccountId'; epoch BIGINT;
BEGIN
  IF (passshare_exact_object(v,ARRAY['expectedStateRevision','expectedKeyEpoch','expectedOwnerBundleVersion','removeAccountId','bundle'])
    AND passshare_safe_number(v->'expectedStateRevision',1) AND passshare_safe_number(v->'expectedKeyEpoch',1)
    AND passshare_safe_number(v->'expectedOwnerBundleVersion',1)
    AND jsonb_typeof(v->'removeAccountId')='string'
    AND removed ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND removed<>'00000000-0000-0000-0000-000000000000' AND removed<>owner::text) IS NOT TRUE THEN RETURN FALSE; END IF;
  epoch:=(v->>'expectedKeyEpoch')::bigint;
  RETURN epoch<9007199254740991 AND (v->>'expectedOwnerBundleVersion')::bigint<9007199254740991
    AND (v->>'expectedStateRevision')::bigint<9007199254740991
    AND passshare_owner_shape(v->'bundle',box,owner,epoch+1);
END $$;
CREATE TABLE IF NOT EXISTS encrypted_rotations (
  box_id VARCHAR(26) NOT NULL REFERENCES encrypted_box_state(box_id) ON DELETE CASCADE,
  operation_id UUID NOT NULL CHECK (operation_id<>'00000000-0000-0000-0000-000000000000'::uuid),
  actor_id UUID NOT NULL REFERENCES users(id),
  header JSONB,
  header_hash TEXT NOT NULL CHECK (header_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('pending','committed')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp()+INTERVAL '24 hours'),
  item_count BIGINT NOT NULL DEFAULT 0 CHECK (item_count BETWEEN 0 AND 9007199254740991),
  grant_count BIGINT NOT NULL DEFAULT 0 CHECK (grant_count BETWEEN 0 AND 9007199254740991),
  staged_bytes BIGINT NOT NULL CHECK (staged_bytes BETWEEN 0 AND 1073741824),
  byte_limit BIGINT NOT NULL CHECK (byte_limit BETWEEN 0 AND 1073741824),
  result JSONB,
  PRIMARY KEY(box_id,operation_id),
  CHECK ((status='pending' AND passshare_rotation_shape(header,box_id,actor_id)
    AND header_hash=encode(sha256(convert_to(header::text,'UTF8')),'hex') AND result IS NULL
    OR status='committed' AND header IS NULL AND result IS NOT NULL) IS TRUE),
  CHECK (staged_bytes<=byte_limit)
);
CREATE UNIQUE INDEX IF NOT EXISTS encrypted_one_pending_rotation ON encrypted_rotations(box_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS encrypted_rotation_items (
  box_id VARCHAR(26) NOT NULL, operation_id UUID NOT NULL,
  item_id VARCHAR(26) NOT NULL CHECK (item_id ~ '^[a-z0-9]{26}$'),
  previous BIGINT NOT NULL CHECK (previous BETWEEN 1 AND 9007199254740990),
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 2 AND 9007199254740991),
  envelope JSONB NOT NULL CHECK (passshare_item_shape(envelope,box_id,item_id,previous+1,key_epoch) IS TRUE),
  PRIMARY KEY(box_id,operation_id,item_id),
  FOREIGN KEY(box_id,operation_id) REFERENCES encrypted_rotations(box_id,operation_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS encrypted_rotation_grants (
  box_id VARCHAR(26) NOT NULL, operation_id UUID NOT NULL,
  sender_id UUID NOT NULL, recipient_id UUID NOT NULL,
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 2 AND 9007199254740991),
  envelope JSONB NOT NULL CHECK (passshare_grant_shape(envelope,box_id,sender_id,recipient_id,key_epoch) IS TRUE),
  PRIMARY KEY(box_id,operation_id,recipient_id),
  FOREIGN KEY(box_id,operation_id) REFERENCES encrypted_rotations(box_id,operation_id) ON DELETE CASCADE,
  FOREIGN KEY(sender_id,box_id) REFERENCES vault_memberships(user_id,vault_id),
  FOREIGN KEY(recipient_id,box_id) REFERENCES vault_memberships(user_id,vault_id),
  FOREIGN KEY(sender_id) REFERENCES encrypted_account_identities(account_id),
  FOREIGN KEY(recipient_id) REFERENCES encrypted_account_identities(account_id)
);

-- Attachments contain ONLY the Core public envelope. All measurements are the
-- UTF8 bytes of the persisted JSONB envelope, not its public plaintext length.
CREATE OR REPLACE FUNCTION passshare_attachment_shape(v JSONB, box VARCHAR, item VARCHAR, attachment VARCHAR, rev BIGINT, epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c JSONB:=v->'context'; size BIGINT; t TEXT; b BYTEA;
BEGIN
  IF (box ~ '^[a-z0-9]{26}$' AND item ~ '^[a-z0-9]{26}$' AND attachment ~ '^[a-z0-9]{26}$'
    AND rev BETWEEN 1 AND 9007199254740991 AND epoch BETWEEN 1 AND 9007199254740991
    AND passshare_exact_object(v,ARRAY['format','context','contentBytes','nonce','ciphertext'])
    AND jsonb_typeof(v->'format')='number' AND v->>'format'='1'
    AND passshare_exact_object(c,ARRAY['passwordBoxId','itemId','attachmentId','attachmentVersion','keyEpoch'])
    AND jsonb_typeof(c->'passwordBoxId')='string' AND c->>'passwordBoxId'=box
    AND jsonb_typeof(c->'itemId')='string' AND c->>'itemId'=item
    AND jsonb_typeof(c->'attachmentId')='string' AND c->>'attachmentId'=attachment
    AND passshare_safe_number(c->'attachmentVersion',1) AND c->>'attachmentVersion'=rev::text
    AND passshare_safe_number(c->'keyEpoch',1) AND c->>'keyEpoch'=epoch::text
    AND passshare_safe_number(v->'contentBytes',0) AND passshare_identity_base64(v->'nonce',24)
    AND jsonb_typeof(v->'ciphertext')='string' AND octet_length(v::text)<=1404000) IS NOT TRUE THEN RETURN FALSE; END IF;
  size:=(v->>'contentBytes')::bigint; t:=v->>'ciphertext';
  IF size>1048576 OR length(t)>1403592 THEN RETURN FALSE; END IF;
  b:=decode(t,'base64');
  RETURN octet_length(b) BETWEEN 20+size AND 4116+size AND replace(encode(b,'base64'),chr(10),'')=t;
EXCEPTION WHEN data_exception THEN RETURN FALSE;
END $$;
CREATE TABLE IF NOT EXISTS encrypted_attachments (
  box_id VARCHAR(26) NOT NULL, item_id VARCHAR(26) NOT NULL,
  attachment_id VARCHAR(26) NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 9007199254740991),
  envelope JSONB NOT NULL CHECK (passshare_attachment_shape(envelope,box_id,item_id,attachment_id,revision,key_epoch) IS TRUE),
  last_request_hash TEXT CHECK (last_request_hash ~ '^[0-9a-f]{64}$'),
  last_state_revision BIGINT CHECK (last_state_revision BETWEEN 1 AND 9007199254740991),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(box_id,item_id,attachment_id),
  FOREIGN KEY(box_id,item_id) REFERENCES encrypted_items(box_id,item_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS encrypted_attachment_tombstones (
  box_id VARCHAR(26) NOT NULL REFERENCES encrypted_box_state(box_id) ON DELETE CASCADE,
  item_id VARCHAR(26) NOT NULL CHECK (item_id ~ '^[a-z0-9]{26}$'),
  attachment_id VARCHAR(26) NOT NULL CHECK (attachment_id ~ '^[a-z0-9]{26}$'),
  last_live_version BIGINT NOT NULL CHECK (last_live_version BETWEEN 1 AND 9007199254740991),
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 9007199254740991),
  item_revision BIGINT NOT NULL CHECK (item_revision BETWEEN 1 AND 9007199254740991),
  last_request_hash TEXT NOT NULL CHECK (last_request_hash ~ '^[0-9a-f]{64}$'),
  last_state_revision BIGINT NOT NULL CHECK (last_state_revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(box_id,item_id,attachment_id)
);
CREATE TABLE IF NOT EXISTS encrypted_rotation_attachments (
  box_id VARCHAR(26) NOT NULL, operation_id UUID NOT NULL,
  item_id VARCHAR(26) NOT NULL, attachment_id VARCHAR(26) NOT NULL,
  previous BIGINT NOT NULL CHECK (previous BETWEEN 1 AND 9007199254740990),
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 2 AND 9007199254740991),
  envelope JSONB NOT NULL CHECK (passshare_attachment_shape(envelope,box_id,item_id,attachment_id,previous+1,key_epoch) IS TRUE),
  PRIMARY KEY(box_id,operation_id,item_id,attachment_id),
  FOREIGN KEY(box_id,operation_id) REFERENCES encrypted_rotations(box_id,operation_id) ON DELETE CASCADE
);
ALTER TABLE encrypted_rotations ADD COLUMN IF NOT EXISTS attachment_count BIGINT NOT NULL DEFAULT 0
  CHECK (attachment_count BETWEEN 0 AND 9007199254740991);

CREATE OR REPLACE FUNCTION passshare_attachment_operation(actor UUID, session_id UUID, box VARCHAR, operation TEXT,
  item VARCHAR, attachment VARCHAR, request JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE state encrypted_box_state%ROWTYPE; live_item encrypted_items%ROWTYPE; live encrypted_attachments%ROWTYPE;
  dead encrypted_attachment_tombstones%ROWTYPE; membership_role TEXT; previous BIGINT; item_previous BIGINT; epoch BIGINT;
  expected_revision BIGINT; digest TEXT; item_body JSONB; body JSONB; final_revision BIGINT; byte_total BIGINT; live_count BIGINT;
BEGIN
  IF box IS NULL OR box !~ '^[a-z0-9]{26}$'
    OR (operation='state' AND (item IS NOT NULL OR attachment IS NOT NULL OR request IS NOT NULL))
    OR (operation IS DISTINCT FROM 'state' AND (item IS NULL OR item !~ '^[a-z0-9]{26}$'
      OR attachment IS NULL OR attachment !~ '^[a-z0-9]{26}$')) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid attachment selector'); END IF;
  PERFORM id FROM connect_vaults WHERE id=box FOR UPDATE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Password box not found'); END IF;
  PERFORM id FROM users WHERE id=actor FOR SHARE;
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  SELECT role INTO membership_role FROM vault_memberships WHERE vault_id=box AND user_id=actor
    AND passshare_membership_active(role,confirmed_at) FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(403,'PS016','Confirmed password box membership required'); END IF;
  SELECT * INTO state FROM encrypted_box_state WHERE box_id=box FOR UPDATE;
  SELECT * INTO live_item FROM encrypted_items WHERE box_id=box AND item_id=item FOR UPDATE;
  SELECT * INTO live FROM encrypted_attachments WHERE box_id=box AND item_id=item AND attachment_id=attachment FOR UPDATE;
  SELECT * INTO dead FROM encrypted_attachment_tombstones WHERE box_id=box AND item_id=item AND attachment_id=attachment FOR UPDATE;
  PERFORM passshare_require_live_session(actor,session_id);
  IF state.box_id IS NULL THEN RETURN passshare_encrypted_error(409,'PS055','Encrypted storage is not enabled'); END IF;
  IF membership_role<>'owner' AND NOT EXISTS(SELECT 1 FROM encrypted_key_grants WHERE box_id=box AND recipient_id=actor AND key_epoch=state.key_epoch) THEN
    RETURN passshare_encrypted_error(403,'PS016','Current shared key required'); END IF;
  IF operation='state' THEN
    PERFORM passshare_require_live_session(actor,session_id);
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('stateRevision',state.state_revision,'keyEpoch',state.key_epoch));
  END IF;
  IF live_item.item_id IS NULL THEN RETURN passshare_encrypted_error(409,'PS015','Current parent item required'); END IF;
  IF operation='get' THEN
    IF NOT passshare_exact_object(request,ARRAY['revision']) OR NOT passshare_safe_number(request->'revision',1) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid attachment selector'); END IF;
    IF (request->>'revision')::bigint<>state.state_revision THEN RETURN passshare_encrypted_error(409,'PS015','Attachment snapshot changed'); END IF;
    IF live.attachment_id IS NULL THEN RETURN passshare_encrypted_error(404,'PS012','Attachment not found'); END IF;
    IF live.key_epoch<>state.key_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
    PERFORM passshare_require_live_session(actor,session_id);
    RETURN jsonb_build_object('status',200,'body',live.envelope);
  END IF;
  IF membership_role NOT IN ('owner','member') THEN RETURN passshare_encrypted_error(403,'PS032','Write access required'); END IF;
  IF operation NOT IN ('put','delete') OR NOT passshare_exact_object(request,
    CASE WHEN operation='put' THEN ARRAY['expectedStateRevision','item','expectedVersion','envelope'] ELSE ARRAY['expectedStateRevision','item','expectedVersion','keyEpoch'] END)
    OR NOT passshare_safe_number(request->'expectedStateRevision',1)
    OR NOT passshare_safe_number(request->'expectedVersion',CASE WHEN operation='put' THEN 0 ELSE 1 END)
    OR NOT passshare_exact_object(request->'item',ARRAY['expectedVersion','envelope'])
    OR NOT passshare_safe_number(request->'item'->'expectedVersion',1) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid attachment mutation'); END IF;
  previous:=(request->>'expectedVersion')::bigint; item_previous:=(request->'item'->>'expectedVersion')::bigint;
  expected_revision:=(request->>'expectedStateRevision')::bigint; item_body:=request->'item'->'envelope'; body:=request->'envelope';
  IF item_previous>=9007199254740991 OR (operation='put' AND previous>=9007199254740991) THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
  IF NOT passshare_safe_number(item_body->'context'->'keyEpoch',1) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid attachment context'); END IF;
  epoch:=(item_body->'context'->>'keyEpoch')::bigint;
  IF NOT passshare_item_shape(item_body,box,item,item_previous+1,epoch)
    OR (operation='put' AND NOT passshare_attachment_shape(body,box,item,attachment,previous+1,epoch))
    OR (operation='delete' AND (NOT passshare_safe_number(request->'keyEpoch',1) OR (request->>'keyEpoch')::bigint<>epoch)) THEN
    RETURN passshare_encrypted_error(400,'PS051','Invalid attachment context'); END IF;
  IF epoch<>state.key_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
  digest:=encode(sha256(convert_to(request::text,'UTF8')),'hex');
  -- Replay proves BOTH resources and the original state selector. Any intervening
  -- live change or different payload is a conflict, even after reply loss.
  IF live_item.revision=item_previous+1 AND live_item.envelope=item_body AND live_item.key_epoch=epoch THEN
    IF operation='put' AND live.revision=previous+1 AND live.envelope=body AND live.key_epoch=epoch
      AND live.last_request_hash=digest AND live.last_state_revision=state.state_revision THEN
      PERFORM passshare_require_live_session(actor,session_id);
      RETURN jsonb_build_object('status',200,'body',jsonb_build_object('stateRevision',state.state_revision,'itemVersion',live_item.revision,'attachmentVersion',live.revision,'keyEpoch',epoch));
    ELSIF operation='delete' AND live.attachment_id IS NULL AND dead.last_request_hash=digest
      AND dead.last_state_revision=state.state_revision AND dead.item_revision=live_item.revision AND dead.key_epoch=epoch THEN
      PERFORM passshare_require_live_session(actor,session_id);
      RETURN jsonb_build_object('status',200,'body',jsonb_build_object('stateRevision',state.state_revision,'itemVersion',live_item.revision,'deleted',true,'keyEpoch',epoch));
    END IF;
  END IF;
  IF expected_revision<>state.state_revision OR live_item.revision<>item_previous OR live_item.key_epoch<>epoch
    OR coalesce(live.revision,0)<>previous OR (live.attachment_id IS NOT NULL AND live.key_epoch<>epoch)
    OR dead.attachment_id IS NOT NULL THEN RETURN passshare_encrypted_error(409,'PS015','Item or attachment changed; deleted IDs cannot be reused'); END IF;
  IF state.state_revision>9007199254740989 THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
  SELECT count(*),coalesce(sum(octet_length(envelope::text)),0) INTO live_count,byte_total FROM encrypted_attachments WHERE box_id=box;
  IF operation='put' AND (live_count+CASE WHEN live.attachment_id IS NULL THEN 1 ELSE 0 END>1024
    OR byte_total-coalesce(octet_length(live.envelope::text),0)+octet_length(body::text)>1073741824) THEN RETURN passshare_encrypted_error(409,'PS015','Attachment storage budget exceeded'); END IF;
  final_revision:=state.state_revision+2;
  UPDATE encrypted_items SET revision=item_previous+1,envelope=item_body,updated_at=clock_timestamp() WHERE box_id=box AND item_id=item;
  IF operation='put' THEN
    INSERT INTO encrypted_attachments(box_id,item_id,attachment_id,revision,key_epoch,envelope,last_request_hash,last_state_revision)
      VALUES(box,item,attachment,previous+1,epoch,body,digest,final_revision)
      ON CONFLICT(box_id,item_id,attachment_id) DO UPDATE SET revision=EXCLUDED.revision,key_epoch=EXCLUDED.key_epoch,
        envelope=EXCLUDED.envelope,last_request_hash=digest,last_state_revision=final_revision,updated_at=clock_timestamp();
  ELSE
    DELETE FROM encrypted_attachments WHERE box_id=box AND item_id=item AND attachment_id=attachment;
    INSERT INTO encrypted_attachment_tombstones(box_id,item_id,attachment_id,last_live_version,key_epoch,item_revision,last_request_hash,last_state_revision)
      VALUES(box,item,attachment,previous,epoch,item_previous+1,digest,final_revision);
  END IF;
  PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',CASE WHEN operation='put' THEN
    jsonb_build_object('stateRevision',final_revision,'itemVersion',item_previous+1,'attachmentVersion',previous+1,'keyEpoch',epoch)
    ELSE jsonb_build_object('stateRevision',final_revision,'itemVersion',item_previous+1,'deleted',true,'keyEpoch',epoch) END);
EXCEPTION WHEN SQLSTATE 'P0024' THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
  WHEN SQLSTATE 'P0015' OR numeric_value_out_of_range THEN RETURN passshare_encrypted_error(409,'PS015','Attachment state conflict');
END $$;

CREATE OR REPLACE FUNCTION passshare_grant_identity_matches(v JSONB, box VARCHAR, sender UUID, recipient UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM vault_memberships s JOIN vault_memberships r ON r.vault_id=s.vault_id
    JOIN encrypted_account_identities si ON si.account_id=s.user_id
    JOIN encrypted_account_identities ri ON ri.account_id=r.user_id
    WHERE s.vault_id=box AND s.user_id=sender AND r.user_id=recipient
      AND s.role='owner' AND passshare_membership_active(s.role,s.confirmed_at)
      AND passshare_membership_active(r.role,r.confirmed_at)
      AND v->'context'->>'senderIdentityVersion'=si.identity->>'identityVersion'
      AND v->'context'->>'recipientIdentityVersion'=ri.identity->>'identityVersion'
      AND v->'context'->>'senderKeyId'=si.identity->>'keyId'
      AND v->'context'->>'recipientKeyId'=ri.identity->>'keyId')
$$;
CREATE OR REPLACE FUNCTION passshare_grant_identity_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Let malformed public shapes reach their CHECK (23514); this separate guard
  -- enforces the stored identity binding for otherwise well-formed envelopes.
  IF NOT passshare_grant_shape(NEW.envelope,NEW.box_id,NEW.sender_id,NEW.recipient_id,NEW.key_epoch) THEN RETURN NEW; END IF;
  IF NOT passshare_grant_identity_matches(NEW.envelope,NEW.box_id,NEW.sender_id,NEW.recipient_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0015',MESSAGE='PS015: Shared identity changed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passshare_grant_identity_guard ON encrypted_key_grants;
CREATE TRIGGER passshare_grant_identity_guard BEFORE INSERT OR UPDATE ON encrypted_key_grants
  FOR EACH ROW EXECUTE FUNCTION passshare_grant_identity_guard();
DROP TRIGGER IF EXISTS passshare_grant_identity_guard ON encrypted_rotation_grants;
CREATE TRIGGER passshare_grant_identity_guard BEFORE INSERT OR UPDATE ON encrypted_rotation_grants
  FOR EACH ROW EXECUTE FUNCTION passshare_grant_identity_guard();
CREATE OR REPLACE FUNCTION passshare_immutable_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity IS DISTINCT FROM OLD.identity THEN
    RAISE EXCEPTION USING ERRCODE='P0015',MESSAGE='PS015: Account identity is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passshare_immutable_identity ON encrypted_account_identities;
CREATE TRIGGER passshare_immutable_identity BEFORE UPDATE ON encrypted_account_identities
  FOR EACH ROW EXECUTE FUNCTION passshare_immutable_identity();

-- Writers MUST already hold connect_vaults FOR UPDATE. This trigger never
-- takes a parent-box lock from a child row. Staging has no revision trigger.
CREATE OR REPLACE FUNCTION passshare_live_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE box VARCHAR; old_value JSONB; new_value JSONB;
BEGIN
  IF TG_OP='UPDATE' THEN
    old_value:=to_jsonb(OLD)-ARRAY['updated_at','created_at'];
    new_value:=to_jsonb(NEW)-ARRAY['updated_at','created_at'];
    IF old_value=new_value THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='vault_memberships' THEN
    box:=CASE WHEN TG_OP='DELETE' THEN OLD.vault_id ELSE NEW.vault_id END;
  ELSE
    box:=CASE WHEN TG_OP='DELETE' THEN OLD.box_id ELSE NEW.box_id END;
  END IF;
  IF EXISTS(SELECT 1 FROM connect_vaults WHERE id=box) AND EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=box) THEN
    UPDATE encrypted_box_state SET state_revision=state_revision+1
      WHERE box_id=box AND state_revision<9007199254740991;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0015',MESSAGE='PS015: Safe integer limit reached'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['encrypted_items','encrypted_attachments','encrypted_owner_keys','encrypted_key_grants','vault_memberships'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS passshare_live_revision ON %I',t);
    EXECUTE format('CREATE TRIGGER passshare_live_revision AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION passshare_live_revision()',t);
  END LOOP;
END $$;

-- One statement / transaction. All business rejection paths precede writes.
-- An exception after the first write rolls back the entire statement, including
-- revision triggers. Only the public reply leaves this function.
CREATE OR REPLACE FUNCTION passshare_sharing_operation(
  actor UUID, session_id UUID, box VARCHAR, operation TEXT, op_id UUID,
  target TEXT, request JSONB, verified_snapshot TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  state encrypted_box_state%ROWTYPE;
  owner_key encrypted_owner_keys%ROWTYPE;
  grant_row encrypted_key_grants%ROWTYPE;
  rotation encrypted_rotations%ROWTYPE;
  staged_item encrypted_rotation_items%ROWTYPE;
  staged_grant encrypted_rotation_grants%ROWTYPE;
  staged_attachment encrypted_rotation_attachments%ROWTYPE;
  live_attachment encrypted_attachments%ROWTYPE;
  live_item encrypted_items%ROWTYPE;
  recipient UUID;
  removed UUID;
  expected_revision BIGINT;
  old_epoch BIGINT;
  new_epoch BIGINT;
  owner_version BIGINT;
  current_hash TEXT;
  page JSONB;
  reply JSONB;
  stage_size BIGINT;
  live_count BIGINT;
  live_grants BIGINT;
  live_attachments BIGINT;
  attachment_item VARCHAR;
  attachment_id_value VARCHAR;
  increments BIGINT;
  body JSONB;
BEGIN
  IF box IS NULL OR box !~ '^[a-z0-9]{26}$' THEN RETURN passshare_encrypted_error(400,'PS051','Invalid password box'); END IF;
  PERFORM id FROM connect_vaults WHERE id=box FOR UPDATE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Password box not found'); END IF;
  -- Lock users in UUID order, including all members and invitation senders.
  -- No subsequent child insert needs an unpinned user FK lock.
  PERFORM id FROM users WHERE id=actor OR id IN (SELECT user_id FROM vault_memberships WHERE vault_id=box)
    OR id IN (SELECT inviter_id FROM vault_invitations WHERE vault_id=box) ORDER BY id FOR SHARE;
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  PERFORM user_id FROM vault_memberships WHERE vault_id=box ORDER BY user_id FOR UPDATE;
  PERFORM id FROM vault_invitations WHERE vault_id=box ORDER BY id FOR UPDATE;
  SELECT * INTO state FROM encrypted_box_state WHERE box_id=box FOR UPDATE;
  -- A successful new start may GC an expired operation. Pin its rows and
  -- ciphertext stages now as well, so GC introduces no late lock wait after
  -- the final session/credential/clock checks.
  PERFORM operation_id FROM encrypted_rotations WHERE box_id=box AND (status='pending' OR operation_id=op_id)
    ORDER BY operation_id FOR UPDATE;
  SELECT * INTO rotation FROM encrypted_rotations WHERE box_id=box AND operation_id=op_id FOR UPDATE;
  SELECT * INTO owner_key FROM encrypted_owner_keys WHERE box_id=box AND owner_id=actor FOR UPDATE;
  PERFORM recipient_id FROM encrypted_key_grants WHERE box_id=box ORDER BY recipient_id FOR UPDATE;
  PERFORM item_id FROM encrypted_items WHERE box_id=box ORDER BY item_id FOR UPDATE;
  PERFORM attachment_id FROM encrypted_attachments WHERE box_id=box ORDER BY item_id,attachment_id FOR UPDATE;
  PERFORM item_id FROM encrypted_rotation_items WHERE box_id=box
    AND operation_id IN (SELECT operation_id FROM encrypted_rotations WHERE box_id=box AND (status='pending' OR operation_id=op_id))
    ORDER BY operation_id,item_id FOR UPDATE;
  PERFORM recipient_id FROM encrypted_rotation_grants WHERE box_id=box
    AND operation_id IN (SELECT operation_id FROM encrypted_rotations WHERE box_id=box AND (status='pending' OR operation_id=op_id))
    ORDER BY operation_id,recipient_id FOR UPDATE;
  PERFORM attachment_id FROM encrypted_rotation_attachments WHERE box_id=box
    AND operation_id IN (SELECT operation_id FROM encrypted_rotations WHERE box_id=box AND (status='pending' OR operation_id=op_id))
    ORDER BY operation_id,item_id,attachment_id FOR UPDATE;
  PERFORM account_id FROM encrypted_account_identities WHERE account_id=actor
    OR account_id IN (SELECT user_id FROM vault_memberships WHERE vault_id=box) ORDER BY account_id FOR KEY SHARE;
  IF operation='commit' AND rotation.status='pending' THEN
    PERFORM id FROM connect_tokens WHERE user_id=(rotation.header->>'removeAccountId')::uuid ORDER BY id FOR UPDATE;
  END IF;
  -- EVERY wait has finished. Read liveness and credentials using real time.
  IF NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN
    RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=actor AND passshare_membership_active(role,confirmed_at)) THEN
    RETURN passshare_encrypted_error(403,'PS016','Confirmed password box membership required');
  END IF;
  IF state.box_id IS NULL THEN RETURN passshare_encrypted_error(409,'PS055','Encrypted storage is not enabled'); END IF;
  IF (SELECT count(*) FROM vault_memberships WHERE vault_id=box AND role='owner')<>1 THEN
    RETURN passshare_encrypted_error(409,'PS015','Shared protocol currently requires exactly one owner');
  END IF;
  IF operation='grant-get' THEN
    SELECT * INTO grant_row FROM encrypted_key_grants WHERE box_id=box AND recipient_id=actor AND key_epoch=state.key_epoch;
    IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS012','Current shared key not found'); END IF;
    IF NOT passshare_grant_identity_matches(grant_row.envelope,box,grant_row.sender_id,actor) THEN
      RETURN passshare_encrypted_error(403,'PS016','Confirmed shared identity required');
    END IF;
    PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('grantVersion',grant_row.revision,'keyEpoch',grant_row.key_epoch,'envelope',grant_row.envelope));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=actor AND role='owner' AND passshare_membership_active(role,confirmed_at)) THEN
    RETURN passshare_encrypted_error(403,'PS032','Password box owner access required');
  END IF;
  IF operation='commit' THEN
    SELECT password_hash INTO current_hash FROM users WHERE id=actor;
    IF verified_snapshot IS NULL OR verified_snapshot IS DISTINCT FROM encode(sha256(convert_to(current_hash,'UTF8')),'hex') THEN
      RETURN passshare_encrypted_error(401,'PS026','Reauthentication required to commit rotation');
    END IF;
  END IF;
  IF operation='grant-delete' THEN RETURN passshare_encrypted_error(409,'PS015','Shared keys can only be removed by rotation'); END IF;
  IF operation='snapshot' THEN
    IF owner_key.owner_id IS NULL OR owner_key.key_epoch<>state.key_epoch THEN RETURN passshare_encrypted_error(409,'PS015','Current owner bundle required'); END IF;
    PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('stateRevision',state.state_revision,'keyEpoch',state.key_epoch,
      'ownerAccountId',actor,'ownerBundleVersion',owner_key.revision,
      'memberCount',(SELECT count(*) FROM vault_memberships WHERE vault_id=box),
      'liveItemCount',(SELECT count(*) FROM encrypted_items WHERE box_id=box),
      'grantCount',(SELECT count(*) FROM encrypted_key_grants WHERE box_id=box AND key_epoch=state.key_epoch))
      || CASE WHEN EXISTS(SELECT 1 FROM encrypted_attachments WHERE box_id=box) THEN
        jsonb_build_object('liveAttachmentCount',(SELECT count(*) FROM encrypted_attachments WHERE box_id=box),
          'liveAttachmentBytes',(SELECT coalesce(sum(octet_length(envelope::text)),0) FROM encrypted_attachments WHERE box_id=box)) ELSE '{}'::jsonb END);
  END IF;
  IF operation IN ('members','items','item','attachments','attachment') THEN
    IF operation IN ('attachments','attachment') AND (NOT passshare_exact_object(request,
        CASE WHEN operation='attachments' THEN ARRAY['revision','after'] ELSE ARRAY['revision'] END)
      OR NOT passshare_safe_number(request->'revision',1)
      OR (operation='attachments' AND request->'after'<>'null'::jsonb
        AND (jsonb_typeof(request->'after') IS DISTINCT FROM 'string' OR request->>'after' !~ '^[a-z0-9]{26}:[a-z0-9]{26}$'))
      OR (operation='attachment' AND (target IS NULL OR target !~ '^[a-z0-9]{26}:[a-z0-9]{26}$'))) THEN
      RETURN passshare_encrypted_error(400,'PS051','Invalid attachment snapshot selector'); END IF;
    IF (request->>'revision')::bigint IS DISTINCT FROM state.state_revision THEN RETURN passshare_encrypted_error(409,'PS015','Sharing snapshot changed'); END IF;
    IF operation='members' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('accountId',user_id,'role',role,
        'membershipConfirmed',passshare_membership_active(role,confirmed_at),'keyGranted',key_granted) ORDER BY user_id),'[]'::jsonb)
        INTO page FROM (SELECT m.*,EXISTS(SELECT 1 FROM encrypted_key_grants g WHERE g.box_id=box AND g.recipient_id=m.user_id AND g.key_epoch=state.key_epoch) AS key_granted
          FROM vault_memberships m WHERE vault_id=box AND (request->>'after' IS NULL OR user_id>(request->>'after')::uuid) ORDER BY user_id LIMIT 100) p;
      PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('stateRevision',state.state_revision,'members',page,
        'nextCursor',CASE WHEN jsonb_array_length(page)=100 THEN page->99->>'accountId' ELSE NULL END));
    ELSIF operation='items' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',item_id,'itemVersion',revision,'keyEpoch',key_epoch) ORDER BY item_id),'[]'::jsonb)
        INTO page FROM (SELECT * FROM encrypted_items WHERE box_id=box AND (request->>'after' IS NULL OR item_id>request->>'after') ORDER BY item_id LIMIT 100) p;
      PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('stateRevision',state.state_revision,'items',page,
        'nextCursor',CASE WHEN jsonb_array_length(page)=100 THEN page->99->>'itemId' ELSE NULL END));
    ELSIF operation='attachments' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',item_id,'attachmentId',attachment_id,'attachmentVersion',revision,'keyEpoch',key_epoch) ORDER BY item_id,attachment_id),'[]'::jsonb)
        INTO page FROM (SELECT * FROM encrypted_attachments WHERE box_id=box
          AND (request->>'after' IS NULL OR item_id||':'||attachment_id>request->>'after') ORDER BY item_id,attachment_id LIMIT 100) p;
      PERFORM passshare_require_live_session(actor,session_id);
      RETURN jsonb_build_object('status',200,'body',jsonb_build_object('stateRevision',state.state_revision,'attachments',page,
        'nextCursor',CASE WHEN jsonb_array_length(page)=100 THEN (page->99->>'itemId')||':'||(page->99->>'attachmentId') ELSE NULL END));
    ELSIF operation='attachment' THEN
      SELECT envelope INTO body FROM encrypted_attachments WHERE box_id=box AND item_id=split_part(target,':',1) AND attachment_id=split_part(target,':',2);
      IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS012','Attachment not found'); END IF;
      PERFORM passshare_require_live_session(actor,session_id);
      RETURN jsonb_build_object('status',200,'body',body);
    ELSE
      SELECT envelope INTO body FROM encrypted_items WHERE box_id=box AND item_id=target;
      IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS012','Item not found'); END IF;
      PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',body);
    END IF;
  END IF;
  IF operation='grant-put' THEN
    recipient:=target::uuid; body:=request->'envelope';
    IF NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=recipient AND passshare_membership_active(role,confirmed_at)) THEN
      RETURN passshare_encrypted_error(403,'PS016','Confirmed recipient membership required');
    END IF;
    IF NOT passshare_grant_shape(body,box,actor,recipient,(request->>'keyEpoch')::bigint)
        OR NOT passshare_grant_identity_matches(body,box,actor,recipient) THEN
      RETURN passshare_encrypted_error(409,'PS015','Confirmed immutable sharing identities required');
    END IF;
    IF (request->>'keyEpoch')::bigint IS DISTINCT FROM state.key_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
    SELECT * INTO grant_row FROM encrypted_key_grants WHERE box_id=box AND recipient_id=recipient;
    IF FOUND THEN
      IF grant_row.key_epoch=state.key_epoch AND grant_row.sender_id=actor AND grant_row.envelope=body THEN
        PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('grantVersion',1,'keyEpoch',state.key_epoch,'stateRevision',state.state_revision,'envelope',grant_row.envelope));
      END IF;
      RETURN passshare_encrypted_error(409,'PS015','Shared keys cannot be replaced outside rotation');
    END IF;
    IF request->>'expectedVersion' IS DISTINCT FROM '0' OR (request->>'expectedStateRevision')::bigint IS DISTINCT FROM state.state_revision THEN
      RETURN passshare_encrypted_error(409,'PS015','Sharing snapshot changed');
    END IF;
    IF state.state_revision>=9007199254740991 THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
    INSERT INTO encrypted_key_grants(box_id,sender_id,recipient_id,key_epoch,created_state_revision,envelope)
      VALUES(box,actor,recipient,state.key_epoch,state.state_revision+1,body);
    SELECT state_revision INTO expected_revision FROM encrypted_box_state WHERE box_id=box;
    PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('grantVersion',1,'keyEpoch',state.key_epoch,'stateRevision',expected_revision,'envelope',body));
  END IF;
  IF operation NOT IN ('start','stage-item','stage-attachment','stage-grant','commit','status','abort') OR op_id IS NULL THEN
    RETURN passshare_encrypted_error(400,'PS051','Invalid sharing operation');
  END IF;
  IF rotation.operation_id IS NOT NULL AND rotation.actor_id<>actor THEN RETURN passshare_encrypted_error(403,'PS032','Rotation owner access required'); END IF;
  IF operation='status' THEN
    IF rotation.operation_id IS NULL THEN RETURN passshare_encrypted_error(404,'PS012','Rotation not found'); END IF;
    PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,
      'status',CASE WHEN rotation.status='pending' AND rotation.expires_at<=clock_timestamp() THEN 'expired' ELSE rotation.status END,
      'itemCount',rotation.item_count,'grantCount',rotation.grant_count,'stagedBytes',rotation.staged_bytes,
      'expiresAt',rotation.expires_at,'result',rotation.result)
      || CASE WHEN rotation.attachment_count>0 THEN jsonb_build_object('attachmentCount',rotation.attachment_count) ELSE '{}'::jsonb END);
  END IF;
  IF operation='abort' THEN
    IF rotation.status='committed' THEN RETURN passshare_encrypted_error(409,'PS015','Committed rotation cannot be aborted'); END IF;
    DELETE FROM encrypted_rotations WHERE box_id=box AND operation_id=op_id AND status='pending';
    PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',204);
  END IF;
  IF rotation.status='committed' THEN
    IF operation='commit' THEN PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',rotation.result); END IF;
    IF operation='start' AND rotation.header_hash=encode(sha256(convert_to(request::text,'UTF8')),'hex') THEN
      PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,'status','committed','result',rotation.result));
    END IF;
    RETURN passshare_encrypted_error(409,'PS015','Rotation is already committed');
  END IF;
  IF operation='start' THEN
    IF rotation.operation_id IS NOT NULL THEN
      IF rotation.header=request AND rotation.expires_at>clock_timestamp() THEN
        PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,'status','pending'));
      END IF;
      RETURN passshare_encrypted_error(409,'PS015','Rotation header differs or expired');
    END IF;
    expected_revision:=(request->>'expectedStateRevision')::bigint;
    old_epoch:=(request->>'expectedKeyEpoch')::bigint;
    owner_version:=(request->>'expectedOwnerBundleVersion')::bigint;
    removed:=(request->>'removeAccountId')::uuid;
    IF state.state_revision IS DISTINCT FROM expected_revision OR state.key_epoch IS DISTINCT FROM old_epoch
      OR owner_key.revision IS DISTINCT FROM owner_version OR owner_key.key_epoch IS DISTINCT FROM old_epoch THEN
      RETURN passshare_encrypted_error(409,'PS015','Sharing snapshot or owner bundle changed');
    END IF;
    IF old_epoch>=9007199254740991 OR owner_version>=9007199254740991 OR state.state_revision>=9007199254740991 THEN
      RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached');
    END IF;
    IF NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=removed AND user_id<>actor AND role<>'owner' AND passshare_membership_active(role,confirmed_at)) THEN
      RETURN passshare_encrypted_error(409,'PS015','Confirmed nonowner removal target required');
    END IF;
    IF NOT passshare_owner_shape(request->'bundle',box,actor,old_epoch+1) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid owner bundle'); END IF;
    IF EXISTS(SELECT 1 FROM encrypted_rotations WHERE box_id=box AND status='pending' AND expires_at>clock_timestamp()) THEN
      RETURN passshare_encrypted_error(409,'PS015','Another rotation is pending');
    END IF;
    SELECT count(*) INTO live_count FROM encrypted_items WHERE box_id=box;
    SELECT count(*) INTO live_attachments FROM encrypted_attachments WHERE box_id=box;
    SELECT count(*) INTO live_grants FROM encrypted_key_grants WHERE box_id=box AND key_epoch=old_epoch AND recipient_id<>removed;
    stage_size:=octet_length((request->'bundle')::text);
    -- Opportunistic GC only after all business checks for a successful start.
    DELETE FROM encrypted_rotations WHERE box_id=box AND status='pending' AND expires_at<=clock_timestamp();
    INSERT INTO encrypted_rotations(box_id,operation_id,actor_id,header,header_hash,status,staged_bytes,byte_limit)
      VALUES(box,op_id,actor,request,encode(sha256(convert_to(request::text,'UTF8')),'hex'),'pending',stage_size,
        least(1073741824::bigint,live_count*1500000+live_attachments*1404000+live_grants*2048+2048));
    PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,'status','pending'));
  END IF;
  IF rotation.operation_id IS NULL THEN RETURN passshare_encrypted_error(404,'PS012','Rotation not found'); END IF;
  IF rotation.expires_at<=clock_timestamp() THEN RETURN passshare_encrypted_error(410,'PS040','Rotation expired'); END IF;
  expected_revision:=(rotation.header->>'expectedStateRevision')::bigint;
  old_epoch:=(rotation.header->>'expectedKeyEpoch')::bigint;
  new_epoch:=old_epoch+1;
  owner_version:=(rotation.header->>'expectedOwnerBundleVersion')::bigint;
  removed:=(rotation.header->>'removeAccountId')::uuid;
  IF state.state_revision IS DISTINCT FROM expected_revision OR state.key_epoch IS DISTINCT FROM old_epoch
    OR owner_key.revision IS DISTINCT FROM owner_version OR owner_key.key_epoch IS DISTINCT FROM old_epoch THEN
    RETURN passshare_encrypted_error(409,'PS015','Sharing snapshot or owner bundle changed');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=removed AND role<>'owner' AND passshare_membership_active(role,confirmed_at)) THEN
    RETURN passshare_encrypted_error(409,'PS015','Removal target changed');
  END IF;
  IF operation='stage-item' THEN
    body:=request->'envelope';
    SELECT * INTO live_item FROM encrypted_items WHERE box_id=box AND item_id=target;
    IF NOT FOUND OR live_item.revision IS DISTINCT FROM (request->>'expectedVersion')::bigint OR live_item.key_epoch<>old_epoch THEN
      RETURN passshare_encrypted_error(409,'PS015','Live item changed or does not exist');
    END IF;
    IF live_item.revision>=9007199254740991 THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
    IF NOT passshare_item_shape(body,box,target::varchar,live_item.revision+1,new_epoch) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid staged item'); END IF;
    SELECT * INTO staged_item FROM encrypted_rotation_items WHERE box_id=box AND operation_id=op_id AND item_id=target;
    IF FOUND THEN
      IF staged_item.previous=live_item.revision AND staged_item.envelope=body THEN
        PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,'itemId',target,'itemVersion',live_item.revision+1,'keyEpoch',new_epoch));
      END IF;
      RETURN passshare_encrypted_error(409,'PS015','Staged item differs');
    END IF;
    stage_size:=octet_length(body::text);
    IF rotation.item_count>=(SELECT count(*) FROM encrypted_items WHERE box_id=box) OR rotation.staged_bytes+stage_size>rotation.byte_limit THEN
      RETURN passshare_encrypted_error(409,'PS015','Rotation staging budget exceeded');
    END IF;
    INSERT INTO encrypted_rotation_items(box_id,operation_id,item_id,previous,key_epoch,envelope) VALUES(box,op_id,target,live_item.revision,new_epoch,body);
    UPDATE encrypted_rotations SET item_count=item_count+1,staged_bytes=staged_bytes+stage_size WHERE box_id=box AND operation_id=op_id;
    PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,'itemId',target,'itemVersion',live_item.revision+1,'keyEpoch',new_epoch));
  END IF;
  IF operation='stage-attachment' THEN
    attachment_item:=split_part(target,':',1); attachment_id_value:=split_part(target,':',2); body:=request->'envelope';
    IF NOT passshare_exact_object(request,ARRAY['expectedVersion','envelope']) OR NOT passshare_safe_number(request->'expectedVersion',1) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid attachment stage'); END IF;
    SELECT * INTO live_attachment FROM encrypted_attachments WHERE box_id=box AND item_id=attachment_item AND attachment_id=attachment_id_value;
    IF NOT FOUND OR live_attachment.revision IS DISTINCT FROM (request->>'expectedVersion')::bigint OR live_attachment.key_epoch<>old_epoch THEN
      RETURN passshare_encrypted_error(409,'PS015','Live attachment changed or does not exist'); END IF;
    IF live_attachment.revision>=9007199254740991 THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
    IF NOT passshare_attachment_shape(body,box,attachment_item,attachment_id_value,live_attachment.revision+1,new_epoch) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid staged attachment'); END IF;
    SELECT * INTO staged_attachment FROM encrypted_rotation_attachments WHERE box_id=box AND operation_id=op_id AND item_id=attachment_item AND attachment_id=attachment_id_value;
    IF FOUND THEN
      IF staged_attachment.previous=live_attachment.revision AND staged_attachment.envelope=body THEN
        PERFORM passshare_require_live_session(actor,session_id);
        RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,'itemId',attachment_item,'attachmentId',attachment_id_value,'attachmentVersion',live_attachment.revision+1,'keyEpoch',new_epoch));
      END IF;
      RETURN passshare_encrypted_error(409,'PS015','Staged attachment differs');
    END IF;
    stage_size:=octet_length(body::text);
    IF rotation.attachment_count>=(SELECT count(*) FROM encrypted_attachments WHERE box_id=box) OR rotation.staged_bytes+stage_size>rotation.byte_limit THEN RETURN passshare_encrypted_error(409,'PS015','Rotation staging budget exceeded'); END IF;
    INSERT INTO encrypted_rotation_attachments(box_id,operation_id,item_id,attachment_id,previous,key_epoch,envelope)
      VALUES(box,op_id,attachment_item,attachment_id_value,live_attachment.revision,new_epoch,body);
    UPDATE encrypted_rotations SET attachment_count=attachment_count+1,staged_bytes=staged_bytes+stage_size WHERE box_id=box AND operation_id=op_id;
    PERFORM passshare_require_live_session(actor,session_id);
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,'itemId',attachment_item,'attachmentId',attachment_id_value,'attachmentVersion',live_attachment.revision+1,'keyEpoch',new_epoch));
  END IF;
  IF operation='stage-grant' THEN
    recipient:=target::uuid; body:=request->'envelope';
    IF recipient=removed OR NOT EXISTS(SELECT 1 FROM encrypted_key_grants WHERE box_id=box AND recipient_id=recipient AND key_epoch=old_epoch)
      OR NOT passshare_grant_identity_matches(body,box,actor,recipient) THEN
      RETURN passshare_encrypted_error(409,'PS015','Remaining previous grantee required');
    END IF;
    IF NOT passshare_grant_shape(body,box,actor,recipient,new_epoch) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid staged shared key'); END IF;
    SELECT * INTO staged_grant FROM encrypted_rotation_grants WHERE box_id=box AND operation_id=op_id AND recipient_id=recipient;
    IF FOUND THEN
      IF staged_grant.envelope=body THEN PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,'recipientAccountId',recipient,'keyEpoch',new_epoch)); END IF;
      RETURN passshare_encrypted_error(409,'PS015','Staged shared key differs');
    END IF;
    stage_size:=octet_length(body::text);
    IF rotation.grant_count>=(SELECT count(*) FROM encrypted_key_grants WHERE box_id=box AND key_epoch=old_epoch AND recipient_id<>removed)
      OR rotation.staged_bytes+stage_size>rotation.byte_limit THEN RETURN passshare_encrypted_error(409,'PS015','Rotation staging budget exceeded'); END IF;
    INSERT INTO encrypted_rotation_grants(box_id,operation_id,sender_id,recipient_id,key_epoch,envelope) VALUES(box,op_id,actor,recipient,new_epoch,body);
    UPDATE encrypted_rotations SET grant_count=grant_count+1,staged_bytes=staged_bytes+stage_size WHERE box_id=box AND operation_id=op_id;
    PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationId',op_id,'recipientAccountId',recipient,'keyEpoch',new_epoch));
  END IF;
  -- Commit proves ID AND revision equality in BOTH directions, not just counts.
  IF EXISTS(SELECT item_id,attachment_id,revision FROM encrypted_attachments WHERE box_id=box
      EXCEPT SELECT item_id,attachment_id,previous FROM encrypted_rotation_attachments WHERE box_id=box AND operation_id=op_id)
    OR EXISTS(SELECT item_id,attachment_id,previous FROM encrypted_rotation_attachments WHERE box_id=box AND operation_id=op_id
      EXCEPT SELECT item_id,attachment_id,revision FROM encrypted_attachments WHERE box_id=box)
    OR EXISTS(SELECT 1 FROM encrypted_attachments WHERE box_id=box AND key_epoch<>old_epoch)
    OR EXISTS(SELECT 1 FROM encrypted_rotation_attachments WHERE box_id=box AND operation_id=op_id AND key_epoch<>new_epoch) THEN
    RETURN passshare_encrypted_error(409,'PS015','Complete current live attachment set required'); END IF;
  IF (SELECT coalesce(sum(octet_length(envelope::text)),0) FROM encrypted_rotation_attachments WHERE box_id=box AND operation_id=op_id)>1073741824
    OR (SELECT count(*) FROM encrypted_rotation_attachments WHERE box_id=box AND operation_id=op_id)>1024 THEN RETURN passshare_encrypted_error(409,'PS015','Attachment storage budget exceeded'); END IF;
  IF EXISTS(SELECT item_id,revision FROM encrypted_items WHERE box_id=box
      EXCEPT SELECT item_id,previous FROM encrypted_rotation_items WHERE box_id=box AND operation_id=op_id)
    OR EXISTS(SELECT item_id,previous FROM encrypted_rotation_items WHERE box_id=box AND operation_id=op_id
      EXCEPT SELECT item_id,revision FROM encrypted_items WHERE box_id=box)
    OR EXISTS(SELECT 1 FROM encrypted_items WHERE box_id=box AND key_epoch<>old_epoch)
    OR EXISTS(SELECT 1 FROM encrypted_rotation_items WHERE box_id=box AND operation_id=op_id AND key_epoch<>new_epoch) THEN
    RETURN passshare_encrypted_error(409,'PS015','Complete current live item set required');
  END IF;
  IF EXISTS(SELECT recipient_id FROM encrypted_key_grants WHERE box_id=box AND key_epoch=old_epoch AND recipient_id<>removed
      EXCEPT SELECT recipient_id FROM encrypted_rotation_grants WHERE box_id=box AND operation_id=op_id)
    OR EXISTS(SELECT recipient_id FROM encrypted_rotation_grants WHERE box_id=box AND operation_id=op_id
      EXCEPT SELECT recipient_id FROM encrypted_key_grants WHERE box_id=box AND key_epoch=old_epoch AND recipient_id<>removed)
    OR EXISTS(SELECT 1 FROM encrypted_key_grants WHERE box_id=box AND key_epoch<>old_epoch)
    OR EXISTS(SELECT 1 FROM encrypted_rotation_grants WHERE box_id=box AND operation_id=op_id
      AND (key_epoch<>new_epoch OR sender_id<>actor OR NOT passshare_grant_identity_matches(envelope,box,actor,recipient_id))) THEN
    RETURN passshare_encrypted_error(409,'PS015','Exact remaining previous grantee set required');
  END IF;
  SELECT count(*) INTO live_count FROM encrypted_items WHERE box_id=box;
  SELECT count(*) INTO live_grants FROM encrypted_key_grants WHERE box_id=box;
  SELECT count(*) INTO live_attachments FROM encrypted_attachments WHERE box_id=box;
  -- Each actual live-row change has a revision trigger; reserve the complete
  -- increment budget BEFORE any write. epoch itself contributes one increment.
  increments:=live_count+live_attachments+live_grants+rotation.grant_count+3;
  IF state.state_revision>9007199254740991-increments OR old_epoch>=9007199254740991 OR owner_version>=9007199254740991
    OR EXISTS(SELECT 1 FROM encrypted_items WHERE box_id=box AND revision>=9007199254740991)
    OR EXISTS(SELECT 1 FROM encrypted_attachments WHERE box_id=box AND revision>=9007199254740991) THEN
    RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached');
  END IF;
  IF NOT passshare_owner_shape(rotation.header->'bundle',box,actor,new_epoch) THEN RETURN passshare_encrypted_error(400,'PS051','Invalid staged owner bundle'); END IF;
  UPDATE encrypted_items i SET revision=s.previous+1,key_epoch=new_epoch,envelope=s.envelope,updated_at=clock_timestamp()
    FROM encrypted_rotation_items s WHERE s.box_id=box AND s.operation_id=op_id AND i.box_id=box AND i.item_id=s.item_id;
  UPDATE encrypted_attachments a SET revision=s.previous+1,key_epoch=new_epoch,envelope=s.envelope,
    last_request_hash=NULL,last_state_revision=NULL,updated_at=clock_timestamp()
    FROM encrypted_rotation_attachments s WHERE s.box_id=box AND s.operation_id=op_id AND a.box_id=box AND a.item_id=s.item_id AND a.attachment_id=s.attachment_id;
  UPDATE encrypted_owner_keys SET revision=owner_version+1,key_epoch=new_epoch,bundle=rotation.header->'bundle',updated_at=clock_timestamp()
    WHERE box_id=box AND owner_id=actor;
  DELETE FROM encrypted_key_grants WHERE box_id=box;
  INSERT INTO encrypted_key_grants(box_id,sender_id,recipient_id,key_epoch,created_state_revision,envelope)
    SELECT box,actor,recipient_id,new_epoch,state.state_revision+increments,envelope FROM encrypted_rotation_grants WHERE box_id=box AND operation_id=op_id;
  DELETE FROM vault_memberships WHERE vault_id=box AND user_id=removed;
  UPDATE vault_invitations SET status='revoked',responded_at=clock_timestamp()
    WHERE vault_id=box AND status='pending' AND invitee_email=(SELECT email FROM users WHERE id=removed);
  DELETE FROM connect_tokens WHERE user_id=removed;
  UPDATE encrypted_box_state SET key_epoch=new_epoch,state_revision=state_revision+1 WHERE box_id=box;
  SELECT state_revision INTO expected_revision FROM encrypted_box_state WHERE box_id=box;
  reply:=jsonb_build_object('operationId',op_id,'status','committed','keyEpoch',new_epoch,'stateRevision',expected_revision,
    'ownerBundleVersion',owner_version+1,'removedAccountId',removed,'itemCount',live_count,'grantCount',rotation.grant_count)
    || CASE WHEN live_attachments>0 THEN jsonb_build_object('attachmentCount',live_attachments) ELSE '{}'::jsonb END;
  DELETE FROM encrypted_rotation_items WHERE box_id=box AND operation_id=op_id;
  DELETE FROM encrypted_rotation_grants WHERE box_id=box AND operation_id=op_id;
  DELETE FROM encrypted_rotation_attachments WHERE box_id=box AND operation_id=op_id;
  UPDATE encrypted_rotations SET status='committed',header=NULL,result=reply,staged_bytes=0 WHERE box_id=box AND operation_id=op_id;
  PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',reply);
EXCEPTION
WHEN SQLSTATE 'P0024' THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
 WHEN SQLSTATE 'P0015' OR numeric_value_out_of_range THEN
  -- The exception block is a subtransaction: every preceding write is undone.
  RETURN passshare_encrypted_error(409,'PS015','Sharing state conflict or safe integer limit reached');
END $$;

-- Legacy membership adapters also use box-first locks and real-time session
-- checks. These functions remain installed when the HTTP feature flag is off.
CREATE OR REPLACE FUNCTION passshare_membership_lock(actor UUID, session_id UUID, box VARCHAR, target UUID, owner_required BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM connect_vaults WHERE id=box FOR UPDATE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Password box not found'); END IF;
  PERFORM id FROM users WHERE id IN (actor,target) ORDER BY id FOR SHARE;
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor FOR SHARE;
  PERFORM user_id FROM vault_memberships WHERE vault_id=box ORDER BY user_id FOR UPDATE;
  PERFORM id FROM vault_invitations WHERE vault_id=box ORDER BY id FOR UPDATE;
  PERFORM box_id FROM encrypted_box_state WHERE box_id=box FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN
    RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
  END IF;
  IF owner_required AND NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=actor AND role='owner' AND passshare_membership_active(role,confirmed_at)) THEN
    RETURN passshare_encrypted_error(403,'PS032','Password box owner access required');
  END IF;
  RETURN jsonb_build_object('status',200);
END $$;
CREATE OR REPLACE FUNCTION passshare_trusted_membership_add(account UUID, box VARCHAR, membership_role TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM connect_vaults WHERE id=box FOR UPDATE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Password box not found'); END IF;
  PERFORM id FROM users WHERE id=account FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(401,'PS024','Account no longer exists'); END IF;
  IF EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=account) THEN RETURN jsonb_build_object('status',204); END IF;
  IF EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=box) THEN
    RETURN passshare_encrypted_error(409,'PS015','Encrypted membership requires an authenticated invitation');
  END IF;
  INSERT INTO vault_memberships(user_id,vault_id,role,confirmed_at)
    VALUES(account,box,membership_role,CASE WHEN membership_role='owner' THEN clock_timestamp() ELSE NULL END);
  RETURN jsonb_build_object('status',204);
END $$;
CREATE OR REPLACE FUNCTION passshare_legacy_member_change(actor UUID, session_id UUID, box VARCHAR, target UUID, operation TEXT, next_role TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE access_reply JSONB; member vault_memberships%ROWTYPE;
BEGIN
  access_reply:=passshare_membership_lock(actor,session_id,box,target,TRUE);
  IF access_reply->>'status'<>'200' THEN RETURN access_reply; END IF;
  SELECT * INTO member FROM vault_memberships WHERE vault_id=box AND user_id=target;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS035','Member not found'); END IF;
  IF operation='role' THEN
    IF member.role='owner' THEN RETURN passshare_encrypted_error(404,'PS035','Cannot change owner role'); END IF;
    IF next_role NOT IN ('member','readonly') OR next_role IS NULL THEN RETURN passshare_encrypted_error(400,'PS034','Invalid member role'); END IF;
    IF member.role=next_role THEN PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',204); END IF;
  ELSIF operation='remove' THEN
    IF EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=box) AND passshare_membership_active(member.role,member.confirmed_at) THEN
      RETURN passshare_encrypted_error(409,'PS015','Encrypted membership removal requires atomic key rotation');
    END IF;
    IF member.role='owner' AND (SELECT count(*) FROM vault_memberships WHERE vault_id=box AND role='owner')<=1 THEN
      RETURN passshare_encrypted_error(400,'PS036','Cannot remove the last owner');
    END IF;
  ELSE RETURN passshare_encrypted_error(400,'PS051','Invalid membership operation'); END IF;
  IF (SELECT state_revision FROM encrypted_box_state WHERE box_id=box)>=9007199254740991 THEN RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached'); END IF;
  IF operation='role' THEN UPDATE vault_memberships SET role=next_role WHERE vault_id=box AND user_id=target;
  ELSE
    DELETE FROM vault_memberships WHERE vault_id=box AND user_id=target;
    DELETE FROM connect_tokens WHERE user_id=target;
  END IF;
  PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',204);
EXCEPTION
WHEN SQLSTATE 'P0024' THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
 WHEN SQLSTATE 'P0015' OR numeric_value_out_of_range THEN RETURN passshare_encrypted_error(409,'PS015','Membership state conflict');
END $$;

CREATE OR REPLACE FUNCTION passshare_legacy_invite_accept(actor UUID, session_id UUID, invitation_id UUID, proof TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE invitation vault_invitations%ROWTYPE; access_reply JSONB; user_email TEXT; box VARCHAR; sender UUID;
BEGIN
  SELECT vault_id,inviter_id INTO box,sender FROM vault_invitations WHERE id=invitation_id;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS039','Invitation not found'); END IF;
  access_reply:=passshare_membership_lock(actor,session_id,box,sender,FALSE);
  IF access_reply->>'status'<>'200' THEN RETURN access_reply; END IF;
  SELECT * INTO invitation FROM vault_invitations WHERE id=invitation_id;
  SELECT email INTO user_email FROM users WHERE id=actor;
  IF invitation.status IS DISTINCT FROM 'pending' THEN RETURN passshare_encrypted_error(404,'PS039','Invitation not found'); END IF;
  IF invitation.expires_at<=clock_timestamp() THEN RETURN passshare_encrypted_error(410,'PS040','Invitation has expired'); END IF;
  IF invitation.invitee_email IS DISTINCT FROM user_email THEN RETURN passshare_encrypted_error(403,'PS041','Invitation is for a different email address'); END IF;
  IF invitation.role IS DISTINCT FROM 'member' THEN RETURN passshare_encrypted_error(403,'PS033','Invitation role must be member'); END IF;
  IF NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=sender AND role='owner' AND passshare_membership_active(role,confirmed_at)) THEN
    RETURN passshare_encrypted_error(403,'PS032','Invitation owner no longer has access');
  END IF;
  IF proof IS NULL OR proof IS DISTINCT FROM invitation.confirmation_hash THEN RETURN passshare_encrypted_error(403,'PS045','Invitation confirmation required'); END IF;
  IF (SELECT state_revision FROM encrypted_box_state WHERE box_id=box)>=9007199254740991
    AND NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=actor AND passshare_membership_active(role,confirmed_at)) THEN
    RETURN passshare_encrypted_error(409,'PS015','Safe integer limit reached');
  END IF;
  INSERT INTO vault_memberships(user_id,vault_id,role,confirmed_at) VALUES(actor,box,'member',clock_timestamp())
    ON CONFLICT(user_id,vault_id) DO UPDATE SET confirmed_at=EXCLUDED.confirmed_at WHERE vault_memberships.confirmed_at IS NULL AND vault_memberships.role='member';
  UPDATE vault_invitations SET status='accepted',responded_at=clock_timestamp() WHERE id=invitation_id;
  PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('vaultId',box,'role','member'));
EXCEPTION
WHEN SQLSTATE 'P0024' THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
 WHEN SQLSTATE 'P0015' OR numeric_value_out_of_range THEN RETURN passshare_encrypted_error(409,'PS015','Membership state conflict');
END $$;

CREATE OR REPLACE FUNCTION passshare_legacy_transfer(actor UUID, session_id UUID, box VARCHAR, target UUID, verified_snapshot TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE access_reply JSONB; current_hash TEXT;
BEGIN
  access_reply:=passshare_membership_lock(actor,session_id,box,target,TRUE);
  IF access_reply->>'status'<>'200' THEN RETURN access_reply; END IF;
  SELECT password_hash INTO current_hash FROM users WHERE id=actor;
  IF verified_snapshot IS NULL OR verified_snapshot IS DISTINCT FROM encode(sha256(convert_to(current_hash,'UTF8')),'hex') THEN
    RETURN passshare_encrypted_error(401,'PS024','Session or credential changed');
  END IF;
  IF EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=box) THEN
    RETURN passshare_encrypted_error(409,'PS015','Encrypted ownership transition is not yet supported');
  END IF;
  IF target=actor OR target IS NULL THEN RETURN passshare_encrypted_error(400,'PS018','Invalid ownership transfer'); END IF;
  IF NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=target AND role='member' AND passshare_membership_active(role,confirmed_at)) THEN
    RETURN passshare_encrypted_error(409,'PS047','A confirmed member is required for ownership transfer');
  END IF;
  UPDATE vault_memberships SET role=CASE WHEN user_id=target THEN 'owner' ELSE 'member' END,confirmed_at=coalesce(confirmed_at,clock_timestamp())
    WHERE vault_id=box AND user_id IN (actor,target);
  DELETE FROM connect_tokens WHERE user_id IN (actor,target);
  PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',204);
EXCEPTION
WHEN SQLSTATE 'P0024' THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
 END $$;

CREATE OR REPLACE FUNCTION passshare_legacy_retire(actor UUID, session_id UUID, verified_snapshot TEXT, confirmation_email TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE session_deadline TIMESTAMPTZ; locked_boxes VARCHAR[]; current_boxes VARCHAR[]; private_boxes VARCHAR[]; current_hash TEXT; user_email TEXT;
  membership_boxes VARCHAR[]; related_boxes VARCHAR[];
BEGIN
  SELECT email INTO user_email FROM users WHERE id=actor;
  SELECT coalesce(array_agg(vault_id ORDER BY vault_id),ARRAY[]::varchar[]) INTO membership_boxes FROM vault_memberships WHERE user_id=actor;
  SELECT coalesce(array_agg(id ORDER BY id),ARRAY[]::varchar[]) INTO locked_boxes FROM
    (SELECT id FROM connect_vaults WHERE id=ANY(membership_boxes)
      OR id IN (SELECT vault_id FROM vault_invitations WHERE inviter_id=actor OR invitee_email=user_email) ORDER BY id FOR UPDATE) locked;
  -- Take the required strength initially; no user-lock upgrade after sessions.
  PERFORM id FROM users WHERE id=actor OR id IN (SELECT user_id FROM vault_memberships WHERE vault_id=ANY(locked_boxes))
    OR id IN (SELECT inviter_id FROM vault_invitations WHERE vault_id=ANY(locked_boxes)) ORDER BY id FOR UPDATE;
  PERFORM id FROM sessions WHERE user_id=actor ORDER BY id FOR UPDATE;
  PERFORM user_id FROM vault_memberships WHERE vault_id=ANY(locked_boxes) ORDER BY vault_id,user_id FOR UPDATE;
  PERFORM id FROM vault_invitations WHERE vault_id=ANY(locked_boxes) ORDER BY id FOR UPDATE;
  PERFORM box_id FROM encrypted_box_state WHERE box_id=ANY(locked_boxes) ORDER BY box_id FOR UPDATE;
  PERFORM id FROM connect_tokens WHERE user_id=actor ORDER BY id FOR UPDATE;
  PERFORM email FROM login_failures WHERE email=user_email FOR UPDATE;
  SELECT expires_at INTO session_deadline FROM sessions WHERE id=session_id AND user_id=actor;
  SELECT coalesce(array_agg(vault_id ORDER BY vault_id),ARRAY[]::varchar[]) INTO current_boxes FROM vault_memberships WHERE user_id=actor;
  IF current_boxes IS DISTINCT FROM membership_boxes THEN RETURN passshare_encrypted_error(409,'PS049','Password box memberships changed; retry deletion'); END IF;
  SELECT coalesce(array_agg(vault_id ORDER BY vault_id),ARRAY[]::varchar[]) INTO related_boxes FROM
    (SELECT DISTINCT vault_id FROM vault_invitations WHERE inviter_id=actor OR invitee_email=user_email) related;
  IF NOT related_boxes<@locked_boxes THEN RETURN passshare_encrypted_error(409,'PS049','Password box invitations changed; retry deletion'); END IF;
  IF NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  SELECT password_hash,email INTO current_hash,user_email FROM users WHERE id=actor;
  IF verified_snapshot IS NULL OR verified_snapshot IS DISTINCT FROM encode(sha256(convert_to(current_hash,'UTF8')),'hex') THEN RETURN passshare_encrypted_error(401,'PS024','Session or credential changed'); END IF;
  IF user_email IS DISTINCT FROM confirmation_email OR confirmation_email IS NULL THEN RETURN passshare_encrypted_error(400,'PS048','Confirm the account email before deletion'); END IF;
  SELECT coalesce(array_agg(m.vault_id ORDER BY m.vault_id),ARRAY[]::varchar[]) INTO private_boxes FROM vault_memberships m
    WHERE m.user_id=actor AND m.role='owner' AND NOT EXISTS(SELECT 1 FROM vault_memberships o WHERE o.vault_id=m.vault_id AND o.user_id<>actor);
  IF EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=ANY(membership_boxes) AND NOT box_id=ANY(private_boxes)) THEN
    RETURN passshare_encrypted_error(409,'PS049','Leave surviving encrypted password boxes through atomic rotation before retirement');
  END IF;
  IF EXISTS(SELECT 1 FROM vault_memberships m WHERE m.user_id=actor AND m.role='owner'
    AND EXISTS(SELECT 1 FROM vault_memberships o WHERE o.vault_id=m.vault_id AND o.user_id<>actor)
    AND NOT EXISTS(SELECT 1 FROM vault_memberships o WHERE o.vault_id=m.vault_id AND o.user_id<>actor AND o.role='owner')) THEN
    RETURN passshare_encrypted_error(409,'PS049','Transfer shared password box ownership before deleting the account');
  END IF;
  DELETE FROM connect_vaults WHERE id=ANY(private_boxes);
  DELETE FROM mutation_operations m WHERE m.actor=passshare_legacy_retire.actor::text OR m.resource=ANY(private_boxes::text[]);
  DELETE FROM vault_invitations WHERE invitee_email=user_email AND vault_id=ANY(locked_boxes);
  DELETE FROM login_failures WHERE email=user_email;
  DELETE FROM users WHERE id=actor;
  IF session_deadline IS NULL OR session_deadline<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0024',MESSAGE='PS024: Session is invalid or expired';
  END IF;
  RETURN jsonb_build_object('status',204);
EXCEPTION WHEN SQLSTATE 'P0024' THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
END $$;

CREATE OR REPLACE FUNCTION passshare_legacy_invite_change(actor UUID, session_id UUID, box VARCHAR, operation TEXT,
  invitation_id UUID, invitee TEXT, next_role TEXT, expiration TIMESTAMPTZ, proof TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE access_reply JSONB; user_email TEXT; invitation vault_invitations%ROWTYPE; sender UUID;
BEGIN
  IF operation='decline' THEN
    SELECT vault_id,inviter_id INTO box,sender FROM vault_invitations WHERE id=invitation_id;
    IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS039','Invitation not found'); END IF;
  END IF;
  access_reply:=passshare_membership_lock(actor,session_id,box,coalesce(sender,actor),operation<>'decline');
  IF access_reply->>'status'<>'200' THEN RETURN access_reply; END IF;
  SELECT email INTO user_email FROM users WHERE id=actor;
  IF operation='create' THEN
    IF next_role IS DISTINCT FROM 'member' OR expiration IS NULL OR expiration<=clock_timestamp() OR proof IS NULL OR proof !~ '^[0-9a-f]{64}$' THEN
      RETURN passshare_encrypted_error(400,'PS033','Invalid invitation');
    END IF;
    IF invitee=user_email THEN RETURN passshare_encrypted_error(400,'PS042','Cannot invite yourself'); END IF;
    IF EXISTS(SELECT 1 FROM vault_memberships m JOIN users u ON u.id=m.user_id WHERE m.vault_id=box AND u.email=invitee AND passshare_membership_active(m.role,m.confirmed_at)) THEN
      RETURN passshare_encrypted_error(409,'PS037','User is already a member of this password box');
    END IF;
    IF EXISTS(SELECT 1 FROM vault_invitations WHERE vault_id=box AND invitee_email=invitee AND status='pending' AND expires_at>clock_timestamp()) THEN
      RETURN passshare_encrypted_error(409,'PS038','A pending invitation already exists for this email');
    END IF;
    UPDATE vault_invitations SET status='expired',responded_at=clock_timestamp() WHERE vault_id=box AND invitee_email=invitee AND status='pending' AND expires_at<=clock_timestamp();
    INSERT INTO vault_invitations(id,vault_id,inviter_id,invitee_email,role,expires_at,confirmation_hash)
      VALUES(invitation_id,box,actor,invitee,next_role,expiration,proof);
  ELSIF operation IN ('revoke','decline') THEN
    SELECT * INTO invitation FROM vault_invitations WHERE vault_id=box AND id=invitation_id;
    IF NOT FOUND OR invitation.status<>'pending' OR (operation='decline' AND invitation.invitee_email<>user_email) THEN
      RETURN passshare_encrypted_error(404,'PS039','Invitation not found');
    END IF;
    UPDATE vault_invitations SET status=CASE WHEN operation='revoke' THEN 'revoked' ELSE 'declined' END,responded_at=clock_timestamp() WHERE id=invitation_id;
  ELSE RETURN passshare_encrypted_error(400,'PS051','Invalid invitation operation'); END IF;
  PERFORM passshare_require_live_session(actor,session_id);
  RETURN jsonb_build_object('status',204);
EXCEPTION
WHEN SQLSTATE 'P0024' THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
 END $$;
