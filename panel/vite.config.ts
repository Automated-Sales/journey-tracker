import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pipedrive Custom UI Extensions are served as a static build and iframed
// in. Build output goes to dist/ — deploy that folder (e.g. to Vercel/
// Netlify/S3+CloudFront) and point your app manifest's panel URL at it.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
  },
});
