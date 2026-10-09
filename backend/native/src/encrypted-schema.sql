-- Additive schema. Existing boxes remain on the compatibility path. An owner
-- can opt an EMPTY box into ciphertext-only storage; there is no downgrade.
CREATE TABLE IF NOT EXISTS encrypted_box_state (
  box_id VARCHAR(26) PRIMARY KEY REFERENCES connect_vaults(id) ON DELETE CASCADE,
  key_epoch BIGINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 9007199254740991),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
  SELECT * INTO current_key FROM encrypted_owner_keys WHERE box_id=box AND owner_id=actor;
  IF FOUND THEN
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
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  SELECT role INTO membership_role FROM vault_memberships
    WHERE user_id=actor AND vault_id=box AND passshare_membership_active(role,confirmed_at) FOR SHARE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(403,'PS016','Access denied to password box'); END IF;
  SELECT key_epoch INTO active_epoch FROM encrypted_box_state WHERE box_id=box;
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
  SELECT key_epoch INTO active_epoch FROM encrypted_box_state WHERE box_id=box;
  IF active_epoch IS NULL THEN RETURN passshare_encrypted_error(409,'PS055','Encrypted storage is not enabled'); END IF;
  SELECT * INTO current_key FROM encrypted_owner_keys WHERE box_id=box AND owner_id=actor;
  IF operation='get' THEN
    IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS012','Owner key bundle not found'); END IF;
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
  INSERT INTO encrypted_owner_keys(box_id,owner_id,revision,key_epoch,bundle)
    VALUES(box,actor,previous+1,epoch,body)
    ON CONFLICT(box_id,owner_id) DO UPDATE SET revision=EXCLUDED.revision,key_epoch=EXCLUDED.key_epoch,bundle=EXCLUDED.bundle,updated_at=NOW();
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('bundleVersion',previous+1,'bundle',body));
END $$;
