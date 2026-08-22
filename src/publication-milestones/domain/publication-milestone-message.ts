import type { NewsLanguageCode } from "../../settings/settings.contracts.js";

type RenderPublicationMilestoneMessageInput = {
  ordinal: number;
  languageCode: NewsLanguageCode;
  editorName: string;
};

export function renderPublicationMilestoneMessage({
  ordinal,
  languageCode,
  editorName,
}: RenderPublicationMilestoneMessageInput): string {
  const name = editorName.trim();
  switch (languageCode) {
    case "de":
      return `Das ist unser ${ordinal}. Beitrag. ${name} bedankt sich bei allen, die hier mitlesen, und macht mit weiteren starken Geschichten weiter.`;
    case "uk":
      return `Це наша ${ordinal}-та публікація. ${name} дякує всім, хто нас читає, і продовжить ділитися тут сильними історіями.`;
    case "en":
    default:
      return `This is our ${ordinal}th post. ${name} is grateful to everyone reading and will keep sharing strong stories here.`;
  }
}
