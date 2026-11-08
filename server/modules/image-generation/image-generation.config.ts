// GOLDJAXE fork (реестр §13.3): режим — намерение пользователя, не свойство имени модели.
export const IMAGE_PROFILES = ['draft', 'standard', 'final'] as const;
export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export type ImageProfile = (typeof IMAGE_PROFILES)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export type ImageGenerationSettings = {
  defaultProfile: ImageProfile;
  profiles: Record<ImageProfile, { model: string; quality: ImageQuality }>;
};
