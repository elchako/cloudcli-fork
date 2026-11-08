// GOLDJAXE fork (реестр §13.3): контракт не-секретных профилей API-настройки.
export const IMAGE_PROFILE_IDS = ['draft', 'standard', 'final'] as const;
export const IMAGE_QUALITY_IDS = ['low', 'medium', 'high', 'auto'] as const;
export type ImageProfile = (typeof IMAGE_PROFILE_IDS)[number];
export type ImageQuality = (typeof IMAGE_QUALITY_IDS)[number];
export type ImageGenerationSettings = {
  defaultProfile: ImageProfile;
  profiles: Record<ImageProfile, { model: string; quality: ImageQuality }>;
};
