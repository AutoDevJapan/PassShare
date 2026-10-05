import { execFile } from "node:child_process";
import { connectHttpError } from "../middleware/connect-errors.js";

// The native process receives only this operation's JSON, never the server's
// credentials. Its errors contain a fixed public code, not input or diagnostics.
export async function nativeMutation(input) {
  const binary = process.env.PASSSHARE_MUTATIONS_BIN;
  if (!binary) throw connectHttpError(503, "PS019: Save service unavailable");
  const reply = await new Promise((resolve, reject) => {
    const child = execFile(binary, [], {
      timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
    }, (error, stdout) => {
      if (error) return reject(connectHttpError(503, "PS019: Save service unavailable"));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(connectHttpError(503, "PS019: Save service unavailable")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
  if (reply.status !== 200) {
    const error = connectHttpError(reply.status, reply.message);
    error.code = reply.status === 409 ? "PS015" : "PS018";
    throw error;
  }
  return reply.body;
}
