require('dotenv').config();
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { SocksClient } = require('socks');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const ADMIN_PASSWORD = process.env.ADMIN_PASS;
if (!ADMIN_PASSWORD) {
  console.log('WARNING: ADMIN_PASS not set in environment variables! Web dashboard will be inaccessible.');
}
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
let bot = null;
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60000;

// Serve static files with absolute path for Render compatibility
app.use(express.static(path.join(__dirname, 'public')));

let isAfkEnabled = true;
let autoMsgTimer = null;
let lastAutoMsgTime = Date.now();
let lastReplyTime = 0; // Anti-spam cooldown

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Root route redirect to index.html if needed (fallback)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Override console.log to stream to web dashboard
const originalLog = console.log;
console.log = function (...args) {
  originalLog.apply(console, args);
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');

  // Determine type for better UI coloring
  let type = 'System';
  let level = 'info';

  if (msg.includes('[Server Raw Message]')) { type = 'Server'; level = 'server'; }
  else if (msg.includes('[ChatGame]')) { type = 'Game'; level = 'bot'; }
  else if (msg.includes('Bot spawned') || msg.includes('Moving to NPC')) { type = 'Bot'; level = 'bot'; }

  io.sockets.sockets.forEach(s => {
    if (s.authenticated) {
      // If it's a raw server message, send the original JSON object for rich formatting
      if (msg.includes('[Server Raw Message]')) {
        const rawJsonStr = msg.replace('[Server Raw Message] ', '').trim();
        try {
          const rawObj = JSON.parse(rawJsonStr);
          // If it's wrapped in a 'json' key (common in some Mineflayer versions), unwrap it
          const finalObj = rawObj.json || rawObj;
          s.emit('log', { type: 'Server', msg: finalObj, level: 'server', isRaw: true });
          return;
        } catch (e) {
          // Fallback: strip the tag but keep the text
          const cleanMsg = msg.replace('[Server Raw Message] ', '');
          s.emit('log', { type: 'Server', msg: cleanMsg, level: 'server' });
          return;
        }
      }
      s.emit('log', { type, msg, level });
    }
  });
};

