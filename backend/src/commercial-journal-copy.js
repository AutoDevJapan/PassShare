import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseDeletionJournal} from './commercial-deletion-journal.js';

// An explicit operator destination outside the database/archive, never inferred
// from a backup. This is a verified local copy, not proof of off-host retention.
export function preserveJournalCopy(bytes,{expectedSha256,expectedSourceId,target}){
 parseDeletionJournal(bytes,{expectedSha256,expectedSourceId});
 if(!path.isAbsolute(target))throw Error('Absolute independent journal destination required');
 const parent=path.dirname(target);if(fs.realpathSync(parent)!==parent)throw Error('Plain canonical destination required');
 const fd=fs.openSync(target,'wx+',0o600);let complete=false;
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);if(fs.fstatSync(fd).size!==bytes.length)throw Error('Independent journal readback length mismatch');const actual=Buffer.alloc(bytes.length);let offset=0;while(offset<actual.length){const n=fs.readSync(fd,actual,offset,actual.length-offset,offset);if(!n)throw Error('Independent journal readback incomplete');offset+=n;}const extra=Buffer.alloc(1);if(fs.readSync(fd,extra,0,1,bytes.length)!==0||fs.fstatSync(fd).size!==bytes.length)throw Error('Independent journal readback has trailing bytes');if(createHash('sha256').update(actual).digest('hex')!==expectedSha256)throw Error('Independent journal readback mismatch');complete=true;return{sha256:expectedSha256,sourceId:expectedSourceId,bytes:bytes.length,offHostRetentionProven:false};}
 finally{fs.closeSync(fd);if(!complete)fs.unlinkSync(target);}
}
