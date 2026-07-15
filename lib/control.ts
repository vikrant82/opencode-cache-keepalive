import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { controlFilePath } from "./paths"

export type KeepaliveControl = {
    version: 1
    enabled: boolean
    updatedAt: number
}

export function readControl(): KeepaliveControl | undefined {
    try {
        const value = JSON.parse(
            readFileSync(controlFilePath(), "utf8"),
        ) as Partial<KeepaliveControl>
        if (value.version !== 1 || typeof value.enabled !== "boolean") return undefined
        if (typeof value.updatedAt !== "number") return undefined
        return value as KeepaliveControl
    } catch {
        return undefined
    }
}

export async function writeControl(enabled: boolean): Promise<KeepaliveControl> {
    const value: KeepaliveControl = {
        version: 1,
        enabled,
        updatedAt: Date.now(),
    }
    const path = controlFilePath()
    const tmp = `${path}.${process.pid}.${value.updatedAt}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(value)}\n`, "utf8")
    await rename(tmp, path)
    return value
}
