import { describe, expect, it } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

/** День без скидок: gross = net = total. */
const day = (date: string, total: number) => ({ date, total, gross: total, discount: 0, net: total });

describe("GET /customers/:id/daily-totals", () => {
  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      day("2026-02-09", 0),
      day("2026-02-10", 1000),
      day("2026-02-11", 349),
    ]);
  });

  it("учитывает переход на летнее время: смещение берётся на момент заказа", async () => {
    // Europe/Berlin: до 29.03.2026 01:00Z — UTC+1, после — UTC+2.
    // Любое одно смещение на весь период ошибётся в одном из двух заказов.
    ctx.api.customers.set("c_3", "Europe/Berlin");
    await postWebhook(ctx.app, apiOrder({ customerId: "c_3", amount: 100, createdAt: "2026-03-27T22:30:00Z" })); // 23:30 CET, 27-е
    await postWebhook(ctx.app, apiOrder({ customerId: "c_3", amount: 200, createdAt: "2026-03-30T22:30:00Z" })); // 00:30 CEST, 31-е

    const res = await dailyTotals(ctx.app, "c_3", "2026-03-27", "2026-03-31");
    expect(res.json()).toEqual([
      day("2026-03-27", 100),
      day("2026-03-28", 0),
      day("2026-03-29", 0),
      day("2026-03-30", 0),
      day("2026-03-31", 200),
    ]);
  });

  it("считает gross, discount и net; total = gross", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 1000, discountPercent: 15, amountPaid: 850 }));
    await postWebhook(ctx.app, apiOrder({ amount: "1500.00", discountPercent: "17.5", amountPaid: "1237.50" }));
    await postWebhook(ctx.app, apiOrder({ amount: 300 })); // старый заказ без полей скидки — скидка 0
    await postWebhook(ctx.app, apiOrder({ amount: 900, discountPercent: 50, amountPaid: 450, status: "pending" }));
    // amountPaid, на котором Math.floor(rub * 100) терял копейку
    await postWebhook(ctx.app, apiOrder({ amount: 5000, discountPercent: 5.522, amountPaid: 4723.9, createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { date: "2026-02-10", total: 2800, gross: 2800, discount: 412.5, net: 2387.5 },
      { date: "2026-02-11", total: 5000, gross: 5000, discount: 276.1, net: 4723.9 },
    ]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([day("2026-02-10", 500)]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([day("2026-02-10", 800)]);
  });

  it("таймзона клиента берётся из API один раз", async () => {
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    ctx.api.customers.set("c_1", "UTC");
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    const { rows } = await ctx.db.query(`SELECT timezone FROM customers WHERE id = 'c_1'`);
    expect(rows[0].timezone).toBe("Europe/Moscow");
  });

  it("валидирует даты", async () => {
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-30", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-03-02", "2026-03-01")).statusCode).toBe(400);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });
});
