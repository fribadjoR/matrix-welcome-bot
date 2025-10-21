// --- Charge .env ---
import 'dotenv/config';

import {
  MatrixClient,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
} from "matrix-bot-sdk";
import fs from "fs";

// ============ ENV ============
const HOMESERVER   = process.env.HOMESERVER;                   // ex: https://matrix-client.matrix.org
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;                 // token du compte bot
const LOG_ROOM_ID  = process.env.LOG_ROOM_ID || "";            // optionnel
const GLOBAL_WELCOME = process.env.GLOBAL_WELCOME === "true";  // "true" => un accueil global pour tous les salons cibles
const WELCOME_MODE = (process.env.WELCOME_MODE || "dm").toLowerCase(); // "dm" ou "thread" ; ici on vise "dm"

if (!HOMESERVER || !ACCESS_TOKEN) {
  console.error("HOMESERVER et ACCESS_TOKEN sont requis (dans .env).");
  process.exit(1);
}

// ============ PERSISTENCE LOCALE ============
const storage = new SimpleFsStorageProvider("state.json");
const crypto  = new RustSdkCryptoStorageProvider("crypto");
const client  = new MatrixClient(HOMESERVER, ACCESS_TOKEN, storage, crypto);

// Accueils par salon (texte + fichiers)
const WELCOME_STORE = "welcome_store.json";
let welcomeStore = {};
try { welcomeStore = JSON.parse(fs.readFileSync(WELCOME_STORE, "utf-8")); } catch {}
const saveWelcome = () => fs.writeFileSync(WELCOME_STORE, JSON.stringify(welcomeStore, null, 2));

const getRoomWelcome = (roomId) => {
  if (GLOBAL_WELCOME) return welcomeStore["_global"] || { text: "", files: [] };
  return welcomeStore[roomId] || { text: "", files: [] };
};
const setRoomWelcome = (roomId, data) => {
  if (GLOBAL_WELCOME) roomId = "_global";
  welcomeStore[roomId] = data;
  saveWelcome();
};

// Anti-doublon: une bienvenue par (roomId:userId)
const WELCOMED_FILE = "welcomed.json";
let welcomed = new Set();
try { JSON.parse(fs.readFileSync(WELCOMED_FILE, "utf-8")).forEach(k => welcomed.add(k)); } catch {}
const saveWelcomed = () => fs.writeFileSync(WELCOMED_FILE, JSON.stringify([...welcomed], null, 2));

// ============ UTILS ============
async function getRoomName(roomId){
  const ev = await client.getRoomStateEvent(roomId, "m.room.name", "").catch(() => null);
  return ev?.name || "";
}

// Salons ciblés : noms commençant par "INFO" ou exactement "Accueil des nouveaux•elles"
function roomIsTarget(name){
  if (!name) return false;
  const t = name.trim();
  return t.startsWith("INFO") || t === "Accueil des nouveaux•elles";
}

// Vérifie si l'utilisateur est admin/modo (PL >= 50) dans le salon
async function userIsAdmin(roomId, userId){
  try {
    const pl = await client.getRoomStateEvent(roomId, "m.room.power_levels", "");
    const lvl = pl?.users?.[userId] ?? pl?.users_default ?? 0;
    return lvl >= 50;
  } catch { return false; }
}

