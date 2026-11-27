/** Words, counted the same way everywhere: the status bar and Word count here, and the drafts list and
 * version history from the backend (`word_count` in backend/app/draft_review.py follows the same rule;
 * both are tested on desktop/tests/word-count-cases.json).
 *
 * A word is a run of letters, combining marks, digits or underscores in any script, which an apostrophe
 * or hyphen may join ("don't", "well-known", "GPT-4"). Chinese characters and Japanese kana are written
 * without spaces between words, so each one counts as a word, as Word and Google Docs count them. Other
 * scripts written without spaces (Thai, Lao, Khmer, Burmese) count a word per run between spaces. */
const EAST_ASIAN =
  /[⺀-⿟々〇〡-〩〸-〻぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ\u{20000}-\u{3FFFF}]/u
const LETTER = `(?:(?!${EAST_ASIAN.source})[\\p{L}\\p{M}\\p{N}\\p{Pc}])`
const WORD = new RegExp(`${EAST_ASIAN.source}|${LETTER}+(?:['’-]${LETTER}+)*`, 'gu')

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0
}
