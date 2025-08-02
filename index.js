// 📦 Dependencies: Run `npm install discord.js date-fns dotenv`
require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const { format, addHours, isBefore, parse, subHours } = require('date-fns');

const TOKEN = process.env.DISCORD_TOKEN;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const TRACK_FILE = 'trackedBosses.json';
const BOSS_FILE = './bossData.json'; // This is for general boss info and respawn hours
const UCR_FILE = 'ucrCount.json'; // New: For UCR tracking

// Ensure untrackedReminder.js exists in the same directory, or remove this line
const untrackedReminder = require('./untrackedReminder'); // Assuming this file exists and is configured

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
});

let bossData = [];
let tracked = [];
let ucrCount = 0; // Initialize UCR count
let hourlyBossTimerId = null; // To store the ID of the hourly announcement timer


// Load boss data (general info like respawn hours)
try {
    bossData = JSON.parse(fs.readFileSync(BOSS_FILE));
} catch (err) {
    console.error('Failed to load boss data from bossData.json:', err);
    // Exit or handle gracefully if critical data is missing
    process.exit(1);
}

// Load tracked boss instances (specific killed/spawn times)
tracked = loadTracked();

// Load UCR count
try {
    ucrCount = loadUCRCount();
} catch (err) {
    console.error('Failed to load UCR count from ucrCount.json:', err);
    // If file is missing or corrupted, start from 0 and create the file
    saveUCRCount(0);
}

const scheduledTimers = new Map(); // To keep track of active boss timers

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    // Schedule timers for all currently tracked bosses on startup
    // This will now only schedule for FUTURE spawns based on the modified scheduleBossTimers
    tracked.forEach(entry => {
        const boss = bossData.find(b => b.name === entry.bossName);
        if (boss && entry.spawnAt) {
            scheduleBossTimers(boss, new Date(entry.spawnAt), true);
        }
    });

    // --- Welcome Message Block ---
    const announceChannel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);

    if (announceChannel) {
        const welcomeMessage = `👋 Hello everyone! **${client.user.username}** is online and ready to track bosses. Use \`!help\` to see available commands.`;
        
        try {
            await announceChannel.send(welcomeMessage);
            console.log(`Sent welcome message to ${announceChannel.name}.`);
        } catch (error) {
            console.error(`Failed to send welcome message to ${announceChannel.name}:`, error);
        }
    } else {
        console.error(`Announcement channel with ID ${ANNOUNCE_CHANNEL_ID} not found. Welcome message skipped.`);
    }
    // --- End Welcome Message Block ---


    // Schedule announcements for fixed-time world bosses
    scheduleFixedBossAnnouncements();

    // --- NEW: Start hourly boss announcements ---
    scheduleHourlyBossAnnouncements();
   

    // Start the untracked reminder (if untrackedReminder.js is configured)
    untrackedReminder(client); // Make sure untrackedReminder.js properly utilizes the client object

    // Start the periodic check for bosses that need to be re-logged.
    // We run it once on startup after a small delay to let things settle.
    setTimeout(checkAndReLogUntrackedBosses, 10 * 1000); // Run after 10 seconds
    // Then, run it every 5 minutes.
    setInterval(checkAndReLogUntrackedBosses, 5 * 60 * 1000); // 300,000 ms = 5 minutes

});


