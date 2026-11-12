import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeZip} from './helpers/1pux-zip.js';
import {parse1puxBuffer,map1puxItemToConnectBody} from '../src/lib/1pux-import.js';

function archive(entries){
 const locals=[],centrals=[];let offset=0;
 for(const [name,bytes] of entries){
  const zip=makeZip(name,bytes),end=zip.length-22,centralOffset=zip.readUInt32LE(end+16);
  const local=zip.subarray(0,centralOffset),central=Buffer.from(zip.subarray(centralOffset,end));
  central.writeUInt32LE(offset,42);locals.push(local);centrals.push(central);offset+=local.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
test('official hierarchy and document references retain source, Unicode name and exact binary',async()=>{
 const bytes=Buffer.from([0,255,7,0,128,9]);
 const data={accounts:[{attrs:{uuid:'account'},vaults:[{attrs:{uuid:'vault',name:'Synthetic'},items:[{uuid:'item',categoryUuid:'001',overview:{title:'Synthetic'},details:{notesPlain:'synthetic note',loginFields:[{designation:'password',value:'synthetic-only'}],documentAttributes:{documentId:'document',fileName:'添付-é.bin',decryptedSize:bytes.length}}}]}]}]};
 const zip=archive([['export.attributes',Buffer.from('{"version":3}')],['export.data',Buffer.from(JSON.stringify(data))],['files/document___添付-é.bin',bytes]]);
 const items=await parse1puxBuffer(zip);assert.equal(items.length,1);assert.equal(items[0].importSource.vault.uuid,'vault');
 assert.equal(items[0].importAttachments[0].name,'添付-é.bin');assert.deepEqual(Buffer.from(items[0].importAttachments[0].base64,'base64'),bytes);
 const body=map1puxItemToConnectBody(items[0],{forReplay:true});assert.equal(body.category,'LOGIN');assert.equal(body.fields.find(field=>field.label==='notes').value,'synthetic note');assert.equal('details' in body.importedItem,false);assert.equal('fields' in body.importedItem,false);assert.equal('importAttachments' in body.importedItem,false);
 await assert.rejects(parse1puxBuffer(archive([['export.data',Buffer.from(JSON.stringify(data))]])),/Missing or ambiguous/);
 await assert.rejects(parse1puxBuffer(zip,{maxDecompressedBytes:10}));
 const [doubleSeparator]=await parse1puxBuffer(archive([['export.data',Buffer.from(JSON.stringify(data))],['files/document__添付-é.bin',bytes]]));
 assert.deepEqual(Buffer.from(doubleSeparator.importAttachments[0].base64,'base64'),bytes);
});
test('official URLs and section values preserve client-facing values',async()=>{
 const original={accounts:[{vaults:[{items:[{uuid:'item',categoryUuid:'001',overview:{title:'Synthetic',urls:[{url:'https://example.test/login',label:'work'}]},details:{sections:[{fields:[{id:'password',value:{concealed:'synthetic-secret'}},{id:'username',value:{string:'synthetic-user'}}]}]}}]}]}]};
 const [item]=await parse1puxBuffer(Buffer.from(JSON.stringify(original)));
 const body=map1puxItemToConnectBody(item,{forReplay:true});
 assert.equal(body.urls[0].href,'https://example.test/login');
 assert.equal(body.urls[0].label,'work');
 assert.equal(body.fields[0].value,'synthetic-secret');
 assert.equal(body.fields[0].type,'CONCEALED');
 assert.equal(body.fields[1].value,'synthetic-user');
 assert.equal(body.importedItem.uuid,'item');
 assert.equal('details' in body.importedItem,false);
 const overview=original.accounts[0].vaults[0].items[0].overview;
 overview.url='https://primary.example.test/';
 const [primaryOnly]=await parse1puxBuffer(Buffer.from(JSON.stringify(original)));
 assert.equal(primaryOnly.urls.find(url=>url.primary).href,overview.url);
 overview.urls.push({url:overview.url,label:'primary'});
 const [primaryLast]=await parse1puxBuffer(Buffer.from(JSON.stringify(original)));
 assert.equal(primaryLast.urls.find(url=>url.primary).href,overview.url);
 original.accounts[0].vaults[0].items[0].details.loginFields=[{fieldType:'P',value:'synthetic-form-secret'}];
 const [formPassword]=await parse1puxBuffer(Buffer.from(JSON.stringify(original)));
 assert.equal(formPassword.fields[0].type,'CONCEALED');
 assert.equal(formPassword.fields[0].value,'synthetic-form-secret');
});
