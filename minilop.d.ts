// Types for the Minilop SDK. `import Minilop from 'minilop'`, or the global `Minilop` from the script tag.

export interface MinilopUser {
  /** Stable id. Rows a visitor adds carry it as `user_id`. */
  id: string;
  username: string | null;
  name: string | null;
  avatar: string | null;
  /** The visitor made this app. */
  isOwner: boolean;
}

export interface MinilopApp {
  slug: string;
  name: string;
  url: string;
  shareUrl: string;
}

/** Every table has these, added by Minilop. */
export interface MinilopRow {
  id: string;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  [column: string]: unknown;
}

export interface MinilopError extends Error {
  status: number;
  /** 'not_signed_in', 'not_allowed', or the database's own code. */
  code: string | null;
}

export interface Query<Row = MinilopRow, Result = Row[]> extends PromiseLike<Result> {
  /** Columns to return, as in `select('dish, price')`. Default `*`. */
  select(columns?: string): Query<Row, Result>;
  eq(column: string, value: unknown): Query<Row, Result>;
  neq(column: string, value: unknown): Query<Row, Result>;
  gt(column: string, value: unknown): Query<Row, Result>;
  gte(column: string, value: unknown): Query<Row, Result>;
  lt(column: string, value: unknown): Query<Row, Result>;
  lte(column: string, value: unknown): Query<Row, Result>;
  /** SQL LIKE: `%` is any text, `_` one character. */
  like(column: string, pattern: string): Query<Row, Result>;
  ilike(column: string, pattern: string): Query<Row, Result>;
  in(column: string, values: unknown[]): Query<Row, Result>;
  is(column: string, value: null | boolean): Query<Row, Result>;
  order(column: string, options?: { ascending?: boolean }): Query<Row, Result>;
  limit(count: number): Query<Row, Result>;
  offset(count: number): Query<Row, Result>;
  /** The first row, or null. */
  single(): Query<Row, Row | null>;
  catch<T = never>(onrejected?: (reason: MinilopError) => T | PromiseLike<T>): Promise<Result | T>;
}

export interface Table<Row = MinilopRow> extends Query<Row> {
  insert(rows: Partial<Row> | Partial<Row>[]): Query<Row>;
  /** Needs a filter, such as `.eq('id', id)`. */
  update(patch: Partial<Row>): Query<Row>;
  /** Needs a filter, such as `.eq('id', id)`. */
  delete(): Query<Row>;
}

export interface Minilop {
  version: string;
  Error: new (message: string, options?: { status?: number; code?: string | null }) => MinilopError;
  /** True on Minilop; false when the SDK is keeping data in this browser (localhost, a file). */
  online(): Promise<boolean>;
  user(): Promise<MinilopUser | null>;
  login(returnTo?: string): Promise<void>;
  logout(returnTo?: string | false): Promise<void>;
  signInButton(el: Element | string, options?: { returnTo?: string; theme?: 'dark' | 'light' }): HTMLElement;
  db: { from<Row = MinilopRow>(table: string): Table<Row & MinilopRow> };
  files: {
    upload(file: Blob & { name?: string }, path?: string): Promise<{ path: string }>;
    url(path: string): Promise<string>;
    list(prefix?: string): Promise<unknown[]>;
    delete(path: string): Promise<unknown>;
  };
  app(): Promise<MinilopApp | null>;
  share(): Promise<string | void>;
}

declare const Minilop: Minilop;
export default Minilop;

declare global {
  interface Window { Minilop: Minilop }
  const Minilop: Minilop;
}
