export interface ArxivInput {
  id: string;
  version?: number;
}

/** Parse only arXiv identifiers and known arXiv URLs; never accept arbitrary download URLs. */
export function parseArxivInput(input: string): ArxivInput {
  const invalid = () => new Error('Please enter a valid arXiv link or ID, such as 1706.03762.');
  let value = input.trim().replace(/^arxiv:/i, '');
  if (/^https?:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(
        'Please enter a valid arXiv link from arxiv.org or an ID, such as 1706.03762.',
      );
    }
    if (
      !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/(abs|pdf)\//.test(url.pathname)
    )
      throw new Error(
        'Please enter a valid arXiv link from arxiv.org or an ID, such as 1706.03762.',
      );
    value = url.pathname.replace(/^\/(abs|pdf)\//, '');
  }
  const match = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v([1-9]\d*))?(?:\.pdf)?$/.exec(
    value,
  );
  if (!match) throw invalid();
  const version = match[2] ? Number(match[2]) : undefined;
  if (version !== undefined && !Number.isSafeInteger(version)) throw invalid();
  return version === undefined ? { id: match[1] } : { id: match[1], version };
}
