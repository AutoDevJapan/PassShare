// Dedicated acceptance host: production integration needs only the same two
// registrations. All acceptance decisions and fixtures are in Rust.
import express from "express";
import { createApp } from "../app.js";
import { createEncryptedRouter, createPlaintextBoundary } from "./router.js";
const { app, pool, authStore } = await createApp();
const host = express();
host.use(express.json({ limit: "2mb" }));
host.use("/api/encrypted", await createEncryptedRouter({ pool, authStore }));
host.use("/v1/vaults/:vaultUuid", createPlaintextBoundary({ pool }));
host.use(app);
host.listen(Number(process.env.PORT), "127.0.0.1");
