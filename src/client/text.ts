// Keep mathematical and positional distinctions. Only typographic Latin
// ligatures and whitespace are folded, with callers retaining source offsets.
const ligatures: Record<string, string> = {
  ﬀ: 'ff',
  ﬁ: 'fi',
  ﬂ: 'fl',
  ﬃ: 'ffi',
  ﬄ: 'ffl',
  ﬅ: 'ſt',
  ﬆ: 'st',
};
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[ﬀ-ﬆ]/g, (c) => ligatures[c])
    .replace(/\s/g, ' ');
}
