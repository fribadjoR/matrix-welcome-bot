import { MatrixClient, SimpleFsStorageProvider } from "matrix-bot-sdk";
import fs from "fs";

const HOMESERVER   = process.env.HOMESERVER;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const LOG_ROOM_ID  = process.env.LOG_ROOM_ID || "";
const INFO_PREFIX  = process.env.INFO_PREFIX || "INFO -";

const WELCOME_TITLE = process.env.WELCOME_TITLE || "Bienvenue";
const WELCOME_LINES = process.env.WELCOME_LINES || "• Charte : https://exemple/charte\n• Docs : https://exemple/docs\n• FAQ : https://exemple/faq";
const WELCOME_CTA   = process.env.WELCOME_CTA   || "👉 Pour accéder aux autres salons, répondez directement à ce fil.";

if (!HOMESERVER || !ACCESS_TOKEN) {
  console.error("HOMESERVER et ACCESS_TOKEN sont requis (fichier .env).");
  process.exit(1);
}

const storage = new SimpleFsStorageProvider("state.json");
const client  = new MatrixClient(HOMESERVER, ACCESS_TOKEN, storage);

const DB_FILE = "welcomed.json";
const welcomed = new Set();
if (fs.existsSync(DB_FILE)) {
  try { JSON.parse(fs.readFileSync(DB_FILE, "utf-8")).forEach(k => welcomed.add(k)); } catch {}
}
function saveWelcomed() { fs.writeFileSync(DB_FILE, JSON.stringify([...welcomed], null, 2)); }

async function ensureDmWith(userId) {
  const { room_id } = await client.createRoom({
    invite: [userId],
    is_direct: true,
    preset: "trusted_private_chat",
    initial_state: [
      { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }
    ],
  });
  return room_id;
}

client.on("room.event", async (roomId, ev) => {
  try {
    if (ev?.type !== "m.room.member") return;
    if (ev?.content?.membership !== "join") return;

    const userId = ev?.state_key;
    if (!userId) return;

    const me = await client.getUserId();
    if (userId === me) return;

    const nameEv = await client.getRoomStateEvent(roomId, "m.room.name", "").catch(() => null);
    const roomName = (nameEv && nameEv.name) ? String(nameEv.name) : "";
    if (!roomName.startsWith(INFO_PREFIX)) return;

    const key = `${roomId}:${userId}`;
    if (welcomed.has(key)) return;
    welcomed.add(key); saveWelcomed();

    const dmRoomId = await ensureDmWith(userId);

    const rootBody =
`👋 ${WELCOME_TITLE} dans ${roomName} !
${WELCOME_LINES}

${WELCOME_CTA}`;

    const rootEventId = await client.sendMessage(dmRoomId, {
      msgtype: "m.text",
      body: rootBody,
    });

    await client.sendMessage(dmRoomId, {
      "m.relates_to": {
        "rel_type": "m.thread",
        "event_id": rootEventId,
        "is_falling_back": true,
        "m.in_reply_to": { "event_id": rootEventId }
      },
      msgtype: "m.text",
      body: "Ce fil regroupe l’accueil et vos questions. Dites-nous ce dont vous avez besoin 🙂",
    });

    if (LOG_ROOM_ID) {
      await client.sendNotice(LOG_ROOM_ID, `Arrivée dans ${roomName}: ${userId} → DM d’accueil envoyé.`);
    }
  } catch (e) {
    console.error("Erreur handler:", e?.message || e);
  }
});

client.start().then(() => console.log("Bot prêt (MP-only avec thread)."));
