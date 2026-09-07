import { locales } from "@/i18n/config";

/**
 * The words that confirm an account deletion.
 *
 * The screen shows whichever word is in the reader's language, and the server
 * must accept any of them: it has no business depending on which locale a
 * cookie happened to hold when the form was submitted. So the list is derived
 * from the message catalogues rather than written out, which is what the action
 * used to do with a two-element array. That array meant a third locale would
 * add a word to the interface that the server silently refused, and account
 * deletion would stop working for exactly the people using the new language,
 * with no test failing and no error naming the cause.
 *
 * Server-only. It reads the catalogues off disk the way `src/i18n/request.ts`
 * does, and nothing in the browser needs it: the button compares against the
 * one word it is showing.
 */
export async function deleteConfirmationWords(): Promise<readonly string[]> {
  const catalogues = await Promise.all(
    locales.map(async (locale) => {
      const messages = await import(`../../messages/${locale}.json`);
      return messages.default.account.deleteConfirmWord;
    }),
  );

  return catalogues
    .filter((word): word is string => typeof word === "string")
    .map((word) => word.trim().toUpperCase());
}

export async function isDeleteConfirmation(value: string): Promise<boolean> {
  const words = await deleteConfirmationWords();
  return words.includes(value.trim().toUpperCase());
}
