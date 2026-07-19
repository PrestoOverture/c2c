import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  bundle: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
