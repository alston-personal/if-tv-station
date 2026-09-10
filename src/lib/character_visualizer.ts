import { generateImageSegment } from './gemini';
import { generateCharacterProfile } from './character_profile';
import fs from 'fs';
import path from 'path';
import { IF_TV_DATA_DIR } from './paths';
import { CharacterProfile } from './db';

/**
 * Master Character Visualizer
 * Generates a high-fidelity "Master Image" of the character to serve as a
 * visual anchor (Cref) for all subsequent video segments.
 */
export async function generateMasterCharacterImage(
  worldInfo: any,
  jobId: string,
  characterName: string = 'Protagonist'
): Promise<{ imageUrl: string; profile: CharacterProfile }> {
  console.log(`[MasterChar] Initiating Master Image generation for ${characterName}...`);

  // 1. Ensure we have a detailed Character Profile first
  const profile = await generateCharacterProfile(worldInfo, jobId, characterName);

  // 2. Construct a specialized "Character Sheet" prompt
  // We want a high-fidelity, multi-angle reference image (character sheet style)
  const masterPrompt = `
    FULL BODY CHARACTER SHEET of ${characterName}.
    Core Identity: ${profile.roleInWorld}.
    Visual Essence: ${profile.appearance}.
    Facial Details: ${profile.facialFeatures}.
    Outfit: ${profile.signatureStyle}.
    Color Palette: ${profile.colorPalette}.

    Composition: A professional cinematic character concept sheet showing the character from three angles: full body front view, profile side view, and a detailed close-up of the face.
    Background: Simple neutral studio grey background to isolate the character.
    Lighting: Professional studio lighting, high contrast, volumetric shadows.
    Technical: photorealistic, 8k, ultra-detailed, cinematic character design, sharp focus, concept art style.
  `.trim();

  // 3. Define output path: /renders/characters/[jobId]/master.jpg
  const charDir = path.join(process.cwd(), 'public', 'renders', 'characters', jobId);
  if (!fs.existsSync(charDir)) {
    fs.mkdirSync(charDir, { recursive: true });
  }
  const outputPath = path.join(charDir, 'master.jpg');

  try {
    // 4. Generate using the existing Flux pipeline in gemini.ts
    await generateImageSegment(
      masterPrompt,
      worldInfo.visualStyle,
      profile.consistencyKeyphrases,
      outputPath
    );

    console.log(`[MasterChar] Master Image successfully generated at: ${outputPath}`);

    return {
      imageUrl: outputPath,
      profile: profile
    };
  } catch (err: any) {
    console.error(`[MasterChar] Failed to generate Master Image: ${err.message}`);
    throw err;
  }
}
