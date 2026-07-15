import { defineConfig } from "tsup"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))

export default defineConfig({
    entry: ["index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    define: {
        __KEEPALIVE_VERSION__: JSON.stringify(pkg.version),
    },
})