client.on('messageCreate', async (message) => {
    // Ignore messages that don't start with '!' or are from bots
    if (!message.content.startsWith('!') || message.author.bot) return;

    // Optional: Uncomment and configure if you want the bot to only respond in a specific channel
    if (message.channel.id !== ANNOUNCE_CHANNEL_ID) {
    return message.channel.send('❌ Nope. Ask Agony if you want me to respond here.');
    }

    const [command, ...args] = message.content.trim().split(/\s+/);
    const input = args.join(' ');
    const cmd = command.toLowerCase();

    // Example custom response
    if (cmd === '!hey') {
        return message.channel.send('gago');
    }

    // Map common aliases to their primary command names
    const commandMap = {
        '!lb': '!listboss',
        '!listboss': '!listboss',
        '!tb': '!trackedboss',
        '!trackedboss': '!trackedboss',
        '!bh': '!bosshour',
        '!bosshour': '!bosshour',
        '!b30': '!boss30',
        '!boss30': '!boss30',
        '!bi': '!bossinfo',
        '!bossinfo': '!bossinfo',
        '!bk': '!bosskilled',
        '!bosskilled': '!bosskilled',
        '!wb': '!wb',
        '!help': '!help',
        '!h': '!help',
        '!clearlogs': '!clearlogs',
        '!boss': '!boss',
        '!b': '!boss',
        '!untrackedboss': '!untrackedboss',
        '!ub': '!untrackedboss',
        '!bo': '!bossoffset',
        '!bossoffset': '!bossoffset',
        '!tbi': '!trackedbossinfo',
        '!mm': '!maintenancemode',
        '!maintenancemode': '!maintenancemode',
        '!mmb': '!mmb',
        '!ucr': '!ucr', // New: UCR command
        '!ucrc': '!ucr', // New: Alias for UCR current
        '!ucra': '!ucr', // New: Alias for UCR add
        '!ucrr': '!ucr'  // New: Alias for UCR reset
    };

    const commandNormalized = commandMap[cmd];
    if (!commandNormalized) return; // If command is not recognized, ignore

    try {
        switch (commandNormalized) {
            case '!help':
                await message.channel.send(
                    `🛠️ **Command List:**\n` +
                    `!bosskilled <name> <HH:MM> or !bk <name> <HH:MM> - logs the boss death timer and spawn time [use !lb for exact boss name] use 24hr format for logging\n` +
                    `!trackedboss or !tb - shows list of future boss spawn\n` +
                    `!tbi - shows list of future boss spawn in **Indonesian Time (GMT+7)**.\n` +
                    `!untrackedboss or !ub - shows list of past boss spawn [missed]\n` +
                    `!bossoffset <bossname> <minutes> or !bo <bossname> <minutes> - add  in minutes (max 60) on predicted spawn time\n` +
                    `!listboss or !lb - shows list of bosses [from wiki]\n` +
                    `!bosshour or !bh - shows list of boss spawning in an hour below\n` +
                    `!boss or !b - shows boss' information including dropped items\n` +
                    `!wb - World Boss schedule\n` +
                    `!ucr [add <number>| <number> | current | reset] - Tracks your UCR count. Use '<number>' or 'add <number>' to add, 'current' to view, 'reset' to clear (admin only).\n` + // New help entry
                    `!mm or !maintenancemode - Sets all tracked bosses into maintenance mode (auto re-log skipped). **(Admin only)**`
                );
                break;

            case '!bosskilled': {
                const timeMatch = input.match(/(.+)\s+(\d{1,2}:\d{2})$/);
                if (!timeMatch) {
                    await message.channel.send('❌ Format: !bosskilled <name> <HH:MM> 24H Format');
                    break;
                }

                const bossName = timeMatch[1].trim();
                const timeStr = timeMatch[2];
                const boss = bossData.find(b => b.name.toLowerCase() === bossName.toLowerCase());

                if (!boss || boss.respawn === undefined) { // Check for undefined to distinguish from 0
                    await message.channel.send(`❌ Boss not found or has no respawn time defined in bossData.json.`);
                    break;
                }

                const now = new Date();
                let killedAt = parse(timeStr, 'HH:mm', now);

                // This logic correctly interprets the HH:MM input relative to the server's current day
                // and the bot's internal timezone (which should be UTC+8 for PH).
                // No complex offset math is needed if the server time is set to PHT.
                
                const spawnAt = addHours(killedAt, boss.respawn);

                const entry = {
                    bossName: boss.name,
                    killedAt: killedAt.toISOString(),
                    spawnAt: spawnAt.toISOString(),
                    maintenanceMode: 0, // Set to 0 when manually killed
                };

                const existingIndex = tracked.findIndex(t => t.bossName.toLowerCase() === boss.name.toLowerCase());
                if (existingIndex !== -1) {
                    tracked[existingIndex] = entry; // Update existing entry
                } else {
                    tracked.push(entry); // Add new entry
                }

                saveTracked(tracked);
                scheduleBossTimers(boss, spawnAt); // Schedule new timers for this boss

                // Format times for display (using the PH time for consistent output)
                const displayKilledAt = format(killedAt, 'MM/dd/yyyy hh:mm a');
                const displaySpawnAt = format(spawnAt, 'MM/dd/yyyy hh:mm a');

                await message.channel.send(
                    `💀 **${boss.name}** killed at ${displayKilledAt}, will respawn in ${boss.respawn}h.\n` +
                    `🚩 Zone: ${boss.zone}\n📍 Location: ${boss.area}\n` +
                    `⌛ Respawn Time: **${displaySpawnAt}**\n\n` +
                    `❗ **DOUBLE CHECK: Did you input the correct time format? Use 24H format, e.g. 00:00 for 12:00 AM.**`
                );

                break;
            }

            case '!bossoffset': {
                // 1. UPDATED REGEX: Now accepts an optional '-' sign for negative numbers.
                const offsetMatch = input.match(/^(.+)\s+(-?\d+)$/);
                if (!offsetMatch) {
                    await message.channel.send('❌ Format: !bossoffset <bossname> <minutes>. Example: `!bo Felis -10`');
                    break;
                }

                const bossName = offsetMatch[1].trim();
                const offsetMinutes = parseInt(offsetMatch[2]);

                // 2. UPDATED VALIDATION: Allows a range from -600 to 600, excluding 0.
                if (isNaN(offsetMinutes) || offsetMinutes < -600 || offsetMinutes > 600 || offsetMinutes === 0) {
                    await message.channel.send('❌ Offset must be between -600 and 600 minutes (cannot be 0).');
                    break;
                }

                const entryIndex = tracked.findIndex(t => t.bossName.toLowerCase() === bossName.toLowerCase());
                if (entryIndex === -1) {
                    await message.channel.send(`❌ No tracked entry found for **${bossName}**.`);
                    break;
                }

                const entry = tracked[entryIndex];
                const spawnAt = new Date(entry.spawnAt);
                // This calculation works perfectly for both positive and negative minutes.
                const newSpawnAt = new Date(spawnAt.getTime() + offsetMinutes * 60000);

                // Update the entry and save
                tracked[entryIndex].spawnAt = newSpawnAt.toISOString();
                tracked[entryIndex].maintenanceMode = 0;
                saveTracked(tracked);

                // Reschedule timers for the new time
                const boss = bossData.find(b => b.name.toLowerCase() === bossName.toLowerCase());
                if (boss) {
                    scheduleBossTimers(boss, newSpawnAt);
                }

                // 3. DYNAMIC REPLY: The message now correctly says "added" or "subtracted".
                const action = offsetMinutes > 0 ? 'added' : 'subtracted';
                const displayMinutes = Math.abs(offsetMinutes);

                await message.channel.send(
                    `⏱️ **${bossName}**'s spawn time has been adjusted. **${displayMinutes} minutes** have been **${action}**.\nNew Spawn Time: **${format(newSpawnAt, 'MM/dd/yyyy hh:mm a')}**`
                );

                break;
            }

            case '!listboss': {
                const list = bossData
                    .map(b => `📍 ${b.name} (${b.zone} - ${b.area}) — Respawn: ${b.respawn || '-'}h`)
                    .join('\n');
                await message.channel.send(list);
                break;
            }

            case '!trackedboss': {
                // No sendAndDelete helper needed for this command as messages will not be deleted

                if (tracked.length === 0) {
                    await message.channel.send('No tracked bosses.'); // No self-deletion
                    // User's message is NOT deleted
                    break;
                }

                const now = new Date();

                // Filter only future respawns AND exclude maintenanceMode === 1
                const sortedTracked = tracked
                    .filter(entry =>
                        entry.spawnAt &&
                        new Date(entry.spawnAt) > now &&
                        entry.maintenanceMode !== 1
                    )
                    .sort((a, b) => new Date(a.spawnAt) - new Date(b.spawnAt));

                const list = sortedTracked.map(entry => {
                    const boss = bossData.find(b => b.name === entry.bossName);
                    if (!boss) return null;
                    const spawnAt = new Date(entry.spawnAt);
                    const unixTimestamp = Math.floor(spawnAt.getTime() / 1000); 
                    
                    return `🕒 **${boss.name}** (${boss.zone} - ${boss.area}) — **<t:${unixTimestamp}:t>**`;
                }).filter(Boolean).join('\n');

                await message.channel.send(list || 'No bosses are currently being actively tracked for future spawns.'); // No self-deletion
                
                // --- NO DELETION FOR USER'S COMMAND MESSAGE EITHER ---
                // The block for message.delete() is completely removed here.

                break;
            }

            case '!trackedbossinfo': { // Command for Indonesian Time (GMT+7)
                if (tracked.length === 0) {
                    await message.channel.send('No tracked bosses.');
                    break;
                }

                const now = new Date();

                const sortedTracked = tracked
                    .filter(entry => entry.spawnAt && new Date(entry.spawnAt) > now)
                    .sort((a, b) => new Date(a.spawnAt) - new Date(b.spawnAt));

                // Convert Philippine time (GMT+8) to Indonesian time (GMT+7) by subtracting 1 hour
                const list = sortedTracked.map(entry => {
                    const boss = bossData.find(b => b.name === entry.bossName);
                    if (!boss) return null;
                    const originalSpawnAt = new Date(entry.spawnAt);
                    // Subtract 1 hour from the original spawn time to get GMT+7
                    const adjustedSpawnAt = subHours(originalSpawnAt, 1);
                    const text = `🕒 **${boss.name}** (${boss.zone} - ${boss.area}) — **${format(adjustedSpawnAt, 'hh:mm a')}**`;
                    return `${text}`;
                }).filter(Boolean).join('\n');

                await message.channel.send('**Spawn times in Indonesian Time (GMT+7)** \n\n');
                await message.channel.send(list || 'No bosses are set to respawn in the future.');
                break;
            }

            case '!bosshour':
            case '!boss30': {
                const checkMins = commandNormalized === '!bosshour' ? 60 : 30;
                const now = new Date();

                const upcomingBosses = tracked
                    .map(entry => {
                        const boss = bossData.find(b => b.name === entry.bossName);
                        if (!boss || !entry.spawnAt) return null;
                        const spawnAt = new Date(entry.spawnAt);
                        const diff = (spawnAt - now) / 60000; // Difference in minutes
                        if (diff > 0 && diff <= checkMins) {
                            return { boss, spawnAt, diff };
                        }
                        return null;
                    })
                    .filter(Boolean)
                    .sort((a, b) => a.spawnAt - b.spawnAt);

                    const list = upcomingBosses.map(({ boss, spawnAt, diff }) => {
                    const displaySpawnAt = format(spawnAt, 'hh:mm a');
                    const unixTimestamp = Math.floor(spawnAt.getTime() / 1000); 

                    return `⏱️ **${boss.name}** <t:${unixTimestamp}:R> at **<t:${unixTimestamp}:t>** (${boss.zone} - ${boss.area})`;
                    // return `⏱️ **${boss.name}** spawning in **${Math.round(diff)}** mins at **${displaySpawnAt}** (${boss.zone} - ${boss.area})`;
                }).join('\n');

                await message.channel.send(list || `No bosses spawning in the next ${checkMins} minutes.`);
                break;
            }

            case '!bossinfo': {
                if (!input) {
                    await message.channel.send('❌ Usage: !bossinfo <bossname>');
                    break;
                }

                const bossNameLower = input.toLowerCase();
                const entry = tracked.find(t => t.bossName.toLowerCase() === bossNameLower);
                if (!entry) {
                    await message.channel.send(`❌ No tracked info found for boss: ${input}. Use !bosskilled to track it first.`);
                    break;
                }

                const boss = bossData.find(b => b.name.toLowerCase() === bossNameLower);
                if (!boss) { // Should not happen if entry exists, but good for robustness
                    await message.channel.send(`❌ Boss data not found for: ${input}.`);
                    break;
                }

                const killedAt = new Date(entry.killedAt);
                const spawnAt = new Date(entry.spawnAt);

                await message.channel.send(
                    `ℹ️ **${boss.name} Info:**\n` +
                    `Killed At: ${format(killedAt, 'MM/dd/yyyy hh:mm a')} PH time\n` +
                    `Respawn At: ${format(spawnAt, 'MM/dd/yyyy hh:mm a')} PH time\n` +
                    `Zone: ${boss.zone}\nLocation: ${boss.area}\nRespawn Time: ${boss.respawn} hours`
                );
                break;
            }

            case '!boss': {
                const bossName = args.join(' ').toLowerCase();
                if (!bossName) {
                    await message.channel.send('Please provide a boss name, e.g. `!boss Chertuba`');
                    break;
                }

                // This reads a separate bossInfo.json for detailed drops etc.
                let detailedBossInfo = [];
                try {
                    const bossDataRaw = fs.readFileSync('./bossInfo.json', 'utf8');
                    detailedBossInfo = JSON.parse(bossDataRaw);
                } catch (err) {
                    console.error('Failed to load detailed boss info from bossInfo.json:', err);
                    await message.channel.send('❌ Error: Could not load detailed boss information.');
                    break;
                }

                // Find the boss object by name (case-insensitive)
                const boss = detailedBossInfo.find(b => b.boss.toLowerCase() === bossName);

                if (!boss) {
                    await message.channel.send(`Boss "${bossName}" not found in detailed info. Try using !listboss to see all trackable bosses.`);
                    break;
                }

                const reply = `🔱 Boss Info: ${boss.boss} 🔱\n` +
                    `📍 Zone: ${boss.zone}\n` +
                    `📌 Location: ${boss.location}\n` +
                    `🎯 Level: ${boss.level}\n` +
                    `⏳ Respawn Time: ${boss.respawn_time}\n` +
                    `\n🎁 Dropped Items:\n${boss.drops.map(item => `• ${item}`).join('\n')}`;

                await message.channel.send(reply);
                break;
            }

            case '!untrackedboss': {
                if (!tracked.length) {
                    await message.channel.send('No tracked boss records found.');
                    break;
                }

                // Filter for bosses where maintenanceMode is 1
                const maintenanceModeBosses = tracked
                    .filter(entry => entry.maintenanceMode === 1)
                    .sort((a, b) => {
                        // Sort by spawnAt time
                        return new Date(a.spawnAt) - new Date(b.spawnAt);
                    })
                    .map(entry => {
                        const boss = bossData.find(b => b.name.toLowerCase() === entry.bossName.toLowerCase());
                        if (!boss) return null; // Should not happen if data is consistent

                        const killedAt = new Date(entry.killedAt);
                        const spawnAt = new Date(entry.spawnAt);

                        return `💀 **${boss.name}** (${boss.zone} - ${boss.area}) | Spawns every: **${boss.respawn} hours**`;
                        // return `💀 **${boss.name}** (${boss.zone} - ${boss.area}) - last killed at **${format(killedAt, 'MM/dd/yyyy hh:mm a')}**, respawned at **${format(spawnAt, 'MM/dd/yyyy hh:mm a')}**. Spawns every: **${boss.respawn} hours**`;
                    })
                    .filter(Boolean); // Remove any null entries

                if (maintenanceModeBosses.length === 0) {
                    await message.channel.send('No bosses are currently untracked.');
                } else {
                    const maxLen = 1900;
                    let currentMessage = `🔎 **Untracked Bosses**\n\n`;
                    for (const line of maintenanceModeBosses) {
                        if (currentMessage.length + line.length + 1 > maxLen) {
                            await message.channel.send(currentMessage);
                            currentMessage = '';
                        }
                        currentMessage += line + '\n';
                    }
                    if (currentMessage) {
                        await message.channel.send(currentMessage);
                    }
                }
                break;
            }

            case '!clearlogs': {
                // Clear the tracked array
                tracked = [];
                // Save empty array to the JSON file
                saveTracked(tracked);
                // Clear all scheduled timers
                scheduledTimers.forEach(timer => clearTimeout(timer));
                scheduledTimers.clear();

                await message.channel.send('✅ All tracked boss logs have been cleared.');
                break;
            }

            case '!wb': {
                const fixedBosses = [
                    { name: 'Vask', zone: 'Gludio', area: 'Runes of Vereth', hour: 13 },
                    { name: 'Distorted Cruma', zone: 'Giran', area: 'Forest of No Return', hour: 13 },
                    { name: 'Rayla', zone: 'Dion', area: 'Gallows', hour: 21 },
                    { name: 'Castura', zone: 'Dion', area: 'Flower Garden', hour: 21 },
                ];

                const now = new Date();
                const list = fixedBosses.map(boss => {
                    let nextSpawn = new Date(now);
                    nextSpawn.setHours(boss.hour, 0, 0, 0); // Set to the fixed hour (PH Time)
                    // If the calculated nextSpawn is in the past for today, set it for tomorrow
                    if (isBefore(nextSpawn, now)) {
                        nextSpawn = addHours(nextSpawn, 24);
                    }
                    return `🕰️ ${boss.name} - ${boss.zone} (${boss.area}) - Next spawn: ${format(nextSpawn, 'MM/dd/yyyy hh:mm')} `;
                }).join('\n');

                await message.channel.send(list);
                break;
            }

            case '!mm':
            case '!maintenancemode': {
                // Helper function to send messages with auto-deletion (can be defined once globally or within the event handler)
                const sendAndDelete = async (content, delay = 60000) => { // Default delay 60 seconds (1 minute)
                    try {
                        const sentMsg = await message.channel.send(content);
                        setTimeout(() => {
                            if (sentMsg.deletable) {
                                sentMsg.delete().catch(err => console.error(`Error deleting bot message:`, err));
                            }
                        }, delay);
                    } catch (err) {
                        console.error(`Error sending bot message:`, err);
                    }
                };

                // IMPORTANT: Permission check for administrator access
                if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await sendAndDelete('❌ You do not have permission to use this command.');
                    // Optional: Delete user's command if desired
                    // if (message.deletable) message.delete().catch(err => console.error('Error deleting user !mm message:', err));
                    break;
                }

                let updatedCount = 0;
                const now = new Date();
                // Calculate the time 2 days (48 hours) ago
                const twoDaysAgo = new Date(now.getTime() - (48 * 60 * 60 * 1000)); // 48 hours * 60 mins * 60 secs * 1000 ms

                // Iterate through the 'tracked' array and update each boss object
                tracked = tracked.map(entry => {
                    if (entry.maintenanceMode !== 1) {
                        updatedCount++;
                        // Update maintenanceMode and set spawnAt to 2 days ago
                        return { 
                            ...entry, 
                            maintenanceMode: 1,
                            spawnAt: twoDaysAgo.toISOString() // Set spawnAt to 2 days ago
                        };
                    }
                    return entry;
                });

                saveTracked(tracked);

                if (updatedCount > 0) {
                    await sendAndDelete(`🛠️ **Maintenance Mode Activated:** Set 'maintenanceMode' to **1** for **${updatedCount}** boss entries. Auto re-logging will now skip these bosses.`);
                } else {
                    await sendAndDelete('ℹ️ All tracked boss entries are already in maintenance mode (`maintenanceMode: 1`).');
                }
                
                // Optional: Delete user's command if desired
                // if (message.deletable) message.delete().catch(err => console.error('Error deleting user !mm message:', err));
                
                break;
            }

            case '!mmb':
                {
                    if (!input) {
                        await message.channel.send('❌ Usage: !mmb <bossname>');
                        break;
                    }

                    const bossNameLower = input.toLowerCase();
                    const entryIndex = tracked.findIndex(t => t.bossName.toLowerCase() === bossNameLower);

                    if (entryIndex === -1) {
                        await message.channel.send(`❌ Boss "**${input}**" not found in tracked list. Make sure the name is correct or log it first.`);
                        break;
                    }

                    const entry = tracked[entryIndex];

                    if (entry.maintenanceMode === 1) {
                        await message.channel.send(`ℹ️ **${entry.bossName}** is already in untracked mode.`);
                    } else {
                        entry.maintenanceMode = 1; // Set maintenanceMode to 1 for this specific boss
                        saveTracked(tracked); // Save the updated tracked data

                        await message.channel.send(`❓ **${entry.bossName}** has been put into **untracked mode**. Auto re-logging will now skip this boss.`);
                    }
                    break;
                }

            case '!ucr': { // New UCR command handler
                const subCommand = args[0] ? args[0].toLowerCase() : '';
                let amount = parseInt(args[0]); // Try to parse as a number directly if no subcommand

                if (subCommand === 'reset') {
                    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                        return message.channel.send('❌ You do not have permission to reset the UCR count.');
                    }
                    ucrCount = 0;
                    saveUCRCount(ucrCount);
                    await message.channel.send('✅ UCR count has been reset to 0.');
                    break;
                }

                if (subCommand === 'add' && args[1]) {
                    amount = parseInt(args[1]);
                }

                if (!isNaN(amount) && amount > 0) {
                    ucrCount += amount;
                    let replyMessage = `✨ **${amount} UCR** added to your inventory.`;

                    if (ucrCount >= 50) {
                        ucrCount = 0; // Reset to 0
                        replyMessage += `\n🎉 **UCR can be crafted to ECR! Congratulations!** Your UCR count has been reset to 0.`;
                    }
                    replyMessage += `\n📦 Current UCR count: **${ucrCount}**`;

                    saveUCRCount(ucrCount);
                    await message.channel.send(replyMessage);
                } else if (subCommand === 'current' || (!subCommand && isNaN(amount))) {
                    await message.channel.send(`📦 Current UCR count: **${ucrCount}**`);
                } else {
                    await message.channel.send('❌ Usage: `!ucr add <number>`, `!ucr <number>`, `!ucr current`, or `!ucr reset` (admin only).');
                }
                break;
            }

        }
    } catch (error) {
        console.error('❌ Error handling command:', error);
        await message.channel.send('An unexpected error occurred while processing your command.');
    }
});

