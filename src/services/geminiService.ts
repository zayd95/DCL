import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || '' 
});

export const analyzeLogisticsDocument = async (base64Data: string, mimeType: string) => {
  try {
    const prompt = `Tu es un expert en logistique portuaire au PAD (Port Autonome de Dakar). 
    Analyse ce document (Facture, Liste de colisage ou Bon de livraison) et extrais les informations clés pour le système de gestion de stock Dakar Cold Link.
    
    RÈGLES D'EXTRACTION :
    1. Identifie le numéro de conteneur (format type MSCU1234567).
    2. Identifie le fournisseur (Supplier).
    3. Identifie le numéro de facture ou de référence.
    4. Liste tous les produits détectés avec leur nom et quantité (en cartons/units).
    5. Trouve la valeur totale si disponible.
    6. Identifie les dates de production ou d'expiration si présentes.
    
    Réponds EXCLUSIVEMENT au format JSON.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType
              }
            }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            containerNumber: { type: Type.STRING, description: "Numéro de conteneur (ex: MSCU1234567)" },
            supplier: { type: Type.STRING, description: "Nom du fournisseur" },
            invoiceNumber: { type: Type.STRING, description: "Numéro de facture" },
            totalValue: { type: Type.NUMBER, description: "Valeur totale en FCFA ou devise détectée" },
            products: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Nom du produit (ex: Buffalo Meat)" },
                  quantity: { type: Type.NUMBER, description: "Quantité en cartons" }
                },
                required: ["name", "quantity"]
              }
            },
            dates: {
              type: Type.OBJECT,
              properties: {
                arrival: { type: Type.STRING, description: "Date d'arrivée prévue" },
                expiry: { type: Type.STRING, description: "Date d'expiration" }
              }
            }
          }
        }
      }
    });

    const result = JSON.parse(response.text || '{}');
    return result;
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    throw error;
  }
};
