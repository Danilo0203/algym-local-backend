export interface SaleReceipt {
  movementId: string;
  reference: string;
  date: string;
  customer: string;
  cashier: string;
  method: string;
  status: string;
  note: string | null;
  items: Array<{ name: string; quantity: number; unitPrice: number; total: number }>;
  subtotal: number;
  discount: number;
  total: number;
}

const WIDTH = 32;
function safeText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
}
function wrap(value: string): string[] {
  const lines: string[] = [];
  let remaining = safeText(value);
  while (remaining.length > WIDTH) {
    const space = remaining.lastIndexOf(" ", WIDTH);
    const end = space > 0 ? space : WIDTH;
    lines.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}
function money(value: number): string { return "Q" + value.toFixed(2); }
function amounts(label: string, value: number): string {
  const right = money(value);
  return safeText(label).slice(0, WIDTH - right.length - 1).padEnd(WIDTH - right.length) + right;
}

export function receiptBytes(receipt: SaleReceipt): Buffer {
  const date = new Intl.DateTimeFormat("es-GT", {
    timeZone: "America/Guatemala", dateStyle: "short", timeStyle: "short",
  }).format(new Date(receipt.date));
  const lines = ["             AlGym", "        RECIBO DE PAGO", "-".repeat(WIDTH),
    ...wrap("Ref: " + receipt.reference), ...wrap("Fecha: " + date),
    ...wrap("Cliente: " + receipt.customer), ...wrap("Atendio: " + receipt.cashier),
    "Pago: " + (receipt.method === "cash" ? "Efectivo" : receipt.method === "card" ? "Tarjeta" : "Transferencia"),
    ...(receipt.status !== "posted" ? ["*** ANULADO / REVERSADO ***"] : []), "-".repeat(WIDTH)];
  for (const item of receipt.items) {
    lines.push(...wrap(item.name), amounts(item.quantity + " x " + money(item.unitPrice), item.total));
  }
  lines.push("-".repeat(WIDTH), amounts("Subtotal", receipt.subtotal));
  if (receipt.discount > 0) lines.push(amounts("Descuento", -receipt.discount));
  lines.push(amounts("TOTAL", receipt.total));
  if (receipt.note) lines.push(...wrap(receipt.note));
  lines.push("", "       Gracias por tu visita", "", "", "");
  // RAW: inicialización + texto saneado. Nunca incluye ESC p (apertura).
  return Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.from(lines.join("\n") + "\n", "ascii")]);
}