// --- Helper Functions ---

/**
 * Loads the tracked boss data from trackedBosses.json.
 * @returns {Array} An array of tracked boss objects.
 */
function loadTracked() {
    try {
        if (fs.existsSync(TRACK_FILE)) {
            return JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8'));
        }
        return []; // Return empty array if file does not exist
    } catch (err) {
        console.error('Failed to load tracked data from trackedBosses.json:', err);
        return [];
    }
}

/**
 * Saves the tracked boss data to trackedBosses.json.
 * @param {Array} data - The array of tracked boss objects to save.
 */
function saveTracked(data) {
    try {
        fs.writeFileSync(TRACK_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Failed to save tracked data to trackedBosses.json:', err);
    }
}

/**
 * Loads the UCR count from ucrCount.json.
 * @returns {number} The current UCR count.
 */
function loadUCRCount() {
    try {
        if (fs.existsSync(UCR_FILE)) {
            const data = fs.readFileSync(UCR_FILE, 'utf8');
            const parsed = JSON.parse(data);
            return parsed.count || 0; // Return count, default to 0 if not found
        }
        return 0; // Return 0 if file does not exist
    } catch (err) {
        console.error('Failed to load UCR count:', err);
        return 0; // Default to 0 on error
    }
}

/**
 * Saves the UCR count to ucrCount.json.
 * @param {number} count - The UCR count to save.
 */
function saveUCRCount(count) {
    try {
        fs.writeFileSync(UCR_FILE, JSON.stringify({ count: count }, null, 2));
    } catch (err) {
        console.error('Failed to save UCR count:', err);
    }
}


/**
 * Schedules Discord announcements and timers for a given boss spawn.
 * @param {object} boss - The boss definition object.
 * @param {Date} spawnAt - The calculated spawn time.
 * @param {boolean} isStartup - True if called during bot startup.
 */
function scheduleBossTimers(boss, spawnAt, isStartup = false) {
    // Clear any existing timers for this boss to prevent duplicates
    clearTimers(boss.name); 
    const now = new Date(); // Get the current time

    // --- Logic to prevent scheduling for past spawns ---
    // If the calculated spawn time is in the past, do not schedule any new timers.
    // The 'checkAndReLogUntrackedBosses' function is responsible for adjusting
    // past or missed spawns to a future, trackable time.
    if (isBefore(spawnAt, now)) {
        // Only log this message if the function is called for active scheduling,
        // not during the initial bot startup process (which might naturally
        // encounter past spawns as it reads from trackedBosses.json).
        if (!isStartup) { 
            console.log(`[Skipping Timer] Boss ${boss.name} spawn time ${format(spawnAt, 'MM/dd/yyyy hh:mm a')} is in the past. Not scheduling announcement.`);
        }
        return; // Exit the function immediately as nothing needs to be scheduled
    }

    // --- Retrieve the announcement channel ---
    // Assumes ANNOUNCE_CHANNEL_ID is a single string ID from your .env file
    const announceChannel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (!announceChannel) {
        console.error(`Announcement channel with ID ${ANNOUNCE_CHANNEL_ID} not found. Please check .env ANNOUNCE_CHANNEL_ID.`);
        return; // Exit if the channel isn't found, as announcements cannot be sent
    }

    // --- Calculate the 10-minute warning time ---
    const tenMinBefore = new Date(spawnAt.getTime() - 10 * 60000); // 10 minutes before the actual spawn time

    // --- Schedule 10-minute warning ---
    // Only schedule if the 10-minute warning time is still in the future relative to now

    if (isBefore(now, tenMinBefore)) {
        const timer10 = setTimeout(() => {
            const unixTimestamp = Math.floor(spawnAt.getTime() / 1000); 
            const epicText = boss.dropEpic ? ' [DROPS EPIC]' : '';
            const spawnChanceText = typeof boss.chanceSpawn === 'number' ? `\n🎯 Spawn Chance: **${boss.chanceSpawn}%**` : '';
            
            // Send the 10-minute warning message to the announcement channel
            announceChannel.send(
                `@everyone ⚠️ **${boss.name}${epicText}** will spawn **<t:${unixTimestamp}:R>** at ${boss.zone} - ${boss.area}!\n⏰ Spawn Time: **<t:${unixTimestamp}:t>**${spawnChanceText}`
            )
            .then(sentMessage => { // --- ADDED THIS .then() BLOCK ---
                // Schedule the deletion of the 'sentMessage' after 11 minutes (660,000 milliseconds)
                setTimeout(() => {
                    if (sentMessage.deletable) { // Check if bot has permission and message still exists
                        sentMessage.delete()
                            .catch(err => console.error(`Error deleting 10-min warning for ${boss.name}:`, err));
                    }
                }, 600000); // 600000 milliseconds = 10 minutes
            })
            .catch(err => console.error(`Error sending 10-min announcement for ${boss.name}:`, err));
            // --- END OF ADDED .then() BLOCK ---
            
            // Note: The timer for 10-min warning is typically cleared by clearTimers
            // when the boss is killed, or by this very function if re-scheduled.
            // It's not explicitly deleted from `scheduledTimers` here after firing
            // because `clearTimers` is called right before new timers are set.
        }, tenMinBefore - now); // Calculate delay in milliseconds
        
        // Store the timer ID in the scheduledTimers Map for later management (e.g., clearing)
        scheduledTimers.set(`${boss.name}_10min`, timer10);
        console.log(`[Scheduled] ${boss.name} 10-min warning for ${format(tenMinBefore, 'hh:mm a')}`);
    } else {
        // Log if the 10-minute warning time has already passed
        console.log(`[Skipped] ${boss.name} 10-min warning (time already passed).`);
    }

   

    // --- Schedule actual spawn announcement ---
const timerSpawn = setTimeout(() => {
        const epicText = boss.dropEpic ? ' [DROPS EPIC]' : ''; 
        
        // Determine spawn chance text
        const spawnChanceText = typeof boss.chanceChance === 'number' ? `\n🎯 Spawn Chance: **${boss.chanceChance}%**` : ''; // Assuming boss.chanceSpawn is the correct property name

        // Calculate Unix timestamp for the exact spawn time
        const unixTimestampSpawn = Math.floor(spawnAt.getTime() / 1000); 

        // Send the actual spawn message to the announcement channel
        announceChannel.send(
            // --- MODIFIED THIS LINE TO MOVE TIMESTAMP ---
            `@everyone 🚨 **${boss.name}${epicText}** has spawned at ${boss.zone} - ${boss.area}! [**<t:${unixTimestampSpawn}:t>**] ${spawnChanceText}`
            // --- END MODIFIED ---
        )
        .then(sentMessage => { 
            // Schedule the deletion of the 'sentMessage' after 5 minutes (300,000 milliseconds)
            setTimeout(() => {
                if (sentMessage.deletable) { 
                    sentMessage.delete()
                        .catch(err => console.error(`Error deleting spawned boss announcement for ${boss.name}:`, err));
                }
            }, 300000); // 300000 milliseconds = 5 minutes
        })
        .catch(err => console.error(`Error sending spawn announcement for ${boss.name}:`, err));
        
        // Clear all timers for this boss once it has spawned (as it's now 'killed' for this cycle)
        clearTimers(boss.name); 
        console.log(`[Announced] ${boss.name} spawned.`);
    }, spawnAt - now); // Calculate delay in milliseconds

    // Store the spawn timer ID in the scheduledTimers Map
    scheduledTimers.set(`${boss.name}_spawn`, timerSpawn);
    console.log(`[Scheduled] ${boss.name} spawn for ${format(spawnAt, 'hh:mm a')}`);
}

/**
 * Clears scheduled timers for a specific boss.
 * @param {string} bossName - The name of the boss.
 */
function clearTimers(bossName) {
    ['_10min', '_spawn'].forEach(suffix => {
        const key = bossName + suffix;
        if (scheduledTimers.has(key)) {
            clearTimeout(scheduledTimers.get(key));
            scheduledTimers.delete(key);
            console.log(`[Cleared Timer] ${key}`);
        }
    });
}

let fixedBossTimerId = null;
let nextAnnouncementOffset = 30; // Start announcing 30 minutes before fixed spawns

/**
 * Schedules periodic announcements for fixed-time world bosses.
 */
function scheduleFixedBossAnnouncements() {
    if (fixedBossTimerId) clearTimeout(fixedBossTimerId); // Clear previous timer if exists

    const now = new Date();
    const fixedBossHours = [13, 21]; // 1 PM and 9 PM PH time
    let nextFixedBossSpawn = null;

    for (const hour of fixedBossHours) {
        let spawnTimeToday = new Date(now);
        spawnTimeToday.setHours(hour, 0, 0, 0);

        if (isBefore(now, spawnTimeToday)) {
            nextFixedBossSpawn = spawnTimeToday;
            break;
        }
    }

    if (!nextFixedBossSpawn) {
        const firstSpawnTomorrow = new Date(now);
        firstSpawnTomorrow.setDate(firstSpawnTomorrow.getDate() + 1);
        firstSpawnTomorrow.setHours(fixedBossHours[0], 0, 0, 0);
        nextFixedBossSpawn = firstSpawnTomorrow;
    }

    const announceTime = new Date(nextFixedBossSpawn.getTime() - nextAnnouncementOffset * 60 * 1000);
    const announceChannel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);

    if (!announceChannel) {
        console.error(`Announcement channel with ID ${ANNOUNCE_CHANNEL_ID} not found.`);
        return;
    }

    if (isBefore(now, announceTime)) {
        const delay = announceTime.getTime() - now.getTime();
        fixedBossTimerId = setTimeout(() => {
            announceChannel.send(`@everyone 📣 Fixed World Bosses will spawn in **${nextAnnouncementOffset} minutes**! Check !wb for details.`).catch(err => console.error('Error sending fixed boss announcement:', err));
            scheduleFixedBossAnnouncements();
        }, delay);
        console.log(`[Scheduled] Fixed World Boss reminder for ${format(announceTime, 'MM/dd/yyyy hh:mm a')}`);
    } else {
        console.log(`[Skipped] Fixed World Boss reminder (time already passed for ${format(announceTime, 'MM/dd/yyyy hh:mm a')}). Scheduling next.`);
        fixedBossTimerId = setTimeout(() => {
            scheduleFixedBossAnnouncements();
        }, 10 * 1000);
    }
}

