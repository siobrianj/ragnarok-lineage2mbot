const fs = require('fs');
const path = require('path');
const { formatDistanceToNowStrict, format } = require('date-fns');
const bossData = require('./bossData.json');
const trackedBossesPath = path.join(__dirname, 'trackedBosses.json');
const CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;

function loadTracked() {
  if (!fs.existsSync(trackedBossesPath)) return [];
  return JSON.parse(fs.readFileSync(trackedBossesPath, 'utf8'));
}


function getUntrackedBosses() {
  const now = new Date();
  return loadTracked().filter(entry => {
    const spawnAt = new Date(entry.spawnAt);
    return spawnAt <= now && !entry.killedAt;
  });
}

module.exports = (client) => {
  setInterval(async () => {
    const now = new Date();
    const currentMinute = now.getMinutes();
    const untracked = getUntrackedBosses();

    const bossesToRemind = untracked.filter(entry => {
      const spawnAt = new Date(entry.spawnAt);
      return spawnAt.getMinutes() === currentMinute;
    });

    if (!bossesToRemind.length) return;

    const announceChannel = await client.channels.fetch(CHANNEL_ID);
    if (!announceChannel) return;

    const reminders = bossesToRemind.map(entry => {
      const boss = bossData.find(b => b.name.toLowerCase() === entry.bossName.toLowerCase());
      if (!boss) return null;

      const spawnAt = new Date(entry.spawnAt);
      const formattedSpawn = format(spawnAt, 'MM/dd/yyyy hh:mm a');
      const since = formatDistanceToNowStrict(spawnAt, { addSuffix: true });

      return `❓ Have you checked **${boss.name}**?\n🕒 Spawned at **${formattedSpawn}** (${since}), ${boss.zone} - ${boss.area}`;
    }).filter(Boolean);

    if (reminders.length) {
      await announceChannel.send(`@everyone\n${reminders.join('\n\n')}`);
    }
  }, 60 * 1000); // Check every minute
};
