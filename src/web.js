import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { state } from "./state.js";
import { snapshot } from "./analysis.js";
import { askClaude } from "./claude.js";
import { wsHealth } from "./binance.js";
import { getMLSnapshot } from "./ml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startWeb() {
  const app = express();
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use(express.json());

  app.get("/api/snapshot", (req, res) => {
    const out = config.symbols.map((sym) => snapshot(state.getSymbol(sym)));
    res.json({
      snapshots: out,
      levels: config.levels,
      ml: getMLSnapshot(),
      ws: {
        connected: wsHealth.connected,
        lastMessageAt: wsHealth.lastMessageAt,
        sinceLastMs: wsHealth.lastMessageAt
          ? Date.now() - wsHealth.lastMessageAt
          : null,
        reconnectCount: Math.max(0, wsHealth.reconnectCount - 1),
        messagesReceived: wsHealth.messagesReceived,
      },
      time: Date.now(),
    });
  });

  app.get("/api/snapshot/:symbol", (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    const data = state.getSymbol(sym);
    if (!data) return res.status(404).json({ error: "unknown symbol" });
    res.json(snapshot(data));
  });

  app.post("/api/advice", async (req, res) => {
    try {
      const advice = await askClaude({ extraContext: req.body?.context || "" });
      res.json({ advice, time: Date.now() });
    } catch (e) {
      console.error("[web] advice error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      time: Date.now(),
      symbols: config.symbols,
      ws: wsHealth,
    });
  });

  app.listen(config.web.port, config.web.host, () => {
    console.log(
      `[web] listening on http://${config.web.host}:${config.web.port}`,
    );
  });
}