/**
 * Schedules a periodic announcement of bosses spawning within the next hour.
 * This function recursively schedules itself for the top of the next hour.
 */
function scheduleHourlyBossAnnouncements() {
    if (hourlyBossTimerId) clearTimeout(hourlyBossTimerId); // Clear any existing timer

    const now = new Date();
    // Calculate the time for the top of the next hour (e.g., if now is 2:35 PM, next is 3:00 PM)
    const nextHourTop = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);

    const delay = nextHourTop.getTime() - now.getTime();

    // Ensure the delay is positive; if somehow we're past the next hour top, schedule for the hour after
    if (delay < 0) {
        nextHourTop.setHours(nextHourTop.getHours() + 1); // Move to the hour after next
        const newDelay = nextHourTop.getTime() - now.getTime();
        hourlyBossTimerId = setTimeout(sendHourlyBossAnnouncement, newDelay);
        console.log(`[Hourly Announcer] Scheduling for ${format(nextHourTop, 'MM/dd/yyyy hh:mm a')} (adjusted due to past time).`);
    } else {
        hourlyBossTimerId = setTimeout(sendHourlyBossAnnouncement, delay);
        console.log(`[Hourly Announcer] Scheduling for ${format(nextHourTop, 'MM/dd/yyyy hh:mm a')}.`);
    }
}

