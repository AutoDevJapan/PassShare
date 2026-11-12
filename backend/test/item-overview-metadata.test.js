import {test}from'node:test';import assert from'node:assert/strict';import{toItemOverview}from'../src/lib/connect.js';
import fs from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
test('metadata selection matches the actual shared detail mapper across field combinations',async()=>{
 const source=await fs.readFile(new URL('../../shared/cloud/connect-items.ts',import.meta.url),'utf8');
 const js=stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm,'').replaceAll('export function','function'));
 const exports=Function(js+';return {connectItemFromApi};')();
 const choices=[[],[{label:'notes',value:''}],[{label:'notes',value:'note',type:'STRING'}],[{label:'notes',value:'secret',type:'CONCEALED'}],[{label:'notes',value:''},{label:'notes',value:'later'}],[{label:'body',value:'body'}],[{label:'body',value:'hidden-body',type:'concealed'}]];
 let count=0;for(const left of choices)for(const right of choices){const item={id:'synthetic',category:'SECURE_NOTE',title:'synthetic',fields:[...left,...right]};const detail=exports.connectItemFromApi(item),metadata=toItemOverview(item);assert.equal(metadata.hasBody,Boolean(detail.body));const first=label=>item.fields.find(f=>f.label.toLowerCase()===label);const selected=first('notes')?.value?first('notes'):first('body');const hidden=selected?.type?.toUpperCase()==='CONCEALED';assert.equal(metadata.bodyPreview,hidden?'':(detail.body??'').slice(0,81));count++;}assert.equal(count,49);
});
test('list metadata preserves existing search and card data without passwords or full notes',()=>{
 const item={id:'synthetic',title:'title',category:'LOGIN',favorite:true,tags:['tag'],urls:[{href:'https://example.test',primary:true}],fields:[{purpose:'USERNAME',value:'user'},{purpose:'PASSWORD',value:'synthetic-secret'},{label:'notes',value:'n'.repeat(200)}]};const row=toItemOverview(item);
 assert.equal(row.username,'user');assert.equal(row.favorite,true);assert.equal(row.hasPassword,true);assert.equal(row.hasBody,true);assert.equal(row.bodyPreview.length,81);assert.equal(JSON.stringify(row).includes('synthetic-secret'),false);assert.equal('fields'in row,false);
});
test('concealed notes retain copy availability without disclosing the body preview',()=>{
 const row=toItemOverview({category:'SECURE_NOTE',fields:[{label:'notes',type:'CONCEALED',value:'synthetic-only-note'}]});
 assert.equal(row.hasBody,true);assert.equal(row.bodyPreview,'');assert.equal(JSON.stringify(row).includes('synthetic-only-note'),false);
});
test('body availability follows the existing first matching notes and body selection',()=>{
 assert.equal(toItemOverview({fields:[{label:'notes',value:''},{label:'notes',type:'CONCEALED',value:'hidden-later'}]}).hasBody,false);
 assert.equal(toItemOverview({fields:[{label:'notes',value:''},{label:'body',type:'CONCEALED',value:'body'}]}).hasBody,true);
 const mixed=toItemOverview({fields:[{label:'notes',type:'CONCEALED',value:'hidden-notes'},{label:'body',value:'different-body'}]});assert.equal(mixed.hasBody,true);assert.equal(mixed.bodyPreview,'');assert.equal(JSON.stringify(mixed).includes('different-body'),false);
});
test('legacy malformed fields do not break the shared list projection',()=>{
 for(const fields of ['oops',[null],[{purpose:1}],[{label:'notes',value:123}]])assert.doesNotThrow(()=>toItemOverview({id:'synthetic',fields}));
 assert.equal(toItemOverview({fields:[{label:'notes',value:''},{label:'body',value:'body'}]}).bodyPreview,'body');
 for(const type of ['CONCEALED','concealed','Concealed'])assert.equal(JSON.stringify(toItemOverview({fields:[{label:'notes',type,value:'synthetic-secret'},{purpose:'USERNAME',type,value:'synthetic-secret'}]})).includes('synthetic-secret'),false);
});
