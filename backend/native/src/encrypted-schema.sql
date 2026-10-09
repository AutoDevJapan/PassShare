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
      OR EXISTS(SELECT 1 FROM encrypted_items WHERE box_id=box) THEN
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
  IF operation<>'put' OR previous IS NULL OR previous<0 OR previous>=9007199254740991 OR body IS NULL THEN
    RETURN passshare_encrypted_error(400,'PS051','Invalid encrypted storage request');
  END IF;
  IF membership_role NOT IN ('owner','member') THEN RETURN passshare_encrypted_error(403,'PS032','Write access required'); END IF;
  IF epoch IS DISTINCT FROM active_epoch THEN RETURN passshare_encrypted_error(409,'PS056','Key epoch changed'); END IF;
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
