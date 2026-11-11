import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseDeletionJournal} from './commercial-deletion-journal.js';

// An explicit operator destination outside the database/archive, never inferred
// from a backup. This is a verified local copy, not proof of off-host retention.
export function preserveJournalCopy(bytes,{expectedSha256,expectedSourceId,target}){
 parseDeletionJournal(bytes,{expectedSha256,expectedSourceId});
 if(!path.isAbsolute(target))throw Error('Absolute independent journal destination required');
 target=path.resolve(target);const parent=path.dirname(target);if(path.relative(fs.realpathSync(parent),parent)!=='')throw Error('Plain canonical destination required');
 const fd=fs.openSync(target,'wx+',0o600);let identity,complete=false,originalError;
 const ownsPath=()=>{try{const s=fs.lstatSync(target,{bigint:true});return s.isFile()&&!s.isSymbolicLink()&&s.dev===identity.dev&&s.ino===identity.ino;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
 try{identity=fs.fstatSync(fd,{bigint:true});fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);if(fs.fstatSync(fd).size!==bytes.length)throw Error('Independent journal readback length mismatch');const actual=Buffer.alloc(bytes.length);let offset=0;while(offset<actual.length){const n=fs.readSync(fd,actual,offset,actual.length-offset,offset);if(!n)throw Error('Independent journal readback incomplete');offset+=n;}const extra=Buffer.alloc(1);if(fs.readSync(fd,extra,0,1,bytes.length)!==0||fs.fstatSync(fd).size!==bytes.length)throw Error('Independent journal readback has trailing bytes');if(createHash('sha256').update(actual).digest('hex')!==expectedSha256)throw Error('Independent journal readback mismatch');if(!ownsPath())throw Error('Independent journal destination disappeared or changed');complete=true;return{sha256:expectedSha256,sourceId:expectedSourceId,bytes:bytes.length,offHostRetentionProven:false};}
 catch(error){originalError=error;throw error;}
 finally{let closeError;try{fs.closeSync(fd);}catch(e){closeError=e;}if(originalError||closeError){const error=new AggregateError([originalError,closeError].filter(Boolean),'Journal copy failed; destination requires owner verification before retry');error.copyMayRemain=true;error.cleanupRequired=true;error.copyVerifiedBeforeClose=complete;throw error;}}
}
