import {test}from'node:test';import assert from'node:assert/strict';import{toItemOverview}from'../src/lib/connect.js';
test('list metadata preserves existing search and card data without passwords or full notes',()=>{
 const item={id:'synthetic',title:'title',category:'LOGIN',favorite:true,tags:['tag'],urls:[{href:'https://example.test',primary:true}],fields:[{purpose:'USERNAME',value:'user'},{purpose:'PASSWORD',value:'synthetic-secret'},{label:'notes',value:'n'.repeat(200)}]};const row=toItemOverview(item);
 assert.equal(row.username,'user');assert.equal(row.favorite,true);assert.equal(row.hasPassword,true);assert.equal(row.hasBody,true);assert.equal(row.bodyPreview.length,81);assert.equal(JSON.stringify(row).includes('synthetic-secret'),false);assert.equal('fields'in row,false);
});
test('concealed notes retain copy availability without disclosing the body preview',()=>{
 const row=toItemOverview({category:'SECURE_NOTE',fields:[{label:'notes',type:'CONCEALED',value:'synthetic-only-note'}]});
 assert.equal(row.hasBody,true);assert.equal(row.bodyPreview,'');assert.equal(JSON.stringify(row).includes('synthetic-only-note'),false);
});
test('legacy malformed fields do not break the shared list projection',()=>{
 for(const fields of ['oops',[null],[{purpose:1}],[{label:'notes',value:123}]])assert.doesNotThrow(()=>toItemOverview({id:'synthetic',fields}));
 assert.equal(toItemOverview({fields:[{label:'notes',value:''},{label:'body',value:'body'}]}).bodyPreview,'body');
 for(const type of ['CONCEALED','concealed','Concealed'])assert.equal(JSON.stringify(toItemOverview({fields:[{label:'notes',type,value:'synthetic-secret'},{purpose:'USERNAME',type,value:'synthetic-secret'}]})).includes('synthetic-secret'),false);
});
