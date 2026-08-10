import { uuidv7 } from "uuidv7";

/**
 * The only id generator. UUIDv7 is time-ordered, so ids sort by creation and
 * index inserts stay at the right edge of the btree — the reason ids are minted
 * here and not by a Postgres default.
 */
export const newId = (): string => uuidv7();
