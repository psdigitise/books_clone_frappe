import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: resolve(__dirname, "../public/js"),
    lib: {
      entry:    resolve(__dirname, "src/main.js"),
      name:     "BooksApp",
      fileName: () => "books.js",
      formats:  ["iife"],
    },
    rollupOptions: {
      // Vue + VueRouter are loaded from CDN at runtime
      external: ["vue", "vue-router"],
      output: {
        globals: {
          vue:          "Vue",
          "vue-router": "VueRouter",
        },
        assetFileNames: (info) => {
          if (info.name?.endsWith(".css")) return "../../css/books.css";
          return info.name;
        },
      },
    },
    minify: true,
    cssCodeSplit: false,
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
