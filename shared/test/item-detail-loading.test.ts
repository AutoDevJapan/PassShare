import {test} from 'node:test';import assert from 'node:assert/strict';import{loadCurrentItem,loadItemDetails,loadItemOverviewPage}from'../lib/item-detail-loading.ts';
test('late detail after actor, Box, lock or encryption state change is never released',async()=>{
 for(const state of ['actor','box','locked','encrypted']){let current=true,released=false;await assert.rejects(loadCurrentItem(async()=>{current=false;return{secret:'synthetic'};},async()=>{if(!current)throw Error(state);}).then(()=>{released=true;}),new RegExp(state));assert.equal(released,false);}
});
test('expired detail authorization preserves original rejection and no cached retry',async()=>{
 let calls=0;const error=Object.assign(Error('expired'),{status:401});for(let i=0;i<2;i++)await assert.rejects(loadCurrentItem(async()=>{calls++;throw error;},async()=>{}),e=>e===error);assert.equal(calls,2);
});
test('Web metadata list loads 1000 rows in one request without full details',async()=>{
 let lists=0,details=0;const rows=Array.from({length:1000},(_,i)=>({id:String(i),username:'user'+i}));const client={listItems:async()=>{lists++;return rows;},getItem:async()=>{details++;}};
 assert.deepEqual(await loadItemOverviewPage(client,'box',async()=>{}),rows);assert.equal(lists,1);assert.equal(details,0);
});
test('a late list from a changed scope never reaches the caller',async()=>{
 let current=true;await assert.rejects(loadItemOverviewPage({listItems:async()=>{current=false;return[{id:'old'}];}},'box',async()=>{if(!current)throw Error('inactive');}),/inactive/);
});
test('1000 full sync documents retain order without a detail request burst',async()=>{
 let active=0,peak=0,calls=0;const rows=Array.from({length:1000},(_,i)=>({id:String(i)}));
 const result=await loadItemDetails(rows,async id=>{calls++;peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,0));active--;return{id,secret:'synthetic',extra:{preserved:true}};});
 assert.equal(calls,1000);assert.ok(peak<=8);assert.deepEqual(result.map(x=>x.id),rows.map(x=>x.id));assert.equal(result[999].extra.preserved,true);
});
test('failure drains started work and prevents further scheduling',async()=>{
 let calls=0,active=0;const error=Object.assign(Error('revoked'),{status:401});
 await assert.rejects(loadItemDetails(Array.from({length:1000},(_,i)=>({id:String(i)})),async id=>{calls++;active++;try{await new Promise(r=>setTimeout(r,0));if(id==='0')throw error;return id;}finally{active--;}}),e=>e===error);
 assert.ok(calls<=8);assert.equal(active,0);
});
test('scope or encryption gate rejection sends no detail request',async()=>{
 let calls=0;await assert.rejects(loadItemDetails([{id:'a'}],async()=>{calls++;},async()=>{throw Error('inactive');}),/inactive/);assert.equal(calls,0);
});
