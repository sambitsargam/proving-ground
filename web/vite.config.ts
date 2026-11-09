import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The landing page reads the attack reports from the repository root.
  server: { fs: { allow: [".."] } },
});
