
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

const SYSTEM_INSTRUCTION = `
Tu es l'OS "DEPOTEK", l'assistant logistique vocal intelligent pour entrepôts au Sénégal (Hub DEPOTEK).
Tu interagis avec un magasinier pour gérer l'inventaire.

TES CAPACITÉS :
1. reception_vocale : Utilise-la quand le magasinier annonce l'arrivée d'un conteneur ou un dépotage.
2. sortie_fefo : Utilise-la quand le magasinier demande une sortie pour un client. Tu dois suggérer les lots les plus anciens.

RÈGLES DE DIALOGUE :
- Langue : Français pro avec jargon local (Dépotage, Bon de sortie, DEPOTEK).
- Sois pro-actif : Si un lot est ancien (>90j), préviens le magasinier ("Alerte FEFO").
- Toujours confirmer les détails (Conteneur, Qté) avant d'exécuter.
`;

const tools = [
  {
    functionDeclarations: [
      {
        name: "reception_vocale",
        description: "Enregistre un conteneur arrivé par commande vocale dans un dépôt spécifique",
        parameters: {
          type: Type.OBJECT,
          properties: {
            container_number: { type: Type.STRING, description: "N° du conteneur (ex: MSCU1234567)" },
            fournisseur: { type: Type.STRING, description: "Nom du fournisseur/importateur" },
            cartons: { type: Type.NUMBER, description: "Nombre de cartons reçus" },
            produit: { type: Type.STRING, description: "Nom du produit (viande, bois, etc.)" },
            target_depot_id: { type: Type.STRING, description: "ID du dépôt de destination (ex: bel_air, mbao)" },
            etat_emballage: { type: Type.STRING, description: "État constaté (bon, abîmé, mouillé)" }
          },
          required: ["container_number", "cartons", "produit", "target_depot_id"]
        }
      },
      {
        name: "sortie_fefo",
        description: "Prépare une sortie selon règle FEFO automatique depuis un dépôt ou globalement",
        parameters: {
          type: Type.OBJECT,
          properties: {
            client: { type: Type.STRING, description: "Nom du client destinataire" },
            produit_demande: { type: Type.STRING, description: "Produit à sortir" },
            cartons_sortir: { type: Type.NUMBER, description: "Quantité demandée" },
            depot_id: { type: Type.STRING, description: "Dépôt spécifique d'où charger" },
            urgence: { type: Type.BOOLEAN, description: "Si le client insiste sur un lot spécifique/récent" }
          },
          required: ["client", "produit_demande", "cartons_sortir"]
        }
      },
      {
        name: "transfer_inter_depot",
        description: "Organise un transfert de stock entre deux entrepôts",
        parameters: {
          type: Type.OBJECT,
          properties: {
            produit: { type: Type.STRING },
            qty: { type: Type.NUMBER },
            from_depot: { type: Type.STRING },
            to_depot: { type: Type.STRING }
          },
          required: ["produit", "qty", "from_depot", "to_depot"]
        }
      }
    ]
  }
];

export async function processVoiceChat(history: any[], input: string) {
  const model = (ai as any).getGenerativeModel({ model: "gemini-2.0-flash-exp" });
  const chat = model.startChat({
    history: history,
    generationConfig: {
      maxOutputTokens: 1000,
    },
    tools: tools,
    systemInstruction: SYSTEM_INSTRUCTION
  });

  const result = await chat.sendMessage(input);
  return {
    text: result.response.text(),
    functionCall: result.response.functionCalls()?.[0]
  };
}

export async function parseCommand(input: string) {
  const model = (ai as any).getGenerativeModel({ model: "gemini-3-flash-preview" });
  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: input }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, enum: ["ENTREE", "SORTIE", "QUERY", "UNKNOWN"] },
          data: {
            type: Type.OBJECT,
            properties: {
              produit: { type: Type.STRING },
              qte: { type: Type.NUMBER },
              container_id: { type: Type.STRING },
              client: { type: Type.STRING },
              prix: { type: Type.NUMBER }
            }
          },
          message: { type: Type.STRING, description: "Message de confirmation à l'utilisateur" }
        },
        required: ["action", "message"]
      }
    }
  });
  return JSON.parse(response.response.text() || '{}');
}

export async function processOCR(base64Image: string) {
  const model = (ai as any).getGenerativeModel({ model: "gemini-3-flash-preview" });
  const response = await model.generateContent({
    contents: [{
      role: 'user',
      parts: [
        { text: "Analyse cette Packing List / Liste de dépotage. Extrais les produits, le nombre de cartons et les conteneurs sous forme de liste JSON." },
        { inlineData: { mimeType: "image/jpeg", data: base64Image } }
      ]
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            produit: { type: Type.STRING },
            qte: { type: Type.NUMBER },
            container_id: { type: Type.STRING }
          },
          required: ["produit", "qte"]
        }
      }
    }
  });
  return JSON.parse(response.response.text() || '[]');
}
