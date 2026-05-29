import path from "node:path";

/**
 * Pin React imports to the consuming app's node_modules.
 * Required for @vitejs/plugin-react v5+ when bundling TSX from shared/.
 */
export function reactResolveFromApp(appRootDir: string) {
  const nodeModules = path.join(appRootDir, "node_modules");

  return {
    alias: {
      react: path.join(nodeModules, "react"),
      "react-dom": path.join(nodeModules, "react-dom"),
      "react/jsx-runtime": path.join(nodeModules, "react/jsx-runtime"),
      "react/jsx-dev-runtime": path.join(nodeModules, "react/jsx-dev-runtime"),
    },
    dedupe: ["react", "react-dom"],
  };
}
