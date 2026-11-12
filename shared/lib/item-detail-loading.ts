/** Complete ordered retrieval for consumers that really need full documents. */
export async function loadItemOverviewPage<T>(client:{listItems:(box:string)=>Promise<T[]>},box:string,ensureCurrent:()=>Promise<void>):Promise<T[]>{
  await ensureCurrent();
  const rows=await client.listItems(box);
  await ensureCurrent();
  return rows;
}
export async function loadCurrentItem<T>(fetchDetail:()=>Promise<T>,ensureCurrent:()=>Promise<void>):Promise<T>{
  await ensureCurrent();
  const item=await fetchDetail();
  await ensureCurrent();
  return item;
}

export async function loadItemDetails<T extends { id: string }, R>(
  overviews: readonly T[],
  fetchDetail: (id: string) => Promise<R>,
  ensureCurrent: () => Promise<void> = async () => {},
): Promise<R[]> {
  const result = new Array<R>(overviews.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(8, overviews.length) }, async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= overviews.length) return;
      try {
        await ensureCurrent();
        if (failed) return;
        result[index] = await fetchDetail(overviews[index].id);
      } catch (error) {
        if (!failed) { failure = error; failed = true; }
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
  return result;
}