/**
 * Sends the hourly boss announcement message.
 * This function is called by the setTimeout from scheduleHourlyBossAnnouncements.
 */
async function sendHourlyBossAnnouncement() {
    const now = new Date();
    const checkMins = 60; // Check for bosses spawning in the next 60 minutes
    const unixTimestampForNow = Math.floor(now.getTime() / 1000);

    const upcomingBosses = tracked
        .map(entry => {
            const boss = bossData.find(b => b.name === entry.bossName);
            if (!boss || !entry.spawnAt || entry.maintenanceMode === 1) return null; // Exclude maintenance mode
            const spawnAt = new Date(entry.spawnAt);
            const diff = (spawnAt - now) / 60000; // Difference in minutes
            if (diff > 0 && diff <= checkMins) {
                return { boss, spawnAt, diff };
            }
            return null;
        })
        .filter(Boolean) // Remove null entries
        .sort((a, b) => a.spawnAt - b.spawnAt); // Sort by soonest spawn time

    let messageContent = `@everyone 🔔 **Hourly Boss Summary (<t:${unixTimestampForNow}:t>):**\n\n`; // Kept PH Time for reference
    
    if (upcomingBosses.length === 0) {
        messageContent += "No bosses are scheduled to spawn in the next hour.";
    } else {
        messageContent += "Here are the bosses that will spawn within the next hour:\n\n";
        upcomingBosses.forEach(({ boss, spawnAt, diff }) => {
            const unixTimestamp = Math.floor(spawnAt.getTime() / 1000); 
            
            const epicText = boss.dropEpic ? ' [DROPS EPIC]' : '';
            const spawnChanceText = typeof boss.chanceSpawn === 'number' ? `, 🎯 ${boss.chanceChance}% chance` : ''; // Corrected to boss.chanceSpawn if needed here
            // Note: Make sure `boss.chanceChance` is actually `boss.chanceSpawn` if that's where your numerical chance is stored.
            // Assuming it's `boss.chanceSpawn` as per previous discussions:
            const correctedSpawnChanceText = typeof boss.chanceSpawn === 'number' ? `, 🎯 ${boss.chanceSpawn}% chance` : '';

            messageContent +=
                `• **${boss.name}** **<t:${unixTimestamp}:R>** at **<t:${unixTimestamp}:t>** ` +
                `(${boss.zone} - ${boss.area})${epicText}${correctedSpawnChanceText}\n`;
        });
    }

    const announceChannel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (announceChannel) {
        // --- ADDED SELF-DELETION LOGIC ---
        const deleteDelay = 3600000; // 60 minutes = 3600000 milliseconds

        if (messageContent.length > 2000) {
            const chunks = messageContent.match(/[\s\S]{1,1900}/g) || [];
            chunks.forEach(chunk => {
                announceChannel.send(chunk)
                    .then(sentMessage => {
                        setTimeout(() => {
                            if (sentMessage.deletable) {
                                sentMessage.delete().catch(err => console.error(`Error deleting hourly announcement chunk:`, err));
                            }
                        }, deleteDelay);
                    })
                    .catch(err => console.error(`Error sending hourly announcement chunk:`, err));
            });
        } else {
            announceChannel.send(messageContent)
                .then(sentMessage => {
                    setTimeout(() => {
                        if (sentMessage.deletable) {
                            sentMessage.delete().catch(err => console.error(`Error deleting hourly announcement:`, err));
                        }
                    }, deleteDelay);
                })
                .catch(err => console.error(`Error sending hourly announcement:`, err));
        }
        // --- END SELF-DELETION LOGIC ---
    } else {
        console.error(`Hourly Announcer: Announcement channel with ID ${ANNOUNCE_CHANNEL_ID} not found.`);
    }

    // Recursively schedule the next hourly announcement
    scheduleHourlyBossAnnouncements();
}

