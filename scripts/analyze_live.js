const https = require("https");

function fetchTrades() {
  return new Promise((resolve, reject) => {
    https.get("https://btc-trading-dashboard.onrender.com/api/all-trades", (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function run() {
  const trades = await fetchTrades();
  console.log("Total trades retrieved:", trades.length);
  
  const closedTrades = trades.filter(t => t.isCorrect !== undefined);
  console.log("Closed trades:", closedTrades.length);

  const byStrategy = {};
  const byDirection = { LONG: { total: 0, win: 0, loss: 0, pnl: 0 }, SHORT: { total: 0, win: 0, loss: 0, pnl: 0 } };
  const byDate = {};

  closedTrades.forEach(t => {
    const reason = (t.reasoning && t.reasoning[0]) ? t.reasoning[0] : "未知策略";
    let stratKey = "其他";
    if (reason.includes("二次反包")) stratKey = "二次反包确认反转";
    else if (reason.includes("多头回踩EMA50")) stratKey = "多头回踩EMA50做多";
    else if (reason.includes("空头反弹EMA50")) stratKey = "空头反弹EMA50做空";
    else if (reason.includes("5连跌")) stratKey = "5连跌超跌反弹做多";
    else if (reason.includes("5连涨")) stratKey = "5连涨摸顶做空";
    else if (reason.includes("长下影阳线吞没")) stratKey = "长下影阳线吞没做多";
    else if (reason.includes("长上影阴线吞没")) stratKey = "长上影阴线吞没做空";
    else if (reason.includes("偏离EMA50做多")) stratKey = "偏离EMA50做多";
    else if (reason.includes("偏离EMA50做空")) stratKey = "偏离EMA50做空";
    else if (reason.includes("平行") || reason.includes("EMA200")) stratKey = "EMA200平行趋势回踩";
    else if (reason.includes("EMA150")) stratKey = "EMA150策略(历史)";
    else stratKey = reason.substring(0, 30);

    if (!byStrategy[stratKey]) {
      byStrategy[stratKey] = { total: 0, win: 0, loss: 0, pnl: 0 };
    }
    byStrategy[stratKey].total++;
    if (t.isCorrect) {
      byStrategy[stratKey].win++;
    } else {
      byStrategy[stratKey].loss++;
    }
    byStrategy[stratKey].pnl += (t.profitLoss || 0);

    const dir = t.tradeType || (t.signal === "BUY" ? "LONG" : "SHORT");
    if (byDirection[dir]) {
      byDirection[dir].total++;
      if (t.isCorrect) byDirection[dir].win++;
      else byDirection[dir].loss++;
      byDirection[dir].pnl += (t.profitLoss || 0);
    }

    const d = t.timestamp ? t.timestamp.substring(0, 10) : "未知";
    if (!byDate[d]) byDate[d] = { total: 0, win: 0, loss: 0, pnl: 0 };
    byDate[d].total++;
    if (t.isCorrect) byDate[d].win++;
    else byDate[d].loss++;
    byDate[d].pnl += (t.profitLoss || 0);
  });

  console.log("\n=== 1. 按策略统计 ===");
  Object.entries(byStrategy)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([k, v]) => {
      const wr = (v.win / v.total * 100).toFixed(1);
      console.log(`${k.padEnd(24)}: 笔数=${String(v.total).padStart(3)}, 胜=${String(v.win).padStart(2)}, 负=${String(v.loss).padStart(2)}, 胜率=${wr.padStart(5)}%, 净盈亏=${String(v.pnl).padStart(5)}U`);
    });

  console.log("\n=== 2. 按多空方向统计 ===");
  for (const [k, v] of Object.entries(byDirection)) {
    const wr = (v.win / v.total * 100).toFixed(1);
    console.log(`${k}: 笔数=${v.total}, 胜=${v.win}, 负=${v.loss}, 胜率=${wr}%, 净盈亏=${v.pnl}U`);
  }

  console.log("\n=== 3. 按日期统计 ===");
  for (const [k, v] of Object.entries(byDate)) {
    const wr = (v.win / v.total * 100).toFixed(1);
    console.log(`${k}: 笔数=${String(v.total).padStart(2)}, 胜=${String(v.win).padStart(2)}, 负=${String(v.loss).padStart(2)}, 胜率=${wr}%, 净盈亏=${v.pnl}U`);
  }

  // Drawdown analysis
  let peak = 500;
  let maxDrawdown = 0;
  let balance = 500;
  closedTrades.forEach(t => {
    balance += (t.profitLoss || 0);
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDrawdown) maxDrawdown = dd;
  });
  console.log(`\n=== 4. 资金与回撤 ===`);
  console.log(`初始资金: 500U`);
  console.log(`最高资金峰值: ${peak}U`);
  console.log(`当前资金: ${balance}U`);
  console.log(`历史最大回撤(绝对值): ${maxDrawdown}U`);
}

run().catch(console.error);


async function runPeriodComparison() {
  const trades = await fetchTrades();
  const closed = trades.filter(t => t.isCorrect !== undefined);
  
  const recent = closed.filter(t => t.timestamp >= "2026-10-28");
  console.log("\n==========================================");
  console.log("=== 近期策略情况（2026-10-28 至今，共 " + recent.length + " 笔） ===");
  console.log("==========================================");
  
  const stratMap = {};
  let recentLongWin = 0, recentLongTotal = 0, recentLongPnl = 0;
  let recentShortWin = 0, recentShortTotal = 0, recentShortPnl = 0;

  recent.forEach(t => {
    const reason = (t.reasoning && t.reasoning[0]) || "未知";
    let k = reason.split("｜")[0].trim();
    stratMap[k] = stratMap[k] || { total: 0, win: 0, loss: 0, pnl: 0 };
    stratMap[k].total++;
    if (t.isCorrect) stratMap[k].win++;
    else stratMap[k].loss++;
    stratMap[k].pnl += (t.profitLoss || 0);

    const dir = t.tradeType || (t.signal === "BUY" ? "LONG" : "SHORT");
    if (dir === "LONG") {
      recentLongTotal++;
      if (t.isCorrect) recentLongWin++;
      recentLongPnl += (t.profitLoss || 0);
    } else {
      recentShortTotal++;
      if (t.isCorrect) recentShortWin++;
      recentShortPnl += (t.profitLoss || 0);
    }
  });

  Object.entries(stratMap)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([k, v]) => {
      console.log(`${k.padEnd(28)}: 笔数=${String(v.total).padStart(2)}, 胜=${String(v.win).padStart(2)}, 负=${String(v.loss).padStart(2)}, 胜率=${(v.win/v.total*100).toFixed(1).padStart(5)}%, 净盈亏=${String(v.pnl).padStart(5)}U`);
    });

  console.log("\n近期多空对比:");
  console.log(`多头(LONG): 笔数=${recentLongTotal}, 胜率=${(recentLongWin/recentLongTotal*100).toFixed(1)}%, 盈亏=${recentLongPnl}U`);
  console.log(`空头(SHORT): 笔数=${recentShortTotal}, 胜率=${(recentShortWin/recentShortTotal*100).toFixed(1)}%, 盈亏=${recentShortPnl}U`);
}

runPeriodComparison().catch(console.error);