// DM helper (crée une DM chiffrée avec l'utilisateur)
async function ensureDmWith(userId){
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

// Envoi texte d'accueil (DM par défaut)
async function sendWelcomeTextDM(userId, body){
  const dmId = await ensureDmWith(userId);
  await client.sendMessage(dmId, { msgtype: "m.text", body });
  return dmId;
}

// Envoi fichier/média dans la même DM (réutilise content.file/url + info)
async function sendWelcomeFileDM(dmId, fileContent){
  const content = { ...fileContent };
  // content doit contenir: msgtype, body, et soit file (E2EE) soit url (non chiffré), + info éventuelle
  await client.sendMessage(dmId, content);
}

// Déchiffre un event si nécessaire (utile pour les commandes attach en E2EE)
async function decryptIfNeeded(roomId, ev) {
  if (!ev) return ev;
  if (ev.type !== "m.room.encrypted") return ev;
  try {
    const dec = await client.crypto.decryptRoomEvent(ev);
    return { ...ev, type: dec.type, content: dec.content };
  } catch {
    return ev; // pas de clés -> on laisse tel quel
  }
}

// ============ COMMANDES ADMIN ============
// Les admins du salon configurent le texte & les pièces jointes directement depuis Element
async function handleAdminCommands(roomId, ev){
  if (ev.type !== "m.room.message") return;
  const c = ev.content || {};
  if ((c.msgtype || "") !== "m.text") return;

  const body = (c.body || "").trim();
  if (!body.startsWith("!welcome")) return;

  const userId = ev.sender;
  if (!await userIsAdmin(roomId, userId)) {
    await client.sendNotice(roomId, "⛔ Cette commande est réservée aux admins du salon.");
    return;
  }

  const store = getRoomWelcome(roomId);

  if (body.startsWith("!welcome text ")) {
    const text = body.slice("!welcome text ".length).trim();
    store.text = text;
    setRoomWelcome(roomId, store);
    await client.sendNotice(roomId, "✅ Texte d'accueil mis à jour.");
    return;
  }

  if (body === "!welcome show") {
    await client.sendNotice(roomId,
      `🔎 Accueil actuel :\n\n${store.text || "(aucun texte)"}\n\nFichiers: ${store.files?.length || 0}`);
    return;
  }

  if (body === "!welcome clear") {
    store.files = [];
    setRoomWelcome(roomId, store);
    await client.sendNotice(roomId, "✅ Pièces jointes d'accueil supprimées.");
    return;
  }

  if (body === "!welcome reset") {
    setRoomWelcome(roomId, { text: "", files: [] });
    await client.sendNotice(roomId, "✅ Accueil réinitialisé (texte + fichiers).");
    return;
  }

  if (body === "!welcome attach") {
    // doit être une réponse à un message fichier/média
    const rel = c["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    if (!rel) {
      await client.sendNotice(roomId, "Réponds au message du fichier (PDF, image, audio, vidéo), puis tape `!welcome attach`.");
      return;
    }

    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(rel)}`;
    let orig = await client.doRequest("GET", path).catch(() => null);
    if (!orig) { await client.sendNotice(roomId, "Impossible de lire le message ciblé."); return; }

    // déchiffrer si besoin (E2EE)
    orig = await decryptIfNeeded(roomId, orig);

    const m = orig.content || {};
    const ok = ["m.file","m.image","m.video","m.audio"].includes(m.msgtype || "");
    if (!ok) { await client.sendNotice(roomId, "Ce message n'est pas un fichier/média."); return; }

    // On stocke un "content" prêt-à-envoyer en DM plus tard
    const fileContent = { msgtype: m.msgtype, body: m.body || "(fichier)" };
    if (m.file) fileContent.file = m.file;           // E2EE (chiffré)
    else if (m.url) fileContent.url = m.url;         // non chiffré
    if (m.info) fileContent.info = m.info;

    store.files = store.files || [];
    store.files.push(fileContent);
    setRoomWelcome(roomId, store);
    await client.sendNotice(roomId, "✅ Fichier ajouté à l'accueil.");
    return;
  }
}

// ============ ACCUEIL À L’ARRIVÉE ============
client.on("room.event", async (roomId, ev) => {
  try {
    // 0) Commandes admin (dans tous les cas, d’abord)
    await handleAdminCommands(roomId, ev);

    // 1) On ne s'occupe que des "join"
    if (ev?.type !== "m.room.member") return;
    if (ev?.content?.membership !== "join") return;

    const userId = ev?.state_key;
    const me = await client.getUserId();
    if (!userId || userId === me) return;

    // 2) Filtrage du salon cible
    const roomName = await getRoomName(roomId);
    if (!roomIsTarget(roomName)) return;

    // 3) Anti-doublon: une seule bienvenue par (roomId:userId)
    const key = `${roomId}:${userId}`;
    if (welcomed.has(key)) return;
    welcomed.add(key); saveWelcomed();

    // 4) Récupérer la config d'accueil pour CE salon (ou globale si GLOBAL_WELCOME=true)
    const conf = getRoomWelcome(roomId);

    // 5) Si rien n'est configuré, on DM un message pédagogique
    if (!conf.text && (!conf.files || !conf.files.length)) {
      const dmId = await sendWelcomeTextDM(userId,
        "ℹ️ Bienvenue ! Les admins peuvent définir l'accueil de ce salon avec :\n" +
        "• `!welcome text ...`\n" +
        "• (répondre à un fichier) puis `!welcome attach`\n" +
        "• `!welcome show` pour vérifier.");
      if (LOG_ROOM_ID) await client.sendNotice(LOG_ROOM_ID, `Info DM envoyée (pas de config) à ${userId} pour ${roomName}`);
      return;
    }

    // 6) Envoyer le texte d'accueil en DM
    const header = `👋 Bienvenue dans « ${roomName} » !`;
    const text   = conf.text ? `\n\n${conf.text}` : "";
    const dmId   = await sendWelcomeTextDM(userId, header + text);

    // 7) Envoyer les pièces jointes d'accueil en DM (sans télécharger/déchiffrer côté bot)
    for (const f of (conf.files || [])) {
      await sendWelcomeFileDM(dmId, f);
    }

    if (LOG_ROOM_ID) {
      await client.sendNotice(LOG_ROOM_ID, `Accueil DM envoyé à ${userId} pour ${roomName} (${conf.files?.length || 0} fichier[s]).`);
    }
  } catch (e) {
    console.error("Erreur handler:", e?.message || e);
  }
});

// ============ DÉMARRAGE ============
client.start().then(() => {
  console.log("Bot prêt (DM onboarding, E2EE-ready, commandes !welcome, cibles: INFO* + Accueil des nouveaux•elles).");
}).catch(err => {
  console.error("Échec démarrage:", err?.message || err);
});
