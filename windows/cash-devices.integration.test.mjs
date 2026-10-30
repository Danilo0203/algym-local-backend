import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import bcrypt from "bcryptjs";
import request from "supertest";
import { bootstrap } from "./bootstrap.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("cajón y recibos: cobros confirmados, permisos, duplicados, fallos y rollback", { timeout: 420000 }, async () => {
  const bin = process.env.ALGYM_INSTALLER_PG_BIN;
  assert.ok(bin, "Se requiere un binario PostgreSQL para crear un clúster aislado");
  const root = await mkdtemp(path.join(os.tmpdir(), "algym-cash-test-"));
  const data = path.join(root, "postgres");
  const port = await freePort();
  assert.notEqual(port, 55432); assert.notEqual(port, 5432);
  const installation = { installationId: randomUUID(), host: "127.0.0.1", port,
    database: "algym_windows", adminPassword: randomBytes(32).toString("hex"),
    appPassword: randomBytes(32).toString("hex"), syncPassword: randomBytes(32).toString("hex"),
    owner: { name: "Caja de prueba", email: "caja@example.test", password: "Caja temporal prueba 123" } };
  const run = (name, args) => execFileSync(path.join(bin, name + (process.platform === "win32" ? ".exe" : "")),
    args, { encoding: "utf8", stdio: process.platform === "win32" ? "ignore" : "pipe", windowsHide: true,
      env: { ...process.env, PGPASSWORD: installation.adminPassword } });
  let started = false, admin, applicationPool;
  try {
    await writeFile(path.join(root, "password"), installation.adminPassword);
    run("initdb", ["-D", data, "-U", "postgres", "--encoding=UTF8", "--locale=C",
      "--auth=scram-sha-256", "--pwfile=" + path.join(root, "password")]);
    run("pg_ctl", ["-D", data, "-w", "-l", path.join(root, "postgres.log"),
      "-o", "-h 127.0.0.1 -p " + port + " -c cluster_name=AlGym-" + installation.installationId, "start"]);
    started = true;
    console.log("Clúster temporal listo en puerto " + port + "; aplicando migraciones.");
    await bootstrap(installation);
    console.log("Migraciones aplicadas; verificando cobros con transporte simulado.");
    admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres",
      password: installation.adminPassword, database: "postgres" });
    await admin.connect();
    await admin.query("CREATE DATABASE algym_test TEMPLATE algym_windows");
    await admin.end();
    admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres",
      password: installation.adminPassword, database: "algym_test" });
    await admin.connect();
    Object.assign(process.env, { NODE_ENV: "test", ALGYM_ENV_FILE: path.join(root, "no-env"),
      DB_HOST: "127.0.0.1", DB_PORT: String(port), DB_NAME: "algym_test", DB_USER: "algym_app",
      DB_PASSWORD: installation.appPassword, AUTH_COOKIE_SECURE: "false", LOG_LEVEL: "error",
      CASH_DRAWER_ENABLED: "true", CASH_PRINTER_NAME: "POS-58", CASH_DEVICE_DATA_DIR: path.join(root, "device"),
    });
    const { app } = await import("../dist/app.js");
    const { pool } = await import("../dist/db/pool.js");
    applicationPool = pool;
    const { cashDeviceTransport } = await import("../dist/modules/cash/cash-device-transport.js");
    const { queueAutomaticDrawer } = await import("../dist/modules/cash/cash-devices.service.js");
    const { withUserTransaction } = await import("../dist/db/transaction.js");
    const { createPaidMembershipInTransaction } = await import("../dist/modules/payments/paid-membership.service.js");
    const { paidMembershipSchema } = await import("../dist/modules/payments/payments.schemas.js");
    const sent = [];
    let failNext = false;
    cashDeviceTransport.send = async (id, kind, bytes) => {
      // A committed row MUST be visible from another connection before hardware.
      const row = (await admin.query("SELECT status FROM cash_device_operations WHERE id=$1", [id])).rows[0];
      assert.equal(row?.status, "dispatching");
      sent.push({ id, kind, bytes: Buffer.from(bytes) });
      if (failNext) { failNext = false; throw new Error("Equipo desconectado simulado"); }
      return { status: "sent", message: "Simulado, sin hardware", jobId: sent.length };
    };
    const login = await request(app).post("/auth/login").send({ email: installation.owner.email, password: installation.owner.password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const cookie = login.headers["set-cookie"][0];
    const owner = (await admin.query("SELECT id FROM auth.users WHERE email=$1", [installation.owner.email])).rows[0].id;
    const get = url => request(app).get(url).set("Cookie", cookie);
    const post = (url, body) => request(app).post(url).set("Cookie", cookie).send(body);
    const register = (await admin.query("SELECT id FROM cash_registers LIMIT 1")).rows[0].id;
    assert.equal((await post("/cash/sessions", { registerId: register, openingAmount: 0 })).status, 201);
    const product = randomUUID();
    await admin.query("INSERT INTO products(id,name,sku,cost_price,sale_price,is_active,created_by_user_id) VALUES($1,'Agua de prueba','TEST-WATER',2,5,true,$2)", [product, owner]);
    await admin.query("INSERT INTO inventory_movements(product_id,movement_type,quantity_delta,quantity_before,quantity_after,unit_cost,unit_price,created_by_user_id) VALUES($1,'entry',100,0,100,2,5,$2)", [product, owner]);
    const sell = method => post("/cash/products/sales", { items: [{ productId: product, quantity: 2 }], paymentMethod: method });
    async function settle(id) {
      for (let i = 0; i < 100; i++) {
        const row = (await admin.query("SELECT * FROM cash_device_operations WHERE id=$1", [id])).rows[0];
        if (row && !["pending", "dispatching"].includes(row.status)) return row;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error("La orden no terminó");
    }
    async function settleMovement(id) {
      const row = (await admin.query("SELECT id FROM cash_device_operations WHERE movement_id=$1 AND kind='drawer_auto'", [id])).rows[0];
      assert.ok(row); return settle(row.id);
    }
    const cash = await sell("cash");
    assert.equal(cash.status, 201, JSON.stringify(cash.body));
    assert.equal((await settleMovement(cash.body.cash_movement_id)).status, "sent");
    assert.equal(sent.length, 1);
    assert.deepEqual([...sent[0].bytes], [27,112,0,50,250]);
    await withUserTransaction(owner, client => queueAutomaticDrawer(client, owner, cash.body.cash_movement_id, "cash"));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(sent.length, 1, "No repetir apertura del mismo cobro");
    for (const method of ["card", "transfer"]) assert.equal((await sell(method)).status, 201);
    assert.equal(sent.length, 1, "Tarjeta y transferencia no abren");
    await admin.query("UPDATE products SET sale_price=9 WHERE id=$1", [product]);
    const detail = await get("/cash/sales/" + cash.body.cash_movement_id + "/receipt");
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.total, 10);
    assert.equal(detail.body.items[0].unitPrice, 5, "Usar precio histórico de venta");
    const history = await get("/cash/sales?page=1");
    assert.equal(history.status, 200); assert.equal(history.body.total, 3);
    const printId = randomUUID();
    const printUrl = "/cash/sales/" + cash.body.cash_movement_id + "/receipt";
    const copies = await Promise.all([post(printUrl, { requestId: printId }), post(printUrl, { requestId: printId })]);
    assert.ok(copies.every(response => response.status === 202));
    assert.equal((await settle(printId)).status, "sent");
    assert.equal(sent.length, 2, "Una impresión por solicitud incluso concurrente");
    assert.equal(sent[1].kind, "receipt");
    assert.equal(sent[1].bytes.indexOf(Buffer.from([27,112])), -1, "Imprimir no abre");
    assert.match(sent[1].bytes.toString("ascii"), /TOTAL\s+Q10.00/);

    const plan = Number((await admin.query("INSERT INTO plans(name,price,duration_days,is_active) VALUES('Plan de prueba',100,30,true) RETURNING id")).rows[0].id);
    let biometric = 900000;
    async function customer() {
      const id = randomUUID(), email = id + "@example.test", password = "Cliente de prueba 123";
      await admin.query("INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data,created_at,updated_at) VALUES($1,$2,$3,'{}',now(),now())", [id,email,await bcrypt.hash(password,4)]);
      await admin.query("INSERT INTO profiles(id,full_name,phone,birth_date,gender,role,biometric_id,is_active) VALUES($1,'Cliente temporal','55555555','1990-01-01','male','client',$2,true)", [id,++biometric]);
      return { id,email,password };
    }
    const member = await customer();
    const membershipInput = { customerId: member.id, planId: plan, operation: "create", paymentMethod: "cash", requireSession: true };
    const membership = await post("/payments/membership", membershipInput);
    assert.equal(membership.status, 201, JSON.stringify(membership.body));
    assert.equal((await settleMovement(membership.body.cash_movement_id)).status, "sent");
    assert.equal(sent.length, 3);
    const memberReceipt = await get("/cash/payments/" + membership.body.payment_id + "/receipt");
    assert.equal(memberReceipt.status, 200); assert.equal(memberReceipt.body.total, 100);
    const byReference = await get("/cash/sales?search=" + encodeURIComponent(memberReceipt.body.reference));
    assert.equal(byReference.status, 200); assert.equal(byReference.body.total, 1);
    assert.equal(byReference.body.data[0].id, membership.body.cash_movement_id);
    const renewed = await post("/payments/membership", { ...membershipInput, operation: "renew" });
    assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
    await settleMovement(renewed.body.cash_movement_id);
    assert.equal(sent.length, 4);
    const pendingClient = await customer();
    const pending = (await admin.query("INSERT INTO subscriptions(user_id,plan_id,start_date,end_date,status,initial_collection_origin) VALUES($1,$2,current_date,current_date+30,'pending','customers') RETURNING id", [pendingClient.id,plan])).rows[0].id;
    const collected = await post("/payments/membership/pending/" + pending + "/collect", { paymentMethod:"cash", discountAmount:0 });
    assert.equal(collected.status, 201, JSON.stringify(collected.body));
    await settleMovement(collected.body.cash_movement_id);
    assert.equal(sent.length, 5);
    const rollbackClient = await customer();
    await assert.rejects(withUserTransaction(owner, async client => {
      await createPaidMembershipInTransaction(client, owner, paidMembershipSchema.parse({ ...membershipInput, customerId: rollbackClient.id }));
      throw new Error("rollback intencional");
    }), /rollback intencional/);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(sent.length, 5, "Rollback no abre");
    assert.equal((await admin.query("SELECT count(*)::int n FROM payments WHERE user_id=$1", [rollbackClient.id])).rows[0].n, 0);
    const clientLogin = await request(app).post("/auth/login").send({email:member.email,password:member.password});
    const clientCookie = clientLogin.headers["set-cookie"][0];
    assert.equal((await request(app).get("/cash/sales").set("Cookie",clientCookie)).status,403);
    assert.equal((await request(app).post(printUrl).set("Cookie",clientCookie).send({requestId:randomUUID()})).status,403);
    assert.equal((await request(app).post("/cash/devices/drawer").set("Cookie",clientCookie).send({requestId:randomUUID(),reason:"Cambio"})).status,403);
    assert.equal((await request(app).get("/cash/sales")).status,401);
    failNext = true;
    const failedDeviceSale = await sell("cash");
    assert.equal(failedDeviceSale.status,201,"La venta se guarda aunque falle el dispositivo");
    assert.equal((await settleMovement(failedDeviceSale.body.cash_movement_id)).status,"unknown");
    assert.equal((await admin.query("SELECT status FROM product_sales WHERE id=$1",[failedDeviceSale.body.product_sale_id])).rows[0].status,"posted");
    const countBeforeRead = sent.length;
    await get("/cash/devices"); await get(printUrl);
    assert.equal(sent.length,countBeforeRead,"Consultar estado o detalle no vuelve a enviar");
    const manualId = randomUUID();
    assert.equal((await post("/cash/devices/drawer",{requestId:manualId,reason:"Dar cambio de prueba"})).status,202);
    assert.equal((await settle(manualId)).status,"sent");
    assert.equal((await post("/cash/devices/drawer",{requestId:manualId,reason:"Dar cambio de prueba"})).status,202);
    assert.equal(sent.length,countBeforeRead+1);
    const stale = randomUUID();
    await admin.query("INSERT INTO cash_device_operations(id,actor_user_id,kind,created_at) VALUES($1,$2,'drawer_manual',now()-interval '2 minutes')",[stale,owner]);
    await get("/cash/devices");
    assert.equal((await settle(stale)).status,"expired");
    assert.equal(sent.length,countBeforeRead+1,"Órdenes caducadas no abren tarde");
    const voided = await post("/cash/products/sales/" + cash.body.product_sale_id + "/void",{note:"Anulación de prueba"});
    assert.equal(voided.status,201);
    assert.equal((await get(printUrl)).body.status,"voided");
    assert.equal(sent.length,countBeforeRead+1,"Anulaciones no abren");
    // Integrated annual enrollment: one purchase, two concepts, one drawer pulse.
    await admin.query("UPDATE plans SET price=150 WHERE id=$1", [plan]);
    const enrollmentState = (await get("/enrollment/settings")).body;
    const quote = { year: enrollmentState.year, fee: enrollmentState.fee };
    const joinedMember = await customer();
    const beforeJoined = sent.length;
    const historyBeforeJoined = (await get("/cash/sales")).body.total;
    const joined = await post("/payments/membership", { ...membershipInput, customerId: joinedMember.id, enrollment: quote });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
    assert.equal(joined.body.total_paid, 200);
    await settleMovement(joined.body.cash_movement_id);
    assert.equal(sent.length, beforeJoined + 1, "Mensualidad e inscripción abren una sola vez");
    assert.equal((await admin.query("SELECT count(*)::int n FROM cash_device_operations WHERE collection_id=$1 AND kind='drawer_auto'", [joined.body.collection_id])).rows[0].n, 1);
    const joinedReceipt = (await get("/cash/payments/" + joined.body.enrollment.payment_id + "/receipt")).body;
    assert.equal(joinedReceipt.movementId, joined.body.cash_movement_id);
    assert.equal(joinedReceipt.items.length, 2);
    assert.equal(joinedReceipt.items[0].unitPrice, 150);
    assert.equal(joinedReceipt.items[1].name, "Inscripción " + quote.year);
    assert.equal(joinedReceipt.total, 200);
    const joinedHistory = (await get("/cash/sales")).body;
    assert.equal(joinedHistory.total, historyBeforeJoined + 1);
    assert.equal(joinedHistory.data.find(sale => sale.id === joined.body.cash_movement_id).category, "membership_enrollment");
    const joinedPrint = randomUUID();
    assert.equal((await post("/cash/sales/" + joinedReceipt.movementId + "/receipt", { requestId: joinedPrint })).status, 202);
    await settle(joinedPrint);
    assert.match(sent.at(-1).bytes.toString("ascii"), /TOTAL\s+Q200.00/);
    assert.match(sent.at(-1).bytes.toString("ascii"), /Inscripcion/);
    assert.equal(sent.at(-1).bytes.indexOf(Buffer.from([27,112])), -1);

    const beforeRenewal = sent.length;
    await admin.query("UPDATE subscriptions SET start_date=current_date-90,end_date=current_date-60,status='expired' WHERE id=$1", [joined.body.subscription_id]);
    const afterAbsence = await post("/payments/membership", { ...membershipInput, customerId: joinedMember.id, operation: "renew" });
    assert.equal(afterAbsence.status, 201, JSON.stringify(afterAbsence.body));
    await settleMovement(afterAbsence.body.cash_movement_id);
    assert.equal(afterAbsence.body.total_paid, 150);
    assert.equal((await get("/enrollment/" + joinedMember.id)).body.status, "paid");
    assert.equal(sent.length, beforeRenewal + 1);

    const standaloneMember = await customer();
    const standaloneBefore = sent.length;
    const standalone = await Promise.all([1,2].map(() => post("/enrollment/" + standaloneMember.id + "/collect", { ...quote, paymentMethod: "cash" })));
    assert.deepEqual(standalone.map(response => response.status).sort(), [201,409]);
    const standalonePaid = standalone.find(response => response.status === 201).body;
    await settleMovement(standalonePaid.cash_movement_id);
    assert.equal(sent.length, standaloneBefore + 1);
    const standaloneReceipt = (await get("/cash/sales/" + standalonePaid.cash_movement_id + "/receipt")).body;
    assert.equal(standaloneReceipt.total, 50);
    assert.equal(standaloneReceipt.items[0].name, "Inscripción " + quote.year);
    assert.equal((await admin.query("SELECT count(*)::int n FROM subscriptions WHERE user_id=$1", [standaloneMember.id])).rows[0].n, 0);

    const joinedPendingMember = await customer();
    const joinedPendingId = (await admin.query("INSERT INTO subscriptions(user_id,plan_id,start_date,end_date,status,initial_collection_origin) VALUES($1,$2,current_date,current_date+30,'pending','customers') RETURNING id", [joinedPendingMember.id,plan])).rows[0].id;
    const beforePending = sent.length;
    const joinedPending = await post("/payments/membership/pending/" + joinedPendingId + "/collect", { paymentMethod: "cash", discountAmount: 0, enrollment: quote });
    assert.equal(joinedPending.status, 201, JSON.stringify(joinedPending.body));
    await settleMovement(joinedPending.body.cash_movement_id);
    assert.equal(joinedPending.body.total_paid, 200);
    assert.equal(sent.length, beforePending + 1);

    const beforeCorrection = sent.length;
    const correction = await post("/payments/" + joined.body.payment_id + "/reverse", { amountOriginal:150, discountAmount:0, amountPaid:150, paymentMethod:"card", reason:"Método corregido", sourceCategory:"membership" });
    assert.equal(correction.status,201,JSON.stringify(correction.body));
    const correctedReceipt = (await get("/cash/payments/" + correction.body.replacement_payment_id + "/receipt")).body;
    assert.equal(correctedReceipt.total,150); assert.equal(correctedReceipt.method,"card");
    assert.equal((await get("/cash/payments/" + joined.body.enrollment.payment_id + "/receipt")).body.total,50);
    const originalReceipt = (await get("/cash/payments/" + joined.body.payment_id + "/receipt")).body;
    assert.equal(originalReceipt.status,"reversed"); assert.equal(originalReceipt.total,150);
    assert.equal(sent.length,beforeCorrection,"Corregir no vuelve a abrir el cajón");

    const joinedRollback = await customer();
    await assert.rejects(withUserTransaction(owner, async client => {
      await createPaidMembershipInTransaction(client, owner, paidMembershipSchema.parse({ ...membershipInput, customerId:joinedRollback.id, enrollment:quote }));
      throw new Error("rollback integrado");
    }), /rollback integrado/);
    assert.equal((await admin.query("SELECT count(*)::int n FROM payments WHERE user_id=$1", [joinedRollback.id])).rows[0].n,0);
    assert.equal((await get("/enrollment/" + joinedRollback.id)).body.status,"pending");
    assert.equal(sent.length,beforeCorrection,"Rollback del cobro conjunto no abre");
    console.log("Verificados: ventas, inscripción conjunta e independiente, ausencias, recibos, correcciones, duplicados y rollback. Cero llamadas físicas.");
  } finally {
    await applicationPool?.end();
    await admin?.end();
    if (started) run("pg_ctl", ["-D",data,"-m","fast","-w","stop"]);
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("algym-cash-test-"));
    await rm(resolved,{recursive:true,force:true});
  }
});
