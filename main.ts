// SPDX-License-Identifier: MIT
// SwingRider: tranche dip-buyer for the cbBTC minute-bar replay
// (agent-fun/bars-replay/v1).
//
// Design notes, from the shape of this market and the kit's own baselines:
//   * The pool is thin, most one-minute bars are flat or noisy, and a full
//     round trip at full size costs roughly 30-36 bps in fees, modelled
//     slippage and price impact. Chasing momentum on minute bars whipsaws:
//     the house EMA-cross baseline trades dozens of times and loses
//     heavily, and high-frequency scalping pays the impact toll on every
//     flip. The money in this tape is in the hour-scale swings.
//   * So this bot does one thing, patiently: it watches the drawdown from
//     the running high of closes. When price has fallen 140 bps below that
//     high it buys a first tranche (30% of starting equity); if the fall
//     deepens to 200 and then 255 bps it adds 35% and 35%, so the blended
//     entry sits near the bottom of a genuine sell-off instead of chasing
//     the first downtick. Position size scales down automatically with
//     shallower dips, which keeps impact (quadratic in size) contained.
//   * It sells the recovery: +150 bps from the blended cost basis, or a
//     wide -260 bps disaster stop, or after 480 bars (8 hours) if the
//     recovery never comes, so capital is never stranded for a whole race.
//     A cycle only re-arms once price has recovered to within 40 bps of
//     the running high, which stops the bot from catching the same falling
//     knife twice, and no new cycle opens in the last 120 bars of the
//     window, where a fresh dip would have no time to recover before the
//     end-of-window flatten.
//   * Entries work from bar 30 onward: the reference is the running high,
//     not a long lookback, so the bot is not blind during an early crash
//     the way a 480-bar trend filter would be.
//   * Everything is a deterministic function of the bars seen so far: no
//     clock, no randomness, no files, no network. Two runs on the same
//     data produce the same orders byte for byte.

import * as readline from "node:readline";

// ---- tunable constants (basis points unless noted) --------------------------
const TRANCHE_DD_BPS = [140.0, 200.0, 255.0]; // drawdown triggers per tranche
const TRANCHE_FRAC = [0.30, 0.35, 0.35];      // fraction of starting equity
const TAKE_PROFIT_BPS = 150.0;  // sell when the gain from cost reaches this
const STOP_LOSS_BPS = 260.0;    // disaster stop from cost
const TIMEOUT_BARS = 480;       // exit a position that never recovered
const COOLDOWN = 45;            // bars flat after an exit before any re-entry
const REARM_BPS = 40.0;         // cycle re-arms this close to the running high
const MIN_BARS = 30;            // bars of history before the first possible entry
const LAST_ENTRY_BAR = 1320;    // no new cycle in the final 120 bars
const MAX_SLIP = 200;           // max_slippage_bps sent with every order
const MIN_NOTIONAL = 1000000n;  // 1 USDC in quote units

type Order = Record<string, unknown>;

class SwingRider {
  closes: number[] = [];
  runningHigh = 0.0;
  inPosition = false;
  entryPrice: number | null = null;
  barsHeld = 0;
  barsSinceExit = COOLDOWN + 1;
  cycleArmed = true;
  tranchesDone = 0;
  refEquity: bigint | null = null;
  orderNo = 0;
  symbol = "CBBTC";
  // Bar prices are integers at price_scale; the account's cost basis is in
  // quote units per qty unit. entryScale converts cost/qty into the same
  // integer scale as the bar prices: 10^(qty_scale - quote_scale + price_scale).
  entryScale = 1.0;

  drawdownBps(close: number): number {
    if (this.runningHigh <= 0.0) return 0.0;
    return (close / this.runningHigh - 1.0) * 10000.0;
  }

  gainBps(close: number): number {
    if (this.entryPrice === null || this.entryPrice <= 0.0) return 0.0;
    return (close / this.entryPrice - 1.0) * 10000.0;
  }

  buyOrder(cash: bigint, frac: number): Order | null {
    if (this.refEquity === null) return null;
    let notional = BigInt(Math.floor(Number(this.refEquity) * frac));
    if (notional > cash) notional = cash;
    if (notional < MIN_NOTIONAL) return null;
    this.orderNo += 1;
    return {
      side: "buy",
      client_id: "b" + this.orderNo,
      symbol: this.symbol,
      notional_quote_units: notional.toString(),
      max_slippage_bps: MAX_SLIP,
    };
  }

