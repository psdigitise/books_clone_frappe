import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";
import { writeFileSync, mkdirSync } from "fs";

// Custom plugin: after build, copy the generated CSS from outDir/assets/
// into the correct Frappe public/css/ location.
function copyBooksCSS() {
  return {
    name: "copy-books-css",
    closeBundle() {
      const src  = resolve(__dirname, "../dist/books.css");
      const dest = resolve(__dirname, "../../css/books.css");
      try {
        const { readFileSync } = require("fs");
        const css = readFileSync(src, "utf8");
        mkdirSync(resolve(__dirname, "../../css"), { recursive: true });
        writeFileSync(dest, css);
        console.log("✓ Copied books.css → public/css/books.css");
      } catch (e) {
        // CSS may be inline-only when there are no <style> blocks with actual output
        console.warn("  (no separate CSS file emitted — styles are inline or empty)");
      }
    },
  };
}

export default defineConfig({
  plugins: [vue(), copyBooksCSS()],
  build: {
    // Output the JS bundle directly into public/js/
    outDir:    resolve(__dirname, "../../js"),
    // Temp asset dir (CSS lands here first before the plugin moves it)
    assetsDir: "dist",
    emptyOutDir: false,   // never wipe the parent js/ folder
    lib: {
      entry:    resolve(__dirname, "src/main.js"),
      name:     "BooksApp",
      fileName: () => "books.js",
      formats:  ["iife"],
    },
    rollupOptions: {
      // Vue 3 + Vue Router 4 are served from CDN (declared in www/books/index.html)
      external: ["vue", "vue-router"],
      output: {
        globals: {
          vue:          "Vue",
          "vue-router": "VueRouter",
        },
        // CSS asset name — must be a plain filename, no path separators
        assetFileNames: "dist/[name][extname]",
      },
    },
    minify: true,
    cssCodeSplit: false,
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