/**
 * Periodically checks for tracked bosses that have passed their spawn time
 * and automatically re-logs them for the next cycle if they haven't been updated.
 */
async function checkAndReLogUntrackedBosses() {
    console.log('[Auto Re-log] Running check for past-due bosses...');
    const now = new Date();
    let updated = false; // Flag to check if we need to save the file

    for (let i = 0; i < tracked.length; i++) {
        const entry = tracked[i];

        // 1. Skip if the boss is in maintenance mode
        if (entry.maintenanceMode === 1) {
            continue;
        }

        const spawnAt = new Date(entry.spawnAt);
        const tenMinutesAfterSpawn = new Date(spawnAt.getTime() + 10 * 60 * 1000); // 10 minutes after presumed spawn

        // 2. Check if 10 minutes have passed since the spawn time
        if (isBefore(tenMinutesAfterSpawn, now)) {
            const boss = bossData.find(b => b.name === entry.bossName);

            if (!boss || boss.respawn === undefined) {
                console.error(`[Auto Re-log] Could not find boss data for ${entry.bossName}. Skipping.`);
                continue;
            }

            console.log(`[Auto Re-log] Boss ${boss.name} is past due. Re-logging...`);

            const newKilledAt = spawnAt; // Use the old spawnAt as the new killedAt for re-logging purposes
            const newSpawnAt = addHours(newKilledAt, boss.respawn); // Calculate the new spawnAt

            tracked[i].killedAt = newKilledAt.toISOString();
            tracked[i].spawnAt = newSpawnAt.toISOString();
            tracked[i].maintenanceMode = 0; // Ensure maintenance mode is off if auto-relogged
            
            updated = true; // Mark that an update occurred

            scheduleBossTimers(boss, newSpawnAt); // Re-schedule timers for the newly re-logged boss

            const announceChannel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
            if (announceChannel) {
                // Keep original time formatting for now
                const prevSpawnTimeFormatted = format(newKilledAt, 'MM/dd/yyyy hh:mm a');
                const newSpawnTimeFormatted = format(newSpawnAt, 'MM/dd/yyyy hh:mm a');

                const messageContent =
                    `@everyone 🔄 **AUTO RE-LOG:** **${boss.name}** was not updated.\n` +
                    `Automatically re-logged as killed at **${prevSpawnTimeFormatted}** (previous presumed spawn time).\n` +
                    `New Respawn time: **${newSpawnTimeFormatted}** (${boss.zone} - ${boss.area}).\n\n` +
                    `*Have you killed this boss? Please re-log manually using \`!bk <name> <HH:MM>\` for accurate spawn times.*`;
                
                try {
                    // --- MODIFIED FOR SELF-DELETION ONLY ---
                    await announceChannel.send(messageContent)
                        .then(sentMessage => {
                            // Schedule deletion after 5 minutes (300,000 milliseconds)
                            setTimeout(() => {
                                if (sentMessage.deletable) {
                                    sentMessage.delete().catch(err => console.error(`Error deleting auto-relog message for ${boss.name}:`, err));
                                }
                            }, 60000); // 1 minute
                        });
                    // --- END MODIFIED ---
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
}

// Client login
client.login(TOKEN);