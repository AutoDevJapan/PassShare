import {test}from'node:test';import assert from'node:assert/strict';import{toItemOverview}from'../src/lib/connect.js';
test('list metadata preserves existing search and card data without passwords or full notes',()=>{
 const item={id:'synthetic',title:'title',category:'LOGIN',favorite:true,tags:['tag'],urls:[{href:'https://example.test',primary:true}],fields:[{purpose:'USERNAME',value:'user'},{purpose:'PASSWORD',value:'synthetic-secret'},{label:'notes',value:'n'.repeat(200)}]};const row=toItemOverview(item);
 assert.equal(row.username,'user');assert.equal(row.favorite,true);assert.equal(row.hasPassword,true);assert.equal(row.hasBody,true);assert.equal(row.bodyPreview.length,80);assert.equal(JSON.stringify(row).includes('synthetic-secret'),false);assert.equal('fields'in row,false);
});
