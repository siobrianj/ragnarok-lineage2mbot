// --- Dependencies and Configuration ---
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { parse, addHours, isBefore, format, intervalToDuration } = require('date-fns');

// --- Timestamp Console Override ---
function formatLogTimestamp() {
    return `[${new Date().toLocaleTimeString()}]`;
}

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
    originalLog(formatLogTimestamp(), ...args);
};

console.error = (...args) => {
    originalError(formatLogTimestamp(), ...args);
};

console.warn = (...args) => {
    originalWarn(formatLogTimestamp(), ...args);
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;

// --- Global Variables and Data Files ---
let tracked = [];
let bossData = [];
let ucrCount = {};
const trackedFilePath = path.join(__dirname, 'trackedBosses.json');
const bossDataFilePath = path.join(__dirname, 'bossData.json');
const ucrCountFilePath = path.join(__dirname, 'ucrCount.json');

// --- Live Message Feature ---
let liveBossListMessageIds = [];
const liveMessageFilePath = path.join(__dirname, 'liveMessage.json');

// --- Timers and Utility Functions ---
const scheduledTimers = new Map();
let hourlyBossTimerId = null;

function saveTracked(data) {
    try {
        fs.writeFileSync(trackedFilePath, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error writing to tracked.json:', err);
    }
}

function saveUcrCount() {
    try {
        fs.writeFileSync(ucrCountFilePath, JSON.stringify(ucrCount, null, 2));
    } catch (err) {
        console.error('Error writing to ucrCount.json:', err);
    }
}

function loadUcrCount() {
    try {
        if (fs.existsSync(ucrCountFilePath)) {
            const data = fs.readFileSync(ucrCountFilePath, 'utf8');
            ucrCount = JSON.parse(data);
        } else {
            ucrCount = { count: 0 };
            saveUcrCount();
        }
    } catch (err) {
        console.error('Error loading ucrCount.json:', err);
    }
}

function clearTimers(bossName) {
    const bossKey = bossName.toLowerCase().replace(/\s/g, '');
    const timer10 = scheduledTimers.get(`${bossKey}_10min`);
    const timerSpawn = scheduledTimers.get(`${bossKey}_spawn`);
    if (timer10) clearTimeout(timer10);
    if (timerSpawn) clearTimeout(timerSpawn);
    scheduledTimers.delete(`${bossKey}_10min`);
    scheduledTimers.delete(`${bossKey}_spawn`);
}

function scheduleBossTimers(boss, spawnAt, isStartup = false) {
    clearTimers(boss.name);

    if (boss.maintenanceMode === 1) {
        if (!isStartup) {
            console.log(`[Skipping Scheduling] Boss ${boss.name} is in maintenance mode.`);
        }
        return;
    }

    const now = new Date();
    if (isBefore(spawnAt, now)) {
        if (!isStartup) {
            console.log(`[Skipping Timer] Boss ${boss.name} spawn time is in the past.`);
        }
        return;
    }

    const announceChannel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (!announceChannel) {
        console.error(`Announcement channel not found.`);
        return;
    }

    const tenMinBefore = new Date(spawnAt.getTime() - 10 * 60000);
    if (isBefore(now, tenMinBefore)) {
        const timer10 = setTimeout(async () => {
            const unixTimestamp = Math.floor(spawnAt.getTime() / 1000);
            const epicText = boss.dropEpic ? ' [E]' : '';
            const spawnChanceText = typeof boss.chanceSpawn === 'number' ? `\n🎯 Spawn Chance: **${boss.chanceSpawn}%**` : '';
            announceChannel.send(
                `@everyone ⚠️ **${boss.name}${epicText}** will spawn **<t:${unixTimestamp}:R>** at ${boss.zone} - ${boss.area}!\n⏰ Spawn Time: **<t:${unixTimestamp}:t>**${spawnChanceText}`
            ).then(sentMessage => {
                setTimeout(() => { if (sentMessage.deletable) sentMessage.delete().catch(() => {}); }, 10000);
            }).catch(err => console.error(`Error sending 10-min announcement for ${boss.name}:`, err));

            await updateLiveBossList();
        }, tenMinBefore - now);
        scheduledTimers.set(`${boss.name}_10min`, timer10);
    }

    const timerSpawn = setTimeout(async () => {
        const epicText = boss.dropEpic ? ' [E]' : '';
        const spawnChanceText = typeof boss.chanceSpawn === 'number' ? `\n🎯 Spawn Chance: **${boss.chanceSpawn}%**` : '';
        const unixTimestampSpawn = Math.floor(spawnAt.getTime() / 1000);
        announceChannel.send(
            `@everyone 🚨 **${boss.name}${epicText}** has spawned at ${boss.zone} - ${boss.area}! [**<t:${unixTimestampSpawn}:t>**] ${spawnChanceText}`
        ).then(sentMessage => {
            setTimeout(() => { if (sentMessage.deletable) sentMessage.delete().catch(() => {}); }, 10000);
        }).catch(err => console.error(`Error sending spawn announcement for ${boss.name}:`, err));
        
        await updateLiveBossList();
        
        clearTimers(boss.name);
    }, spawnAt - now);
    scheduledTimers.set(`${boss.name}_spawn`, timerSpawn);
}

function scheduleHourlyBossAnnouncements() {
    if (hourlyBossTimerId) clearTimeout(hourlyBossTimerId);
    const now = new Date();
    const nextHourTop = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
    const delay = nextHourTop.getTime() - now.getTime();

    if (delay < 0) {
        nextHourTop.setHours(nextHourTop.getHours() + 1);
        const newDelay = nextHourTop.getTime() - now.getTime();
        hourlyBossTimerId = setTimeout(sendHourlyBossAnnouncement, newDelay);
    } else {
        hourlyBossTimerId = setTimeout(sendHourlyBossAnnouncement, delay);
    }
}

async function sendHourlyBossAnnouncement() {
    // This function's implementation is not included here for brevity
}

// --- Live Message Functions ---
function saveLiveMessageIds() {
    try {
        fs.writeFileSync(liveMessageFilePath, JSON.stringify({ messageIds: liveBossListMessageIds }, null, 2));
    } catch (err) {
        console.error('Error saving live message IDs:', err);
    }
}

function loadLiveMessageIds() {
    try {
        if (fs.existsSync(liveMessageFilePath)) {
            const data = fs.readFileSync(liveMessageFilePath, 'utf8');
            const messageData = JSON.parse(data);
            liveBossListMessageIds = messageData.messageIds || [];
            console.log(`Live message IDs loaded: ${liveBossListMessageIds.join(', ')}`);
        }
    } catch (err) {
        console.error('Error loading live message IDs:', err);
    }
}

async function updateLiveBossList() {
    const announceChannel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (!announceChannel) {
        console.error('Announcement channel not found. Cannot update live boss list.');
        return;
    }
    
    const now = new Date();
    const tenMinsAgo = new Date(now.getTime() - (10 * 60 * 1000));
    const tenMinsFromNow = new Date(now.getTime() + (10 * 60 * 1000));
    const thirtyMinsFromNow = new Date(now.getTime() + (30 * 60 * 1000));
    const sixtyMinsFromNow = new Date(now.getTime() + (60 * 60 * 1000));
    const twoHoursFromNow = new Date(now.getTime() + (120 * 60 * 1000));

    const activeBosses = tracked.filter(entry => entry.maintenanceMode !== 1);
    
    const recentlySpawned = activeBosses
        .filter(entry => entry.spawnAt && isBefore(new Date(entry.spawnAt), now) && isBefore(tenMinsAgo, new Date(entry.spawnAt)))
        .sort((a, b) => new Date(b.spawnAt) - new Date(a.spawnAt));

    const within10Mins = activeBosses
        .filter(entry => entry.spawnAt && isBefore(new Date(entry.spawnAt), tenMinsFromNow) && isBefore(now, new Date(entry.spawnAt)))
        .sort((a, b) => new Date(a.spawnAt) - new Date(b.spawnAt));
        
    const within30Mins = activeBosses
        .filter(entry => entry.spawnAt && isBefore(new Date(entry.spawnAt), thirtyMinsFromNow) && isBefore(tenMinsFromNow, new Date(entry.spawnAt)))
        .sort((a, b) => new Date(a.spawnAt) - new Date(b.spawnAt));
        
    const within1Hour = activeBosses
        .filter(entry => entry.spawnAt && isBefore(new Date(entry.spawnAt), sixtyMinsFromNow) && isBefore(thirtyMinsFromNow, new Date(entry.spawnAt)))
        .sort((a, b) => new Date(a.spawnAt) - new Date(b.spawnAt));

    const within2Hours = activeBosses
        .filter(entry => entry.spawnAt && isBefore(new Date(entry.spawnAt), twoHoursFromNow) && isBefore(sixtyMinsFromNow, new Date(entry.spawnAt)))
        .sort((a, b) => new Date(a.spawnAt) - new Date(b.spawnAt));

    const later = activeBosses
        .filter(entry => entry.spawnAt && isBefore(twoHoursFromNow, new Date(entry.spawnAt)))
        .sort((a, b) => new Date(a.spawnAt) - new Date(b.spawnAt));
    
    const untracked = tracked.filter(entry => entry.maintenanceMode === 1);

    const formatBossEntry = (entry, icon) => {
        const boss = bossData.find(b => b.name === entry.bossName);
        if (!boss) return null;
        const spawnAt = new Date(entry.spawnAt);
        const unixTimestamp = Math.floor(spawnAt.getTime() / 1000); 
        const dropEpicText = boss.dropEpic ? ` [**E**]` : '';
        
        let locationAndChanceText = '';
        if (icon === '🚨' || icon === '🟢') {
            const locationText = ` at **${boss.zone} - ${boss.area}**`;
            const spawnChanceText = typeof boss.chanceSpawn === 'number' ? ` | 🎯 Spawn Chance: **${boss.chanceSpawn}%**` : '';
            locationAndChanceText = `${locationText}${spawnChanceText}`;
        }

        let timeText = '';
        if (icon === '🚨') {
            timeText = ` (**<t:${unixTimestamp}:R>**) ago`;
        } else {
            timeText = ` (**<t:${unixTimestamp}:R>**) [**<t:${unixTimestamp}:t>**]`;
        }
        
        return `${icon} **${boss.name}**${dropEpicText}${timeText}${locationAndChanceText}`;
    };
    
    let listContentArray = [];
    const nowUnixTimestamp = Math.floor(now.getTime() / 1000);
    // Combined and corrected the header lines for clarity and to include bot status
    listContentArray.push(`**BOSS TIMERS**- **[${activeBosses.length} Tracked | ${untracked.length} Untracked]**`);
    listContentArray.push(`**UCR in Inventory**: **${ucrCount.count || 0}/50**`);
    listContentArray.push(`**Last Update: <t:${nowUnixTimestamp}:t> - if last update >10mins = bot down. Tell Agony**`);


    if (recentlySpawned.length > 0) {
        listContentArray.push('---');
        listContentArray.push('***Recently Spawned***');
        recentlySpawned.forEach(entry => listContentArray.push(formatBossEntry(entry, '🚨')));
    }
    
    if (within10Mins.length > 0) {
        listContentArray.push('---');
        listContentArray.push('***Spawning within 10 minutes***');
        within10Mins.forEach(entry => listContentArray.push(formatBossEntry(entry, '🟢')));
    }

    if (within30Mins.length > 0) {
        listContentArray.push('---');
        listContentArray.push('***Spawning within 30 minutes***');
        within30Mins.forEach(entry => listContentArray.push(formatBossEntry(entry, '⏳')));
    }

    if (within1Hour.length > 0) {
        listContentArray.push('---');
        listContentArray.push('***Spawning within 1 hour***');
        within1Hour.forEach(entry => listContentArray.push(formatBossEntry(entry, '⏰')));
    }

    if (within2Hours.length > 0) {
        listContentArray.push('---');
        listContentArray.push('***Spawning within 2 hours***');
        within2Hours.forEach(entry => listContentArray.push(formatBossEntry(entry, '🕑')));
    }
    
    if (later.length > 0) {
        listContentArray.push('---');
        listContentArray.push('***Spawning later***');
        later.forEach(entry => listContentArray.push(formatBossEntry(entry, '🗓️')));
    }

    if (untracked.length > 0) {
        listContentArray.push('---');
        listContentArray.push(`**UNTRACKED** (${untracked.length})`);
        untracked.forEach(entry => {
            const boss = bossData.find(b => b.name === entry.bossName);
            if (boss) {
                listContentArray.push(`🚫 **${boss.name}** (${boss.zone} - ${boss.area})`);
            }
        });
    }

    listContentArray.push(`\n**Last Update: <t:${nowUnixTimestamp}:t> - if last update >10mins = bot down. Tell Agony**`);

    // Corrected the "no bosses" message logic to avoid duplication
    if (listContentArray.length === 1) {
        listContentArray.push('---');
        listContentArray.push('No bosses are currently being actively tracked for future spawns.');
    }
    
    const messageChunks = [''];
    listContentArray.filter(Boolean).forEach(line => {
        if (messageChunks[messageChunks.length - 1].length + line.length + 1 > 2000) {
            messageChunks.push(line);
        } else {
            messageChunks[messageChunks.length - 1] += (messageChunks[messageChunks.length - 1] ? '\n' : '') + line;
        }
    });

    const newLiveMessageIds = [];
    for (let i = 0; i < messageChunks.length; i++) {
        const chunk = messageChunks[i];
        try {
            if (liveBossListMessageIds[i]) {
                const liveMessage = await announceChannel.messages.fetch(liveBossListMessageIds[i]);
                if (liveMessage.author.id === client.user.id) {
                    await liveMessage.edit(chunk);
                    newLiveMessageIds.push(liveBossListMessageIds[i]);
                } else {
                    const newMessage = await announceChannel.send(chunk);
                    newLiveMessageIds.push(newMessage.id);
                }
            } else {
                const newMessage = await announceChannel.send(chunk);
                newLiveMessageIds.push(newMessage.id);
            }
        } catch (error) {
            if (error.code === 10008) {
                console.warn(`Live boss list message chunk ${i + 1} with ID ${liveBossListMessageIds[i]} was not found. Creating a new message.`);
                 try {
                     const newMessage = await announceChannel.send(chunk);
                     newLiveMessageIds.push(newMessage.id);
                 } catch (sendError) {
                     console.error(`Failed to send new live message chunk after previous failure:`, sendError);
                 }
            } else {
                console.error(`Failed to update live boss list message chunk ${i + 1}:`, error);
                 try {
                     const newMessage = await announceChannel.send(chunk);
                     newLiveMessageIds.push(newMessage.id);
                 } catch (sendError) {
                     console.error(`Failed to send new live message chunk after previous failure:`, sendError);
                 }
            }
        }
    }

    if (liveBossListMessageIds.length > newLiveMessageIds.length) {
        for (let i = newLiveMessageIds.length; i < liveBossListMessageIds.length; i++) {
            try {
                const messageToDelete = await announceChannel.messages.fetch(liveBossListMessageIds[i]);
                await messageToDelete.delete();
            } catch (error) {
                console.warn(`Could not delete old live boss list message with ID ${liveBossListMessageIds[i]}:`, error.message);
            }
        }
    }

    liveBossListMessageIds = newLiveMessageIds;
    saveLiveMessageIds();
}

/**
 * Periodically checks for tracked bosses that have passed their spawn time
 * and automatically re-logs them for the next cycle if they haven't been updated.
 */
async function checkAndReLogUntrackedBosses() {
    console.log('[Auto Re-log] Running check for past-due bosses...');
    const now = new Date();
    let updated = false;

    for (let i = 0; i < tracked.length; i++) {
        const entry = tracked[i];

        if (entry.maintenanceMode === 1) {
            continue;
        }

        const spawnAt = new Date(entry.spawnAt);
        const tenMinutesAfterSpawn = new Date(spawnAt.getTime() + 10 * 60 * 1000);

        if (isBefore(tenMinutesAfterSpawn, now)) {
            const boss = bossData.find(b => b.name === entry.bossName);

            if (!boss || boss.respawn === undefined) {
                console.error(`[Auto Re-log] Could not find boss data for ${entry.bossName}. Skipping.`);
                continue;
            }
            
            console.log(`[Auto Re-log] Processing past-due boss: ${boss.name}. Old spawn time: ${spawnAt.toISOString()}`);

            const newKilledAt = spawnAt;
            const newSpawnAt = addHours(newKilledAt, boss.respawn);

            tracked[i].killedAt = newKilledAt.toISOString();
            tracked[i].spawnAt = newSpawnAt.toISOString();
            tracked[i].maintenanceMode = 0;
            
            updated = true;
            
            console.log(`[Auto Re-log] Re-logged ${boss.name}. New spawn time: ${newSpawnAt.toISOString()}`);

            scheduleBossTimers(boss, new Date(tracked[i].spawnAt));

            const announceChannel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
            if (announceChannel) {
                const unixTimestamp = Math.floor(newSpawnAt.getTime() / 1000);
                
                const messageContent =
                    `@everyone 🔄 **AUTO RE-LOG:** **${boss.name}** was not logged. New spawn: **<t:${unixTimestamp}:t>** at ${boss.zone} - ${boss.area}. Please use \`!bk ${boss.name} <HH:MM>\` to fix the time.`;
                
                try {
                    const sentMessage = await announceChannel.send(messageContent);
                    setTimeout(() => {
                        if (sentMessage.deletable) {
                            sentMessage.delete().catch(() => {});
                        }
                    }, 10000);
                } catch (err) {
                    console.error(`[Auto Re-log] Failed to send message for ${boss.name}:`, err);
                }
            } else {
                console.error(`[Auto Re-log] Announcement channel not found!`);
            }
        }
    }

    if (updated) {
        saveTracked(tracked);
        console.log('[Auto Re-log] Saved updates to trackedBosses.json.');
    }
    
    // Call the update function unconditionally to refresh the list every 5 minutes.
    updateLiveBossList();
}

/**
 * Converts a duration object to a human-readable string.
 * @param {object} duration - The duration object from intervalToDuration.
 * @returns {string} The formatted duration string (e.g., "1h 30m").
 */
function formatDuration(duration) {
    const parts = [];
    if (duration.years) parts.push(`${duration.years}y`);
    if (duration.months) parts.push(`${duration.months}mo`);
    if (duration.days) parts.push(`${duration.days}d`);
    if (duration.hours) parts.push(`${duration.hours}h`);
    if (duration.minutes) parts.push(`${duration.minutes}m`);
    if (duration.seconds) parts.push(`${duration.seconds}s`);
    
    if (parts.length === 0) {
        return "less than a minute";
    }
    return parts.join(' ');
}


// --- Client Ready Event ---
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    try {
        tracked = JSON.parse(fs.readFileSync(trackedFilePath, 'utf8'));
        bossData = JSON.parse(fs.readFileSync(bossDataFilePath, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn(`Data file not found. Initializing empty files.`);
            tracked = [];
            bossData = [];
            fs.writeFileSync(trackedFilePath, '[]', 'utf8');
            fs.writeFileSync(bossDataFilePath, '[]', 'utf8');
        } else {
            console.error('Failed to load tracked or boss data:', err);
            return;
        }
    }
    
    loadUcrCount();
    
    loadLiveMessageIds();
    
    await updateLiveBossList();

    scheduleHourlyBossAnnouncements();
    
    setInterval(checkAndReLogUntrackedBosses, 5 * 60 * 1000);

    tracked.forEach(entry => {
        const boss = bossData.find(b => b.name === entry.bossName);
        if (boss && entry.spawnAt) {
            scheduleBossTimers(boss, new Date(entry.spawnAt), true);
        }
    });
});


// --- Command Handler ---
client.on('messageCreate', async message => {
    // Check if the message is in the announcement channel and is not from the bot itself.
    if (ANNOUNCE_CHANNEL_ID && message.channel.id === ANNOUNCE_CHANNEL_ID && !message.author.bot) {
        try {
            await message.delete();
        } catch (error) {
            console.error(`Failed to delete message in channel ${message.channel.name}:`, error);
        }
    }
    
    if (message.author.bot || !message.content.startsWith('!')) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {
        case 'ucr':
        case 'ucrr':
        case 'updatecr': {
            const subCommand = args[0] ? args[0].toLowerCase() : '';
            let amount = parseInt(args[0]);

            if (subCommand === 'reset') {
                if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await message.channel.send('❌ You do not have permission to reset the UCR count.').then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                    if (message.deletable) message.delete().catch(() => {});
                    break;
                }
                ucrCount.count = 0;
                saveUcrCount();
                await message.channel.send('✅ UCR count has been reset to **0**.').then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                await updateLiveBossList();
                if (message.deletable) message.delete().catch(() => {});
                break;
            }

            if (subCommand === 'add' && args[1]) {
                amount = parseInt(args[1]);
            }

            if (!isNaN(amount) && amount > 0) {
                ucrCount.count += amount;
                let replyMessage = `✨ **${amount} UCR** added to your inventory.`;

                if (ucrCount.count >= 50) {
                    ucrCount.count = 0;
                    replyMessage += `\n🎉 **UCR can be crafted to ECR! Congratulations!** Your UCR count has been reset to **0**`;
                }
                replyMessage += `\n📦 Current UCR count: **${ucrCount.count}**`;

                await message.channel.send(replyMessage).then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                saveUcrCount();
                await updateLiveBossList();
                if (message.deletable) message.delete().catch(() => {});
            } else if (subCommand === 'current' || (!subCommand && isNaN(amount))) {
                await message.channel.send(`📦 Current UCR count: **${ucrCount.count}**`).then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                if (message.deletable) message.delete().catch(() => {});
            } else {
                await message.channel.send('❌ Usage: `!ucr add <number>`, `!ucr <number>`, `!ucr current`, or `!ucr reset` (admin only).').then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                if (message.deletable) message.delete().catch(() => {});
            }
            break;
        }
        
        case 'bk':
        case 'bosskilled': {
            const input = args.join(' ');
            const timeMatch = input.match(/(.+)\s+(\d{1,2}:\d{2})$/);
            if (!timeMatch) {
                await message.channel.send('❌ Invalid format! Are you sure you logged it using 24h format? `!bk <name> <HH:MM>`. Check again.').then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                if (message.deletable) message.delete().catch(() => {});
                break;
            }
            const bossName = timeMatch[1].trim();
            const timeStr = timeMatch[2];
            const boss = bossData.find(b => b.name.toLowerCase() === bossName.toLowerCase());
            if (!boss || boss.respawn === undefined) {
                await message.channel.send(`❌ Boss not found or has no respawn time defined.`).then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                if (message.deletable) message.delete().catch(() => {});
                break;
            }
            
            const now = new Date();
            let killedAt = parse(timeStr, 'HH:mm', now);

            const spawnAt = addHours(killedAt, boss.respawn);

            let timeToKillMessage = '';
            const existingEntry = tracked.find(t => t.bossName.toLowerCase() === boss.name.toLowerCase());
            if (existingEntry && existingEntry.spawnAt) {
                const previousSpawn = new Date(existingEntry.spawnAt);
                const duration = intervalToDuration({ start: previousSpawn, end: killedAt });
                const formattedDuration = formatDuration(duration);
                if (formattedDuration) {
                    timeToKillMessage = `\n⏱️ **Time to Kill**: ${formattedDuration}`;
                }
            }

            const entry = {
                bossName: boss.name,
                killedAt: killedAt.toISOString(),
                spawnAt: spawnAt.toISOString(),
                maintenanceMode: 0,
            };
            const existingIndex = tracked.findIndex(t => t.bossName.toLowerCase() === boss.name.toLowerCase());
            if (existingIndex !== -1) {
                tracked[existingIndex] = entry;
            } else {
                tracked.push(entry);
            }
            saveTracked(tracked);
            
            scheduleBossTimers(boss, new Date(entry.spawnAt));
            await updateLiveBossList();
            
            const unixTimestamp = Math.floor(spawnAt.getTime() / 1000);
            
            let replyMessage = `✅ **${boss.name}** logged at **${timeStr}**. New spawn: **<t:${unixTimestamp}:t>**!`;

            if (timeToKillMessage) {
                replyMessage += timeToKillMessage;
            }

            // This is the new line with the reminder
            replyMessage += `\n❗**Double Check**: Make sure its \`24h format\` **GMT+8**`;

            await message.channel.send(replyMessage).then(sentMsg => setTimeout(() => {
                if (sentMsg.deletable) {
                    sentMsg.delete().catch(() => {});
                }
            }, 10000));

            if (message.deletable) message.delete().catch(() => {});
            break;
        }

        // --- START OF NEW !bossoffset COMMAND ---
        case 'bossoffset':
        case 'bo': {
            const input = args.join(' ');
            const offsetMatch = input.match(/^(.+)\s+(-?\d+)$/);
            if (!offsetMatch) {
                await message.channel.send('❌ Format: `!bossoffset <bossname> <minutes>`. Example: `!bo Felis -10`').then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                if (message.deletable) message.delete().catch(() => {});
                break;
            }

            const bossName = offsetMatch[1].trim();
            const offsetMinutes = parseInt(offsetMatch[2]);
            
            if (isNaN(offsetMinutes) || offsetMinutes < -600 || offsetMinutes > 600 || offsetMinutes === 0) {
                await message.channel.send('❌ Offset must be between -600 and 600 minutes (cannot be 0).').then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                if (message.deletable) message.delete().catch(() => {});
                break;
            }
            
            const entryIndex = tracked.findIndex(t => t.bossName.toLowerCase() === bossName.toLowerCase());
            if (entryIndex === -1) {
                await message.channel.send(`❌ No tracked entry found for **${bossName}** or boss is in maintenance mode.`).then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                if (message.deletable) message.delete().catch(() => {});
                break;
            }

            const entry = tracked[entryIndex];
            const spawnAt = new Date(entry.spawnAt);
            const newSpawnAt = new Date(spawnAt.getTime() + offsetMinutes * 60000);

            tracked[entryIndex].spawnAt = newSpawnAt.toISOString();
            tracked[entryIndex].maintenanceMode = 0;
            saveTracked(tracked);

            const boss = bossData.find(b => b.name.toLowerCase() === bossName.toLowerCase());
            if (boss) {
                scheduleBossTimers(boss, newSpawnAt);
            }
            await updateLiveBossList();
            
            const action = offsetMinutes > 0 ? 'added' : 'subtracted';
            const displayMinutes = Math.abs(offsetMinutes);
            const unixTimestamp = Math.floor(newSpawnAt.getTime() / 1000);

            await message.channel.send(
                `⏱️ **${bossName}**'s spawn time has been adjusted. **${displayMinutes} minutes** have been **${action}**.\nNew Spawn Time: **<t:${unixTimestamp}:t>** (<t:${unixTimestamp}:R>)`
            ).then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
            
            if (message.deletable) message.delete().catch(() => {});
            break;
        }
        // --- END OF NEW !bossoffset COMMAND ---

        case 'mm':
        case 'maintenancemode': {
            const input = args.join(' ');
            if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                await message.channel.send('❌ You do not have permission to use this command.').then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 10000));
                if (message.deletable) message.delete().catch(() => {});
                break;
            }
            let updatedCount = 0;
            const now = new Date();
            const twoDaysAgo = new Date(now.getTime() - (48 * 60 * 60 * 1000));
            tracked = tracked.map(entry => {
                if (entry.maintenanceMode !== 1) {
                    updatedCount++;
                    return { ...entry, maintenanceMode: 1, spawnAt: twoDaysAgo.toISOString() };
                }
                return entry;
            });
            saveTracked(tracked);
            
            await updateLiveBossList();
            
            if (updatedCount > 0) {
                await message.channel.send(`🛠️ **Maintenance Mode Activated:** Set 'maintenanceMode' to **1** and adjusted 'spawnAt' to **2 days ago** for **${updatedCount}** boss entries.`).then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 60000));
            } else {
                await message.channel.send('ℹ️ All tracked boss entries are already in maintenance mode.').then(sentMsg => setTimeout(() => sentMsg.deletable && sentMsg.delete().catch(() => {}), 60000));
            }
            
            if (message.deletable) message.delete().catch(() => {});
            break;
        }
    }
});

client.login(BOT_TOKEN);