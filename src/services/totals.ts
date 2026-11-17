import type { OrdersRepository } from "../repositories/orders.js";
import { fromKop } from "../utils/money.js";
import { dateAtOffset, datesBetween, tzOffsetMinutes } from "../utils/time.js";
import type { CustomersService } from "./customers.js";

export interface DailyTotal {
  date: string;
  /** = gross, оставлено для обратной совместимости */
  total: number;
  /** Сумма до скидки */
  gross: number;
  /** gross - net */
  discount: number;
  /** Фактически оплачено клиентами */
  net: number;
}

const DAY = 86_400_000;

export class TotalsService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
  ) {}

  /**
   * Сумма оплаченных заказов клиента по дням в его таймзоне, from..to включительно.
   * Дни без оплат — с нулём.
   */
  async daily(customerId: string, from: string, to: string): Promise<DailyTotal[]> {
    const timezone = await this.customers.timezone(customerId);

    // Смещения таймзон в пределах ±14 ч: берём с запасом в сутки с каждой стороны
    const rows = await this.orders.paidCreatedBetween(
      customerId,
      new Date(Date.parse(`${from}T00:00:00Z`) - DAY),
      new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY),
    );

    // Суммы в копейках, в рубли — только на выходе
    const sums = new Map(datesBetween(from, to).map((d) => [d, { gross: 0, net: 0 }]));
    for (const o of rows) {
      // сдвиг с учетом переводов часов и летнего времени, чтобы получить день в таймзоне клиента
      const date = dateAtOffset(o.createdAt, tzOffsetMinutes(timezone, o.createdAt));
      const cur = sums.get(date);
      if (cur) {
        cur.gross += o.amountKop;
        cur.net += o.paidKop;
      }
    }
    return [...sums].map(([date, { gross, net }]) => ({
      date,
      total: fromKop(gross),
      gross: fromKop(gross),
      discount: fromKop(gross - net),
      net: fromKop(net),
    }));
  }
}
