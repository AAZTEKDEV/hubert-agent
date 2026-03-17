/// <reference types="@workadventure/iframe-api-typings" />
import { getLayersMap, Properties } from '@workadventure/scripting-api-extra/dist';

// ==============================================================
//  HUBERT — Claude Agent pour WorkAdventure (Ambre Partners)
// ==============================================================

// REMPLACE par ta vraie cle API Anthropic
const ANTHROPIC_API_KEY = 'sk-ant-VOTRE_CLE_ICI';
const MODEL = 'claude-sonnet-4-6';
const BOT_NAME = 'Hubert';

// Historique par joueur (userId -> messages[])
const conversations = new Map<string, Array<{ role: string; content: any }>>();

// -- System prompt --
async function buildSystemPrompt(): Promise<string> {
  return `Tu es Hubert, l'assistant IA d'Ambre Partners dans cet espace virtuel WorkAdventure.

Ton role :
- Accueillir chaleureusement les visiteurs qui s'approchent de toi
- Repondre a leurs questions sur les espaces disponibles dans le monde
- Les orienter vers les bonnes personnes ou zones
- Fournir des informations generales sur Ambre Partners si on te le demande

Ton style :
- Chaleureux, professionnel et concis (2-3 phrases max par reponse)
- Tu tutoies les collaborateurs internes, tu vouvoies les visiteurs externes
- Tu peux repondre en francais et en anglais selon la langue de ton interlocuteur
- Tu utilises un ton decontracte mais serieux, a l'image d'un collegue bienveillant

Tu disposes de plusieurs outils :
- get_map_info : pour connaitre les zones IA de la carte
- get_people_in_map : pour savoir qui est connecte
- move_to : pour te deplacer vers une zone precise
- get_datetime : pour donner l'heure actuelle

Utilise ces outils quand c'est pertinent pour aider les visiteurs. Si tu ne connais pas la reponse a une question, dis-le honnetement et propose de rediriger vers la bonne personne.`;
}

// -- Skills disponibles --
const SKILLS = {
  async getMapInfo(): Promise<string> {
    const layers = await getLayersMap();
    const zones: string[] = [];
    for (const layer of layers.values()) {
      if (layer.type === 'objectgroup') {
        for (const obj of (layer as any).objects) {
          if (obj.type === 'area' || obj.class === 'area') {
            const props = new Properties(obj.properties);
            if (props.getBoolean('ai-zone')) {
              zones.push(`- ${obj.name}: ${props.getString('description')}`);
            }
          }
        }
      }
    }
    return zones.length > 0
      ? `Zones :\n${zones.join('\n')}`
      : 'Aucune zone AI definie sur cette carte.';
  },

  async getPeopleInMap(): Promise<string> {
    const players = await WA.players.list();
    if (players.length === 0) return 'Aucun joueur present actuellement.';
    return players.map((p: any) =>
      `- ${p.name} (tags: ${p.tags.join(', ') || 'aucun'})`
    ).join('\n');
  },

  async moveTo(areaName: string): Promise<string> {
    try {
      await WA.player.moveTo(areaName);
      return `Je me deplace vers : ${areaName}`;
    } catch {
      return `Impossible de me deplacer vers : ${areaName}`;
    }
  },

  getDateTime(): string {
    return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  }
};

// -- Definition des tools pour Claude --
const CLAUDE_TOOLS = [
  {
    name: 'get_map_info',
    description: 'Recupere la liste des zones IA de la carte avec leurs descriptions.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_people_in_map',
    description: 'Liste les joueurs actuellement presents dans le monde.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'move_to',
    description: 'Deplace le bot vers une zone nommee de la carte.',
    input_schema: {
      type: 'object',
      properties: {
        area_name: { type: 'string', description: 'Nom exact de la zone cible' }
      },
      required: ['area_name']
    }
  },
  {
    name: 'get_datetime',
    description: "Retourne la date et l'heure actuelles a Paris.",
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

// -- Execution d'un tool --
async function executeTool(toolName: string, toolInput: any): Promise<string> {
  switch (toolName) {
    case 'get_map_info':       return await SKILLS.getMapInfo();
    case 'get_people_in_map':  return await SKILLS.getPeopleInMap();
    case 'move_to':            return await SKILLS.moveTo(toolInput.area_name);
    case 'get_datetime':       return SKILLS.getDateTime();
    default:                   return `Tool inconnu : ${toolName}`;
  }
}

// -- Boucle tool-use Claude --
async function callClaude(
  messages: Array<{ role: string; content: any }>,
  systemPrompt: string
): Promise<string> {
  let currentMessages = [...messages];

  // Maximum 5 iterations de tool-use
  for (let i = 0; i < 5; i++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: CLAUDE_TOOLS,
        messages: currentMessages
      })
    });

    const data = await response.json();

    // Reponse finale texte
    if (data.stop_reason === 'end_turn') {
      const textBlock = data.content.find((b: any) => b.type === 'text');
      return textBlock?.text ?? '...';
    }

    // Tool use -> executer et boucler
    if (data.stop_reason === 'tool_use') {
      const toolResults: any[] = [];
      for (const block of data.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result
          });
        }
      }
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: data.content },
        { role: 'user', content: toolResults }
      ];
    }
  }

  return "Trop d'iterations de tools -- je n'ai pas pu finaliser ma reponse.";
}

// -- Point d'entree (exporte pour WorkAdventure) --
export default {
  run: async (metadata: any) => {
    // Activer le suivi des joueurs
    await WA.players.configureTracking({ players: true, movement: false });

    // Message d'arrivee
    WA.chat.sendChatMessage(`${BOT_NAME} est en ligne !`, BOT_NAME);

    // Ecouter les messages chat
    WA.chat.onChatMessage(async (message: string, { user }: any) => {
      const userId = String(user?.id ?? 'anonymous');
      const userName = user?.name ?? 'Visiteur';

      // Initialiser l'historique si nouveau joueur
      if (!conversations.has(userId)) {
        conversations.set(userId, []);
      }
      const history = conversations.get(userId)!;

      // Ajouter le message utilisateur
      history.push({ role: 'user', content: `${userName}: ${message}` });

      try {
        const systemPrompt = await buildSystemPrompt();
        const reply = await callClaude(history, systemPrompt);

        // Sauvegarder la reponse et limiter l'historique a 20 messages
        history.push({ role: 'assistant', content: reply });
        if (history.length > 20) {
          history.splice(0, history.length - 20);
        }

        WA.chat.sendChatMessage(reply, BOT_NAME);
      } catch (e) {
        console.error('Erreur Hubert:', e);
        WA.chat.sendChatMessage(
          "Oups, j'ai eu un souci technique. Reessaie dans quelques secondes !",
          BOT_NAME
        );
      }
    });
  }
};
