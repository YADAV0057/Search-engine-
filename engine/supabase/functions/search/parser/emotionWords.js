// engine/supabase/functions/search/parser/emotionWords.js
// 
// Curated AFINN-word -> richer-emotion overrides for the AFINN fallback
// path (see Notion "Backend Update List" -- "Richer mood taxonomy on the
// AFINN fallback"). AFINN only encodes a signed intensity per word, not
// which flavor of positive/negative it is, so moodLexicon.js's fallback
// collapsed every unmatched word to just {positive}/{negative} -- the
// custom manga_emotion_lexicon table (444 terms) was the only path to
// MANGA_ROUTING's other 25 emotion keys.
//
// This map lets a curated subset of common AFINN words resolve directly
// to one of those richer keys instead. Deliberately conservative: only
// words with a clear, unambiguous mapping to a single emotion are
// included. Anything not listed here still falls back to plain
// positive/negative, same as before -- this is additive, not a rewrite of
// the fallback's overall shape.
//
// NOT covered: 'nostalgia' and 'identity' have no clean single-word AFINN
// matches (nostalgia is a mood *about time*, not a sentiment a single word
// carries) -- still custom-lexicon-only. Extend manga_emotion_lexicon for
// those instead of trying to force a word list here.
//
// Some entries intentionally point AWAY from what AFINN's own score sign
// would suggest -- e.g. 'ominous' scores +3 in AFINN (a known AFINN
// oddity) but clearly means "dread", not something positive. Since this
// map is checked before the score-sign fallback, those get correctly
// routed regardless of the underlying AFINN sign.

