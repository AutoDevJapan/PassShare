// Inspect real pg Client parsing, replacing only network transport. No database
// or provider is contacted; no credentials are emitted by this fixture.
import pg from 'pg';
pg.Client.prototype.connect=async function(){
 const p=this.connectionParameters;
 console.log(JSON.stringify({fixtureTransport:true,host:p.host,ssl:p.ssl,sslnegotiation:p.sslnegotiation,applicationName:p.application_name}));
 if(process.env.PASSSHARE_RECOVERY_TRANSPORT_SOURCE==='true'&&p.application_name==='passshare-offline-deletion-recovery')return;
 throw Error('Stopped before any network transport');
};
pg.Client.prototype.end=async function(){};
