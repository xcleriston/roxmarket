[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JP.md)

<p align="center">
  <img src="asset/logo.png" alt="PolyCopy" width="200">
</p>

<h1 align="center">PolyCopy</h1>

<p align="center">
  <strong>Automated copy trading bot for Polymarket prediction markets</strong>
</p>

<p align="center">
  <a href="https://github.com/neosun100/polycopy/actions"><img src="https://img.shields.io/badge/build-passing-brightgreen" alt="Build"></a>
  <a href="https://github.com/neosun100/polycopy/blob/main/LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
  <a href="https://hub.docker.com/r/neosun/polycopy"><img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker" alt="Docker"></a>
  <img src="https://img.shields.io/badge/tests-40%20passed-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green?logo=node.js" alt="Node">
</p>

---

> **⚠️ Security Note**: This project was forked from a malicious repository that contained hidden private key theft code. All malicious code has been removed, audited 3 times, and the project has been completely rewritten with security-first design. See [Security](#-security) for details.

## ✨ Features

- **Multi-Trader Copy Trading** — Track and mirror trades from multiple top Polymarket traders simultaneously
- **3 Copy Strategies** — Percentage, Fixed, or Adaptive sizing with tiered multipliers
- **Kill Switch Protection** — Automatic daily loss cap stops trading when threshold is exceeded
- **Preview Mode** — Dry-run mode to test without risking real funds
- **Trade Aggregation** — Combines small trades into larger executable orders
- **Position Tracking** — Accurate buy/sell tracking even after balance changes
- **Web Dashboard** — Real-time monitoring UI with dark theme and multi-language support
- **REST API + Swagger** — Full API with interactive documentation at `/docs`
- **MCP Server** — Model Context Protocol integration for AI assistant access
- **Telegram Notifications** — Trade execution, kill switch, and error alerts
- **Zero External DB** — Uses NeDB (local file storage), no MongoDB needed
- **Docker Ready** — Single container, 189MB, all-in-one deployment

## 🚀 Quick Start

### Option 1: Docker (Recommended)

```bash
# Pull and run
docker run -d --name polycopy \
  -p 3000:3000 \
  -v polycopy_data:/app/data \
  --env-file .env \
  neosun/polycopy:latest

# Open dashboard
open http://localhost:3000
```

### Option 2: From Source

```bash
git clone https://github.com/neosun100/polycopy.git
cd polycopy
npm install
cp .env.example .env   # Edit with your settings
npm run build
npm start              # Bot + Web UI on port 3000
```

## ⚙️ Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Required
USER_ADDRESSES='0xTraderAddress1,0xTraderAddress2'  # Traders to copy
PROXY_WALLET='0xYourWalletAddress'                   # Your wallet
PRIVATE_KEY='your_64_hex_private_key'                # No 0x prefix
RPC_URL='https://polygon-mainnet.infura.io/v3/KEY'   # Polygon RPC

# Strategy (defaults shown)
COPY_STRATEGY='PERCENTAGE'    # PERCENTAGE | FIXED | ADAPTIVE
COPY_SIZE=10.0                # 10% of trader's order
MAX_ORDER_SIZE_USD=100.0      # Max per trade
SLIPPAGE_TOLERANCE=0.05       # Max price deviation

# Safety
DAILY_LOSS_CAP_PCT=20         # Kill switch at 20% daily loss
PREVIEW_MODE=false            # Set true to test without trading

# Optional
TELEGRAM_BOT_TOKEN='...'      # From @BotFather
TELEGRAM_CHAT_ID='...'        # Your chat ID
```

See [.env.example](.env.example) for all options including tiered multipliers and trade aggregation.

## 🖥️ Access Modes

| Mode | URL | Description |
|------|-----|-------------|
| Web UI | `http://localhost:3000` | Dashboard with trade monitoring |
| Swagger | `http://localhost:3000/docs` | Interactive API documentation |
| REST API | `http://localhost:3000/api/*` | Programmatic access |
| MCP | stdio | AI assistant integration |

### MCP Configuration

```json
{
  "mcpServers": {
    "polycopy": {
      "command": "node",
      "args": ["dist/mcp/server.js"]
    }
  }
}
```

Available MCP tools: `get_bot_status`, `get_recent_trades`, `get_positions`, `get_config`

## 🏗️ Project Structure

```
polycopy/
├── src/
│   ├── config/          # Environment & strategy configuration
│   ├── interfaces/      # TypeScript type definitions
│   ├── models/          # NeDB data models
│   ├── server/          # Express.js Web UI + API
│   ├── services/        # Trade monitor & executor
│   ├── mcp/             # MCP server
│   ├── utils/           # Core utilities (orders, balance, logging)
│   ├── scripts/         # CLI tools (health check, simulation, etc.)
│   └── __tests__/       # Unit tests (40 tests)
├── Dockerfile           # Multi-stage build
├── docker-compose.yml   # One-command deployment
└── .env.example         # Configuration template
```

## 🛡️ Security

This project was forked from [a known malicious repository](https://phemex.com/blogs/openclaw-polymarket-automated-trading-analysis) and has undergone extensive security hardening:

- ✅ Removed hidden private key theft code (`keccak256-helper` supply chain attack)
- ✅ Removed 2 malicious npm packages
- ✅ Removed leaked MongoDB credentials and API keys from docs
- ✅ 3 rounds of security audits (code, dependencies, network requests)
- ✅ Pre-commit secret scanning script (`npm run check-secrets`)
- ✅ `npm audit` runs automatically before each start
- ✅ Private key format validation on startup
- ✅ No external data exfiltration — only connects to Polymarket API and Polygon RPC

## 🧪 Testing

```bash
npm test                # Run all 40 tests
npm run test:coverage   # With coverage report
npm run check-secrets   # Scan for leaked secrets
npm run health-check    # Verify all connections
```

## 🔧 Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript 5 |
| Runtime | Node.js 18+ |
| Trading | @polymarket/clob-client (official) |
| Blockchain | ethers.js v5 (Polygon) |
| Database | NeDB (local file, zero config) |
| Web UI | Express.js + vanilla JS |
| API Docs | Swagger UI |
| MCP | @modelcontextprotocol/sdk |
| Testing | Jest + ts-jest |
| Container | Docker (Alpine, 189MB) |

## 📋 Available Commands

```bash
npm start              # Start bot + web UI
npm run dev            # Development mode
npm run health-check   # Verify configuration
npm run check-secrets  # Security scan
npm test               # Run tests
npm run find-traders   # Discover profitable traders
npm run simulate       # Backtest strategies
npm run check-stats    # View trading statistics
```

## 👥 Contributors

<table>
<tr>
<td align="center">
<a href="https://github.com/neosun100">
<img src="https://avatars.githubusercontent.com/u/13846998?v=4" width="100px;" alt="Neo 孫"/>
<br /><sub><b>Neo 孫</b></sub>
</a>
<br />🛡️ Security Hardening & v2.0 Rewrite
</td>
<td align="center">
<a href="https://github.com/LesterCovata">
<img src="https://avatars.githubusercontent.com/u/123233333?v=4" width="100px;" alt="LesterCovata"/>
<br /><sub><b>LesterCovata</b></sub>
</a>
<br />📝 Original Codebase (v1.0)
</td>
</tr>
</table>

**Neo 孫** (v2.0 — Security Rewrite):
- 🛡️ Discovered and removed hidden private key theft code (`keccak256-helper` supply chain attack)
- 🛡️ Removed 2 malicious npm packages (`keccak256-helper`, `encrypt-layout-helper`)
- 🛡️ 3 rounds of security audits (code, dependencies, network requests)
- 🛡️ Removed leaked MongoDB credentials and Infura API keys from docs
- 🛡️ Added pre-commit secret scanning and `npm audit` automation
- 🚀 Migrated from MongoDB to NeDB (zero external database dependency)
- 🚀 Added kill switch + daily loss cap protection
- 🚀 Added preview/dry-run mode
- 🚀 Added Telegram notifications
- 🚀 Added Web UI dashboard + REST API + Swagger docs
- 🚀 Added MCP server for AI assistant integration
- 🚀 Parallel trader monitoring (5x faster with multiple traders)
- 🚀 Configurable slippage protection
- 🐛 Fixed `TOO_OLD_TIMESTAMP` comparison bug (was comparing Unix timestamp with hours integer)
- 🐛 Removed ~80 lines of dead code (unreachable `merge` branch)
- 🧪 Added 40 unit tests (copyStrategy, postOrder, env)
- 🐳 Docker all-in-one image (189MB, multi-stage build)
- 📝 4-language README (EN/CN/TW/JP)

**LesterCovata** (v1.0 — Original):
- 📝 Core copy trading logic (trade monitor, executor, order posting)
- 📝 3 copy strategies (Percentage, Fixed, Adaptive) with tiered multipliers
- 📝 Position tracking system with `myBoughtSize`
- 📝 Trade aggregation for small orders
- 📝 20+ CLI utility scripts (find traders, simulate, check stats, etc.)
- 📝 Comprehensive documentation (15+ guides)

> ⚠️ **A note on the original codebase**: The v1.0 code was a fully functional copy trading bot — credit where it's due. However, it also contained a carefully hidden supply chain attack: a `setTimeout` call buried at the end of a 500-character line that silently sent your private key to a malicious npm package. The code was designed to look legitimate while stealing funds. This is a textbook example of why you should **never run unaudited trading bots with real private keys**. All malicious code has been removed in v2.0.

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Run tests (`npm test`)
4. Commit changes (`git commit -m 'Add amazing feature'`)
5. Push to branch (`git push origin feature/amazing`)
6. Open a Pull Request

## 📄 License

MIT License — see [LICENSE.md](LICENSE.md)

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=neosun100/polycopy&type=Date)](https://star-history.com/#neosun100/polycopy)

## 📱 Follow

![WeChat](https://img.aws.xin/uPic/扫码_搜索联合传播样式-标准色版.png)

---

**Disclaimer**: This software is for educational purposes only. Trading involves risk of loss. Only invest what you can afford to lose.