export const EMOTION_WORD_MAP = {
  calm: 'calm', calmed: 'calm', calming: 'calm', calms: 'calm',
  relaxed: 'calm', peaceful: 'calm', peacefully: 'calm',
  serene: 'calm', tranquil: 'calm', soothe: 'calm', soothed: 'calm',
  soothing: 'calm', restful: 'calm',

  comfort: 'comfort', comfortable: 'comfort', comfortably: 'comfort',
  comforting: 'comfort', comforts: 'comfort', reassure: 'comfort',
  reassured: 'comfort', reassures: 'comfort', reassuring: 'comfort',

  joy: 'joy', joyful: 'joy', joyfully: 'joy', joyous: 'joy',
  jubilant: 'joy', delight: 'joy', delighted: 'joy', delightful: 'joy',
  delightfully: 'joy', delighting: 'joy', delights: 'joy',
  cheer: 'joy', cheered: 'joy', cheerful: 'joy', cheerfully: 'joy',
  cheering: 'joy', cheers: 'joy', cheery: 'joy', glee: 'joy',
  gleeful: 'joy', happy: 'joy', happiness: 'joy', happiest: 'joy',
  merry: 'joy',

  excite: 'excitement', excited: 'excitement', excitement: 'excitement',
  exciting: 'excitement',

  thrilled: 'thrill', riveting: 'thrill', gripping: 'thrill',

  daring: 'adrenaline', daredevil: 'adrenaline', bold: 'adrenaline',
  boldly: 'adrenaline',

  tense: 'tension', tension: 'tension', anxious: 'tension',
  anxiety: 'tension', nervous: 'tension', nervously: 'tension',
  uneasy: 'tension',

  dread: 'dread', dreaded: 'dread', dreadful: 'dread',
  dreading: 'dread', ominous: 'dread', doom: 'dread', doomed: 'dread',

  fear: 'fear', fearful: 'fear', fearfully: 'fear', fearing: 'fear',
  frightened: 'fear', frightening: 'fear', terrified: 'fear',
  terror: 'fear', scared: 'fear', scary: 'fear', afraid: 'fear',
  horror: 'fear', horrific: 'fear', horrendous: 'fear',
  horrible: 'fear', horrid: 'fear', horrified: 'fear',

  disgust: 'disgust', disgusted: 'disgust', disgustful: 'disgust',
  disgusting: 'disgust', gross: 'disgust', nasty: 'disgust',
  repulsive: 'disgust', repulsed: 'disgust', repulse: 'disgust',
  vile: 'disgust', icky: 'disgust',

  sad: 'sadness', sadly: 'sadness', sadden: 'sadness',
  saddened: 'sadness', sorrow: 'sadness', sorrowful: 'sadness',
  unhappy: 'sadness', unhappiness: 'sadness', heartbroken: 'sadness',
  heartbreaking: 'sadness', grief: 'sadness', grieved: 'sadness',
  mourn: 'sadness', mourned: 'sadness', mourning: 'sadness',
  mournful: 'sadness', mourns: 'sadness', tears: 'sadness',
  cry: 'sadness', crying: 'sadness', cries: 'sadness', cried: 'sadness',

  melancholy: 'melancholy', gloomy: 'melancholy', gloom: 'melancholy',
  somber: 'melancholy', dreary: 'melancholy', lonely: 'melancholy',
  lonesome: 'melancholy',

  trauma: 'trauma', traumatic: 'trauma', devastate: 'trauma',
  devastated: 'trauma', devastating: 'trauma', devastation: 'trauma',
  shattered: 'trauma',

  awesome: 'awe', astonished: 'awe', astound: 'awe',
  astounded: 'awe', astounding: 'awe', astoundingly: 'awe',
  astounds: 'awe', breathtaking: 'awe', magnificent: 'awe',
  stunning: 'awe',

  wonderful: 'wonder', wonderfully: 'wonder', marvel: 'wonder',
  marvelous: 'wonder', marvels: 'wonder', mesmerizing: 'wonder',
  enchanted: 'wonder', fascinate: 'wonder', fascinated: 'wonder',
  fascinates: 'wonder', fascinating: 'wonder', fascination: 'wonder',

  curious: 'curiosity', intrigues: 'curiosity',

  whimsical: 'whimsy', playful: 'whimsy', silly: 'whimsy',
  goofy: 'whimsy', goofiness: 'whimsy', funny: 'whimsy',
  funnier: 'whimsy',

  romance: 'romance', romantical: 'romance', romantically: 'romance',
  love: 'romance', loved: 'romance', loves: 'romance',
  loving: 'romance', lovable: 'romance', lovely: 'romance',
  lovelies: 'romance', adore: 'romance', adored: 'romance',
  adores: 'romance', adoring: 'romance', adoringly: 'romance',
  affection: 'romance', affectionate: 'romance',
  affectionateness: 'romance',

  sexy: 'arousal', passion: 'arousal', passionate: 'arousal',
  desire: 'arousal', desired: 'arousal', desirous: 'arousal',

  warm: 'warmth', warmhearted: 'warmth', warmness: 'warmth',
  warmth: 'warmth', coziness: 'warmth', tender: 'warmth',
  tenderness: 'warmth', caring: 'warmth', kind: 'warmth',
  kinder: 'warmth', kindness: 'warmth',

  hope: 'hope', hopeful: 'hope', hopefully: 'hope', hoping: 'hope',
  hopes: 'hope', optimism: 'hope', optimistic: 'hope', faith: 'hope',
  faithful: 'hope',

  determined: 'determination', resolute: 'determination',
  ambitious: 'determination', courageous: 'determination',
  courageously: 'determination', courage: 'determination',
  courageousness: 'determination', brave: 'determination',
  braveness: 'determination', bravery: 'determination',
  steadfast: 'determination',

  elegant: 'elegance', elegantly: 'elegance', graceful: 'elegance',
  grace: 'elegance', gracious: 'elegance', sophisticated: 'elegance',
  refined: 'elegance', polished: 'elegance', classy: 'elegance',
  chic: 'elegance'
};

export function getEmotionWordOverride(word) {
  if (!word) return null;
  return EMOTION_WORD_MAP[word.toLowerCase()] || null;
}

