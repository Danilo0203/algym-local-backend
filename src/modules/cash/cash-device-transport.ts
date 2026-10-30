import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { env } from "../../config/env.js";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../../../windows/Invoke-CashDevice.ps1", import.meta.url));
export type DeviceResult = { status: "sent" | "failed" | "unknown"; message: string; jobId?: number };

export const cashDeviceTransport = {
  async send(id: string, kind: "drawer" | "receipt", bytes: Buffer): Promise<DeviceResult> {
    // Nunca se envían órdenes físicas desde pruebas ni otros sistemas operativos.
    if (env.NODE_ENV === "test" || process.platform !== "win32") {
      throw new Error("El transporte físico solo está disponible en Windows fuera de pruebas");
    }
    if (!env.CASH_PRINTER_NAME || !env.CASH_DEVICE_DATA_DIR) throw new Error("Dispositivo no configurado");
    const directory = path.resolve(env.CASH_DEVICE_DATA_DIR);
    await mkdir(directory, { recursive: true });
    const payload = path.join(directory, id + ".bin");
    await writeFile(payload, bytes, { flag: "wx" });
    try {
      const powershell = path.join(process.env.SystemRoot || "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout } = await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", script, "-PrinterName", env.CASH_PRINTER_NAME,
        "-Kind", kind, "-PayloadPath", payload, "-RequestId", id],
      { windowsHide: true, timeout: 25_000, maxBuffer: 64 * 1024 });
      const result = JSON.parse(stdout.trim()) as DeviceResult;
      if (!["sent", "failed", "unknown"].includes(result.status)) throw new Error("Respuesta de dispositivo inválida");
      return result;
    } finally {
      await rm(payload, { force: true });
    }
  },
};
