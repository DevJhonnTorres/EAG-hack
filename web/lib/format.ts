/**
 * Formateo de montos.
 *
 * Trabaja sobre el `bigint` original y nunca lo convierte a `number` para
 * mostrarlo: un monto en wei excede con facilidad la precision de un double, y
 * un redondeo en la capa de presentacion haria que la interfaz muestre una cifra
 * distinta de la que se firma y se manda a la cadena.
 */
export function formatUnidades(wei: bigint, decimales = 18, precision = 6): string {
  const negativo = wei < 0n;
  const absoluto = negativo ? -wei : wei;
  const base = 10n ** BigInt(decimales);

  const entera = absoluto / base;
  const fraccionaria = absoluto % base;

  const fraccionTexto = fraccionaria.toString().padStart(decimales, "0").slice(0, precision).replace(/0+$/, "");

  const texto = fraccionTexto.length > 0 ? `${entera}.${fraccionTexto}` : entera.toString();
  return negativo ? `-${texto}` : texto;
}

/** Convierte un texto decimal escrito por una persona a wei, sin pasar por float. */
export function parseUnidades(texto: string, decimales = 18): bigint {
  const limpio = texto.trim();
  if (limpio === "" || limpio === ".") return 0n;
  if (!/^\d*\.?\d*$/.test(limpio)) throw new Error(`monto invalido: ${texto}`);

  const [entera = "0", fraccionaria = ""] = limpio.split(".");
  const fraccionRellena = fraccionaria.padEnd(decimales, "0").slice(0, decimales);
  return BigInt(entera || "0") * 10n ** BigInt(decimales) + BigInt(fraccionRellena || "0");
}

export function porcentaje(parte: bigint, total: bigint, decimales = 2): string {
  if (total === 0n) return "0";
  // Se escala antes de dividir para conservar los decimales sin usar punto flotante.
  const escala = 10n ** BigInt(decimales + 2);
  const valor = (parte * escala) / total;
  return (Number(valor) / 10 ** decimales).toFixed(decimales);
}

export function acortarDireccion(direccion: string): string {
  if (direccion.length < 12) return direccion;
  return `${direccion.slice(0, 6)}...${direccion.slice(-4)}`;
}

export function formatearDuracion(segundos: number): string {
  const dias = Math.floor(segundos / 86_400);
  const horas = Math.floor((segundos % 86_400) / 3_600);
  if (dias === 0) return `${horas}h`;
  if (horas === 0) return `${dias}d`;
  return `${dias}d ${horas}h`;
}
