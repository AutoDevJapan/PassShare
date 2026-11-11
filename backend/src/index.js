import { createApp } from "./app.js";
import {startDueDeletionWorker} from './commercial-deletion-worker.js';

const port = Number(process.env.PORT ?? 8080);
const appEnv = process.env.APP_ENV ?? "local";
const { app,pool } = await createApp();

const server=app.listen(port, () => {
  console.log(`pass-share-backend listening on ${port} (${appEnv})`);
});
const due=startDueDeletionWorker(pool);
let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;await due.stop();await new Promise(resolve=>server.close(resolve));if(pool)await pool.end();}
process.once('SIGTERM',()=>{shutdown().catch(()=>{process.exitCode=1;});});
process.once('SIGINT',()=>{shutdown().catch(()=>{process.exitCode=1;});});
