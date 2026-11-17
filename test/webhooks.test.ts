import { describe, expect, it } from "vitest";
import { apiOrder, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("POST /webhooks/order", () => {
  it("создаёт заказ", async () => {
    const res = await postWebhook(ctx.app, apiOrder());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "created" });
  });

  it("повтор того же события ничего не меняет", async () => {
    const o = apiOrder();
    await postWebhook(ctx.app, o);
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
  });

  it("устаревшее событие после нового игнорируется", async () => {
    const o = apiOrder({ status: "paid", updatedAt: "2026-02-10T12:00:00Z" });
    await postWebhook(ctx.app, { ...o, status: "refunded", updatedAt: "2026-02-11T12:00:00Z" });
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT status FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0].status).toBe("refunded");
  });

  it("новое событие обновляет заказ", async () => {
    const o = apiOrder({ status: "pending" });
    await postWebhook(ctx.app, o);
    const res = await postWebhook(ctx.app, { ...o, status: "paid", updatedAt: "2026-02-11T00:00:00Z" });
    expect(res.json()).toEqual({ result: "updated" });
  });

  it("сохраняет оплаченную сумму со скидкой в копейках", async () => {
    const o = apiOrder({ amount: "1500.00", discountPercent: "17.5", amountPaid: "1237.50" });
    await postWebhook(ctx.app, o);
    const { rows } = await ctx.db.query(`SELECT amount_kop, paid_kop FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0]).toEqual({ amount_kop: "150000", paid_kop: "123750" });
  });

  it("без полей скидки оплачено = amount", async () => {
    const o = apiOrder({ amount: 1000 });
    await postWebhook(ctx.app, o);
    const { rows } = await ctx.db.query(`SELECT paid_kop FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0].paid_kop).toBe("100000");
  });

  it("amountPaid больше amount или мусор — 400", async () => {
    expect((await postWebhook(ctx.app, apiOrder({ amount: 1000, amountPaid: 1000.01 }))).statusCode).toBe(400);
    expect((await postWebhook(ctx.app, apiOrder({ amount: 1000, amountPaid: "abc" }))).statusCode).toBe(400);
    expect((await postWebhook(ctx.app, apiOrder({ amount: 1000, amountPaid: -1 }))).statusCode).toBe(400);
  });

  it("невалидное тело — 400", async () => {
    const res = await postWebhook(ctx.app, { id: "x" });
    expect(res.statusCode).toBe(400);
  });
});