  sellOrder(posQty: bigint): Order {
    // Sell the whole position: the exit rules (take-profit, disaster
    // stop, timeout) are all-or-nothing, never partial.
    this.orderNo += 1;
    return {
      side: "sell",
      client_id: "s" + this.orderNo,
      symbol: this.symbol,
      qty: posQty.toString(),
      max_slippage_bps: MAX_SLIP,
    };
  }

  onBar(close: number, cash: bigint, posQty: bigint, posCost: bigint): Order[] {
    this.closes.push(close);
    if (this.refEquity === null) this.refEquity = cash;
    if (close > this.runningHigh) this.runningHigh = close;

    const holding = posQty > 0n;
    if (holding && !this.inPosition) {
      // A buy fill landed since the last batch: adopt the position and
      // derive the entry price from the account's own cost basis.
      this.inPosition = true;
      this.entryPrice = posCost > 0n ? (Number(posCost) / Number(posQty)) * this.entryScale : close;
      this.barsHeld = 0;
    }
    if (!holding && this.inPosition) {
      // A sell fill landed: the book is flat again, start the cooldown.
      this.inPosition = false;
      this.entryPrice = null;
      this.barsSinceExit = 0;
      this.tranchesDone = 0;
    }

    const dd = this.drawdownBps(close);
    if (dd > -REARM_BPS) this.cycleArmed = true;

    const orders: Order[] = [];
    if (this.inPosition) {
      this.barsHeld += 1;
      const gain = this.gainBps(close);
      if (gain >= TAKE_PROFIT_BPS || gain <= -STOP_LOSS_BPS || this.barsHeld >= TIMEOUT_BARS) {
        orders.push(this.sellOrder(posQty));
      } else if (this.tranchesDone < TRANCHE_DD_BPS.length) {
        // Deepen the position if the sell-off extends to the next tranche.
        if (dd <= -TRANCHE_DD_BPS[this.tranchesDone] && cash >= MIN_NOTIONAL) {
          const o = this.buyOrder(cash, TRANCHE_FRAC[this.tranchesDone]);
          if (o !== null) {
            this.tranchesDone += 1;
            orders.push(o);
          }
        }
      }
    } else {
      this.barsSinceExit += 1;
      if (
        this.cycleArmed &&
        this.tranchesDone === 0 &&
        this.closes.length >= MIN_BARS &&
        this.closes.length <= LAST_ENTRY_BAR &&
        this.barsSinceExit > COOLDOWN &&
        cash >= MIN_NOTIONAL &&
        dd <= -TRANCHE_DD_BPS[0]
      ) {
        const o = this.buyOrder(cash, TRANCHE_FRAC[0]);
        if (o !== null) {
          this.cycleArmed = false;
          this.tranchesDone = 1;
          orders.push(o);
        }
      }
    }
    return orders;
  }
}

function main(): void {
  const rider = new SwingRider();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line: string) => {
    const text = line.trim();
    if (!text) return;
    const msg = JSON.parse(text);
    if (msg.type === "hello") {
      if (Array.isArray(msg.symbols) && msg.symbols.length > 0) {
        const sym = msg.symbols[0];
        rider.symbol = sym.symbol;
        const quoteScale = msg.capital?.quote_scale ?? 6;
        const exponent = (sym.qty_scale ?? 8) - quoteScale + (sym.price_scale ?? 5);
        rider.entryScale = Math.pow(10, exponent);
      }
      return;
    }
    if (msg.type === "done") {
      rl.close();
      return;
    }
    if (msg.type !== "batch") return;

    const account = msg.account;
    const cash = BigInt(account.cash_quote_units);
    let qty = 0n;
    let cost = 0n;
    for (const pos of account.positions ?? []) {
      if (pos.symbol === rider.symbol) {
        qty = BigInt(pos.qty);
        cost = BigInt(pos.cost_quote_units);
      }
    }
    let close: number | null = null;
    for (const bar of msg.bars ?? []) {
      if (bar.symbol === rider.symbol) close = Number(bar.c);
    }
    let orders: Order[] = [];
    if (close !== null && close > 0) {
      orders = rider.onBar(close, cash, qty, cost);
    }
    process.stdout.write(
      JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
    );
  });
}

main();
