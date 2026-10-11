-- Authoritative monotonically increasing legacy generation. Contains no DTO,
-- plaintext fingerprint, name, binary or key. Never reset after delete/reinsert.
CREATE TABLE IF NOT EXISTS encrypted_migration_sources (
  box_id varchar(26) PRIMARY KEY REFERENCES connect_vaults(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  auth_binding text NOT NULL
);
CREATE TABLE IF NOT EXISTS encrypted_migrations (
  box_id varchar(26) NOT NULL REFERENCES connect_vaults(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  header jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','committed','aborted')),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',
  PRIMARY KEY(box_id,operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS encrypted_migration_pending ON encrypted_migrations(box_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS encrypted_migration_items (
  box_id varchar(26) NOT NULL, operation_id uuid NOT NULL,
  source_id varchar(26) NOT NULL, item_id varchar(26) NOT NULL,
  payload jsonb NOT NULL CHECK(octet_length(payload::text)<=1800000),
  PRIMARY KEY(box_id,operation_id,item_id), UNIQUE(box_id,operation_id,source_id),
  FOREIGN KEY(box_id,operation_id) REFERENCES encrypted_migrations(box_id,operation_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS encrypted_migration_files (
  box_id varchar(26) NOT NULL, operation_id uuid NOT NULL,
  item_id varchar(26) NOT NULL, attachment_id varchar(26) NOT NULL,
  source_id varchar(26) NOT NULL, envelope jsonb NOT NULL,
  PRIMARY KEY(box_id,operation_id,attachment_id), UNIQUE(box_id,operation_id,source_id),
  FOREIGN KEY(box_id,operation_id,item_id) REFERENCES encrypted_migration_items(box_id,operation_id,item_id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION passshare_migration_bump(box varchar) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE encrypted_migration_sources SET revision=revision+1 WHERE box_id=box;
END $$;
CREATE OR REPLACE FUNCTION passshare_migration_budget(bytes bigint, files bigint) RETURNS boolean LANGUAGE SQL IMMUTABLE AS $$
  SELECT (bytes BETWEEN 0 AND 1073741824 AND files BETWEEN 0 AND 1024) IS TRUE
$$;
-- Legacy item/file writers, including feature-flag-off instances and old store
-- adapters, share the same parent lock as commit. DELETE is also serialized.
CREATE OR REPLACE FUNCTION passshare_migration_legacy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_box varchar; new_box varchar; b varchar;
BEGIN
  IF TG_TABLE_NAME='connect_items' THEN
    IF TG_OP<>'INSERT' THEN old_box:=OLD.vault_id; END IF;
    IF TG_OP<>'DELETE' THEN new_box:=NEW.vault_id; END IF;
  ELSIF TG_TABLE_NAME='connect_item_files' THEN
    IF TG_OP<>'INSERT' THEN SELECT vault_id INTO old_box FROM connect_items WHERE id=OLD.item_id; END IF;
    IF TG_OP<>'DELETE' THEN SELECT vault_id INTO new_box FROM connect_items WHERE id=NEW.item_id; END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN old_box:=OLD.vault_id; END IF;
    IF TG_OP<>'DELETE' THEN new_box:=NEW.vault_id; END IF;
  END IF;
  FOR b IN SELECT DISTINCT v FROM unnest(ARRAY[old_box,new_box]) v WHERE v IS NOT NULL ORDER BY v LOOP
    PERFORM id FROM connect_vaults WHERE id=b FOR UPDATE;
    IF TG_TABLE_NAME IN ('connect_items','connect_item_files') AND TG_OP<>'DELETE'
        AND EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=b) THEN
      RAISE EXCEPTION USING ERRCODE='P0055',MESSAGE='PS055: Ciphertext storage required';
    END IF;
    PERFORM passshare_migration_bump(b);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['connect_items','connect_item_files','vault_memberships','vault_invitations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS passshare_migration_legacy_guard ON %I',t);
    EXECUTE format('CREATE TRIGGER passshare_migration_legacy_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION passshare_migration_legacy_guard()',t);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION passshare_migration_box_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM passshare_migration_bump(OLD.id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passshare_migration_box_guard ON connect_vaults;
CREATE TRIGGER passshare_migration_box_guard BEFORE UPDATE ON connect_vaults FOR EACH ROW EXECUTE FUNCTION passshare_migration_box_guard();

-- Validate unmodified DTO routing and complete metadata associations. NULL
-- content is explicitly unavailable, not an empty file. Its independently
-- prepared envelope is still required; only the caller can authenticate bytes.
CREATE OR REPLACE FUNCTION passshare_migration_inventory_valid(box varchar) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE row record; f jsonb; seen text[]:=ARRAY[]::text[]; meta connect_item_files%ROWTYPE; n bigint:=0;
BEGIN
  FOR row IN SELECT * FROM connect_items WHERE vault_id=box LOOP
    IF jsonb_typeof(row.document) IS DISTINCT FROM 'object' OR row.document->>'id' IS DISTINCT FROM row.id
      OR row.document->'vault'->>'id' IS DISTINCT FROM box OR NOT passshare_safe_number(row.document->'version',1)
      OR octet_length(row.document::text)>1048576 THEN RETURN false; END IF;
    IF row.document ? 'attachments' AND jsonb_typeof(row.document->'attachments') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    FOR f IN SELECT value FROM jsonb_array_elements(COALESCE(row.document->'attachments','[]'::jsonb)) LOOP
      IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(f->'attachmentId') IS DISTINCT FROM 'string'
        OR (f->>'attachmentId') !~ '^[a-z0-9]{26}$' OR NOT passshare_safe_number(f->'attachmentVersion',1)
        OR NOT passshare_safe_number(f->'keyEpoch',1) OR f->>'attachmentId'=ANY(seen) THEN RETURN false; END IF;
      seen:=array_append(seen,f->>'attachmentId'); n:=n+1;
      IF n>1024 THEN RETURN false; END IF;
      SELECT * INTO meta FROM connect_item_files WHERE id=f->>'attachmentId' AND item_id=row.id;
      IF NOT FOUND OR meta.size<0 OR meta.size>1048576 OR octet_length(meta.name)>4096
        OR (meta.content IS NOT NULL AND octet_length(meta.content)<>meta.size)
        OR (f ? 'name' AND f->>'name' IS DISTINCT FROM meta.name)
        OR (f ? 'contentBytes' AND (NOT passshare_safe_number(f->'contentBytes',0) OR (f->>'contentBytes')::bigint<>meta.size)) THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN n=(SELECT count(*) FROM connect_item_files f JOIN connect_items i ON i.id=f.item_id WHERE i.vault_id=box);
END $$;

CREATE OR REPLACE FUNCTION passshare_migration_binding_valid(box varchar, payload jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE b jsonb:=payload->'binding'; s jsonb:=b->'source'; t jsonb:=b->'target'; d jsonb; pair jsonb; ref jsonb; idx integer:=0;
  sources text[]:=ARRAY[]::text[]; targets text[]:=ARRAY[]::text[];
BEGIN
  IF NOT passshare_exact_object(payload,ARRAY['binding','envelope']) OR NOT passshare_exact_object(b,ARRAY['source','target','attachments'])
    OR NOT passshare_exact_object(s,ARRAY['passwordBoxId','itemId','itemVersion','keyEpoch'])
    OR NOT passshare_exact_object(t,ARRAY['passwordBoxId','itemId','itemVersion','keyEpoch'])
    OR s->>'passwordBoxId' IS DISTINCT FROM box OR t->>'passwordBoxId' IS DISTINCT FROM box
    OR NOT passshare_safe_number(s->'itemVersion',1) OR NOT passshare_safe_number(s->'keyEpoch',1)
    OR t->'itemVersion' IS DISTINCT FROM s->'itemVersion' OR t->>'keyEpoch' IS DISTINCT FROM '1'
    OR jsonb_typeof(b->'attachments') IS DISTINCT FROM 'array'
    OR NOT passshare_item_shape(payload->'envelope',box,t->>'itemId',(t->>'itemVersion')::bigint,1) THEN RETURN false; END IF;
  SELECT document INTO d FROM connect_items WHERE vault_id=box AND id=s->>'itemId';
  IF NOT FOUND OR d->'version' IS DISTINCT FROM s->'itemVersion'
    OR jsonb_array_length(COALESCE(d->'attachments','[]'::jsonb))<>jsonb_array_length(b->'attachments') THEN RETURN false; END IF;
  IF t->>'itemId'<>s->>'itemId' AND EXISTS(SELECT 1 FROM connect_items WHERE vault_id=box AND id=t->>'itemId') THEN RETURN false; END IF;
  FOR pair IN SELECT value FROM jsonb_array_elements(b->'attachments') LOOP
    ref:=d->'attachments'->idx; idx:=idx+1;
    IF NOT passshare_exact_object(pair,ARRAY['source','target'])
      OR NOT passshare_exact_object(pair->'source',ARRAY['passwordBoxId','itemId','attachmentId','attachmentVersion','keyEpoch'])
      OR NOT passshare_exact_object(pair->'target',ARRAY['passwordBoxId','itemId','attachmentId','attachmentVersion','keyEpoch'])
      OR pair->'source'->>'passwordBoxId' IS DISTINCT FROM box OR pair->'target'->>'passwordBoxId' IS DISTINCT FROM box
      OR pair->'source'->>'itemId' IS DISTINCT FROM s->>'itemId' OR pair->'target'->>'itemId' IS DISTINCT FROM t->>'itemId'
      OR pair->'source'->'keyEpoch' IS DISTINCT FROM s->'keyEpoch' OR pair->'target'->>'keyEpoch' IS DISTINCT FROM '1'
      OR pair->'source'->'attachmentId' IS DISTINCT FROM ref->'attachmentId'
      OR pair->'source'->'attachmentVersion' IS DISTINCT FROM ref->'attachmentVersion'
      OR pair->'source'->'keyEpoch' IS DISTINCT FROM ref->'keyEpoch'
      OR pair->'target'->'attachmentVersion' IS DISTINCT FROM ref->'attachmentVersion'
      OR (pair->'target'->>'attachmentId') !~ '^[a-z0-9]{26}$'
      OR pair->'source'->>'attachmentId'=ANY(sources) OR pair->'target'->>'attachmentId'=ANY(targets) THEN RETURN false; END IF;
    sources:=array_append(sources,pair->'source'->>'attachmentId'); targets:=array_append(targets,pair->'target'->>'attachmentId');
    IF pair->'target'->>'attachmentId'<>pair->'source'->>'attachmentId' AND EXISTS(
      SELECT 1 FROM connect_item_files f JOIN connect_items i ON i.id=f.item_id WHERE i.vault_id=box AND f.id=pair->'target'->>'attachmentId') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN data_exception THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION passshare_migration_operation(actor uuid, session_id uuid, box varchar, operation text,
  op_id uuid, item varchar, file_id varchar, request jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE source encrypted_migration_sources%ROWTYPE; migration encrypted_migrations%ROWTYPE; saved jsonb; binding jsonb;
  user_version text; item_count bigint; file_count bigint; total bigint; rows jsonb; cursor_id varchar; expected bigint;
BEGIN
  PERFORM id FROM connect_vaults WHERE id=box FOR UPDATE;
  IF NOT FOUND THEN RETURN passshare_encrypted_error(404,'PS044','Password box not found'); END IF;
  PERFORM id FROM users WHERE id=actor FOR SHARE;
  PERFORM id FROM sessions WHERE id=session_id AND user_id=actor FOR SHARE;
  PERFORM user_id FROM vault_memberships WHERE vault_id=box ORDER BY user_id FOR UPDATE;
  PERFORM id FROM vault_invitations WHERE vault_id=box ORDER BY id FOR UPDATE;
  SELECT * INTO source FROM encrypted_migration_sources WHERE box_id=box FOR UPDATE;
  PERFORM operation_id FROM encrypted_migrations WHERE box_id=box AND (operation_id=op_id OR status='pending') ORDER BY operation_id FOR UPDATE;
  SELECT * INTO migration FROM encrypted_migrations WHERE box_id=box AND operation_id=op_id;
  IF operation='commit' THEN
    PERFORM id FROM connect_items WHERE vault_id=box ORDER BY id FOR UPDATE;
    PERFORM f.id FROM connect_item_files f JOIN connect_items i ON i.id=f.item_id WHERE i.vault_id=box ORDER BY f.id FOR UPDATE OF f;
    PERFORM item_id FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id ORDER BY item_id FOR UPDATE;
    PERFORM attachment_id FROM encrypted_migration_files WHERE box_id=box AND operation_id=op_id ORDER BY attachment_id FOR UPDATE;
    PERFORM m.request_key FROM mutation_operations m WHERE m.resource=box OR (m.operation='box' AND m.result->>'vaultId'=box) ORDER BY m.actor,m.resource,m.operation,m.request_key FOR UPDATE;
  END IF;
  -- All waits precede authorization. Short per-request transactions; no lock
  -- is retained between snapshot/pages/stages. Parent writers share this lock.
  IF NOT EXISTS(SELECT 1 FROM sessions WHERE id=session_id AND user_id=actor AND expires_at>clock_timestamp()) THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired'); END IF;
  IF NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id=box AND user_id=actor AND role='owner' AND passshare_membership_active(role,confirmed_at)) THEN RETURN passshare_encrypted_error(403,'PS016','Password box owner required'); END IF;
  IF (SELECT count(*) FROM vault_memberships WHERE vault_id=box)<>1 OR EXISTS(SELECT 1 FROM vault_invitations WHERE vault_id=box) THEN RETURN passshare_encrypted_error(409,'PS015','Migration currently requires sole owner and no invitations'); END IF;
  SELECT encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex') INTO user_version FROM users u WHERE id=actor;
  IF operation='status' AND migration.operation_id IS NOT NULL THEN
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('status',migration.status,'expired',migration.expires_at<=clock_timestamp(),'header',migration.header));
  END IF;
  IF operation='abort' AND migration.status IN ('pending','aborted') THEN
    IF migration.status='pending' THEN
      UPDATE encrypted_migrations SET status='aborted' WHERE box_id=box AND operation_id=op_id;
      DELETE FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id;
    END IF;
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('status','aborted'));
  END IF;
  IF operation IN ('staged-item','staged-file') AND migration.status IN ('pending','committed') THEN
    IF migration.status='pending' AND (migration.expires_at<=clock_timestamp() OR source.auth_binding<>user_version
      OR (migration.header->>'sourceRevision')::bigint<>source.revision) THEN RETURN passshare_encrypted_error(409,'PS015','Migration expired or source changed'); END IF;
    IF operation='staged-item' THEN SELECT payload INTO saved FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id AND item_id=item;
    ELSE SELECT envelope INTO saved FROM encrypted_migration_files WHERE box_id=box AND operation_id=op_id AND item_id=item AND attachment_id=file_id; END IF;
    IF saved IS NULL THEN RETURN passshare_encrypted_error(404,'PS012','Migration stage not found'); END IF;
    RETURN jsonb_build_object('status',200,'body',saved);
  END IF;
  IF migration.status='committed' THEN
    IF operation='commit' THEN RETURN jsonb_build_object('status',200,'body',jsonb_build_object('status','committed','operationId',op_id)); END IF;
    -- Exact header and ciphertext replay is checked against immutable stages,
    -- including after response loss. Changed content never earns success.
    IF operation='start' AND migration.header=request THEN RETURN jsonb_build_object('status',200,'body',jsonb_build_object('status','committed')); END IF;
    IF operation='stage-item' THEN SELECT payload INTO saved FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id AND item_id=item;
    ELSIF operation='stage-file' THEN SELECT jsonb_build_object('envelope',envelope) INTO saved FROM encrypted_migration_files WHERE box_id=box AND operation_id=op_id AND item_id=item AND attachment_id=file_id; END IF;
    IF saved=request THEN RETURN jsonb_build_object('status',200,'body',jsonb_build_object('status','committed')); END IF;
    RETURN passshare_encrypted_error(409,'PS015','Migration content conflict');
  END IF;
  IF EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id=box) THEN RETURN passshare_encrypted_error(409,'PS055','Ciphertext storage required'); END IF;
  IF NOT passshare_migration_inventory_valid(box) THEN RETURN passshare_encrypted_error(409,'PS015','Complete unambiguous source inventory required'); END IF;
  PERFORM passshare_require_live_session(actor,session_id);
  IF operation='snapshot' THEN
    IF source.box_id IS NULL THEN
      INSERT INTO encrypted_migration_sources(box_id,auth_binding) VALUES(box,user_version) RETURNING * INTO source;
    ELSIF source.auth_binding<>user_version THEN
      UPDATE encrypted_migration_sources SET revision=revision+1,auth_binding=user_version WHERE box_id=box RETURNING * INTO source;
    END IF;
  ELSE
    IF source.box_id IS NULL OR source.auth_binding<>user_version THEN RETURN passshare_encrypted_error(409,'PS015','Source authorization changed'); END IF;
  END IF;
  SELECT count(*) INTO item_count FROM connect_items WHERE vault_id=box;
  SELECT count(*) INTO file_count FROM connect_item_files f JOIN connect_items i ON i.id=f.item_id WHERE i.vault_id=box;
  IF operation='snapshot' THEN RETURN jsonb_build_object('status',200,'body',jsonb_build_object('sourcePasswordBoxId',box,'sourceRevision',source.revision,'itemCount',item_count,'attachmentCount',file_count,'keyEpoch',1)); END IF;
  IF operation IN ('items','item','file') THEN
    IF NOT passshare_safe_number(request->'revision',1) OR (request->>'revision')::bigint<>source.revision THEN RETURN passshare_encrypted_error(409,'PS015','Source changed'); END IF;
    IF operation='items' THEN
      cursor_id:=request->>'after';
      IF cursor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM connect_items WHERE vault_id=box AND id=cursor_id) THEN RETURN passshare_encrypted_error(409,'PS015','Source cursor changed'); END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'version',document->'version') ORDER BY id),'[]'::jsonb) INTO rows
        FROM (SELECT id,document FROM connect_items WHERE vault_id=box AND (cursor_id IS NULL OR id>cursor_id) ORDER BY id LIMIT 100) page;
      RETURN jsonb_build_object('status',200,'body',jsonb_build_object('items',rows,'sourceRevision',source.revision,'after',CASE WHEN jsonb_array_length(rows)=100 THEN rows->99->>'id' ELSE NULL END));
    ELSIF operation='item' THEN
      SELECT document INTO rows FROM connect_items WHERE vault_id=box AND id=item;
    ELSE
      SELECT jsonb_build_object('id',f.id,'itemId',f.item_id,'name',f.name,'contentBytes',f.size,'available',f.content IS NOT NULL,
        'content',CASE WHEN f.content IS NOT NULL THEN replace(encode(f.content,'base64'),chr(10),'') ELSE NULL END) INTO rows
        FROM connect_item_files f JOIN connect_items i ON i.id=f.item_id WHERE i.vault_id=box AND i.id=item AND f.id=file_id;
    END IF;
    IF rows IS NULL THEN RETURN passshare_encrypted_error(404,'PS012','Source not found'); END IF;
    RETURN jsonb_build_object('status',200,'body',rows);
  END IF;
  IF operation='start' THEN
    IF NOT passshare_exact_object(request,ARRAY['format','operationId','ownerContext','sourcePasswordBoxId','sourceRevision','itemCount','attachmentCount','ownerBundle'])
      OR request->>'format'<>'1' OR request->>'operationId' IS DISTINCT FROM op_id::text OR request->>'sourcePasswordBoxId' IS DISTINCT FROM box
      OR NOT passshare_safe_number(request->'sourceRevision',1) OR (request->>'sourceRevision')::bigint<>source.revision
      OR request->'itemCount' IS DISTINCT FROM to_jsonb(item_count) OR request->'attachmentCount' IS DISTINCT FROM to_jsonb(file_count)
      OR request->'ownerContext' IS DISTINCT FROM jsonb_build_object('passwordBoxId',box,'ownerAccountId',actor,'keyEpoch',1)
      OR NOT passshare_owner_shape(request->'ownerBundle',box,actor,1) THEN RETURN passshare_encrypted_error(409,'PS015','Migration source/header conflict'); END IF;
    IF migration.operation_id IS NOT NULL THEN
      IF migration.header<>request OR migration.status<>'pending' OR migration.expires_at<=clock_timestamp() THEN RETURN passshare_encrypted_error(409,'PS015','Migration replay conflict or expired'); END IF;
      RETURN jsonb_build_object('status',200,'body',jsonb_build_object('status','pending'));
    END IF;
    -- Do not recycle IDs or silently change another plan. Explicit abort frees
    -- the one pending slot. Stages remain opaque for exact historical replay.
    IF EXISTS(SELECT 1 FROM encrypted_migrations WHERE box_id=box AND status='pending') THEN RETURN passshare_encrypted_error(409,'PS015','Pending migration requires explicit cancellation'); END IF;
    INSERT INTO encrypted_migrations(box_id,operation_id,owner_id,header) VALUES(box,op_id,actor,request);
    RETURN jsonb_build_object('status',200,'body',jsonb_build_object('status','pending'));
  END IF;
  IF migration.operation_id IS NULL THEN RETURN passshare_encrypted_error(404,'PS012','Migration not found'); END IF;
  IF migration.status<>'pending' OR migration.expires_at<=clock_timestamp()
    OR (migration.header->>'sourceRevision')::bigint<>source.revision THEN RETURN passshare_encrypted_error(409,'PS015','Migration expired or source changed'); END IF;
  IF operation='stage-item' THEN
    SELECT payload INTO saved FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id AND item_id=item;
    IF saved IS NOT NULL THEN
      IF saved<>request THEN RETURN passshare_encrypted_error(409,'PS015','Migration item replay conflict'); END IF;
    ELSE
      IF NOT passshare_migration_binding_valid(box,request) OR request->'binding'->'target'->>'itemId' IS DISTINCT FROM item
        OR EXISTS(SELECT 1 FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id AND source_id=request->'binding'->'source'->>'itemId') THEN RETURN passshare_encrypted_error(409,'PS015','Migration binding conflict'); END IF;
      -- Attachment IDs must be unique box-wide, not just per parent item.
      IF EXISTS(SELECT 1 FROM encrypted_migration_items m CROSS JOIN LATERAL jsonb_array_elements(m.payload->'binding'->'attachments') a
        CROSS JOIN jsonb_array_elements(request->'binding'->'attachments') b WHERE m.box_id=box AND m.operation_id=op_id
        AND (a->'source'->>'attachmentId'=b->'source'->>'attachmentId' OR a->'target'->>'attachmentId'=b->'target'->>'attachmentId')) THEN RETURN passshare_encrypted_error(409,'PS015','Duplicate migration attachment'); END IF;
      INSERT INTO encrypted_migration_items VALUES(box,op_id,request->'binding'->'source'->>'itemId',item,request);
    END IF;
  ELSIF operation='stage-file' THEN
    SELECT a INTO binding FROM encrypted_migration_items m CROSS JOIN LATERAL jsonb_array_elements(m.payload->'binding'->'attachments') a
      WHERE m.box_id=box AND m.operation_id=op_id AND m.item_id=item AND a->'target'->>'attachmentId'=file_id;
    IF binding IS NULL OR NOT passshare_exact_object(request,ARRAY['envelope'])
      OR NOT passshare_attachment_shape(request->'envelope',box,item,file_id,(binding->'target'->>'attachmentVersion')::bigint,1)
      OR request->'envelope'->'context' IS DISTINCT FROM binding->'target'
      OR (request->'envelope'->>'contentBytes')::bigint<>(SELECT size FROM connect_item_files WHERE id=binding->'source'->>'attachmentId') THEN RETURN passshare_encrypted_error(409,'PS015','Migration file binding conflict'); END IF;
    SELECT envelope INTO saved FROM encrypted_migration_files WHERE box_id=box AND operation_id=op_id AND attachment_id=file_id;
    IF saved IS NOT NULL THEN
      IF saved<>request->'envelope' THEN RETURN passshare_encrypted_error(409,'PS015','Migration file replay conflict'); END IF;
    ELSE INSERT INTO encrypted_migration_files VALUES(box,op_id,item,file_id,binding->'source'->>'attachmentId',request->'envelope'); END IF;
  ELSIF operation<>'commit' THEN RETURN passshare_encrypted_error(400,'PS051','Invalid migration operation'); END IF;
  SELECT COALESCE(sum(octet_length(decode(payload->'envelope'->>'ciphertext','base64'))-16),0) INTO total FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id;
  SELECT total+COALESCE(sum(octet_length(decode(envelope->>'ciphertext','base64'))-20),0) INTO total FROM encrypted_migration_files WHERE box_id=box AND operation_id=op_id;
  IF NOT passshare_migration_budget(total,file_count) THEN RAISE EXCEPTION USING ERRCODE='P0015',MESSAGE='PS015: Migration byte budget exceeded'; END IF;
  IF operation<>'commit' THEN RETURN jsonb_build_object('status',200,'body',jsonb_build_object('status','pending')); END IF;
  IF item_count<>(SELECT count(*) FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id)
    OR file_count<>(SELECT count(*) FROM encrypted_migration_files WHERE box_id=box AND operation_id=op_id)
    OR EXISTS(SELECT 1 FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id AND NOT passshare_migration_binding_valid(box,payload))
    OR EXISTS(SELECT 1 FROM connect_items i WHERE i.vault_id=box AND NOT EXISTS(SELECT 1 FROM encrypted_migration_items m WHERE m.box_id=box AND m.operation_id=op_id AND m.source_id=i.id))
    OR EXISTS(SELECT 1 FROM encrypted_migration_files f WHERE f.box_id=box AND f.operation_id=op_id AND NOT EXISTS(
      SELECT 1 FROM encrypted_migration_items m CROSS JOIN LATERAL jsonb_array_elements(m.payload->'binding'->'attachments') a
      JOIN connect_item_files original ON original.id=a->'source'->>'attachmentId'
      WHERE m.box_id=box AND m.operation_id=op_id AND m.item_id=f.item_id
        AND a->'target'=f.envelope->'context' AND a->'source'->>'attachmentId'=f.source_id
        AND passshare_attachment_shape(f.envelope,box,f.item_id,f.attachment_id,(a->'target'->>'attachmentVersion')::bigint,1)
        AND f.envelope->'contentBytes'=to_jsonb(original.size)))
    OR EXISTS(SELECT 1 FROM connect_item_files f JOIN connect_items i ON i.id=f.item_id WHERE i.vault_id=box AND NOT EXISTS(SELECT 1 FROM encrypted_migration_files m WHERE m.box_id=box AND m.operation_id=op_id AND m.source_id=f.id)) THEN RETURN passshare_encrypted_error(409,'PS015','Complete migration inventory required'); END IF;
  -- One statement transaction: any constraint/trigger/fault rolls back the
  -- state, opaque rows and every original row (including original xmin).
  PERFORM passshare_require_live_session(actor,session_id);
  INSERT INTO encrypted_box_state(box_id,key_epoch) VALUES(box,1);
  INSERT INTO encrypted_owner_keys(box_id,owner_id,revision,key_epoch,bundle) VALUES(box,actor,1,1,migration.header->'ownerBundle');
  INSERT INTO encrypted_items(box_id,item_id,revision,key_epoch,envelope)
    SELECT box,item_id,(payload->'binding'->'target'->>'itemVersion')::bigint,1,payload->'envelope' FROM encrypted_migration_items WHERE box_id=box AND operation_id=op_id;
  INSERT INTO encrypted_attachments(box_id,item_id,attachment_id,revision,key_epoch,envelope)
    SELECT box,item_id,attachment_id,(envelope->'context'->>'attachmentVersion')::bigint,1,envelope FROM encrypted_migration_files WHERE box_id=box AND operation_id=op_id;
  INSERT INTO encrypted_item_tombstones(box_id,item_id,last_live_version,key_epoch)
    SELECT box,source_id,(payload->'binding'->'source'->>'itemVersion')::bigint,1 FROM encrypted_migration_items m
      WHERE box_id=box AND operation_id=op_id AND NOT EXISTS(SELECT 1 FROM encrypted_items WHERE box_id=box AND item_id=m.source_id);
  INSERT INTO encrypted_attachment_tombstones(box_id,item_id,attachment_id,last_live_version,key_epoch,item_revision,last_request_hash,last_state_revision)
    SELECT box,m.item_id,a->'source'->>'attachmentId',(a->'source'->>'attachmentVersion')::bigint,1,
      (m.payload->'binding'->'target'->>'itemVersion')::bigint,encode(sha256(convert_to(a::text,'UTF8')),'hex'),
      (SELECT state_revision FROM encrypted_box_state WHERE box_id=box)
      FROM encrypted_migration_items m CROSS JOIN LATERAL jsonb_array_elements(m.payload->'binding'->'attachments') a
      WHERE m.box_id=box AND m.operation_id=op_id AND NOT EXISTS(SELECT 1 FROM encrypted_attachments WHERE box_id=box AND item_id=m.item_id AND attachment_id=a->'source'->>'attachmentId');
  DELETE FROM mutation_operations m WHERE m.resource=box OR (m.operation='box' AND m.result->>'vaultId'=box);
  DELETE FROM connect_item_files WHERE item_id IN (SELECT id FROM connect_items WHERE vault_id=box);
  DELETE FROM connect_items WHERE vault_id=box;
  UPDATE encrypted_migrations SET status='committed' WHERE box_id=box AND operation_id=op_id;
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('status','committed','operationId',op_id));
EXCEPTION
  WHEN SQLSTATE 'P0024' THEN RETURN passshare_encrypted_error(401,'PS024','Session is invalid or expired');
  WHEN SQLSTATE 'P0015' OR numeric_value_out_of_range THEN RETURN passshare_encrypted_error(409,'PS015','Migration limit or state conflict');
END $$;
