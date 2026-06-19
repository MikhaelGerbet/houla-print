// Shared i18n module — usable from BOTH the main process (CommonJS via tsc)
// and conceptually mirrored into the renderer (see src/renderer/i18n.js,
// which is generated from the same locale JSON by scripts/copy-renderer.js).

import fr from './locales/fr.json';
import en from './locales/en.json';
import it from './locales/it.json';

export type Language = 'en' | 'fr' | 'it';

export const DEFAULT_LANGUAGE: Language = 'fr';

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'it', label: 'Italiano' },
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
];

export type TranslationMap = Record<string, string>;

export const translations: Record<Language, TranslationMap> = {
  fr: fr as TranslationMap,
  en: en as TranslationMap,
  it: it as TranslationMap,
};

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'fr' || value === 'it';
}

/**
 * Interpolate ${name} placeholders in a template string with values from `vars`.
 * Missing placeholders are left untouched.
 */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match
  );
}

/**
 * Translate a key for the given language.
 * Falls back to French, then to the key itself if missing.
 * Optional `vars` interpolates ${...} placeholders.
 */
export function t(
  key: string,
  lang: Language = DEFAULT_LANGUAGE,
  vars?: Record<string, string | number>
): string {
  const table = translations[lang] || translations[DEFAULT_LANGUAGE];
  const raw =
    table[key] ??
    translations[DEFAULT_LANGUAGE][key] ??
    key;
  return interpolate(raw, vars);
}
