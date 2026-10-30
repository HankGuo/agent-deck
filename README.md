# ⚡ Agent Deck · 赛博军团调度台

> A lightweight, zero-dependency Multi-Agent local orchestration desk and interactive Web console, supporting Agent Client Protocol (ACP) and Stream JSON.

---

## 🌟 Highlights

- **Multi-Agent Coordination**: Seamlessly coordinate multiple coding & reasoning agents (Antigravity, Kimi Code, MiniMax Code, OpenClaw, etc.).
- **Protocol Flexibility**:
  - **ACP (Agent Client Protocol)**: Standard JSON-RPC over stdio.
  - **Stream JSON / NDJSON**: Native CLI stream integration.
- **Zero External Dependencies**: Pure Node.js standard library (`node:http`, `node:fs`, `node:child_process`).
- **Real-time Web Console**: Clean web dashboard with real-time SSE streaming, token counting, and thinking block visualizations.
- **Sandboxed Workspaces**: Built-in input (`uploads/`) and output (`outputs/`) separation to keep deliverables safe and tidy.

---

## 🚀 Quick Start

### 1. Requirements
- Node.js >= 18.0.0

### 2. Run
```bash
# Clone the repository
git clone https://github.com/HankGuo/agent-deck.git
cd agent-deck

# Start the gateway server (default port: 8788)
node server/server.mjs
```

Open your browser at `http://localhost:8788`.

---

## ⚙️ Configuration

Agent configuration and workspace paths are defined in `server/registry.json`:

```json
{
  "version": 1,
  "workspace": "./workspace",
  "uploads": "./uploads",
  "outputs": "./outputs",
  "limits": {
    "maxConcurrentRuns": 2,
    "promptTimeoutMs": 600000
  },
  "agents": [
    {
      "id": "kimi",
      "name": "Kimi Code",
      "protocol": "acp",
      "cmd": ["kimi", "acp"],
      "model": "K3.1 Pro"
    }
  ]
}
```

---

## 📄 License

MIT © [HankGuo](https://github.com/HankGuo)
