import assert from "node:assert/strict";
import test from "node:test";
import { receiptBytes, type SaleReceipt } from "./receipt.js";

const sale: SaleReceipt = {
  movementId: "a", reference: "V-0001", date: "2026-10-30T02:00:00Z",
  customer: "María López", cashier: "Cajero", method: "cash", status: "posted", note: null,
  items: [{ name: "Agua mineral", quantity: 2, unitPrice: 5, total: 10 }],
  subtotal: 10, discount: 0, total: 10,
};
test("recibo conserva cantidades e importes sin incluir pulso de apertura", () => {
  const bytes = receiptBytes(sale);
  assert.deepEqual([...bytes.subarray(0, 2)], [27, 64]);
  assert.equal(bytes.indexOf(Buffer.from([27, 112])), -1);
  const text = bytes.subarray(2).toString("ascii");
  assert.match(text, /Maria Lopez/);
  assert.match(text, /2 x Q5.00\s+Q10.00/);
  assert.match(text, /TOTAL\s+Q10.00/);
  assert.ok(text.split("\n").every(line => line.length <= 32));
});
test("nombres, notas y referencias no pueden insertar comandos de hardware", () => {
  const bytes = receiptBytes({ ...sale, customer: "\x1bp\x00\x32\xfa",
    reference: "Venta\r\n\x1b@NO", note: "\x1dV\x00\x1bp" + "x".repeat(300),
    items: [{ name: "á".repeat(70), quantity: 1, unitPrice: 10, total: 10 }] });
  assert.equal([...bytes].filter(byte => byte === 27).length, 1);
  assert.ok([...bytes.subarray(2)].every(byte => byte === 10 || (byte >= 32 && byte <= 126)));
  assert.ok(bytes.subarray(2).toString("ascii").split("\n").every(line => line.length <= 32));
});
test("recibos anulados y descuentos mantienen el estado de la venta", () => {
  const text = receiptBytes({ ...sale, status: "voided", discount: 2, total: 8 }).toString("ascii");
  assert.match(text, /ANULADO/);
  assert.match(text, /Descuento\s+Q-2.00/);
  assert.match(text, /TOTAL\s+Q8.00/);
});
