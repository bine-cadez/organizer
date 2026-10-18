import type { BookCandidate } from "../shared/types";

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
export class BookProviderError extends Error {
  code = "PROVIDER_UNAVAILABLE";
  status = 503;
  retryable = true;
}
export function normalizeIsbn(value: string): string {
  const isbn = value.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const first = `978${isbn.slice(0, 9)}`;
    const checksum =
      (10 -
        ([...first].reduce(
          (sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1),
          0,
        ) %
          10)) %
      10;
    return first + checksum;
  }
  return isbn;
}
export class BookCatalog {
  constructor(
    private cache: KVNamespace,
    private contact?: string,
    private fetcher: typeof fetch = fetch,
    private beforeFetch?: () => Promise<void>,
  ) {}
  private async request(path: string): Promise<JsonRecord> {
    const cacheKey = `book-cache:v1:${path}`;
    const cached = await this.cache.get<JsonRecord>(cacheKey, "json");
    if (cached) return cached;
    await this.beforeFetch?.();
    const userAgent = this.contact
      ? `Organizer (${this.contact})`
      : "Organizer (private book lookup)";
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher(`https://openlibrary.org${path}`, {
        headers: { "User-Agent": userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new BookProviderError(
        "Could not reach the books database. Try again, or add it by hand.",
      );
    }
    if (!response.ok)
      throw new BookProviderError(
        "Could not reach the books database. Try again, or add it by hand.",
      );
    const result = object(await response.json());
    await this.cache.put(cacheKey, JSON.stringify(result), {
      expirationTtl: 86400,
    });
    return result;
  }
  async search(
    query: string,
    limit = 10,
    cursor?: string,
  ): Promise<{ items: BookCandidate[]; nextCursor: string | null }> {
    query = query.trim();
    if (query.length < 2 || query.length > 200)
      throw Object.assign(new Error("Search must contain 2–200 characters."), {
        code: "VALIDATION_ERROR",
        status: 400,
      });
    const page = cursor ? Number(cursor) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100)
      throw Object.assign(new Error("Invalid search cursor."), {
        code: "VALIDATION_ERROR",
        status: 400,
      });
    const params = new URLSearchParams({
      q: /^\d[\d\s-]{8,}$/.test(query) ? `isbn:${normalizeIsbn(query)}` : query,
      fields:
        "key,title,author_name,first_publish_year,number_of_pages_median,cover_i,isbn,editions,editions.key,editions.title",
      limit: String(Math.max(1, Math.min(limit, 10))),
      page: String(page),
      lang: "en",
    });
    const data = await this.request(`/search.json?${params}`);
    const docs = Array.isArray(data.docs) ? data.docs : [];
    const items = docs
      .map((raw) => {
        const book = object(raw);
        const editionDocs = object(book.editions).docs;
        const edition = object(
          Array.isArray(editionDocs) ? editionDocs[0] : undefined,
        );
        const coverId =
          typeof book.cover_i === "number" ? book.cover_i : undefined;
        return {
          editionId: String(edition.key || ""),
          workId: String(book.key || ""),
          title: String(edition.title || book.title || "Untitled"),
          authors: strings(book.author_name),
          pageCount:
            typeof book.number_of_pages_median === "number"
              ? book.number_of_pages_median
              : undefined,
          pageCountSource: "work_median",
          coverId,
          coverUrl: coverId
            ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg?default=false`
            : undefined,
          isbn: strings(book.isbn).find(
            (v) => v.replace(/[\s-]/g, "").length === 13,
          ),
          year:
            typeof book.first_publish_year === "number"
              ? book.first_publish_year
              : undefined,
        } satisfies BookCandidate;
      })
      .filter((book) => /^\/books\/OL\d+M$/.test(book.editionId));
    return {
      items,
      nextCursor: docs.length >= limit ? String(page + 1) : null,
    };
  }
  async candidate(input: {
    editionId?: string;
    isbn?: string;
  }): Promise<BookCandidate> {
    let path: string;
    if (input.editionId && /^\/books\/OL\d+M$/.test(input.editionId))
      path = `${input.editionId}.json`;
    else if (
      input.isbn &&
      /^(\d{13}|\d{9}[\dX])$/.test(normalizeIsbn(input.isbn))
    )
      path = `/isbn/${normalizeIsbn(input.isbn)}.json`;
    else
      throw Object.assign(new Error("Choose a valid book edition or ISBN."), {
        code: "VALIDATION_ERROR",
        status: 400,
      });
    const book = await this.request(path);
    const authorKeys = (Array.isArray(book.authors) ? book.authors : [])
      .map((a) => String(object(a).key || ""))
      .filter((key) => /^\/authors\/OL\d+A$/.test(key))
      .slice(0, 5);
    const authors: string[] = [];
    for (const key of authorKeys) {
      const author = await this.request(`${key}.json`);
      if (typeof author.name === "string") authors.push(author.name);
    }
    const work = object((Array.isArray(book.works) ? book.works : [])[0]);
    const coverId = (Array.isArray(book.covers) ? book.covers : []).find(
      (v): v is number => typeof v === "number" && v > 0,
    );
    return {
      editionId: String(book.key || input.editionId),
      workId: typeof work.key === "string" ? work.key : undefined,
      title: String(book.title || "Untitled"),
      authors,
      pageCount:
        typeof book.number_of_pages === "number" && book.number_of_pages > 0
          ? book.number_of_pages
          : undefined,
      pageCountSource: "edition",
      coverId,
      coverUrl: coverId
        ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg?default=false`
        : undefined,
      isbn:
        strings(book.isbn_13)[0] ||
        (strings(book.isbn_10)[0]
          ? normalizeIsbn(strings(book.isbn_10)[0])
          : undefined),
    };
  }
}
