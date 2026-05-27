import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const appEnv = process.env.APP_ENV ?? "local";
const { app } = await createApp();

app.listen(port, () => {
  console.log(`pass-share-backend listening on ${port} (${appEnv})`);
});