io.on('connection', (socket) => {
  socket.on('auth', (pass) => {
    if (pass === ADMIN_PASSWORD) {
      socket.authenticated = true;
      socket.emit('auth_success');
    } else {
      socket.emit('auth_fail');
    }
  });

  // Countdown Heartbeat
  setInterval(() => {
    const remaining = Math.max(0, 240000 - (Date.now() - lastAutoMsgTime));
    socket.emit('auto_msg_countdown', { remaining });
  }, 1000);

  socket.on('cmd', (cmd) => {
    if (socket.authenticated && bot) {
      bot.chat(cmd);
      console.log(`[Web Command Executed] ${cmd}`);
    }
  });

  socket.on('action', (action) => {
    if (!socket.authenticated || !bot) return;
    console.log(`[Web Action] ${action}`);
    switch (action) {
      case 'reconnect':
        bot.end();
        break;
      case 'joinSurvival':
        joinSurvival();
        break;
      case 'toggleAfk':
        isAfkEnabled = !isAfkEnabled;
        console.log(`AFK Mode is now ${isAfkEnabled ? 'Enabled' : 'Disabled'}`);
        if (isAfkEnabled) randomMovement();
        break;
      case 'useItem':
        if (bot) {
          console.log('[Manual Action] Using held item (Right-Click)...');
          bot.activateItem();
        }
        break;
    }
  });

  socket.on('inv_action', (data) => {
    if (!socket.authenticated || !bot) return;
    console.log(`[Inventory Action] ${data.action} on slot ${data.slot}`);
    const item = bot.inventory.slots[data.slot];
    if (!item) return;

    switch (data.action) {
      case 'equip':
        bot.equip(item, 'hand').catch(err => console.log('Equip error:', err));
        break;
      case 'use':
        bot.equip(item, 'hand').then(() => {
          bot.consume().catch(() => bot.activateItem());
        }).catch(err => console.log('Use error:', err));
        break;
      case 'drop':
        bot.tossStack(item).catch(err => console.log('Drop error:', err));
        break;
      case 'drop1':
        bot.toss(item.type, null, 1).catch(err => console.log('Drop error:', err));
        break;
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Admin Console running at http://0.0.0.0:${PORT}`);
  console.log(`Detected Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Handle EPIPE and other stream errors globally to prevent crashes on Render
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') {
    console.log('Caught EPIPE error (Broken Pipe). This is often a non-fatal network blip on Render.');
    return;
  }
  console.error('Uncaught Exception:', err);
});

function createBot() {
  if (bot) {
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  const botOptions = {
    host: process.env.BOT_HOST || 'khushigaming.com',
    port: parseInt(process.env.BOT_PORT) || 25565,
    username: process.env.BOT_USERNAME || 'Sujal_live_bot',
    version: process.env.BOT_VERSION || false
  };

  // Sanitize version typo (1.21.11 -> 1.21.1)
  if (botOptions.version === '1.21.11') {
    console.log('[Fix] Correcting version typo from 1.21.11 to 1.21.1');
    botOptions.version = '1.21.1';
  }

  // SOCKS5 Proxy logic
  if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
    console.log(`[Proxy] Routing connection through SOCKS5 proxy: ${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`);
    botOptions.connect = (client) => {
      const proxyOptions = {
        proxy: {
          host: process.env.PROXY_HOST,
          port: parseInt(process.env.PROXY_PORT),
          type: 5
        },
        command: 'connect',
        destination: {
          host: botOptions.host,
          port: botOptions.port
        }
      };

      if (process.env.PROXY_USER && process.env.PROXY_PASS) {
        proxyOptions.proxy.userId = process.env.PROXY_USER;
        proxyOptions.proxy.password = process.env.PROXY_PASS;
      }

      SocksClient.createConnection(proxyOptions, (err, info) => {
        if (err) {
          console.log(`[Proxy Error] Failed to connect: ${err.message}`);
          return;
        }
        client.setSocket(info.socket);
        client.emit('connect');
      });
    };
  }

  bot = mineflayer.createBot(botOptions);

  bot.loadPlugin(pathfinder);

  bot.on('message', (jsonMsg) => {
    // preserve § color codes for the web dashboard
    const msg = jsonMsg.toMotd();
    console.log(msg);
    const clean = jsonMsg.toString();
    const lower = clean.toLowerCase();

    if (lower.includes('/register') || lower.includes('register')) {
      bot.chat('/register Bot@12345 Bot@12345');
    } else if (lower.includes('/login') || lower.includes('login') || lower.includes('autenticar')) {
      bot.chat('/login Bot@12345');
    }

    solveChatGames(clean);

    // Improved Chat Triggers with Self-Reply Guard
    const lowerClean = clean.toLowerCase();
    const botName = bot.username ? bot.username.toLowerCase() : '';
    
    // Ignore messages from the bot itself to prevent loops
    // Anti-spam cooldown (1 reply per 10 seconds)
    if (Date.now() - lastReplyTime < 10000) return;

    if (!botName || !lowerClean.startsWith(botName)) {
        if (lowerClean.endsWith('help')) {
            bot.chat('kya hua bhai');
            lastReplyTime = Date.now();
        } else if (lowerClean.endsWith('ping')) {
            bot.chat('pong');
            lastReplyTime = Date.now();
        } else if (lowerClean.endsWith('bot')) {
            bot.chat('I am an AFK bot created by Sujal_live for 24/7 server stability!');
            lastReplyTime = Date.now();
        } else if (lowerClean.endsWith('sujal_live_bot')) {
            bot.chat('Developer: Sujal_live | Features: Auto-AFK, Auto-Inventory, Live Dashboard. Thanks for using it!');
            lastReplyTime = Date.now();
        }
    }
  });

  bot.on('health', () => {
    if (bot.food < 15) {
      const food = bot.inventory.items().find(i =>
        i.name.includes('apple') || i.name.includes('bread') ||
        i.name.includes('steak') || i.name.includes('cooked') ||
        i.name.includes('carrot') || i.name.includes('potato')
      );
      if (food) {
        console.log(`Hungry (${bot.food})! Eating ${food.name}...`);
        bot.equip(food, 'hand').then(() => {
          bot.consume();
        }).catch(err => console.log('Error eating:', err));
      }
    }
  });

  let lastPosCheck = null;
  let stuckCounter = 0;
  setInterval(() => {
    if (bot.entity && isAfkEnabled) {
      if (lastPosCheck && bot.entity.position.distanceTo(lastPosCheck) < 0.1) {
        stuckCounter++;
        if (stuckCounter > 15) { // ~30s if interval is 2s
          console.log('Bot seems stuck. Jumping...');
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 500);
          stuckCounter = 0;
        }
      } else {
        stuckCounter = 0;
      }
      lastPosCheck = bot.entity.position.clone();
    }
  }, 2000);

  bot.on('title', (title) => {
    const text = getText(title);
    if (typeof text === 'string' && text.trim()) console.log('[Server Title] ' + text);
  });
  bot.on('actionBar', (msg) => {
    const text = getText(msg);
    if (typeof text === 'string' && text.trim()) console.log('[Server Action Bar] ' + text);
  });
  bot.on('windowOpen', (win) => {
    console.log('[Server Window] Title: ' + win.title + ' ID: ' + win.id);
    sendInventory();
  });


  bot.on('whisper', (username, message) => {
    if (username === bot.username) return;
    console.log(`[Whisper] <${username}>: ${message}`);
    bot.whisper(username, `Hello ${username}, I got your message!`);
  });

  bot.once('spawn', () => {
    console.log('Bot spawned successfully!');
    console.log('Detected version: ' + bot.version);
    reconnectDelay = 5000; // Reset backoff on successful spawn

    // Status update loop
    setInterval(() => {
      if (bot.entity) {
        io.sockets.sockets.forEach(s => {
          if (s.authenticated) {
            s.emit('status', {
              health: bot.health,
              food: bot.food,
              pos: bot.entity.position,
              isAfk: !bot.pathfinder.isMoving()
            });
          }
        });
      }
    }, 1000);

    // Inventory Sync Loop (Every 5 seconds)
    setInterval(() => {
      sendInventory();
    }, 5000);

    // Immediate initial sync
    setTimeout(() => {
      sendInventory();
      if (bot.entity) {
        io.to('authenticated').emit('status', {
          health: bot.health,
          food: bot.food,
          pos: bot.entity.position,
          isAfk: false
        });
      }
    }, 2000);

    setTimeout(() => {
      bot.chat('/login Bot@12345'); // Fallback login attempt
      setTimeout(() => {
        joinSurvival();
      }, 5000);
    }, 2000);

    // Start simple auto-messenger
    startAutoMessenger();
  });

  bot.on('end', () => {
    console.log(`Bot disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(() => {
      console.log('Attempting reconnection...');
      createBot();
    }, reconnectDelay);
    
    // Exponential backoff
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
  });

  bot.on('error', err => {
    if (err.code === 'ECONNRESET') {
      console.log('Bot Error: ECONNRESET (Connection Reset by Server).');
      console.log('NOTE: This often means the Minecraft server is blocking Render.com IPs or the version is wrong.');
    } else {
      console.log('Bot error:', err);
    }
  });

  bot.on('kicked', reason => {
    console.log('Bot was kicked:', JSON.stringify(reason));
  });

  bot.on('windowOpen', () => sendInventory());
  bot.on('inventoryEvent', () => sendInventory());
}

// --- Global Functions for Bot Control ---

function joinSurvival() {
  if (!bot) return;
  // Temporarily disable AFK movement so it doesn't fight the pathfinder
  const wasAfk = isAfkEnabled;
  isAfkEnabled = false;

  const nX = parseFloat(process.env.NPC_X) || 36;
  const nY = parseFloat(process.env.NPC_Y) || 106;
  const nZ = parseFloat(process.env.NPC_Z) || 15;

  console.log(`Checking distance to NPC at ${nX}, ${nY}, ${nZ}...`);
  if (bot.entity && bot.entity.position.distanceTo(new Vec3(nX, nY, nZ)) > 500) {
    console.log('[Nav] Bot is too far from lobby coordinates (>500 blocks). You might already be in Survival or a different world. Cancelling auto-join.');
    isAfkEnabled = true;
    randomMovement();
    return;
  }

  // Stealth Movements: No sprinting/parkour in lobby to avoid Vulcan
  const lobbyMovements = new Movements(bot);
  lobbyMovements.allowSprinting = false;
  console.log(`Setting movement goal to: ${nX}, ${nY}, ${nZ}`);
  const goal = new GoalNear(nX, nY, nZ, 2);
  
  try {
    bot.pathfinder.setGoal(goal);
  } catch (err) {
    console.log('[Movement Error] Pathfinder failed to set goal:', err.message);
  }

  // Diagnostic Path Logging
  const onPathUpdate = (r) => {
    if (r.status === 'noPath') {
      console.log('Pathfinder: No path found! Is there a wall? Trying a small jump/move...');
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  };
  bot.on('path_update', onPathUpdate);

  // Periodic Distance Logging
  const distanceInterval = setInterval(() => {
    if (bot.entity && bot.entity.position) {
      const pos = bot.entity.position;
      if (!isNaN(pos.x) && !isNaN(pos.y) && !isNaN(pos.z)) {
        const dist = pos.distanceTo(new Vec3(nX, nY, nZ));
        console.log(`[Nav] Distance to NPC: ${dist.toFixed(1)} blocks (Current: ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`);
        if (dist < 3) clearInterval(distanceInterval);
      }
    }
  }, 5000);

  let retryTimeout;

  bot.once('goal_reached', () => {
    console.log('Arrived at NPC location. Stopping and waiting (Human Pause)...');
    bot.pathfinder.setGoal(null); // Stop pathfinder explicitly

    // Configurable Look Direction
    const lX = parseFloat(process.env.LOOK_X) || 36;
    const lY = parseFloat(process.env.LOOK_Y) || 107;
    const lZ = parseFloat(process.env.LOOK_Z) || 24;

    // Wait 2 seconds before interacting (Stealth)
    setTimeout(() => {
      console.log('Jumping and Interacting...');
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 200);

      bot.lookAt(new Vec3(lX, lY, lZ)).then(() => {
        // Diagnostic: List all entities nearby
        const entities = Object.values(bot.entities);
        const nearby = entities.filter(e => e.position.distanceTo(new Vec3(nX, nY, nZ)) < 10);
        console.log(`[Interaction] Found ${nearby.length} entities within 10 blocks:`);

        const entity = entities.find(e =>
          e.id !== bot.entity.id &&
          e.position.distanceTo(new Vec3(nX, nY, nZ)) < 5
        );

        if (entity) {
          const npcName = entity.username || entity.displayName || 'Unknown';
          console.log(`Targeting NPC: ${npcName}. Aiming...`);
          
          bot.lookAt(entity.position.offset(0, 1.6, 0));
          
          // Wait 2 seconds while looking at NPC before interacting (more human-like)
          setTimeout(() => {
            console.log(`[Action] Right-clicking NPC: ${npcName}`);
            bot.activateEntity(entity);
            
            // Wait 1 second and then try Left-Click as a fallback
            setTimeout(() => {
                if (bot.entity && bot.entity.position.distanceTo(new Vec3(nX, nY, nZ)) < 5) {
                    console.log(`[Backup] Right-click might have failed. Trying Left-click on ${npcName}...`);
                    bot.attack(entity);
                }
            }, 1000);
          }, 2000);
        } else {
          console.log('No specific entity found within 5 blocks. Checking block interaction...');
          const block = bot.blockAt(new Vec3(nX, nY, nZ));
          if (block) bot.activateBlock(block);
        }
      });
    }, 2000);

    retryTimeout = setTimeout(() => {
      // If 15s later we are still near the lobby spawn, retry
      if (bot.entity && bot.entity.position.distanceTo(new Vec3(nX, nY, nZ)) < 10) {
        console.log('Still in lobby area. Retrying Join Survival...');
        bot.removeListener('path_update', onPathUpdate);
        clearInterval(distanceInterval);
        isAfkEnabled = wasAfk; // Restore state before retry to be safe
        joinSurvival();
      } else {
        console.log('--- SUCCESS ---');
        console.log('AFK bot online in Survival!');
        bot.removeListener('path_update', onPathUpdate);
        clearInterval(distanceInterval);
        isAfkEnabled = true; // Bot reached survival, enable AFK
        randomMovement();
      }
    }, 15000);
  });
}

function randomMovement() {
  if (!isAfkEnabled || !bot || !bot.entity) return;

  const mcData = require('minecraft-data')(bot.version || '1.21.1');
  const movements = new Movements(bot, mcData);
  bot.pathfinder.setMovements(movements);

  const directions = ['forward', 'back', 'left', 'right'];
  const dir = directions[Math.floor(Math.random() * directions.length)];

  bot.setControlState(dir, true);
  setTimeout(() => {
    bot.setControlState(dir, false);
    if (bot && isAfkEnabled) setTimeout(randomMovement, 2000);
  }, 3000);
}

const SCRAB_WORDS = [
  'diamond', 'iron', 'gold', 'coal', 'obsidian', 'redstone', 'dirt', 'stone', 'wood', 'crafting',
  'furnace', 'anvil', 'beacon', 'torch', 'bucket', 'creeper', 'skeleton', 'enderman', 'zombie',
  'villager', 'guardian', 'spider', 'wolf', 'pig', 'cow', 'sheep', 'chicken', 'enderdragon',
  'survival', 'creative', 'adventure', 'hardcore', 'enchanting', 'brewing', 'smelting', 'mining',
  'building', 'sprinting', 'sneaking', 'nether', 'biome', 'desert', 'cavern', 'ravine', 'stronghold',
  'dungeon', 'fortress', 'village', 'ocean', 'server', 'lobby', 'spawn', 'chat', 'forum', 'reward',
  'player', 'admin', 'moderator', 'khushi', 'conquer', 'gaming', 'pickaxe', 'sword', 'shovel', 'armor',
  'helmet', 'chestplate', 'leggings', 'boots', 'apple', 'bread', 'steak', 'potato', 'carrot', 'president',
  'member', 'legendary', 'helper', 'builder', 'donator', 'vip', 'mvp', 'owner', 'staff', 'server',
  'bedrock', 'emerald', 'lapis', 'quartz', 'glowstone', 'tnt', 'flint', 'steel', 'elytra', 'firework',
  'shulker', 'trident', 'shield', 'totem', 'undying', 'crossbow', 'bamboo', 'scaffolding', 'honey',
  'piston', 'repeater', 'comparator', 'lever', 'button', 'pressure', 'plate', 'daylight', 'sensor'
];

function getAnagramMatch(scrambled) {
  const sorted = scrambled.toLowerCase().split('').sort().join('');
  return SCRAB_WORDS.find(word => word.toLowerCase().split('').sort().join('') === sorted);
}

function solveMath(equation) {
  try {
    // Handle 'x' as multiplication and remove any symbols like '?' or '='
    const clean = equation.toLowerCase().replace(/x/g, '*').replace(/[^0-9+\-*/().]/g, '');
    return eval(clean);
  } catch (e) {
    return null;
  }
}

function solveChatGames(msg) {
  if (!bot) return;
  const cleanMsg = msg.replace(/\n\s*\n/g, '\n').trim();
  const lower = cleanMsg.toLowerCase();

  // Updated regex: Handles No spaces, 'x' operator, and trailing symbols
  const mathMatch = cleanMsg.match(/(\d+)\s*([\+\-\*\/xX])\s*(\d+)/);
  if (mathMatch) {
    const result = solveMath(mathMatch[0]);
    if (result !== null) {
      console.log(`[ChatGame] Found math: ${mathMatch[0]} = ${result}`);
      setTimeout(() => bot.chat(result.toString()), 2000);
      return;
    }
  }

  if (lower.includes('word scramble') || lower.includes('unscramble')) {
    const lines = cleanMsg.split('\n');
    for (const line of lines) {
      const potentialWord = line.trim().replace(/[\[\]]/g, '');
      if (potentialWord.length >= 3 && /^[A-Z]+$/.test(potentialWord)) {
        const match = getAnagramMatch(potentialWord);
        if (match) {
          console.log(`[ChatGame] Found scramble: ${potentialWord} -> ${match}`);
          setTimeout(() => bot.chat(match), 2000);
          return;
        }
      }
    }
  }
}

function sendInventory() {
  if (!bot) return;
  // Send all slots from 0 to 45 (Classic Inventory + Armor + Crafting)
  const slots = bot.inventory.slots.map((item, index) => {
    if (!item) return { slot: index, isEmpty: true };
    return {
      name: item.name,
      displayName: item.displayName,
      count: item.count,
      slot: index,
      type: item.type
    };
  });
  io.sockets.sockets.forEach(s => {
    if (s.authenticated) s.emit('inventory', slots);
  });
}

function startAutoMessenger() {
  if (autoMsgTimer) clearInterval(autoMsgTimer);
  autoMsgTimer = setInterval(() => {
    if (bot && bot.entity) {
      const now = Date.now();
      const elapsed = now - lastAutoMsgTime;
      
      // If 4 minutes (240,000ms) have passed
      if (elapsed >= 240000) {
        const nX = parseFloat(process.env.NPC_X) || 36;
        const nY = parseFloat(process.env.NPC_Y) || 106;
        const nZ = parseFloat(process.env.NPC_Z) || 15;
        const distToLobby = bot.entity.position.distanceTo(new Vec3(nX, nY, nZ));
        
        // Only send if in survival (far from lobby NPC)
        if (distToLobby > 100) {
          bot.chat("This AFK bot is made up by Sujal_live");
          lastAutoMsgTime = now; // Reset timer ONLY after successful send
          console.log("[Auto-Msg] Loop: Message sent to survival chat.");
        }
      }
    }
  }, 1000); // Check every second for the perfect loop
}

function getText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;

  // Handle NBT-style { type: 'string', value: '...' }
  if (obj.type === 'string' && typeof obj.value === 'string') return String(obj.value);

  let text = '';
  if (typeof obj.text === 'string') text += obj.text;

  // Handle NBT-style { type: 'list', value: [...], ... }
  if (Array.isArray(obj.value)) {
    text += obj.value.map(e => getText(e)).join('');
  }

  // Handle standard 'extra' array
  if (obj.extra) {
    if (Array.isArray(obj.extra)) {
      text += obj.extra.map(e => getText(e)).join('');
    } else {
      text += getText(obj.extra);
    }
  }

  // Handle nested objects in 'value'
  if (obj.value && typeof obj.value === 'object' && !Array.isArray(obj.value)) {
    text += getText(obj.value);
  }

  // Handle raw arrays
  if (Array.isArray(obj)) {
    text += obj.map(e => getText(e)).join('');
  }

  return String(text);
}

createBot();
