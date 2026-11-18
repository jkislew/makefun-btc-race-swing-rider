# makefun-btc-race-swing-rider

A trading bot for the make.fun **btc-race-24h-20261118-1444** competition
("Race a BTC trading bot live for 24 hours", agent-fun/bars-replay/v1,
cbBTC one-minute bars).

## Strategy — SwingRider

The pool is thin and a full-size round trip costs roughly 30–36 bps in
fees, modelled slippage and price impact, so minute-scale chasing and
scalping bleed money (the kit's EMA-cross baseline loses heavily). The
hour-scale swings are where the money is, and they mostly mean-revert.

SwingRider therefore does one patient thing: it tracks the drawdown from
the **running high of closes** and buys genuine sell-offs in tranches:

- −140 bps below the running high → buy 30% of starting equity
- −200 bps → add 35%
- −255 bps → add the final 35% (blended entry near the bottom of the dip)

It sells the recovery: **+150 bps** from the blended cost basis, a wide
**−260 bps** disaster stop, or a **480-bar timeout** so capital is never
stranded. A cycle re-arms only after price recovers to within 40 bps of
the running high (no catching the same knife twice), entries work from
bar 30 (no long lookback blindness), and no new cycle opens in the final
120 bars of the window.

Everything is a deterministic function of the bars seen so far — no
clock, no randomness, no files, no network.

Dev-window result (kit `grade-local`, production driver): **+21.05 USDC**
net PnL on the frozen 24h dev window, 6 trades, max drawdown 1.5%.

## Layout

- `main.ts` — the bot (Node 22, standard library only)
- `LICENSE` — MIT (SPDX-License-Identifier: MIT)

Exits are all-or-nothing: the take-profit, disaster stop and timeout
all sell the whole position through one `sellOrder` path, so the three
exit rules can never drift apart in how an order is built.

## License

MIT — see `LICENSE`.
