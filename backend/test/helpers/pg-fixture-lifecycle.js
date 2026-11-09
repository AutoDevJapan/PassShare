export function trackPoolShutdown(pool) {
  if(pool.totalCount!==0)throw Error('Track fixture connections before first use');
  const pending=new Set();
  const connected=client=>{
    const ended=new Promise(resolve=>client.once('end',resolve));
    pending.add(ended);
    ended.then(()=>pending.delete(ended));
  };
  pool.on('connect',connected);
  let closing;
  return () => closing ??= (async()=>{
    try {
      await pool.end();
      // pg-pool removes clients before their socket-end callbacks finish.
      // A database must not be dropped while those connections still exist.
      await Promise.all([...pending]);
    }finally{pool.removeListener('connect',connected);}
  })();
}
