#!/usr/bin/env node
/**
 * Enlaza los binarios de Foundry que vienen en los paquetes npm
 * @foundry-rs/{forge,cast,anvil}-<plataforma> dentro de node_modules/.bin.
 *
 * Por que existe esto: sin el enlace, `npx forge` resuelve a un paquete
 * homonimo y ajeno del registry publico en vez de a nuestro binario fijado.
 * Fijar la version en package.json hace que todo el equipo y el CI compilen
 * con exactamente el mismo compilador.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/tools$/, "");
const binDir = join(root, "node_modules", ".bin");

const platform = process.platform === "win32" ? "win32" : process.platform;
const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch;
const suffix = `${platform}-${arch}`;

mkdirSync(binDir, { recursive: true });

let linked = 0;
for (const tool of ["forge", "cast", "anvil"]) {
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  const source = join(root, "node_modules", "@foundry-rs", `${tool}-${suffix}`, "bin", exe);
  if (!existsSync(source)) {
    console.warn(`[foundry] falta el binario de ${tool} para ${suffix}, se omite`);
    continue;
  }
  chmodSync(source, 0o755);
  const target = join(binDir, tool);
  rmSync(target, { force: true });
  symlinkSync(source, target);
  linked += 1;
}

console.log(`[foundry] ${linked}/3 binarios enlazados en node_modules/.bin (${suffix})`);
