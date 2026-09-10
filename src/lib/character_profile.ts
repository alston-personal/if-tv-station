import { executeWithFallback, generateContentWithModelFallback } from './gemini';
import fs from 'fs';
import path from 'path';
import { IF_TV_DATA_DIR } from './paths';
import { CharacterProfile } from './db';

const CHAR_MEMORY_DIR = path.join(IF_TV_DATA_DIR, 'memory', 'characters');

/**
 * Character Profile Generator
 * Transforms a basic character description into a highly detailed visual profile
 * to ensure consistency across AI image and video generations.
 */
export async function generateCharacterProfile(
  worldInfo: any,
  jobId: string,
  characterName: string = 'Protagonist'
): Promise<CharacterProfile> {
  console.log(`[CharacterProfile] Generating detailed visual profile for ${characterName} in ${worldInfo.worldName}...`);

  const baseDescription = typeof worldInfo.mainCharacterDescription === 'object'
  ? JSON.stringify(worldInfo.mainCharacterDescription)
  : worldInfo.mainCharacterDescription;

  return executeWithFallback(async (ai) => {
    const systemPrompt = `You are a Master Concept Artist and Character Designer for a high-budget cinematic production.
Your task is to take a basic character description and expand it into a "Master Visual Profile".
This profile will be the absolute source of truth for all AI image and video generators to ensure the character looks identical in every shot.

The profile must be extremely concrete, avoiding vague adjectives like "beautiful" or "strange". Use specific materials, colors, and anatomical markers.

Requirements for each field:
1. appearance: A comprehensive physical description. Focus on silhouette, skin texture, and overarching vibe. (English, cinematic language)
2. facialFeatures: Detailed map of the face. Eye shape/color, nose type, jawline, any scars, tattoos, or distinctive jewelry. (English)
3. bodyType: Height, build, posture, and how they move. (English)
4. signatureStyle: Detailed clothing breakdown. Layers, fabric types (e.g., "weathered brown leather", "iridescent silk"), specific accessories, and how they fit. (English)
5. colorPalette: Define 2-3 dominant colors for the character. Use specific names (e.g., "Midnight Cobalt", "Oxidized Copper"). (English)
6. personalityVisualCues: How their internal state manifests visually (e.g., "a nervous twitch in the left eye", "a rigid, military-straight posture"). (English)
7. consistencyKeyphrases: A comma-separated list of 5-8 specific tokens that MUST be included in every prompt to trigger this specific look. (English)

Respond STRICTLY in JSON format.`;

    const prompt = `
World: ${worldInfo.worldName}
World Description: ${worldInfo.worldDescription}
Visual Style: ${worldInfo.visualStyle}
Basic Character Description: ${baseDescription}
Character Name: ${characterName}

Generate the Master Visual Profile for this character.`;

    const response = await generateContentWithModelFallback(ai, {
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json'
      }
    });

    const profileData = JSON.parse(response.text || '{}');

    const profile: CharacterProfile = {
      id: `char_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      characterName,
      roleInWorld: 'Protagonist',
      appearance: profileData.appearance || '',
      facialFeatures: profileData.facialFeatures || '',
      bodyType: profileData.bodyType || '',
      signatureStyle: profileData.signatureStyle || '',
      colorPalette: profileData.colorPalette || '',
      personalityVisualCues: profileData.personalityVisualCues || '',
      consistencyKeyphrases: profileData.consistencyKeyphrases || '',
      generatedAt: new Date().toISOString(),
      worldId: jobId
    };

    // Persistence: Save to memory directory for future reference/auditing
    const profilePath = path.join(CHAR_MEMORY_DIR, `${profile.id}.json`);
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    return profile;
  });
}
