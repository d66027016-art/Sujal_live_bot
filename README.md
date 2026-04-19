# 🤖 SUJAL_LIVE Assistant – Classic Minecraft AFK Bot & Dashboard

A premium, lightweight **Minecraft AFK bot** and **Remote Management Dashboard** built with [mineflayer](https://github.com/PrismarineJS/mineflayer). This bot doesn't just AFK; it allows you to manage your inventory, escape lobbies, and solve chat games remotely through a beautiful, responsive web interface.

---

### 🌟 Key Features

#### 📦 Classic Inventory Dashboard
- **Pixel-Accurate UI**: A classic Minecraft inventory layout including Armor slots, Crafting grid, and Hotbar.
- **Remote Interaction**: Equip, Use/Consume, or Drop items (Toss 1 or Toss All) directly from your browser.
- **Live State Sync**: Real-time heartbeat synchronization for Health, Hunger, and Coordinates.

#### 🧠 Intelligent Automation
- **Lobby Escape**: Automated NPC navigation and "Use Held Item" manual fallback for Hub selectors.
- **Chat Game Solver**: Automatically detects and answers Math equations (e.g., `15 + 5`) and Word Scrambles.
- **AFK Movement**: Randomized movement and anti-stuck jumping to prevent server kicks.
- **Auto-Promoter**: Periodically broadcasts your custom message to the server chat.

#### 🔒 Security & Performance
- **Dashboard Auth**: Password-protected web console to prevent unauthorized access.
- **Environment Driven**: All secrets (IP, Port, Passwords) are stored in a secure `.env` file, never committed to GitHub.
- **Auto-Reconnect**: Automatically recovers from server restarts or connection drops.

---

### 🌐 Server Configuration

Your bot is configured via environment variables for maximum security.

| Setting | Environment Variable | Default / Example |
| :--- | :--- | :--- |
| **Host** | `BOT_HOST` | `play.khushigaming.com` |
| **Port** | `BOT_PORT` | `1241` |
| **Username**| `BOT_USERNAME` | `Sujal_live_bot` |
| **Version** | `BOT_VERSION` | `1.21.11` (Auto-detect) |
| **Admin UI** | `ADMIN_PASS` | `Sujal8905` |

---

### 💬 Chat Commands

The bot responds to everyone in the public chat:
- **`help`** – Replies with "kya hua bhai"
- **`ping`** – Responds with "pong"
- **`bot`** – Shows creator information
- **`sujal_live_bot`** – Detailed creator credit

---

### 🔧 Setup & Installation

1. **Clone the Project**
   ```bash
   git clone https://github.com/d66027016-art/Sujal_live_bot.git
   cd Sujal_live_bot
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Configure Secrets**
   Create a `.env` file in the root directory:
   ```env
   BOT_HOST=play.khushigaming.com
   BOT_PORT=1241
   BOT_USERNAME=Sujal_live_bot
   BOT_VERSION=1.21.11
   ADMIN_PASS=YourSecretPass
   PORT=3000
   ```

4. **Run the Bot**
   ```bash
   node index.js
   ```

---

### 🧑‍💻 Author

Built with ❤️ by **Sujal_live**

---

### 📜 License

This project is open-source and free to use.  
**Give a ⭐ if you find it useful!**
